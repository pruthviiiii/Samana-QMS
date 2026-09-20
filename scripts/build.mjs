import { cp, mkdtemp, symlink, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] === 'node' ? 'node' : 'cloudflare';
// OneDrive locks directories during the multi-phase bundler cleanup on Windows.
// Build an identical, secret-free source copy in a fresh temporary directory.
const staging = await mkdtemp(join(tmpdir(), 'samana-qms-build-'));
const entries = [
  'app',
  'components',
  'hooks',
  'lib',
  'public',
  'db',
  'scripts',
  '.openai',
  'package.json',
  'package-lock.json',
  'next.config.ts',
  'middleware.ts',
  'tsconfig.json',
  'vite.config.ts',
  'components.json',
];
for (const entry of entries)
  await cp(join(root, entry), join(staging, entry), { recursive: true });
await symlink(
  join(root, 'node_modules'),
  join(staging, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir',
);
console.log(`Building Samana QMS for ${target}.`);
const child = spawn(
  process.execPath,
  [join(root, 'node_modules/vinext/dist/cli.js'), 'build'],
  {
    cwd: staging,
    env: { ...process.env, QMS_TARGET: target },
    stdio: 'inherit',
    windowsHide: true,
  },
);
const code = await new Promise((resolveExit) => child.on('exit', resolveExit));
if (code !== 0) {
  process.exitCode = Number(code) || 1;
  throw new Error('Production build failed.');
}
const destination = join(root, target === 'node' ? 'dist-node' : 'dist');
if (
  !resolve(destination).startsWith(root + '\\') &&
  !resolve(destination).startsWith(root + '/')
)
  throw new Error('Invalid build destination.');
await rm(destination, {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 250,
});
await cp(join(staging, 'dist'), destination, { recursive: true });
console.log(
  `Validated build saved to ${target === 'node' ? 'dist-node' : 'dist'}.`,
);
await mkdir(join(root, '.analysis'), { recursive: true });
await writeFile(
  join(root, '.analysis', 'last-build.json'),
  JSON.stringify({ target, staging, at: new Date().toISOString() }),
);
