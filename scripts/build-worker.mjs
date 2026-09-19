import { build } from 'esbuild';
await build({
  entryPoints: ['scripts/worker-entry.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'dist-worker/worker.mjs',
  target: 'node22',
});
console.log('Background scheduler built.');
