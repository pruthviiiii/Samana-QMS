import { query } from '../db';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../prisma';
import { commentRow, rows } from './rows';
// The activity log: who did what, when, to which ticket. Written for every
// sign-in, presence change, lookup, export and administrative change; the
// database functions write the ticket actions themselves.
const DUBAI = '+04:00'; // Asia/Dubai has no daylight saving

/** Records one event. `details` never carries a customer identifier. */
export async function record(
  actorId: string | null,
  action: string,
  details: Record<string, unknown> = {},
  ticketId: string | null = null,
) {
  await prisma().events.create({
    data: {
      actor_id: actorId,
      action,
      details: details as Prisma.InputJsonValue,
      ticket_id: ticketId,
    },
  });
}

/** Every event on one ticket, oldest first, with who did it. */
export async function forTicket(ticketId: string) {
  const list = await prisma().events.findMany({
    where: { ticket_id: ticketId },
    select: { id: true, action: true, details: true, created_at: true, users: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });
  return list.map(({ users, id, ...event }) => ({
    id: String(id),
    ...event,
    actor_name: users?.name ?? null,
  }));
}

export interface AuditFilter {
  before: string | null; // last id seen, as a decimal string
  action: string;
  from: string; // YYYY-MM-DD in Dubai, inclusive, or ''
  to: string; // YYYY-MM-DD in Dubai, inclusive, or ''
  limit: number;
}
/** A page of the trail, newest first, filtered by action and Dubai calendar day. */
export async function page(filter: AuditFilter) {
  const list = await prisma().events.findMany({
    where: {
      ...(filter.before ? { id: { lt: BigInt(filter.before) } } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      created_at: {
        ...(filter.from ? { gte: new Date(filter.from + 'T00:00:00' + DUBAI) } : {}),
        ...(filter.to ? { lt: new Date(new Date(filter.to + 'T00:00:00' + DUBAI).getTime() + 86400000) } : {}),
      },
    },
    select: {
      id: true,
      action: true,
      details: true,
      created_at: true,
      users: { select: { name: true } },
      tickets: { select: { number: true } },
    },
    orderBy: { id: 'desc' },
    take: filter.limit,
  });
  return list.map(({ users, tickets, id, ...event }) => ({
    id: String(id),
    ...event,
    number: tickets?.number ?? null,
    actor_name: users?.name ?? null,
  }));
}

/** Closing notes on a ticket, for the Salesforce write-back. */
export async function comments(ticketId: string) {
  const result = await query(
    "SELECT details->>'comment' body,u.name \"byName\",e.created_at at FROM qms.events e LEFT JOIN qms.users u ON u.id=e.actor_id WHERE ticket_id=$1 AND nullif(details->>'comment','') IS NOT NULL ORDER BY e.id",
    [ticketId],
  );
  return rows(commentRow, result, 'ticket comments');
}
