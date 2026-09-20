/** @param {Record<string, string | undefined>} env */
export function schedulerConfig(env = process.env) {
  const configured = env.WORKER_ORIGIN || env.APP_ORIGIN;
  if (!configured && env.NODE_ENV === 'production')
    throw new Error('WORKER_ORIGIN is required.');
  let url;
  try {
    url = new URL(configured || 'http://localhost:3000');
  } catch {
    throw new Error('Invalid worker origin.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(env.NODE_ENV !== 'production' && local && url.protocol === 'http:'))
  )
    throw new Error(
      'Worker requires an HTTPS origin (HTTP loopback is allowed only in development).',
    );
  if (!env.WORKER_SECRET) throw new Error('WORKER_SECRET is required.');
  return { origin: url.origin, secret: env.WORKER_SECRET };
}

export async function schedulerTick(config, request = fetch) {
  const response = await request(config.origin + '/api/jobs/run', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + config.secret },
    redirect: 'manual',
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error('Scheduler endpoint rejected the request.');
  const result = await response.json();
  const values = [
    result?.routing?.checked,
    result?.jobs?.processed,
    result?.jobs?.sent,
  ];
  if (
    !values.every((value) => Number.isInteger(value) && value >= 0) ||
    result.jobs.sent > result.jobs.processed
  )
    throw new Error('Invalid scheduler response.');
  return {
    routed: result.routing.checked,
    processed: result.jobs.processed,
    sent: result.jobs.sent,
  };
}
