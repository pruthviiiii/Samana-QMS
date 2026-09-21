import { Pool, neonConfig } from '@neondatabase/serverless';
// One pooled connection set per process, over the PostgreSQL wire protocol
// (WebSocket transport on Neon). Queries share connections instead of opening
// an HTTP request each, and multi-statement work runs in real transactions.
if (typeof WebSocket !== 'undefined')
  neonConfig.webSocketConstructor = WebSocket;
let pool: Pool | null = null;
function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_NOT_CONFIGURED');
  if (!pool)
    pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      allowExitOnIdle: true,
      statement_timeout: 15000,
      query_timeout: 20000,
    });
  return pool;
}
export type Query = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await getPool().query(text, params)).rows as T[];
}
// Runs `work` inside one transaction on one connection; any throw rolls back.
export async function transaction<T>(work: (q: Query) => Promise<T>) {
  const client = await getPool().connect();
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
// Closes the pool; used by scripts and tests that must exit promptly.
export async function closeDb() {
  const current = pool;
  pool = null;
  if (current) await current.end();
}
