// Low-volume checks: no credentials, customer lookups, ticket writes, or worker runs.
const input = process.argv[2];
if (!input)
  throw new Error(
    'Usage: node scripts/security-smoke.mjs https://your-app.example',
  );
const origin = new URL(input).origin;
if (!/^https?:$/.test(new URL(origin).protocol))
  throw new Error('HTTP(S) URL required.');
let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
async function request(path, init = {}) {
  return fetch(origin + path, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  });
}
const home = await request('/');
check('Home page responds', home.status === 200);
const html = await home.text();
check('Home is HTML', home.headers.get('content-type')?.includes('text/html'));
check(
  'Browser MIME protection',
  home.headers.get('x-content-type-options') === 'nosniff',
);
check('Embedding blocked', home.headers.get('x-frame-options') === 'DENY');
check(
  'Referrer token protection',
  home.headers.get('referrer-policy') === 'no-referrer',
);
const csp = home.headers.get('content-security-policy') || '';
check(
  'Content security policy',
  csp.includes("default-src 'self'") &&
    csp.includes("frame-ancestors 'none'") &&
    csp.includes("object-src 'none'") &&
    !csp.includes("'unsafe-eval'"),
);
if (origin.startsWith('https://'))
  check(
    'HTTPS transport policy',
    /max-age=[1-9]\d*/.test(
      home.headers.get('strict-transport-security') || '',
    ),
  );
const asset = html.match(
  /(?:src|href)="([^" ]*\/_next\/static\/[^" ]+\.js)"/,
)?.[1];
check(
  'App includes a local JavaScript entry',
  !!asset && new URL(asset, origin).origin === origin,
);
if (asset && new URL(asset, origin).origin === origin) {
  const response = await fetch(new URL(asset, origin), {
    signal: AbortSignal.timeout(30000),
  });
  check(
    'JavaScript entry is served',
    response.status === 200 &&
      /javascript/.test(response.headers.get('content-type') || ''),
  );
  await response.body?.cancel();
}
for (const path of [
  '/api/queue',
  '/api/team',
  '/api/reports',
  '/api/integrations',
  '/api/audit',
]) {
  const response = await request(path);
  check(`${path} requires authentication`, response.status === 401);
  check(
    `${path} is not cached`,
    response.headers.get('cache-control') === 'no-store',
  );
  await response.body?.cancel();
}
for (const path of ['/.env', '/.git/config', '/%2eenv', '/%2eanalysis/test']) {
  const response = await request(path);
  check(`${path} is hidden`, response.status === 404);
  await response.body?.cancel();
}
const crossOrigin = await request('/api/auth/login', {
  method: 'POST',
  headers: {
    Origin: 'https://untrusted.example',
    'Content-Type': 'application/json',
  },
  body: '{}',
});
check('Cross-origin login rejected', crossOrigin.status === 403);
await crossOrigin.body?.cancel();
const worker = await request('/api/jobs/run', { method: 'POST' });
check('Worker endpoint requires its secret', worker.status === 401);
await worker.body?.cancel();
const health = await request('/api/health');
check(
  'Database health ready',
  health.status === 200 && (await health.json()).status === 'ready',
);
console.log(`${failures} failed security smoke checks.`);
process.exitCode = failures ? 1 : 0;
