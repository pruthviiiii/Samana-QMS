import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// prisma/schema.prisma is the master description of the data. It is produced
// by introspecting the migrated database, so it can only be wrong in one way:
// by going stale after a migration. This test introspects the test database
// again and fails on any difference, the same way tests/schema.test.ts guards
// the SQL snapshot. Together they pin both descriptions to the one database.
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const normalise = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();
describe('Prisma schema', () => {
  it('matches the migrated database exactly (run npm run prisma:pull after a migration)', () => {
    const url = process.env.DATABASE_URL;
    if (!url || new URL(url).pathname !== '/samana_qms_test')
      throw new Error('Prisma schema test requires the isolated samana_qms_test database.');
    const printed = execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'db',
        'pull',
        '--print',
        '--schema',
        'backend/prisma/schema.prisma',
        '--url',
        url,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 },
    );
    const committed = readFileSync(new URL('../backend/prisma/schema.prisma', import.meta.url), 'utf8');
    expect(normalise(printed)).toBe(normalise(committed));
  });
  it('describes every table the SQL snapshot has, and nothing else', () => {
    const schema = readFileSync(new URL('../backend/prisma/schema.prisma', import.meta.url), 'utf8');
    const snapshot = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]).sort();
    const tables = [...snapshot.matchAll(/^-- table qms\.(\w+)/gm)].map((m) => m[1]).sort();
    expect(models).toEqual(tables);
    // The partial unique index that stops an agent holding two live customers
    // must be described as partial, or the schema would claim more than the
    // database enforces.
    expect(schema).toMatch(/one_active_service_per_agent.*where: raw\(/);
  });
  it('has a generated client that the API and the scheduler import', () => {
    expect(existsSync(new URL('../lib/generated/prisma/client.ts', import.meta.url))).toBe(true);
  });
});
