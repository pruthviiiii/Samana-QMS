import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { query } from '../lib/db';
import { snapshot } from '../scripts/schema-snapshot.mjs';
import { userColumns } from '../lib/api/shared';
import { ticketColumns } from '../lib/operations';
let live = '';
let committed = '';
beforeAll(async () => {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !== '/samana_qms_test'
  )
    throw new Error('Schema tests require the isolated test database.');
  live = await snapshot((text: string, params?: unknown[]) =>
    query(text, params),
  );
  committed = readFileSync(
    new URL('../db/schema.sql', import.meta.url),
    'utf8',
  ).replace(/\r\n/g, '\n');
});
describe('Schema snapshot', () => {
  it('matches the migrated database exactly (run npm run db:schema after a migration)', () => {
    expect(live).toBe(committed);
  });
  it('contains every column the API selects by name', () => {
    const users = live.split('-- table qms.users')[1].split('\n-- ')[0];
    for (const column of userColumns.split(','))
      expect(users, column).toContain(`  ${column} `);
    const view = live.split('-- view qms.ticket_view')[1].split('\n-- ')[0];
    for (const column of ticketColumns.split(','))
      expect(view, column).toMatch(new RegExp(`\\b${column}\\b`));
  });
});
