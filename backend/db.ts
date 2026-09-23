import pg from 'pg';
import { config } from './config';
// One pooled connection set per process over the standard PostgreSQL wire
// protocol, so any PostgreSQL 14 or newer server works: your own machine, a
// company server, or a managed host such as Neon. The same pool serves the
// Prisma client (backend/prisma.ts) and the raw, validated queries below, so a
// process never holds two sets of connections. TLS is switched on by
// `sslmode=verify-full` in DATABASE_URL and off when the parameter is absent.
let current: pg.Pool | null = null;
export function pool() {
  if (!current)
    current = new pg.Pool({
      connectionString: config().DATABASE_URL,
      // Every connection speaks UTC. Timestamps are stored with their zone and
      // the calendar-day rules name Asia/Dubai explicitly, so nothing depends
      // on the server's default zone; pinning it means the Prisma client, which
      // assumes UTC, reads and compares timestamps correctly on any server.
      options: '-c timezone=UTC',
      max: 10,
      idleTimeoutMillis: 30000,
      allowExitOnIdle: true,
      statement_timeout: 15000,
      query_timeout: 20000,
    });
  return current;
}
export type Query = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await pool().query(text, params)).rows as T[];
}
// Runs `work` inside one transaction on one connection; any throw rolls back.
export async function transaction<T>(work: (q: Query) => Promise<T>) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(
      async (text, params = []) => (await client.query(text, params)).rows,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      /* the connection is discarded below */
    });
    throw error;
  } finally {
    client.release();
  }
}
// Closes the pool; used by scripts, tests and shutdown handlers. Tolerates a
// pool the Prisma client already ended.
export async function closeDb() {
  const ending = current;
  current = null;
  if (ending)
    await ending.end().catch(() => {
      /* already ended */
    });
}
