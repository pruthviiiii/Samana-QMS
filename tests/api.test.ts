import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { query } from '../lib/db';
import { hashPassword, sha256 } from '../lib/security';
import type { Customer } from '../lib/domain';
const lookup = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => vi.fn());
vi.mock('../lib/salesforce', async (original) => ({
  ...(await original<typeof import('../lib/salesforce')>()),
  lookupCustomer: lookup,
  searchUsers: search,
}));
import { GET, POST, PUT, PATCH, DELETE } from '../app/api/[...path]/route';
const handlers: Record<string, typeof GET> = { GET, POST, PUT, PATCH, DELETE };
const prefix = 'api-test-' + crypto.randomUUID().slice(0, 8);
const password = 'Synthetic-API-Test-Password-24';
let adminCookie = '';
let agentCookie = '';
let adminId = '';
let agentId = '';
let activeTicket = '';
let guestCookie = '';
const loginFixtures: { id: string; username: string; email: string }[] = [];
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
  const response = await handlers[method](request(path, method, data, cookie));
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
  for (const [suffix, email] of [
    ['aliases', prefix + '-aliases@example.test'],
    ['long-email', `${prefix}@${'a'.repeat(63)}.${'b'.repeat(63)}.test`],
    ['Ambiguous@example.test', prefix + '-ambiguous-one@example.test'],
    ['aMBIGUOUS@example.test', prefix + '-ambiguous-two@example.test'],
    ['email-target', prefix + '-ambiguous@example.test'],
  ]) {
    const username = prefix + '-' + suffix;
    const [user] = await query<{ id: string }>(
      "INSERT INTO qms.users(username,email,name,role,password_hash,must_change_password) VALUES($1,$2,'Login fixture','agent',$3,false) RETURNING id",
      [username, email, hash],
    );
    loginFixtures.push({ id: user.id, username, email });
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
  for (const fixture of loginFixtures) {
    await query('DELETE FROM qms.sessions WHERE user_id=$1', [fixture.id]);
    // Sign-in attempts are audited; synthetic fixtures take their rows with them.
    await query('DELETE FROM qms.events WHERE actor_id=$1', [fixture.id]);
    await query('DELETE FROM qms.users WHERE id=$1', [fixture.id]);
    await query('DELETE FROM qms.rate_limits WHERE key=ANY($1::text[])', [
      [
        'login-account:' + fixture.id,
        'login:' + (await sha256(fixture.username)),
        'login:' + (await sha256(fixture.email)),
      ],
    ]);
  }
});
describe('Authenticated API workflows', { concurrent: false }, () => {
  it('rejects ambiguous case-insensitive usernames without email fallback', async () => {
    const identifier = loginFixtures[2].username.toLowerCase();
    expect(loginFixtures[3].username.toLowerCase()).toBe(identifier);
    expect(loginFixtures[4].email).toBe(identifier);
    const login = await send(
      'auth/login',
      'POST',
      {
        username: identifier,
        password,
      },
      '',
    );
    expect(login.response.status).toBe(401);
    expect(login.response.headers.get('set-cookie')).toBeNull();
    expect(
      await query(
        'SELECT token_hash FROM qms.sessions WHERE user_id=ANY($1::uuid[])',
        [loginFixtures.slice(2).map((fixture) => fixture.id)],
      ),
    ).toHaveLength(0);
  });
  it('shares the account login limit between username and email', async () => {
    const fixture = loginFixtures[0];
    for (let attempt = 0; attempt < 8; attempt++) {
      const login = await send(
        'auth/login',
        'POST',
        {
          username: attempt % 2 === 0 ? fixture.username : fixture.email,
          password: 'Incorrect-synthetic-password',
        },
        '',
      );
      expect(login.response.status).toBe(401);
    }
    for (const identifier of [fixture.username, fixture.email]) {
      const login = await send(
        'auth/login',
        'POST',
        {
          username: identifier,
          password,
        },
        '',
      );
      expect(login.response.status).toBe(429);
      expect(login.response.headers.get('set-cookie')).toBeNull();
    }
    expect(
      await query('SELECT token_hash FROM qms.sessions WHERE user_id=$1', [
        fixture.id,
      ]),
    ).toHaveLength(0);
  });
  it('accepts a valid email login identifier longer than 120 characters', async () => {
    const fixture = loginFixtures[1];
    expect(fixture.email.length).toBeGreaterThan(120);
    expect(fixture.email.length).toBeLessThanOrEqual(254);
    const login = await send(
      'auth/login',
      'POST',
      {
        username: fixture.email,
        password,
      },
      '',
    );
    expect(login.response.status).toBe(200);
    expect((login.result.user as { id: string }).id).toBe(fixture.id);
    expect(cookie(login.response)).not.toBe('');
  });
  it('requires authentication for the queue', async () =>
    expect((await send('queue', 'GET', undefined, '')).response.status).toBe(
      401,
    ));
  it('rejects cross-origin state changes', async () =>
    expect(
      (
        await PUT(
          request(
            'presence',
            'PUT',
            { online: true },
            adminCookie,
            'https://evil.example',
          ),
        )
      ).status,
    ).toBe(403));
  it('rejects invalid JSON', async () => {
    const r = await PUT(
      new Request('http://qms.test/api/presence', {
        method: 'PUT',
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
    const r = await PUT(
      request('presence', 'PUT', { padding: 'x'.repeat(33000) }, adminCookie),
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
  it('stops exposing notifications to an agent after reassignment', async () => {
    await query("SELECT qms.assign_ticket($1,$2,'test_assignment')", [
      activeTicket,
      agentId,
    ]);
    const before = await send('queue', 'GET', undefined, agentCookie);
    expect(
      (before.result.notifications as { ticket_id: string }[]).some(
        (n) => n.ticket_id === activeTicket,
      ),
    ).toBe(true);
    await query("SELECT qms.assign_ticket($1,$2,'manager_reassignment')", [
      activeTicket,
      adminId,
    ]);
    const after = await send('queue', 'GET', undefined, agentCookie);
    expect(
      (after.result.notifications as { ticket_id: string }[]).some(
        (n) => n.ticket_id === activeTicket,
      ),
    ).toBe(false);
    expect(
      (await send('tickets/' + activeTicket, 'GET', undefined, agentCookie))
        .response.status,
    ).toBe(404);
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
      (await send('presence', 'PUT', { online: false }, agentCookie)).response
        .status,
    ).toBe(409));
  it('revokes logout sessions even while a called ticket stays assigned', async () => {
    expect(
      (await send('auth/logout', 'POST', {}, agentCookie)).response.status,
    ).toBe(200);
    expect(
      (await send('auth/me', 'GET', undefined, agentCookie)).response.status,
    ).toBe(401);
    const [ticket] = await query<{ assigned_to: string; status: string }>(
      'SELECT assigned_to,status FROM qms.tickets WHERE id=$1',
      [activeTicket],
    );
    expect(ticket.assigned_to).toBe(agentId);
    expect(ticket.status).toBe('called');
    const login = await send(
      'auth/login',
      'POST',
      { username: prefix + '-agent', password },
      '',
    );
    expect(login.response.status).toBe(200);
    agentCookie = cookie(login.response);
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
          'PUT',
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

describe('On-demand Salesforce user search', () => {
  const found = {
    id: '005000000000001AAA',
    name: 'Synthetic Agent',
    username: 'synthetic.agent@example.test',
    email: 'synthetic.agent@example.test',
    managerId: '005000000000002AAA',
    managerName: 'Synthetic Manager',
  };
  it('returns matches to an administrator only when a query is given', async () => {
    search.mockResolvedValueOnce([found]);
    const ok = await send('integrations/salesforce/users?q=synthetic');
    expect(ok.response.status).toBe(200);
    expect(ok.result.users).toEqual([found]);
    expect(search).toHaveBeenCalledWith('synthetic');
  });
  it('rejects short queries before contacting Salesforce', async () => {
    search.mockClear();
    const short = await send('integrations/salesforce/users?q=ab');
    expect(short.response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });
  it('is not available to agents', async () => {
    const denied = await send('integrations/salesforce/users?q=synthetic', 'GET', undefined, agentCookie);
    expect(denied.response.status).toBe(403);
  });
  it('no longer exposes bulk import or group sync', async () => {
    expect((await send('integrations/salesforce/sync', 'POST', {})).response.status).toBe(404);
    expect((await send('integrations/salesforce/groups')).response.status).toBe(404);
  });
});

describe('App-managed queues', () => {
  it('lets an administrator add and remove members; nothing goes to Salesforce', async () => {
    search.mockClear();
    lookup.mockClear();
    const added = await send('queues/crm-noc/members/' + agentId, 'PUT');
    expect(added.response.status).toBe(200);
    expect(added.result.services as string[]).toContain('crm-noc');
    const list = await send('queues');
    expect(list.response.status).toBe(200);
    const members = list.result.members as { id: string; service_id: string }[];
    expect(members.some((m) => m.id === agentId && m.service_id === 'crm-noc')).toBe(true);
    const removed = await send('queues/crm-noc/members/' + agentId, 'DELETE');
    expect(removed.response.status).toBe(200);
    expect(removed.result.services as string[]).not.toContain('crm-noc');
    expect(search).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });
  it('is closed to agents', async () => {
    expect((await send('queues', 'GET', undefined, agentCookie)).response.status).toBe(403);
    expect(
      (
        await send(
          'queues/crm-noc/members/' + agentId,
          'PUT',
          undefined,
          agentCookie,
        )
      ).response.status,
    ).toBe(403);
  });
});

describe('Audit trail, walk-ins and error messages', () => {
  it('records failed sign-ins, sign-ins and sign-outs', async () => {
    const failed = await send(
      'auth/login',
      'POST',
      { username: prefix + '-agent', password: 'Wrong-synthetic-password-1' },
      '',
    );
    expect(failed.response.status).toBe(401);
    const login = await send(
      'auth/login',
      'POST',
      { username: prefix + '-agent', password },
      '',
    );
    expect(login.response.status).toBe(200);
    expect(
      (await send('auth/logout', 'POST', {}, cookie(login.response))).response
        .status,
    ).toBe(200);
    const actions = (
      await query<{ action: string }>(
        "SELECT action FROM qms.events WHERE actor_id=$1 AND action IN ('login','login_failed','logout') ORDER BY id",
        [agentId],
      )
    ).map((e) => e.action);
    expect(actions.slice(-3)).toEqual(['login_failed', 'login', 'logout']);
  });
  it('lets staff register a walk-in without Salesforce; guests cannot', async () => {
    lookup.mockClear();
    const walk = await send('customers/lookup', 'POST', {
      type: 'mobile',
      value: '9715' + Date.now().toString().slice(-8),
      walkIn: true,
    });
    expect(walk.response.status).toBe(200);
    expect((walk.result.customer as Customer).registered).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
    const issue = await send('tickets', 'POST', {
      lookupId: walk.result.lookupId,
      serviceId: 'general',
      unitId: null,
      requestId: crypto.randomUUID(),
    });
    expect(issue.response.status).toBe(201);
    const [event] = await query<{ details: { degraded?: boolean } }>(
      "SELECT details FROM qms.events WHERE actor_id=$1 AND action='customer_lookup' ORDER BY id DESC LIMIT 1",
      [adminId],
    );
    expect(event.details.degraded).toBe(true);
    const denied = await send(
      'customers/lookup',
      'POST',
      { type: 'mobile', value: '971500000009', walkIn: true },
      guestCookie,
    );
    expect(denied.response.status).toBe(403);
  });
  it('explains a version conflict in plain words and keeps the code', async () => {
    const [t] = await query<{ id: string; version: number }>(
      "SELECT id,version FROM qms.tickets WHERE created_by=$1 AND status='waiting' ORDER BY created_at DESC LIMIT 1",
      [adminId],
    );
    const stale = await send('tickets/' + t.id + '/action', 'POST', {
      action: 'call',
      version: t.version + 5,
    });
    expect(stale.response.status).toBe(409);
    expect(stale.result.code).toBe('VERSION_CONFLICT');
    expect(String(stale.result.error)).toMatch(/updated by someone else/);
    expect(stale.response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('pages the audit trail with a cursor and filters by action', async () => {
    const first = await send('audit?limit=2');
    expect(first.response.status).toBe(200);
    const events = first.result.events as { id: string; action: string }[];
    expect(events).toHaveLength(2);
    expect(first.result.nextBefore).toBe(events[1].id);
    const next = await send('audit?limit=2&before=' + first.result.nextBefore);
    const older = next.result.events as { id: string }[];
    expect(older.length).toBeGreaterThan(0);
    expect(older.every((e) => Number(e.id) < Number(events[1].id))).toBe(true);
    const logins = await send('audit?action=login&limit=5');
    const rows = logins.result.events as { action: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.action === 'login')).toBe(true);
  });
  it('refuses notification changes from a guest session', async () =>
    expect(
      (await send('notifications', 'PATCH', { ids: [1] }, guestCookie))
        .response.status,
    ).toBe(403));
  it('rejects malformed paging instead of failing in the database', async () => {
    expect((await send('reports?page=Infinity')).response.status).toBe(400);
    expect((await send('queue?page=abc')).response.status).toBe(400);
    expect((await send('audit?limit=0')).response.status).toBe(400);
    expect((await send('queue?page=1')).response.status).toBe(200);
  });
  it('exposes one alert endpoint for uptime monitors', async () => {
    await query(
      "INSERT INTO qms.system_state(key,value) VALUES('worker','{}'::jsonb) ON CONFLICT(key) DO UPDATE SET updated_at=now()",
    );
    const [t] = await query<{ id: string }>(
      'SELECT id FROM qms.tickets WHERE created_by=$1 ORDER BY created_at DESC LIMIT 1',
      [adminId],
    );
    const [previous] = await query<{ status: string }>(
      "SELECT status FROM qms.outbox WHERE ticket_id=$1 AND kind='sms'",
      [t.id],
    );
    const [{ others }] = await query<{ others: number }>(
      "SELECT count(*)::int others FROM qms.outbox WHERE status='failed' AND NOT (ticket_id=$1 AND kind='sms')",
      [t.id],
    );
    await query(
      "INSERT INTO qms.outbox(ticket_id,kind,status,attempts) VALUES($1,'sms','failed',5) ON CONFLICT(ticket_id,kind) DO UPDATE SET status='failed'",
      [t.id],
    );
    const alert = await handlers.GET(request('health/alerts'));
    expect(alert.status).toBe(503);
    const body = (await alert.json()) as { status: string; problems: string[] };
    expect(body.status).toBe('alert');
    expect(body.problems.some((p) => p.startsWith('outbox_failed:'))).toBe(true);
    expect(body.problems).not.toContain('scheduler_stale');
    if (previous)
      await query(
        "UPDATE qms.outbox SET status=$2 WHERE ticket_id=$1 AND kind='sms'",
        [t.id, previous.status],
      );
    else
      await query("DELETE FROM qms.outbox WHERE ticket_id=$1 AND kind='sms'", [
        t.id,
      ]);
    const after = await handlers.GET(request('health/alerts'));
    expect(after.status).toBe(others === 0 ? 200 : 503);
  });
});
