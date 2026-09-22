import { query } from '../db';
import type { IdentifierType } from '../domain';
import { checkedRow, one, ticketRow, type TicketRecord } from './rows';
// The queue engine. Each function here is one PL/pgSQL function in PostgreSQL,
// called once, whose result is parsed before anyone sees it. The rules stay in
// the database on purpose: issuing a ticket must number it, insert it, route it
// and raise the change notification as one indivisible step, and calling a
// customer must guarantee no two agents hold the same ticket. Those are
// database guarantees (one advisory lock and a partial unique index) that an
// application-side implementation would have to rebuild by hand in every
// process that touches the queue. tests/workflow.test.ts exercises them.
//
// Rule violations arrive as SQLSTATE P0001 with the rule name as the message;
// lib/errors.ts maps them to statuses and plain sentences.

export async function issueTicket(args: {
  lookupId: string;
  serviceId: string;
  unitId: string | null;
  requestId: string;
  actorId: string;
}): Promise<TicketRecord> {
  const result = await query<{ ticket: unknown }>(
    'SELECT qms.issue_ticket($1,$2,$3,$4,$5) ticket',
    [args.lookupId, args.serviceId, args.unitId, args.requestId, args.actorId],
  );
  return one(ticketRow, result.map((r) => r.ticket), 'issue_ticket');
}

export type TicketActionKind = 'call' | 'start' | 'close' | 'no_show' | 'reassign';
export async function ticketAction(args: {
  ticketId: string;
  action: TicketActionKind;
  actorId: string;
  version: number;
  comment: string | null;
  targetId: string | null;
}): Promise<TicketRecord> {
  const result = await query<{ ticket: unknown }>(
    'SELECT qms.ticket_action($1,$2,$3,$4,$5,$6) ticket',
    [args.ticketId, args.action, args.actorId, args.version, args.comment, args.targetId],
  );
  return one(ticketRow, result.map((r) => r.ticket), 'ticket_action');
}

export async function setPresence(userId: string, online: boolean, counter?: string | null) {
  await query('SELECT qms.set_presence($1,$2,$3)', [userId, online, counter ?? null]);
}

export async function saveUser(args: {
  id: string | null;
  actorId: string;
  username: string;
  name: string;
  role: string;
  sfId: string | null;
  managerSfId: string | null;
  services: string[];
  counter: string;
  enabled: boolean;
  passwordHash: string | null;
  email: string | null;
}) {
  await query('SELECT qms.save_user($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [
    args.id,
    args.actorId,
    args.username,
    args.name,
    args.role,
    args.sfId,
    args.managerSfId,
    args.services,
    args.counter,
    args.enabled,
    args.passwordHash,
    args.email,
  ]);
}

export async function setQueueMember(
  serviceId: string,
  userId: string,
  member: boolean,
  actorId: string,
): Promise<string[]> {
  const [row] = await query<{ services: unknown }>(
    'SELECT qms.set_queue_member($1,$2,$3,$4) services',
    [serviceId, userId, member, actorId],
  );
  if (!row || !Array.isArray(row.services) || !row.services.every((s) => typeof s === 'string'))
    throw new Error('Unexpected row shape from set_queue_member.');
  return row.services as string[];
}

/** Issues a session only if the password hash is still the one that was verified. */
export async function issueSession(userId: string, passwordHash: string, tokenHash: string) {
  const [row] = await query<{ issued: boolean }>('SELECT qms.issue_session($1,$2,$3) issued', [
    userId,
    passwordHash,
    tokenHash,
  ]);
  return row?.issued === true;
}

/** Changes the password and replaces every session with the new one, atomically. */
export async function changePassword(
  userId: string,
  currentHash: string,
  nextHash: string,
  tokenHash: string,
) {
  const [row] = await query<{ changed: boolean }>(
    'SELECT qms.change_password($1,$2,$3,$4) changed',
    [userId, currentHash, nextHash, tokenHash],
  );
  return row?.changed === true;
}

/** The routing tick: expires silent agents, re-routes, rolls the day over. */
export async function routeDue(): Promise<number> {
  const result = await query('SELECT qms.route_due() checked');
  return one(checkedRow, result, 'route_due').checked;
}

export type { IdentifierType };
