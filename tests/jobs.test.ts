import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { query } from '../lib/db';
const sf = vi.hoisted(() => vi.fn());
vi.mock('../lib/salesforce', () => ({ sfRequest: sf }));
import { processJobs, salesforcePayload } from '../lib/jobs';
let userId = '',
  lookupId = '',
  ticketId = '';
beforeAll(async () => {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !== '/samana_qms_test'
  )
    throw new Error('Outbox tests require isolated test database.');
  const suffix = crypto.randomUUID();
  const [u] = await query<{ id: string }>(
    "INSERT INTO qms.users(username,name,role) VALUES($1,'Outbox fixture','admin') RETURNING id",
    ['outbox-' + suffix],
  );
  userId = u.id;
  const [l] = await query<{ id: string }>(
    "INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES($1,'mobile',$2,$3::jsonb) RETURNING id",
    [
      userId,
      suffix,
      JSON.stringify({
        registered: false,
        name: 'Synthetic Outbox Visitor',
        units: [],
      }),
    ],
  );
  lookupId = l.id;
  const [t] = await query<{ ticket: { id: string } }>(
    "SELECT qms.issue_ticket($1,'general',NULL,$2,$3) ticket",
    [lookupId, crypto.randomUUID(), userId],
  );
  ticketId = t.ticket.id;
});
afterAll(async () => {
  for (const table of ['notifications', 'events', 'outbox'])
    await query(`DELETE FROM qms.${table} WHERE ticket_id=$1`, [ticketId]);
  await query('DELETE FROM qms.tickets WHERE id=$1', [ticketId]);
  await query('DELETE FROM qms.lookups WHERE id=$1', [lookupId]);
  await query('DELETE FROM qms.users WHERE id=$1', [userId]);
  vi.unstubAllEnvs();
});
describe('External delivery safeguards', { concurrent: false }, () => {
  it('never claims Salesforce or SMS work while those integrations are disabled', async () => {
    vi.stubEnv('SALESFORCE_WRITE_ENABLED', 'false');
    vi.stubEnv('SMS_ENABLED', 'false');
    await query(
      "UPDATE qms.outbox SET status='processing',attempts=1,locked_at=now()-interval '6 minutes' WHERE ticket_id=$1",
      [ticketId],
    );
    const result = await processJobs();
    expect(result.processed).toBe(0);
    expect(sf).not.toHaveBeenCalled();
  });
  it('surfaces an abandoned final attempt for operator review', async () => {
    await query(
      "UPDATE qms.outbox SET status='processing',attempts=5,locked_at=now()-interval '6 minutes' WHERE ticket_id=$1",
      [ticketId],
    );
    await processJobs();
    const [job] = await query<{ status: string }>(
      'SELECT status FROM qms.outbox WHERE ticket_id=$1',
      [ticketId],
    );
    expect(job.status).toBe('failed');
    expect(sf).not.toHaveBeenCalled();
  });
  it('sends complete stable ticket snapshots with Salesforce email resolution', () => {
    const payload = salesforcePayload(
      {
        id: 'unique-id',
        number: 'C-001',
        identifier_type: 'mobile',
        customer_id: '001sample',
        customer_name: 'Synthetic',
        customer_email: 'synthetic@example.test',
        service_id: 'crm-noc',
        agent_sf_id: '005sample',
        agent_email: 'staff@example.test',
        created_at: '2026-09-19T08:00:00Z',
        called_at: '2026-09-19T08:02:00Z',
        started_at: '2026-09-19T08:03:00Z',
        closed_at: '2026-09-19T08:05:00Z',
        status: 'closed',
      },
      [{ body: 'Completed' }],
    );
    expect(payload.qmsTicketNumber).toBe('SAMANA-unique-id');
    expect(payload.handledByEmail).toBe('staff@example.test');
    expect(payload.customerEmail).toBe('synthetic@example.test');
    expect(payload.reasonLabel).toBe('NOC/Resale');
    expect(payload.waitingSeconds).toBe(120);
    expect(payload.serviceSeconds).toBe(120);
    expect(payload.outcome).toBe('Completed');
    expect(payload.comments).toHaveLength(1);
  });
});
