import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
// Writes docs/openapi.json from the route table (lib/api) and the body
// schemas each route declares. tests/openapi.test.ts fails when the file is
// out of date, so run `npm run api:docs` after changing a route.
// `--check` only compares and exits 1 when the file is stale.
//
// The route modules are bundled with esbuild into a throwaway file inside the
// project (so `pg` and `zod` resolve from node_modules) and imported once.
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = join(root, 'dist-worker');
await mkdir(scratch, { recursive: true });
const outfile = join(scratch, `.openapi-${randomBytes(4).toString('hex')}.mjs`);
await build({
  stdin: {
    contents:
      "import { routes } from './lib/api'; import { openApiDocument } from './lib/openapi'; export const document = openApiDocument(routes);",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  outfile,
  logLevel: 'error',
});
let document;
try {
  ({ document } = await import(pathToFileURL(outfile).href));
} finally {
  await rm(outfile, { force: true });
}
const text = JSON.stringify(document, null, 2) + '\n';
const target = join(root, 'docs', 'openapi.json');
if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current.replace(/\r\n/g, '\n') !== text) {
    console.error('docs/openapi.json is out of date. Run: npm run api:docs');
    process.exit(1);
  }
  console.log('docs/openapi.json is current.');
} else {
  await writeFile(target, text);
  console.log(
    `Wrote docs/openapi.json (${Object.keys(document.paths).length} paths).`,
  );
}
