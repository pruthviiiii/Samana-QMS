import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// The boundaries of the three tiers, as rules of the repository rather than
// habits. Server modules never reach the browser; the web tier never reaches
// the database or the route table; the environment is read in one place.
const root = fileURLToPath(new URL('..', import.meta.url));
const clientSafe = new Set(['client', 'domain', 'utils']);
const serverModules = /^(api|router|db|http|events|prisma|data|jobs|salesforce|operations|public-access|retention|security|errors|lifecycle|config)$/;
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'generated') continue; // Prisma's output is not ours to police
      out.push(...walk(path));
    } else if (/\.(tsx|ts)$/.test(name)) out.push(path);
  }
  return out;
}
const rel = (file: string) => file.slice(root.length).split(sep).join('/');
function libModule(spec: string) {
  if (spec.startsWith('@/lib/')) return spec.slice('@/lib/'.length).split('/')[0];
  const relative = spec.match(/^(?:\.\.?\/)+lib\/([a-z-]+)/);
  return relative ? relative[1] : null;
}
describe('Tier boundaries', () => {
  it('keeps server modules out of browser code', () => {
    const files = [...walk(join(root, 'components')), ...walk(join(root, 'app'))];
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/from '([^']+)'/g)) {
        const spec = match[1];
        const lib = libModule(spec);
        const serverOnly =
          (lib !== null && !clientSafe.has(lib)) ||
          spec === 'pg' ||
          spec.startsWith('@prisma/') ||
          spec.startsWith('node:') ||
          spec.includes('/scripts/') ||
          spec.includes('/server/');
        if (serverOnly) offenders.push(rel(file) + ' imports ' + spec);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('gives the web tier no way to reach the database or the route table', () => {
    // The web tier is app/, components/, proxy.ts and instrumentation.ts. None
    // of it may import a server module; the API is reached only over HTTP.
    const files = [
      ...walk(join(root, 'app')),
      ...walk(join(root, 'components')),
      join(root, 'proxy.ts'),
      join(root, 'instrumentation.ts'),
      join(root, 'next.config.ts'),
    ];
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/from '([^']+)'|import\('([^']+)'\)/g)].some((m) => {
        const spec = m[1] ?? m[2];
        const lib = libModule(spec);
        return (lib !== null && serverModules.test(lib) && lib !== 'config') || spec.includes('/server/');
      });
    });
    expect(offenders.map(rel)).toEqual([]);
    // instrumentation.ts may import config, and only its web half.
    const instrumentation = readFileSync(join(root, 'instrumentation.ts'), 'utf8');
    expect(instrumentation).toContain('assertWebConfig');
    expect(instrumentation).not.toMatch(/assertConfig\b|lib\/db|lib\/events|lib\/prisma/);
  });
  it('lets only the API service host the route table', () => {
    const importers = [
      ...walk(join(root, 'app')),
      ...walk(join(root, 'components')),
      ...walk(join(root, 'server')),
      ...walk(join(root, 'scripts')),
    ].filter((file) => /from '(\.\.\/|@\/)lib\/api'/.test(readFileSync(file, 'utf8')));
    expect(importers.map(rel)).toEqual(['server/handler.ts']);
    expect(existsSync(join(root, 'app', 'api'))).toBe(false);
  });
  it('reads the environment in one place', () => {
    // lib/config.ts validates every setting once. Three other files may read
    // the environment directly and each has a reason: the proxy runs before
    // the application boots, the root layout needs a metadata base at build
    // time when no environment exists, and the instrumentation hook checks
    // which runtime it is in before importing anything.
    const allowed = new Set([
      'lib/config.ts',
      'proxy.ts',
      'app/layout.tsx',
      'instrumentation.ts',
    ]);
    const offenders = [
      ...walk(join(root, 'lib')),
      ...walk(join(root, 'server')),
      ...walk(join(root, 'components')),
      ...walk(join(root, 'app')),
      join(root, 'proxy.ts'),
      join(root, 'instrumentation.ts'),
    ]
      .filter((file) => readFileSync(file, 'utf8').includes('process.env'))
      .map(rel)
      .filter((file) => !allowed.has(file));
    expect(offenders).toEqual([]);
  });
});
