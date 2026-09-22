import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { query } from '../lib/db';
import { hashPassword, sha256 } from '../lib/security';
import { clientRateLimit, rateLimit } from '../lib/http';
import { resetConfigForTests } from '../lib/config';
// Settings are read once and cached, so a test that changes the environment
// asks for them to be read again.
const setEnv = (name: string, value: string) => {
  vi.stubEnv(name, value);
  resetConfigForTests();
};

let userId = '',
  originalHash = '',
  nextHash = '';
const scope = 'security-test-' + crypto.randomUUID();
beforeAll(async () => {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !== '/samana_qms_test'
  )
    throw new Error('Security tests require isolated test database.');
  originalHash = await hashPassword('Synthetic-old-password-2026');
  nextHash = await hashPassword('Synthetic-new-password-2026');
  const [user] = await query<{ id: string }>(
    "INSERT INTO qms.users(username,name,role,password_hash,must_change_password) VALUES($1,'Security fixture','admin',$2,false) RETURNING id",
    [scope, originalHash],
  );
  userId = user.id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  resetConfigForTests();
  await query('DELETE FROM qms.sessions WHERE user_id=$1', [userId]);
  await query('DELETE FROM qms.events WHERE actor_id=$1', [userId]);
  await query('DELETE FROM qms.users WHERE id=$1', [userId]);
  await query('DELETE FROM qms.rate_limits WHERE key LIKE $1', [scope + '%']);
});
describe('Atomic authentication', () => {
  it('revokes an old-password login regardless of concurrent request ordering', async () => {
    for (let i = 0; i < 5; i++) {
      await query('UPDATE qms.users SET password_hash=$1 WHERE id=$2', [
        originalHash,
        userId,
      ]);
      const oldToken = await sha256(crypto.randomUUID()),
        newToken = await sha256(crypto.randomUUID());
      const [, changed] = await Promise.all([
        query('SELECT qms.issue_session($1,$2,$3) issued', [
          userId,
          originalHash,
          oldToken,
        ]),
        query<{ changed: boolean }>(
          'SELECT qms.change_password($1,$2,$3,$4) changed',
          [userId, originalHash, nextHash, newToken],
        ),
      ]);
      expect(changed[0].changed).toBe(true);
      const sessions = await query<{ token_hash: string }>(
        'SELECT token_hash FROM qms.sessions WHERE user_id=$1',
        [userId],
      );
      expect(sessions.map((s) => s.token_hash)).toEqual([newToken]);
    }
  });
  it('rejects a stale password change and an old-password session', async () => {
    const token = await sha256(crypto.randomUUID());
    expect(
      (
        await query<{ changed: boolean }>(
          'SELECT qms.change_password($1,$2,$3,$4) changed',
          [userId, originalHash, originalHash, token],
        )
      )[0].changed,
    ).toBe(false);
    expect(
      (
        await query<{ issued: boolean }>(
          'SELECT qms.issue_session($1,$2,$3) issued',
          [userId, originalHash, token],
        )
      )[0].issued,
    ).toBe(false);
    expect(
      (
        await query<{ password_hash: string }>(
          'SELECT password_hash FROM qms.users WHERE id=$1',
          [userId],
        )
      )[0].password_hash,
    ).toBe(nextHash);
  });
  it('does not issue sessions for an account disabled during login', async () => {
    await query('UPDATE qms.users SET enabled=false WHERE id=$1', [userId]);
    expect(
      (
        await query<{ issued: boolean }>(
          'SELECT qms.issue_session($1,$2,$3) issued',
          [userId, nextHash, await sha256(crypto.randomUUID())],
        )
      )[0].issued,
    ).toBe(false);
  });
});
describe('Distributed abuse limits', () => {
  it('ignores caller-supplied client headers unless explicitly trusted', async () => {
    setEnv('TRUSTED_CLIENT_IP_HEADER', '');
    const request = new Request('https://qms.test', {
      headers: { 'x-forwarded-for': '192.0.2.11' },
    });
    await clientRateLimit(request, scope + ':untrusted', 0, 60);
    expect(
      await query('SELECT key FROM qms.rate_limits WHERE key LIKE $1', [
        scope + ':untrusted:%',
      ]),
    ).toHaveLength(0);
  });
  it('enforces a shared limiter independently of account identity', async () => {
    await rateLimit(scope + ':global', 2, 60);
    await rateLimit(scope + ':global', 2, 60);
    await expect(rateLimit(scope + ':global', 2, 60)).rejects.toMatchObject({
      status: 429,
    });
  });
  it('uses a configured client header without storing raw IP addresses', async () => {
    setEnv('TRUSTED_CLIENT_IP_HEADER', 'x-forwarded-for');
    const request = new Request('https://qms.test', {
      headers: { 'x-forwarded-for': '192.0.2.10, 192.0.2.1' },
    });
    await clientRateLimit(request, scope, 1, 60);
    await expect(clientRateLimit(request, scope, 1, 60)).rejects.toMatchObject({
      status: 429,
    });
    const rows = await query<{ key: string }>(
      'SELECT key FROM qms.rate_limits WHERE key LIKE $1',
      [scope + ':client:%'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).not.toContain('192.0.2.10');
    expect(rows[0].key).not.toContain('192.0.2.1');
  });
  it('keys the client budget on the address the proxy appended, not a forged prefix', async () => {
    setEnv('TRUSTED_CLIENT_IP_HEADER', 'x-forwarded-for');
    // Two requests claiming different origins in the client-controlled part
    // of the header still land in one bucket when the proxy saw the same address.
    await clientRateLimit(
      new Request('https://qms.test', {
        headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' },
      }),
      scope + ':spoof',
      1,
      60,
    );
    await expect(
      clientRateLimit(
        new Request('https://qms.test', {
          headers: { 'x-forwarded-for': '198.51.100.8, 203.0.113.9' },
        }),
        scope + ':spoof',
        1,
        60,
      ),
    ).rejects.toMatchObject({ status: 429 });
  });
});
