import { neon } from '@neondatabase/serverless';
export function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_NOT_CONFIGURED');
  return neon(url, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
}
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await db().query(text, params)) as T[];
}
