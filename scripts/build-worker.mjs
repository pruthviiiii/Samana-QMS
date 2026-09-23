import { build } from 'esbuild';
await build({
  entryPoints: ['scripts/worker-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Explicit externals rather than packages:'external'. The runtime packages
  // are installed on the host; @qms/shared is workspace source and must be
  // bundled in, or the image would need the whole workspace to resolve it.
  external: ['pg', '@prisma/client', '@prisma/adapter-pg', '@hono/node-server', 'zod'],
  outfile: 'dist-worker/worker.mjs',
  target: 'node22',
});
console.log('Background scheduler built.');
