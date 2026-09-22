import { beforeAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { query } from '../lib/db';
import { snapshot } from '../scripts/schema-snapshot.mjs';
import { ticketColumns } from '../lib/data/tickets';
import {
  MANAGER_ROLES,
  PRESENCE_WINDOW_MS,
  SERVING_ROLES,
  STAFF_ROLES,
} from '../lib/domain';
import { userSelect } from '../lib/data/users';
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
  // Migration 017 moved these from literals repeated across the functions into
  // one definition each. The application holds the same values in lib/domain.ts
  // and lib/api/shared.ts, so this is what stops the two drifting: a screen
  // must never call somebody available after routing has written them off, and
  // an endpoint must never admit a role the database refuses.
  it('agrees with lib/domain.ts on the presence window and the role groups', async () => {
    const [row] = await query<{
      window_ms: number;
      serving: string[];
      managers: string[];
    }>(
      "SELECT (extract(epoch from qms.presence_window())*1000)::int window_ms, qms.serving_roles() serving, qms.manager_roles() managers",
    );
    expect(row.window_ms).toBe(PRESENCE_WINDOW_MS);
    expect([...row.serving].sort()).toEqual([...SERVING_ROLES].sort());
    expect([...row.managers].sort()).toEqual([...MANAGER_ROLES].sort());
  });
  it('accepts every role lib/domain.ts can assign', () => {
    const users = live.split('-- table qms.users')[1].split('\n-- ')[0];
    const check = users.match(/users_role_check CHECK \(\((.*)\)\)/)?.[1] ?? '';
    for (const role of [...STAFF_ROLES, 'customer'])
      expect(check, role).toContain(`'${role}'`);
  });
  it('contains every column the API selects by name', () => {
    const users = live.split('-- table qms.users')[1].split('\n-- ')[0];
    // The columns the Prisma client selects for a signed-in account.
    for (const column of Object.keys(userSelect))
      expect(users, column).toContain(`  ${column} `);
    const view = live.split('-- view qms.ticket_view')[1].split('\n-- ')[0];
    for (const column of ticketColumns.split(','))
      expect(view, column).toMatch(new RegExp(`\\b${column}\\b`));
  });
});
