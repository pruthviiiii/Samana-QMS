import { PrismaPg } from '@prisma/adapter-pg';
import { pool } from './db';
import { PrismaClient } from './generated/prisma/client';
// The typed data client. prisma/schema.prisma is introspected from the
// database and is the master description of every table, column, relation and
// index; the generated client gives every read and write a compile-time type.
// It runs over the same connection pool as the raw queries, through the pg
// driver adapter, so there is one pool per process and one set of TLS settings.
//
// What goes through Prisma: records and relations (staff, sessions, events,
// notifications, lookups, deliveries, services and queue membership).
// What stays as validated raw SQL: the queue engine's functions (issue, route,
// act, presence, save user), the read view that joins tickets with their
// service and agent, aggregate reports, and the two statements that must be
// single atomic writes (the rate limiter and the delivery claim). Every raw
// result is checked against a schema at runtime (backend/data/rows.ts) instead of
// being asserted.
let client: PrismaClient | null = null;
export function prisma() {
  if (!client) client = new PrismaClient({ adapter: new PrismaPg(pool()) });
  return client;
}
/** Releases the client on shutdown; the pool itself is closed by closeDb(). */
export async function closePrisma() {
  const closing = client;
  client = null;
  if (closing)
    await closing.$disconnect().catch(() => {
      /* already gone */
    });
}
