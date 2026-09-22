import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// Server modules never reach the browser. Anything under components/ and any
// page or layout under app/ (everything except app/api) may import only the
// client-safe modules. Next.js would refuse to bundle a Node-only import into
// browser code anyway; this test names the file and the import first, and
// makes the boundary a rule of the repository rather than a habit.
const root = fileURLToPath(new URL('..', import.meta.url));
const clientSafe = new Set(['client', 'domain', 'utils']);
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(tsx|ts)$/.test(name)) out.push(path);
  }
  return out;
}
function libModule(spec: string) {
  if (spec.startsWith('@/lib/')) return spec.slice('@/lib/'.length);
  const relative = spec.match(/^(?:\.\.?\/)+lib\/([a-z-]+)/);
  return relative ? relative[1] : null;
}
describe('Client and server boundary', () => {
  it('keeps server modules out of browser code', () => {
    const files = [...walk(join(root, 'components')), ...walk(join(root, 'app'))].filter(
      (file) => !file.includes(join('app', 'api') + sep),
    );
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
          spec.startsWith('node:') ||
          spec.includes('/scripts/');
        if (serverOnly) offenders.push(file.slice(root.length) + ' imports ' + spec);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('reads the environment in one place', () => {
    // lib/config.ts validates every setting once. Three files are allowed to
    // read the environment directly and each has a reason: the proxy runs
    // before the application boots, the root layout needs a metadata base at
    // build time when no environment exists, and the instrumentation hook
    // checks which runtime it is in before importing anything.
    const allowed = new Set([
      'lib/config.ts',
      'proxy.ts',
      'app/layout.tsx',
      'instrumentation.ts',
    ]);
    const offenders = [
      ...walk(join(root, 'lib')),
      ...walk(join(root, 'components')),
      ...walk(join(root, 'app')),
      join(root, 'proxy.ts'),
      join(root, 'instrumentation.ts'),
    ]
      .filter((file) => readFileSync(file, 'utf8').includes('process.env'))
      .map((file) => file.slice(root.length).split(sep).join('/'))
      .filter((file) => !allowed.has(file));
    expect(offenders).toEqual([]);
  });
  it('lets only the API entry point reach the route table', () => {
    const importers = walk(join(root, 'app')).filter((file) =>
      /from '@\/lib\/(api|router|db|http)'/.test(readFileSync(file, 'utf8')),
    );
    expect(importers.map((f) => f.slice(root.length).split(sep).join('/'))).toEqual([
      'app/api/[...path]/route.ts',
    ]);
  });
});
