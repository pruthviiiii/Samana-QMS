import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { query } from '../lib/db';
const sf = vi.hoisted(() => vi.fn());
vi.mock('../lib/salesforce', () => ({ sfRequest: sf }));
import { processJobs, salesforcePayload } from '../lib/jobs';
let userId = '',
  lookupId = '',
  ticketId = '';
let testDatabaseVerified = false;
let fixtureRequests = 0;
beforeAll(async () => {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !== '/samana_qms_test'
  )
    throw new Error('Outbox tests require isolated test database.');
  const [database] = await query<{ name: string }>(
    'SELECT current_database() name',
  );
  if (database.name !== 'samana_qms_test')
    throw new Error('Outbox tests require isolated test database.');
  testDatabaseVerified = true;
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
beforeEach(() => {
  vi.stubEnv('SALESFORCE_WRITE_ENABLED', 'false');
  vi.stubEnv('SMS_ENABLED', 'false');
  fixtureRequests = 0;
  sf.mockReset();
  sf.mockRejectedValue(
    new Error('No Salesforce delivery configured for this fixture.'),
  );
});

async function prepareSalesforceDelivery(response: Record<string, unknown>) {
  vi.stubEnv('SALESFORCE_WRITE_ENABLED', 'true');
  sf.mockImplementation(async (path: string, options?: RequestInit) => {
    if (typeof options?.body !== 'string')
      throw new Error('Salesforce fixture expects a serialized JSON payload.');
    const payload = JSON.parse(options.body);
    if (
      path !== '/services/apexrest/api/QMSTicketAPI' ||
      options?.method !== 'POST' ||
      payload.qmsTicketNumber !== 'SAMANA-' + ticketId
    )
      throw new Error('Salesforce delivery is outside this test fixture.');
    fixtureRequests++;
    return response;
  });
  // processJobs claims ten jobs globally. Keep this fixture ahead of any old
  // synthetic backlog; unrelated jobs receive no successful provider response.
  const jobs = await query<{ id: string }>(
    `UPDATE qms.outbox SET status='pending',attempts=0,locked_at=NULL,
      lease_token=NULL,provider_reference=NULL,last_error=NULL,
      available_at=LEAST(TIMESTAMPTZ '1900-01-01 00:00:00+00',
        COALESCE((SELECT min(available_at)-interval '1 second'
          FROM qms.outbox WHERE ticket_id<>$1),now()))
      WHERE ticket_id=$1 AND kind='salesforce' RETURNING id`,
    [ticketId],
  );
  expect(jobs).toHaveLength(1);
}

afterAll(async () => {
  try {
    if (!testDatabaseVerified) return;
    if (ticketId) {
      for (const table of ['notifications', 'events', 'outbox'])
        await query(`DELETE FROM qms.${table} WHERE ticket_id=$1`, [ticketId]);
      await query('DELETE FROM qms.tickets WHERE id=$1', [ticketId]);
    }
    if (lookupId)
      await query('DELETE FROM qms.lookups WHERE id=$1', [lookupId]);
    if (userId) await query('DELETE FROM qms.users WHERE id=$1', [userId]);
  } finally {
    vi.unstubAllEnvs();
  }
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
  it('preserves durations returned by the PostgreSQL Date parser', () => {
    const payload = salesforcePayload(
      {
        created_at: new Date('2026-09-20T08:00:00Z'),
        called_at: new Date('2026-09-20T08:02:00Z'),
        started_at: new Date('2026-09-20T08:03:00Z'),
        closed_at: new Date('2026-09-20T08:07:00Z'),
      },
      [],
    );
    expect(payload.waitingSeconds).toBe(120);
    expect(payload.serviceSeconds).toBe(240);
    expect(
      salesforcePayload({ created_at: 'invalid', closed_at: new Date() }, [])
        .waitingSeconds,
    ).toBeNull();
  });
  it('does not mark an ambiguous Salesforce response as delivered', async () => {
    await prepareSalesforceDelivery({ isSuccess: true, statusCode: 200 });
    const result = await processJobs();
    const [job] = await query<{
      status: string;
      provider_reference: string | null;
      attempts: number;
      lease_token: string | null;
      last_error: string | null;
    }>(
      "SELECT status,provider_reference,attempts,lease_token,last_error FROM qms.outbox WHERE ticket_id=$1 AND kind='salesforce'",
      [ticketId],
    );
    expect(fixtureRequests).toBe(1);
    expect(result.sent).toBe(0);
    expect(job.status).toBe('pending');
    expect(job.provider_reference).toBeFalsy();
    expect(job.attempts).toBe(1);
    expect(job.lease_token).toBeNull();
    expect(job.last_error).toBe(
      'Salesforce did not confirm a saved record. Check the integration contract.',
    );
  });
  it('stores the confirmed Salesforce record ID', async () => {
    await prepareSalesforceDelivery({
      isSuccess: true,
      statusCode: 200,
      recordId: 'a01000000000001AAA',
    });
    const result = await processJobs();
    const [job] = await query<{
      status: string;
      provider_reference: string;
      attempts: number;
      lease_token: string | null;
      last_error: string | null;
    }>(
      "SELECT status,provider_reference,attempts,lease_token,last_error FROM qms.outbox WHERE ticket_id=$1 AND kind='salesforce'",
      [ticketId],
    );
    expect(fixtureRequests).toBe(1);
    expect(result.sent).toBe(1);
    expect(job.status).toBe('sent');
    expect(job.provider_reference).toBe('a01000000000001AAA');
    expect(job.attempts).toBe(1);
    expect(job.lease_token).toBeNull();
    expect(job.last_error).toBeNull();
  });
});
