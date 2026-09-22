import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
// Builds the API service into dist-api/api.mjs. The generated Prisma client is
// regenerated first so the bundle always matches prisma/schema.prisma, then
// the server, the route table and the client are bundled into one file with
// the runtime packages (pg, @prisma/client, @hono/node-server, zod) left
// external, so `npm ci --omit=dev` on the host is all the bundle needs.
const generate = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['prisma', 'generate'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
if (generate.status !== 0) throw new Error('prisma generate failed.');
await build({
  entryPoints: ['server/api.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'dist-api/api.mjs',
  target: 'node22',
  banner: {
    // esbuild's ESM output needs these for packages that still use require().
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
console.log('API service built.');
