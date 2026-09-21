import pg from 'pg';
// Standard PostgreSQL connection for the maintenance scripts (migrate,
// bootstrap, schema snapshot, app role). `open` returns:
//   query(text, params) -> rows        transaction(work) -> result
//   end()                              user -> the connected role name
// Statements without parameters go over the simple protocol, which is what
// DDL and function bodies expect.
export async function open(url) {
  if (!url) throw new Error('DATABASE_URL is not set.');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const query = async (text, params = []) =>
    (params.length ? await client.query(text, params) : await client.query(text))
      .rows;
  return {
    query,
    async transaction(work) {
      await client.query('BEGIN');
      try {
        const result = await work(query);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    },
    end: () => client.end(),
  };
}
