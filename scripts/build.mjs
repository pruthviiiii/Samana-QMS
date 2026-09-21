import { cp, rm, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
// Builds the standalone Node server into dist-node/standalone, which Render and
// the Dockerfile start. `next build` runs in place; Next.js keeps development
// output separately under .next/dev, so a running `next dev` is unaffected.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
console.log('Building Samana QMS (standalone Node server).');
const child = spawn(
  process.execPath,
  [join(root, 'node_modules/next/dist/bin/next'), 'build'],
  {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
    windowsHide: true,
  },
);
const code = await new Promise((resolveExit) => child.on('exit', resolveExit));
if (code !== 0) {
  process.exitCode = Number(code) || 1;
  throw new Error('Production build failed.');
}
const built = join(root, '.next');
const destination = join(root, 'dist-node');
if (!resolve(destination).startsWith(root))
  throw new Error('Invalid build destination.');
await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
// The standalone server needs the static assets and public files beside it.
await cp(join(built, 'standalone'), join(destination, 'standalone'), { recursive: true });
await cp(join(built, 'static'), join(destination, 'standalone', '.next', 'static'), { recursive: true });
await cp(join(root, 'public'), join(destination, 'standalone', 'public'), { recursive: true });
await stat(join(destination, 'standalone', 'server.js'));
console.log('Validated build saved to dist-node/standalone (start with node dist-node/standalone/server.js).');
