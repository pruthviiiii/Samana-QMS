import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { query } from '../lib/db';
import { hashPassword } from '../lib/security';
import type { Customer } from '../lib/domain';
const lookup = vi.hoisted(() => vi.fn());
vi.mock('../lib/salesforce', async (original) => ({
  ...(await original<typeof import('../lib/salesforce')>()),
  lookupCustomer: lookup,
}));
import { GET, POST } from '../app/api/[...path]/route';
const prefix = 'api-test-' + crypto.randomUUID().slice(0, 8);
const password = 'Synthetic-API-Test-Password-24';
let adminCookie = '';
let agentCookie = '';
let adminId = '';
let agentId = '';
let activeTicket = '';
let guestCookie = '';
function request(
  path: string,
  method = 'GET',
  data?: unknown,
  cookie = '',
  origin = 'http://qms.test',
) {
  return new Request('http://qms.test/api/' + path, {
    method,
    headers: {
      ...(method !== 'GET'
        ? { 'Content-Type': 'application/json', Origin: origin }
        : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(method !== 'GET' && data !== undefined
      ? { body: JSON.stringify(data) }
      : {}),
  });
}
async function send(
  path: string,
  method = 'GET',
  data?: unknown,
  cookie = adminCookie,
) {
  const response = await (method === 'GET' ? GET : POST)(
    request(path, method, data, cookie),
  );
  const result = (await response.json()) as Record<string, unknown>;
  return { response, result };
}
function cookie(response: Response) {
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}
const guest: Customer = {
  registered: false,
  salesforceId: null,
  name: 'Walk-in customer',
  firstName: '',
  middleName: '',
  lastName: '',
  mobile: null,
  emiratesId: null,
  passportNumber: null,
  units: [],
};
beforeAll(async () => {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !== '/samana_qms_test'
  )
    throw new Error('API tests require isolated samana_qms_test database.');
  const hash = await hashPassword(password);
  for (const [role, label] of [
    ['admin', 'Administrator'],
    ['agent', 'Executive'],
  ]) {
    const [user] = await query<{ id: string }>(
      "INSERT INTO qms.users(username,name,role,password_hash,must_change_password,services,online,last_seen,counter) VALUES($1,$2,$3,$4,false,ARRAY['general','crm-general','collection'],true,now(),'TEST-1') RETURNING id",
      [prefix + '-' + role, label, role, hash],
    );
    if (role === 'admin') adminId = user.id;
    else agentId = user.id;
  }
  const admin = await send(
    'auth/login',
    'POST',
    { username: prefix + '-admin', password },
    '',
  );
  expect(admin.response.status).toBe(200);
  adminCookie = cookie(admin.response);
  const agent = await send(
    'auth/login',
    'POST',
    { username: prefix + '-agent', password },
    '',
  );
  expect(agent.response.status).toBe(200);
  agentCookie = cookie(agent.response);
});
afterAll(async () => {
  await query(
    'UPDATE qms.users SET online=false,enabled=false WHERE username LIKE $1',
    [prefix + '%'],
  );
  await query('DELETE FROM qms.sessions WHERE user_id IN ($1,$2)', [
    adminId,
    agentId,
  ]);
});
describe('Authenticated API workflows', { concurrent: false }, () => {
  it('requires authentication for the queue', async () =>
    expect((await send('queue', 'GET', undefined, '')).response.status).toBe(
      401,
    ));
  it('rejects cross-origin state changes', async () =>
    expect(
      (
        await POST(
          request(
            'presence',
            'POST',
            { online: true },
            adminCookie,
            'https://evil.example',
          ),
        )
      ).status,
    ).toBe(403));
  it('rejects invalid JSON', async () => {
    const r = await POST(
      new Request('http://qms.test/api/presence', {
        method: 'POST',
        headers: {
          Origin: 'http://qms.test',
          'Content-Type': 'application/json',
          Cookie: adminCookie,
        },
        body: '{',
      }),
    );
    expect(r.status).toBe(400);
  });
  it('rejects oversized request bodies', async () => {
    const r = await POST(
      request('presence', 'POST', { padding: 'x'.repeat(33000) }, adminCookie),
    );
    expect(r.status).toBe(413);
  });
  it('forbids agent access to reports and staff administration', async () => {
    expect(
      (await send('reports', 'GET', undefined, agentCookie)).response.status,
    ).toBe(403);
    expect((await send('team', 'POST', {}, agentCookie)).response.status).toBe(
      403,
    );
  });
  it('validates identifiers before contacting Salesforce', async () => {
    lookup.mockClear();
    expect(
      (
        await send('customers/lookup', 'POST', {
          type: 'emiratesId',
          value: '784bad',
        })
      ).response.status,
    ).toBe(400);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('keeps provider errors distinct from no match', async () => {
    lookup.mockRejectedValueOnce(new Error('Provider unreachable'));
    const result = await send('customers/lookup', 'POST', {
      type: 'mobile',
      value: '971500000001',
    });
    expect(result.response.status).toBe(503);
    expect(result.result).not.toHaveProperty('lookupId');
  });
  it('issues and persists a guest ticket exactly once', async () => {
    lookup.mockResolvedValueOnce(guest);
    const found = await send('customers/lookup', 'POST', {
      type: 'mobile',
      value: '9715' + Date.now().toString().slice(-8),
    });
    expect(found.response.status).toBe(200);
    const payload = {
      lookupId: found.result.lookupId,
      serviceId: 'general',
      unitId: null,
      requestId: crypto.randomUUID(),
    };
    const [a, b] = await Promise.all([
      send('tickets', 'POST', payload),
      send('tickets', 'POST', payload),
    ]);
    expect(a.response.status).toBe(201);
    expect(a.result.id).toBe(b.result.id);
    activeTicket = String(a.result.id);
    expect(
      await query('SELECT id FROM qms.tickets WHERE id=$1', [activeTicket]),
    ).toHaveLength(1);
    expect(
      await query(
        "SELECT id FROM qms.outbox WHERE ticket_id=$1 AND kind='sms'",
        [activeTicket],
      ),
    ).toHaveLength(0);
  });
  it('rejects stale versions and serializes simultaneous calls', async () => {
    await query("SELECT qms.assign_ticket($1,$2,'test_assignment')", [
      activeTicket,
      agentId,
    ]);
    const [ticket] = await query<{ version: number }>(
      'SELECT version FROM qms.tickets WHERE id=$1',
      [activeTicket],
    );
    const [a, b] = await Promise.all([
      send(
        'tickets/' + activeTicket + '/action',
        'POST',
        { action: 'call', version: ticket.version },
        agentCookie,
      ),
      send(
        'tickets/' + activeTicket + '/action',
        'POST',
        { action: 'call', version: ticket.version },
        agentCookie,
      ),
    ]);
    expect(
      [a.response.status, b.response.status].sort((a, b) => a - b),
    ).toEqual([200, 409]);
  });
  it('prevents an agent going offline during a called ticket', async () =>
    expect(
      (await send('presence', 'POST', { online: false }, agentCookie)).response
        .status,
    ).toBe(409));
  it('blocks logout during an active call without deleting the session', async () => {
    expect(
      (await send('auth/logout', 'POST', {}, agentCookie)).response.status,
    ).toBe(409);
    expect(
      (await send('auth/me', 'GET', undefined, agentCookie)).response.status,
    ).toBe(200);
  });
  it('starts and completes service with notes and audit history', async () => {
    let [t] = await query<{ version: number }>(
      'SELECT version FROM qms.tickets WHERE id=$1',
      [activeTicket],
    );
    const started = await send(
      'tickets/' + activeTicket + '/action',
      'POST',
      { action: 'start', version: t.version },
      agentCookie,
    );
    expect(started.response.status).toBe(200);
    [t] = await query<{ version: number }>(
      'SELECT version FROM qms.tickets WHERE id=$1',
      [activeTicket],
    );
    const closed = await send(
      'tickets/' + activeTicket + '/action',
      'POST',
      {
        action: 'close',
        version: t.version,
        comment: 'Synthetic test completed',
      },
      agentCookie,
    );
    expect(closed.result.status).toBe('closed');
    const detail = await send('tickets/' + activeTicket);
    expect((detail.result.events as unknown[]).length).toBeGreaterThanOrEqual(
      4,
    );
  });
  it('provides a minimal printable receipt', async () => {
    const response = await send('tickets/' + activeTicket + '/print');
    const t = response.result.ticket as Record<string, unknown>;
    expect(t.number).toBeTruthy();
    expect(t).not.toHaveProperty('mobile');
    expect(t).not.toHaveProperty('comments');
    expect(response.result).not.toHaveProperty('events');
  });
  it('creates customer sessions only from a valid short-lived QR', async () => {
    const invalid = await send('public/session', 'POST', { invite: 'bad' }, '');
    expect(invalid.response.status).toBe(403);
    const link = await send('checkin-link');
    const invite = new URL(String(link.result.url)).searchParams.get('invite');
    const valid = await send('public/session', 'POST', { invite }, '');
    expect(valid.response.status).toBe(200);
    guestCookie = cookie(valid.response);
  });
  it('protects staff data from customer sessions', async () => {
    for (const endpoint of [
      'queue',
      'team',
      'reports',
      'audit',
      'integrations',
      'display',
    ])
      expect(
        (await send(endpoint, 'GET', undefined, guestCookie)).response.status,
      ).toBe(403);
  });
  it('minimizes customer lookup and issued ticket payloads', async () => {
    const synthetic: Customer = {
      ...guest,
      registered: true,
      salesforceId:
        '001' + crypto.randomUUID().replaceAll('-', '').slice(0, 15),
      name: 'Private Synthetic Customer',
      firstName: 'Private',
      lastName: 'Customer',
      mobile: '9715' + Date.now().toString().slice(-8),
      passportNumber: 'SECRET777',
      units: [
        {
          id: 'a01000000000005AAA',
          name: 'TEST-101',
          project: 'Synthetic Project',
          bookingNumber: 'SB-SECRET',
          ownerId: null,
          ownerName: 'Private Executive',
          managerId: null,
          managerName: 'Private Manager',
        },
      ],
    };
    lookup.mockResolvedValueOnce(synthetic);
    const found = await send(
      'customers/lookup',
      'POST',
      { type: 'mobile', value: synthetic.mobile },
      guestCookie,
    );
    const c = found.result.customer as Customer;
    expect(c.mobile).toBeNull();
    expect(c.passportNumber).toBeNull();
    expect(c.units[0].ownerName).toBeNull();
    expect(c.units[0].bookingNumber).toBe('');
    const issue = await send(
      'tickets',
      'POST',
      {
        lookupId: found.result.lookupId,
        serviceId: 'crm-general',
        unitId: synthetic.units[0].id,
        requestId: crypto.randomUUID(),
      },
      guestCookie,
    );
    expect(issue.response.status).toBe(201);
    expect(issue.result).not.toHaveProperty('customer_id');
    expect(issue.result).not.toHaveProperty('mobile');
    expect(issue.result.public_token).toBeTruthy();
    const status = await send(
      'public/status/' + issue.result.public_token,
      'GET',
      undefined,
      '',
    );
    expect(status.response.status).toBe(200);
    expect(status.result.number).toBe(issue.result.number);
    expect(status.result).not.toHaveProperty('customer_name');
  });
  it('disallows customer password creation', async () =>
    expect(
      (
        await send(
          'auth/password',
          'POST',
          { currentPassword: 'anything', newPassword: password },
          guestCookie,
        )
      ).response.status,
    ).toBe(403));
  it('returns aggregate reports', async () => {
    const report = await send('reports');
    expect(report.response.status).toBe(200);
    expect(report.result).toHaveProperty('summary');
    expect(report.result).toHaveProperty('byService');
  });
  it('guards scheduler with a separate credential', async () =>
    expect((await send('jobs/run', 'POST', {}, '')).response.status).toBe(401));
});
