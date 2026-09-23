import { cp, rm, stat, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
// Builds the web tier into dist-node/standalone, which Render and the
// Dockerfile start. `next build` runs inside the frontend workspace; Next.js
// keeps development output separately under .next/dev, so a running `next dev`
// is unaffected.
//
// In a workspace, `outputFileTracingRoot` is the repository root, so Next
// mirrors the path from that root inside its standalone output: the server
// lands at .next/standalone/frontend/server.js with a node_modules tree beside
// it at .next/standalone/node_modules. Both are copied, and the entry point is
// located rather than assumed, so a change to the workspace layout surfaces
// here as a clear failure instead of a missing file at boot.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');
console.log('Building Samana QMS web tier (standalone Node server).');
const child = spawn(
  process.execPath,
  [join(root, 'node_modules/next/dist/bin/next'), 'build'],
  {
    cwd: frontend,
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
const built = join(frontend, '.next');
const destination = join(root, 'dist-node');
if (!resolve(destination).startsWith(root))
  throw new Error('Invalid build destination.');
await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
// The standalone tree carries its own node_modules for the packages Next left
// external. Packages appear as symlinks in a workspace install, so they are
// dereferenced into real directories and the result runs anywhere, including
// Windows hosts where creating symlinks needs privileges.
await cp(join(built, 'standalone'), join(destination, 'standalone'), {
  recursive: true,
  dereference: true,
});
// Locate the server Next actually emitted rather than assuming its depth.
const standalone = join(destination, 'standalone');
const candidates = [join(standalone, 'server.js'), join(standalone, 'frontend', 'server.js')];
let serverDir = null;
for (const candidate of candidates) {
  try {
    await stat(candidate);
    serverDir = dirname(candidate);
    break;
  } catch {
    /* try the next one */
  }
}
if (!serverDir)
  throw new Error(
    `No server.js in the standalone output. Found: ${(await readdir(standalone)).join(', ')}`,
  );
// Static assets and public files must sit beside the server that serves them.
await cp(join(built, 'static'), join(serverDir, '.next', 'static'), { recursive: true });
await cp(join(frontend, 'public'), join(serverDir, 'public'), { recursive: true });
const entry = join(serverDir, 'server.js').slice(root.length + 1).split('\\').join('/');
console.log(`Validated build saved to dist-node (start with node ${entry}).`);
