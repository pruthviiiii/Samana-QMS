import { build } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Writes docs/openapi.json from the route table (lib/api) and the body
// schemas each route declares. tests/openapi.test.ts fails when the file is
// out of date, so run `npm run api:docs` after changing a route.
// `--check` only compares and exits 1 when the file is stale.
const dir = await mkdtemp(join(tmpdir(), 'samana-qms-openapi-'));
const outfile = join(dir, 'openapi.mjs');
await build({
  stdin: {
    contents:
      "import { routes } from './lib/api'; import { openApiDocument } from './lib/openapi'; export const document = openApiDocument(routes);",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'error',
});
const { document } = await import(pathToFileURL(outfile).href);
await rm(dir, { recursive: true, force: true });
const text = JSON.stringify(document, null, 2) + '\n';
const target = new URL('../docs/openapi.json', import.meta.url);
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
