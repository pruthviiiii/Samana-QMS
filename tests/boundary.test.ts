import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// The boundaries between the three workspaces, as rules of the repository
// rather than habits. Since the split they are also visible as directories,
// but a directory is a convention and this is the enforcement: backend code
// never reaches the browser, the frontend never reaches the database or the
// route table, and the environment is read in one place.
//
//   frontend/  screens and the proxy. No credential, ever.
//   backend/   route table, data access, integrations. Never bundled to a browser.
//   shared/    the vocabulary both agree on. No I/O, no dependencies.
const root = fileURLToPath(new URL('..', import.meta.url));
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'generated') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(tsx|ts)$/.test(name)) out.push(path);
  }
  return out;
}
const rel = (file: string) => file.slice(root.length).split(sep).join('/');
// Build configuration is Node code that runs during `next build`. It never
// reaches a browser bundle, so it is not browser code and the rules below do
// not apply to it.
const BUILD_CONFIG = new Set(['frontend/next.config.ts']);
const browserCode = (file: string) => !BUILD_CONFIG.has(rel(file));
const specifiers = (text: string) =>
  [...text.matchAll(/from '([^']+)'|import\('([^']+)'\)/g)].map((m) => m[1] ?? m[2]);
// The single permitted crossing. backend/config.ts validates the settings for
// every process, including the web tier's own four, and holds no I/O and no
// credential -- only the shapes it checks them against. The web tier imports it
// dynamically at boot (frontend/instrumentation.ts) so a deployment missing the
// API address fails at start rather than on every request. Any OTHER backend
// module reaching the frontend is a defect.
const SHARED_CONFIG = '@backend/config';
/** Anything that must never be resolvable from browser code. */
function backendOnly(spec: string) {
  if (spec === SHARED_CONFIG) return false;
  return (
    spec.startsWith('@backend/') ||
    /^(?:\.\.\/)+backend\//.test(spec) ||
    spec === 'pg' ||
    spec.startsWith('@prisma/') ||
    spec.startsWith('node:') ||
    spec.includes('/scripts/')
  );
}
describe('Workspace boundaries', () => {
  it('keeps backend code out of the frontend', () => {
    const files = walk(join(root, 'frontend')).filter(browserCode);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files)
      for (const spec of specifiers(readFileSync(file, 'utf8')))
        if (backendOnly(spec)) offenders.push(rel(file) + ' imports ' + spec);
    expect(offenders).toEqual([]);
  });
  it('gives the frontend no way to reach the database or the route table', () => {
    // The whole web tier: screens, the proxy and the boot hook. None of it may
    // import a backend module; the API is reached only over HTTP.
    const files = walk(join(root, 'frontend')).filter(browserCode);
    const offenders = files.filter((file) =>
      specifiers(readFileSync(file, 'utf8')).some(backendOnly),
    );
    expect(offenders.map(rel)).toEqual([]);
    // And the one permitted crossing is used by exactly one file, for exactly
    // one thing. If a second file starts importing config, that is the moment
    // to ask whether the web tier is growing a server.
    const usesConfig = files.filter((file) =>
      specifiers(readFileSync(file, 'utf8')).includes(SHARED_CONFIG),
    );
    expect(usesConfig.map(rel)).toEqual(['frontend/instrumentation.ts']);
    // instrumentation.ts validates configuration at boot and may read only the
    // web tier's half of it.
    const instrumentation = readFileSync(join(root, 'frontend', 'instrumentation.ts'), 'utf8');
    expect(instrumentation).toContain('assertWebConfig');
    expect(instrumentation).not.toMatch(/assertConfig\b|@backend\/db|@backend\/events|@backend\/prisma/);
  });
  it('lets only the API service host the route table', () => {
    const importers = [
      ...walk(join(root, 'frontend')),
      ...walk(join(root, 'backend')),
      ...walk(join(root, 'scripts')),
    ].filter((file) =>
      specifiers(readFileSync(file, 'utf8')).some(
        (s) => s === '../api' || s === '@backend/api' || s === '../backend/api',
      ),
    );
    expect(importers.map(rel)).toEqual(['backend/server/handler.ts']);
    // The API is its own service; it is not a folder of the web application.
    expect(existsSync(join(root, 'frontend', 'app', 'api'))).toBe(false);
  });
  it('keeps the shared workspace free of I/O and dependencies', () => {
    // shared/ is imported by the browser, so anything it pulls in ships to the
    // browser too. Its whole safety argument is that it pulls in nothing.
    const files = walk(join(root, 'shared'));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files)
      for (const spec of specifiers(readFileSync(file, 'utf8')))
        if (!spec.startsWith('.')) offenders.push(rel(file) + ' imports ' + spec);
    expect(offenders).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, 'shared', 'package.json'), 'utf8'));
    expect(manifest.dependencies ?? {}).toEqual({});
  });
  it('reads the environment in one place', () => {
    // backend/config.ts validates every setting once. Three other files may
    // read the environment directly and each has a reason: the proxy runs
    // before the application boots, the root layout needs a metadata base at
    // build time when no environment exists, and the instrumentation hook
    // checks which runtime it is in before importing anything.
    const allowed = new Set([
      'backend/config.ts',
      'frontend/proxy.ts',
      'frontend/app/layout.tsx',
      'frontend/instrumentation.ts',
    ]);
    const offenders = [
      ...walk(join(root, 'backend')),
      ...walk(join(root, 'frontend')),
      ...walk(join(root, 'shared')),
    ]
      .filter((file) => readFileSync(file, 'utf8').includes('process.env'))
      .map(rel)
      .filter((file) => !allowed.has(file));
    expect(offenders).toEqual([]);
  });
});
