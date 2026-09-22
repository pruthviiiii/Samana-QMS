import { randomUUID } from 'node:crypto';
import pg from 'pg';
// Proves the reads that grow with the visit history stay bounded. Seeds a year
// of closed visits into the isolated test database, measures the dashboard
// aggregates and queue search against the predicates used before and after
// migration 018, then removes everything it created.
//
//   node --env-file=.env.test scripts/read-path-check.mjs [rows]
//
// Measured on a local PostgreSQL 18 at 200,000 tickets: dashboard statistics
// 232 ms -> 2.4 ms, service counts 215 ms -> 0.2 ms, and substring search moved
// from a sequential scan onto a trigram index. Re-run it after any change to
// those queries; a sequential scan in the AFTER rows is a regression.
const ROWS = Number(process.argv[2] || 200000);
const tag = 'bench-' + randomUUID().slice(0, 8);
const plan = (rows) => rows.map((r) => r['QUERY PLAN']).join('\n');
const summarise = (text) => {
  const scans = [...text.matchAll(/(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Bitmap Index Scan)[^\n]*/g)].map((m) => m[0].trim());
  const time = text.match(/Execution Time: ([\d.]+) ms/);
  return { scans: [...new Set(scans.map((s) => s.split(' on ')[0]))], ms: time ? Number(time[1]) : null };
};
(async () => {
  const c = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
  await c.connect();
  if (new URL(process.env.MIGRATE_DATABASE_URL).pathname !== '/samana_qms_test')
    throw new Error('refusing to seed anything but samana_qms_test');
  let admin, lookup;
  let incomplete = '';
  try {
    admin = (await c.query(
      "INSERT INTO qms.users(username,name,role,services,must_change_password) VALUES($1,'Bench','admin',ARRAY['general'],false) RETURNING id", [tag])).rows[0].id;
    lookup = (await c.query(
      "INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES($1,'mobile',$2,'{\"registered\":false,\"name\":\"Bench\",\"units\":[]}'::jsonb) RETURNING id", [admin, tag])).rows[0].id;
    console.log(`Seeding ${ROWS} closed tickets across a year...`);
    await c.query(
      `INSERT INTO qms.tickets(number,day,sequence,request_id,lookup_id,service_id,status,customer_name,identifier_type,created_by,created_at,closed_at,called_at)
       SELECT 'B-'||g, (now() AT TIME ZONE 'Asia/Dubai')::date - (g % 365), 100000+g, gen_random_uuid(), $1, 'general', 'closed',
              'Bench customer '||g, 'mobile', $2,
              now() - make_interval(days => g % 365), now() - make_interval(days => g % 365) + interval '20 min',
              now() - make_interval(days => g % 365) + interval '5 min'
         FROM generate_series(1,$3) g`, [lookup, admin, ROWS]);
    await c.query('ANALYZE qms.tickets');
    const total = (await c.query('SELECT count(*)::int n FROM qms.tickets')).rows[0].n;
    console.log(`tickets table now holds ${total} rows\n`);

    const today = "(now() AT TIME ZONE 'Asia/Dubai')::date";
    const statsBody = `count(*) FILTER(WHERE status='waiting')::int waiting,count(*) FILTER(WHERE status IN ('called','serving'))::int serving,count(*) FILTER(WHERE status='closed' AND day=${today})::int completed,count(*) FILTER(WHERE status='waiting' AND assigned_to IS NULL)::int unassigned`;
    /** @type {{label: string, sql: string, params: unknown[]}[]} */
    const cases = [
      { label: 'dashboard statistics  BEFORE', sql: `SELECT ${statsBody} FROM qms.tickets WHERE ($1::uuid IS NULL OR assigned_to=$1)`, params: [null] },
      { label: 'dashboard statistics  AFTER ', sql: `SELECT ${statsBody} FROM qms.tickets WHERE ($1::uuid IS NULL OR assigned_to=$1) AND (status IN ('waiting','called','serving') OR day=${today})`, params: [null] },
      { label: 'service counts        BEFORE', sql: "SELECT s.id,count(t.id) FILTER(WHERE t.status='waiting')::int waiting FROM qms.services s LEFT JOIN qms.tickets t ON t.service_id=s.id AND ($1::uuid IS NULL OR t.assigned_to=$1) GROUP BY s.id", params: [null] },
      { label: 'service counts        AFTER ', sql: "SELECT s.id,count(t.id) FILTER(WHERE t.status='waiting')::int waiting FROM qms.services s LEFT JOIN qms.tickets t ON t.service_id=s.id AND t.status IN ('waiting','called','serving') AND ($1::uuid IS NULL OR t.assigned_to=$1) GROUP BY s.id", params: [null] },
      { label: 'queue search          TRGM  ', sql: "SELECT count(*)::int n FROM qms.tickets WHERE customer_name ILIKE '%'||$1||'%'", params: ['customer 12345'] },
    ];
    for (const { label, sql, params } of cases) {
      const text = plan((await c.query('EXPLAIN (ANALYZE, BUFFERS) ' + sql, params)).rows);
      const r = summarise(text);
      console.log(`${label}  ${String(r.ms).padStart(9)} ms   ${r.scans.join(' + ')}`);
    }
  } finally {
    // Closing a ticket fires the Salesforce outbox trigger, so the seeded rows
    // have dependents. Delete in dependency order, and let a failure surface: a
    // cleanup that swallows its own errors reports success over rows it never
    // removed, and the next run dies on a unique constraint instead.
    const seeded = "(SELECT id FROM qms.tickets WHERE number LIKE 'B-%')";
    for (const statement of [
      `DELETE FROM qms.outbox WHERE ticket_id IN ${seeded}`,
      `DELETE FROM qms.notifications WHERE ticket_id IN ${seeded}`,
      `DELETE FROM qms.events WHERE ticket_id IN ${seeded}`,
      "DELETE FROM qms.tickets WHERE number LIKE 'B-%'",
      "DELETE FROM qms.lookups WHERE identifier_value LIKE 'bench-%'",
      "DELETE FROM qms.users WHERE username LIKE 'bench-%'",
      'ANALYZE qms.tickets',
    ])
      await c.query(statement);
    const left = (
      await c.query("SELECT count(*)::int n FROM qms.tickets WHERE number LIKE 'B-%'")
    ).rows[0].n;
    await c.end();
    // Recorded, not thrown: a throw here would replace whatever failure sent us
    // into this block, and that one is the more useful of the two.
    if (left) incomplete = `${left} seeded tickets were left behind.`;
    else console.log('\nFixture removed.');
  }
  if (incomplete) throw new Error(incomplete);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
