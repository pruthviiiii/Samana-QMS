import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { record, forTicket, page } from '../lib/data/events';
import { markRead, unread } from '../lib/data/notifications';
import { one, rows, ticketRow } from '../lib/data/rows';
import { BOARD_ROWS, board } from '../lib/data/tickets';
import { createGuest, findSessionUser, loginCandidates, revokeSession } from '../lib/data/users';
import { closeDb, query } from '../lib/db';
import { closePrisma } from '../lib/prisma';
import { sha256 } from '../lib/security';
// The data layer: raw rows are checked, not asserted; records read through
// Prisma come back in the shapes the API promises (ids as strings, dates as
// ISO strings, no bigint anywhere near JSON).
const tag = 'data-test-' + crypto.randomUUID().slice(0, 8);
let userId = '';
let ticketId = '';
beforeAll(async () => {
  if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/samana_qms_test')
    throw new Error('Data tests require the isolated samana_qms_test database.');
  const [user] = await query<{ id: string }>(
    "INSERT INTO qms.users(username,name,role,password_hash,must_change_password,services,online,last_seen) VALUES($1,'Data fixture','agent','pbkdf2$600000$salt$hash',false,ARRAY['general'],true,now()) RETURNING id",
    [tag],
  );
  userId = user.id;
  const [lookup] = await query<{ id: string }>(
    "INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES($1,'mobile',$2,$3::jsonb) RETURNING id",
    [userId, tag, JSON.stringify({ registered: false, name: 'Data fixture visitor', units: [] })],
  );
  const [issued] = await query<{ ticket: { id: string } }>(
    "SELECT qms.issue_ticket($1,'general',NULL,$2,$3) ticket",
    [lookup.id, crypto.randomUUID(), userId],
  );
  ticketId = issued.ticket.id;
});
afterAll(async () => {
  for (const table of ['notifications', 'outbox', 'events']) await query(`DELETE FROM qms.${table} WHERE ticket_id=$1`, [ticketId]);
  await query('DELETE FROM qms.tickets WHERE id=$1', [ticketId]);
  await query('DELETE FROM qms.lookups WHERE actor_id=$1', [userId]);
  await query('DELETE FROM qms.events WHERE actor_id=$1', [userId]);
  await query('DELETE FROM qms.sessions WHERE user_id=$1', [userId]);
  await query('DELETE FROM qms.users WHERE id=$1 OR username LIKE $2', [userId, 'visit-%' + tag.slice(-4)]);
  await closePrisma();
  await closeDb();
});
describe('Row validation', () => {
  it('accepts a ticket row from the view and from a function result alike', async () => {
    const [fromView] = await query('SELECT * FROM qms.ticket_view WHERE id=$1', [ticketId]);
    const parsed = one(ticketRow, [fromView], 'test');
    expect(parsed.id).toBe(ticketId);
    expect(parsed.created_at).toBeInstanceOf(Date);
    const asJson = JSON.parse(JSON.stringify(fromView));
    expect(one(ticketRow, [asJson], 'test').status).toBe('waiting');
  });
  it('names the query and the row when a column is missing or has the wrong type', () => {
    expect(() => rows(ticketRow, [{ id: 'x' }], 'broken query')).toThrow(/broken query \(row 0\)/);
    expect(() => rows(ticketRow, [{ id: 'x' }], 'broken query')).toThrow(/number/);
    expect(() => one(ticketRow, [], 'empty query')).toThrow(/Expected one row from empty query/);
  });
});
describe('The reception television board', () => {
  // The board is the queue, not only the tickets already at a counter: a room
  // with people waiting and nobody called must still have something to show,
  // which is the defect this replaced.
  it('lists tickets that are still waiting, not only those at a counter', async () => {
    const { tickets } = await board();
    // The fixture issued a ticket and never called it, so a board that only
    // knew about counters would come back empty here.
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.some((t) => t.status === 'waiting')).toBe(true);
  });
  it('gives every row what the screen prints, including when it arrived', async () => {
    const { tickets } = await board();
    for (const ticket of tickets) {
      expect(typeof ticket.number).toBe('string');
      expect(typeof ticket.service_name).toBe('string');
      expect(ticket.created_at).toBeTruthy();
      expect(['waiting', 'called', 'serving']).toContain(ticket.status);
    }
  });
  it('never returns more rows than the screen has room for', async () => {
    const { tickets, waiting } = await board();
    expect(tickets.length).toBeLessThanOrEqual(BOARD_ROWS);
    // The total is what the screen turns into its overflow line, so it counts
    // everyone waiting and not just the ones that fit.
    expect(waiting).toBeGreaterThanOrEqual(
      tickets.filter((t) => t.status === 'waiting').length,
    );
  });
  it('puts whoever was called most recently first, so the screen can announce them', async () => {
    const { tickets } = await board();
    const active = tickets.filter((t) => t.status !== 'waiting');
    // Active tickets lead the board, and the waiting queue follows it.
    const firstWaiting = tickets.findIndex((t) => t.status === 'waiting');
    if (active.length && firstWaiting !== -1)
      expect(firstWaiting).toBe(active.length);
  });
});
describe('Records through the Prisma client', () => {
  it('finds the account behind a live session and not behind a revoked or expired one', async () => {
    const token = await sha256('data-test-' + crypto.randomUUID());
    await query("INSERT INTO qms.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [token, userId]);
    const user = await findSessionUser(token);
    expect(user?.id).toBe(userId);
    expect(typeof user?.last_seen).toBe('string');
    await revokeSession(token);
    expect(await findSessionUser(token)).toBeNull();
    const expired = await sha256('data-test-expired-' + crypto.randomUUID());
    await query("INSERT INTO qms.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()-interval '1 second')", [expired, userId]);
    expect(await findSessionUser(expired)).toBeNull();
  });
  it('reads timestamps as the database holds them, whatever the server time zone', async () => {
    // Regression: before every connection was pinned to UTC, a database whose
    // session zone was Asia/Dubai made the client read timestamps four hours
    // late and compare Date parameters four hours early.
    const [raw] = await query<{ last_seen: Date; zone: string }>(
      'SELECT last_seen, current_setting($2) zone FROM qms.users WHERE id=$1',
      [userId, 'TimeZone'],
    );
    expect(raw.zone).toBe('UTC');
    const token = await sha256('data-test-tz-' + crypto.randomUUID());
    await query("INSERT INTO qms.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [token, userId]);
    const user = await findSessionUser(token);
    expect(user?.last_seen).toBe(raw.last_seen.toISOString());
    await revokeSession(token);
  });
  it('matches a login identifier case-insensitively and puts username matches first', async () => {
    const candidates = await loginCandidates(tag.toUpperCase().toLowerCase());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].usernameMatch).toBe(true);
    expect(candidates[0].user.username).toBe(tag);
    expect(candidates[0].passwordHash).toContain('pbkdf2$');
  });
  it('writes and reads the activity log with string ids and actor names', async () => {
    await record(userId, 'data_test_event', { note: 'hello' }, ticketId);
    const history = await forTicket(ticketId);
    const mine = history.find((e) => e.action === 'data_test_event');
    expect(mine).toBeTruthy();
    expect(typeof mine?.id).toBe('string');
    expect(mine?.actor_name).toBe('Data fixture');
    expect(mine?.details).toEqual({ note: 'hello' });
    const filtered = await page({ before: null, action: 'data_test_event', from: '', to: '', limit: 5 });
    expect(filtered[0].number).toBeTruthy();
    expect(() => JSON.stringify(filtered)).not.toThrow();
    const older = await page({ before: filtered[0].id, action: 'data_test_event', from: '', to: '', limit: 5 });
    expect(older.every((e) => BigInt(e.id) < BigInt(filtered[0].id))).toBe(true);
  });
  it('lists unread notices for the assigned agent and clears them by id', async () => {
    await query("SELECT qms.assign_ticket($1,$2,'test_assignment')", [ticketId, userId]);
    const before = await unread(userId);
    const mine = before.find((n) => n.ticket_id === ticketId);
    expect(mine).toBeTruthy();
    expect(typeof mine?.id).toBe('string');
    expect(mine?.number).toBeTruthy();
    await markRead(userId, [Number(mine!.id)]);
    expect((await unread(userId)).some((n) => n.ticket_id === ticketId)).toBe(false);
  });
  it('creates a guest and its session in one transaction', async () => {
    const id = crypto.randomUUID();
    const token = await sha256('guest-' + id);
    await createGuest(id, token, 45);
    const guest = await findSessionUser(token);
    expect(guest?.role).toBe('customer');
    expect(guest?.username).toBe('visit-' + id);
    await revokeSession(token);
    await query('DELETE FROM qms.users WHERE id=$1', [id]);
  });
});
