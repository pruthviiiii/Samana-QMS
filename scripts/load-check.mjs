import { randomUUID } from 'node:crypto';
import pg from 'pg';
// Measures the queue engine under concurrency on the database in
// DATABASE_URL (never point it at production: it creates and deletes staff,
// lookups and tickets). Reports how long the routing tick takes with many
// waiting customers, and the throughput of issuing and working tickets from
// many connections at once, so the single advisory lock is a measured cost.
//
//   node --env-file=.env.test scripts/load-check.mjs [agents] [tickets] [connections]
const agents = Number(process.argv[2] || 20);
const tickets = Number(process.argv[3] || 200);
const connections = Number(process.argv[4] || 20);
const url = process.env.DATABASE_URL;
if (!url || !/samana_qms(_test)?$/.test(new URL(url).pathname))
  throw new Error('DATABASE_URL must point at a samana_qms or samana_qms_test database.');
const pool = new pg.Pool({ connectionString: url, max: connections });
const tag = 'load-' + randomUUID().slice(0, 8);
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
async function timed(label, fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  console.log(`${label}: ${ms(start).toFixed(0)} ms`);
  return result;
}
const ids = { users: [], lookups: [], tickets: [] };
try {
  const admin = (
    await pool.query(
      "INSERT INTO qms.users(username,name,role,services,must_change_password) VALUES($1,'Load admin','admin',ARRAY['general'],false) RETURNING id",
      [tag + '-admin'],
    )
  ).rows[0].id;
  ids.users.push(admin);
  for (let i = 0; i < agents; i++)
    ids.users.push(
      (
        await pool.query(
          "INSERT INTO qms.users(username,name,role,services,online,last_seen,must_change_password) VALUES($1,$2,'agent',ARRAY['general'],false,now(),false) RETURNING id",
          [`${tag}-agent-${i}`, `Load agent ${i}`],
        )
      ).rows[0].id,
    );
  const agentIds = ids.users.slice(1);
  for (let i = 0; i < tickets; i++)
    ids.lookups.push(
      (
        await pool.query(
          "INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES($1,'mobile',$2,'{\"registered\":false,\"name\":\"Load customer\",\"units\":[]}'::jsonb) RETURNING id",
          [admin, `${tag}-${i}`],
        )
      ).rows[0].id,
    );
  console.log(`Fixture: ${agents} agents, ${tickets} lookups, ${connections} connections, tag ${tag}`);

  // 1. Issue every ticket concurrently while no agent is online: they all wait.
  const issueLatency = [];
  await timed(`issue ${tickets} tickets from ${connections} connections`, () =>
    Promise.all(
      ids.lookups.map(async (lookup) => {
        const start = process.hrtime.bigint();
        const row = (
          await pool.query('SELECT qms.issue_ticket($1,$2,$3,$4,$5) t', [lookup, 'general', null, randomUUID(), admin])
        ).rows[0].t;
        issueLatency.push(ms(start));
        ids.tickets.push(row.id);
      }),
    ),
  );
  console.log(`  issue latency p50 ${percentile(issueLatency, 0.5).toFixed(0)} ms, p95 ${percentile(issueLatency, 0.95).toFixed(0)} ms, max ${Math.max(...issueLatency).toFixed(0)} ms`);

  // 2. The routing tick with every ticket waiting and nobody online.
  await timed(`route_due with ${tickets} waiting and 0 agents online`, () => pool.query('SELECT qms.route_due()'));

  // 3. Bring the agents online and tick again: everything gets assigned.
  await pool.query('UPDATE qms.users SET online=true,last_seen=now() WHERE id=ANY($1::uuid[])', [agentIds]);
  await timed(`route_due with ${tickets} waiting and ${agents} agents online`, () => pool.query('SELECT qms.route_due()'));
  const assigned = (
    await pool.query("SELECT count(*)::int n FROM qms.tickets WHERE id=ANY($1::uuid[]) AND assigned_to IS NOT NULL", [ids.tickets])
  ).rows[0].n;
  console.log(`  assigned after tick: ${assigned} of ${tickets}`);

  // 4. Every agent works their tickets concurrently: call, start, close, with
  //    heartbeats from every agent at the same time (the lock is shared).
  const actionLatency = [];
  const byAgent = new Map(agentIds.map((id) => [id, []]));
  for (const row of (await pool.query('SELECT id,assigned_to FROM qms.tickets WHERE id=ANY($1::uuid[]) AND assigned_to IS NOT NULL', [ids.tickets])).rows)
    byAgent.get(row.assigned_to)?.push(row.id);
  const heartbeats = setInterval(() => {
    for (const id of agentIds) pool.query('SELECT qms.set_presence($1,true)', [id]).catch(() => {});
  }, 1000);
  await timed(`call+start+close every assigned ticket with ${agents} agents working in parallel (plus heartbeats)`, () =>
    Promise.all(
      [...byAgent].map(async ([agent, list]) => {
        for (const ticket of list) {
          for (const action of ['call', 'start', 'close']) {
            const start = process.hrtime.bigint();
            const version = (await pool.query('SELECT version FROM qms.tickets WHERE id=$1', [ticket])).rows[0].version;
            await pool.query('SELECT qms.ticket_action($1,$2,$3,$4,$5,$6)', [ticket, action, agent, version, null, null]);
            actionLatency.push(ms(start));
          }
        }
      }),
    ),
  );
  clearInterval(heartbeats);
  console.log(`  ${actionLatency.length} actions, p50 ${percentile(actionLatency, 0.5).toFixed(0)} ms, p95 ${percentile(actionLatency, 0.95).toFixed(0)} ms, max ${Math.max(...actionLatency).toFixed(0)} ms`);
  const closed = (await pool.query("SELECT count(*)::int n FROM qms.tickets WHERE id=ANY($1::uuid[]) AND status='closed'", [ids.tickets])).rows[0].n;
  console.log(`  closed: ${closed} of ${assigned}`);
} finally {
  // Remove everything the run created.
  await pool.query('DELETE FROM qms.notifications WHERE ticket_id=ANY($1::uuid[]) OR user_id=ANY($2::uuid[])', [ids.tickets, ids.users]);
  await pool.query('DELETE FROM qms.outbox WHERE ticket_id=ANY($1::uuid[])', [ids.tickets]);
  await pool.query('DELETE FROM qms.events WHERE ticket_id=ANY($1::uuid[]) OR actor_id=ANY($2::uuid[])', [ids.tickets, ids.users]);
  await pool.query('DELETE FROM qms.tickets WHERE id=ANY($1::uuid[])', [ids.tickets]);
  // The tick may have handed pre-existing waiting tickets to the temporary agents.
  await pool.query(
    "UPDATE qms.tickets SET assigned_to=NULL,assigned_at=NULL,routing_reason='awaiting_agent' WHERE assigned_to=ANY($1::uuid[])",
    [ids.users],
  );
  await pool.query('DELETE FROM qms.lookups WHERE id=ANY($1::uuid[])', [ids.lookups]);
  await pool.query('DELETE FROM qms.round_robin WHERE user_id=ANY($1::uuid[])', [ids.users]);
  await pool.query('DELETE FROM qms.rate_limits WHERE key LIKE $1', ['%' + tag + '%']);
  await pool.query('DELETE FROM qms.users WHERE id=ANY($1::uuid[])', [ids.users]);
  await pool.end();
  console.log('Fixture removed.');
}
