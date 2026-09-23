import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
// Builds the API service into dist-api/api.mjs. The generated Prisma client is
// regenerated first so the bundle always matches backend/prisma/schema.prisma, then
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
  entryPoints: ['backend/server/api.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Explicit externals rather than packages:'external'. The runtime packages
  // are installed on the host; @qms/shared is workspace source and must be
  // bundled in, or the image would need the whole workspace to resolve it.
  external: ['pg', '@prisma/client', '@prisma/adapter-pg', '@hono/node-server', 'zod'],
  outfile: 'dist-api/api.mjs',
  target: 'node22',
  banner: {
    // esbuild's ESM output needs these for packages that still use require().
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
console.log('API service built.');
