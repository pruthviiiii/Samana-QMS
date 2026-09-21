import { z } from 'zod';
import { query } from '../db';
import {
  HttpError,
  body,
  json,
  sessionCookie,
  rateLimit,
  clientRateLimit,
} from '../http';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  randomToken,
  sha256,
} from '../security';
import { SERVICES, type User } from '../domain';
import { define, publicRoute, sessionRoute } from '../router';
import { audit, dummyHash, passwordSchema, userColumns } from './shared';
export const authRoutes = [
  define('POST', 'auth/login', publicRoute, async ({ request }) => {
    const input = z
      .object({
        username: z.string().trim().min(1).max(254),
        password: z.string().min(1).max(128),
      })
      .parse(await body(request));
    const username = input.username.toLowerCase();
    // Bound expensive password work even if an attacker rotates usernames.
    await clientRateLimit(request, 'login', 20, 300);
    await rateLimit('login:global', 120, 60);
    await rateLimit('login:' + (await sha256(username)), 8, 300);
    const candidates = await query<
      User & { password_hash: string; username_match: boolean }
    >(
      // Two rows detect ambiguous usernames or emails without choosing a user.
      'SELECT u.*,lower(u.username)=$1 username_match FROM qms.users u WHERE u.enabled=true AND (lower(u.username)=$1 OR lower(u.email)=$1) ORDER BY username_match DESC LIMIT 2',
      [username],
    );
    const usernameMatches = candidates.filter((c) => c.username_match);
    // A unique username takes precedence. Ambiguous usernames never fall back.
    const u =
      usernameMatches.length === 1
        ? usernameMatches[0]
        : usernameMatches.length === 0 && candidates.length === 1
          ? candidates[0]
          : undefined;
    // Username and email are aliases for one account and share one budget.
    if (u) await rateLimit('login-account:' + u.id, 8, 300);
    // Hash even unknown accounts to avoid fast username enumeration.
    const valid = await verifyPassword(
      input.password,
      u?.password_hash || dummyHash,
    );
    if (!u || !valid) {
      // Failed attempts are audited without the typed identifier, which may
      // be a password entered in the wrong field.
      await audit(u?.id ?? null, 'login_failed', {
        reason: u ? 'password' : candidates.length ? 'ambiguous' : 'unknown',
      });
      throw new HttpError(401, 'Incorrect username or password.');
    }
    const token = randomToken();
    const [session] = await query<{ issued: boolean }>(
      'SELECT qms.issue_session($1,$2,$3) issued',
      [u.id, u.password_hash, await sha256(token)],
    );
    if (!session.issued)
      throw new HttpError(401, 'Your account changed. Please sign in again.');
    // Transparently upgrade hashes created with an older work factor.
    if (needsRehash(u.password_hash))
      await query(
        'UPDATE qms.users SET password_hash=$2 WHERE id=$1 AND password_hash=$3',
        [u.id, await hashPassword(input.password), u.password_hash],
      );
    await audit(u.id, 'login');
    const [user] = await query(
      `SELECT ${userColumns} FROM qms.users WHERE id=$1`,
      [u.id],
    );
    return json({ user }, 200, { 'Set-Cookie': sessionCookie(token) });
  }),
  define('GET', 'auth/me', sessionRoute, async ({ user }) =>
    json({ user, services: SERVICES }),
  ),
  define('POST', 'auth/logout', sessionRoute, async ({ request, user }) => {
    const token = request.headers
      .get('cookie')
      ?.match(/(?:^|;\s*)qms_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (token)
      await query('DELETE FROM qms.sessions WHERE token_hash=$1', [
        await sha256(token),
      ]);
    if (user.role !== 'customer') await audit(user.id, 'logout');
    // Ending authentication is always allowed. Keep active service ownership
    // intact; the separate presence action still guards against abandonment.
    try {
      await query('SELECT qms.set_presence($1,false)', [user.id]);
    } catch {
      console.info(JSON.stringify({ event: 'logout_presence_unchanged' }));
    }
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }),
  define('PUT', 'auth/password', sessionRoute, async ({ request, user }) => {
    if (user.role === 'customer')
      throw new HttpError(403, 'Customer visits cannot set passwords.');
    const input = z
      .object({
        currentPassword: z.string().min(1).max(128),
        newPassword: passwordSchema,
      })
      .parse(await body(request));
    await rateLimit('password:' + user.id, 5, 300);
    const [u] = await query<{ password_hash: string }>(
      'SELECT password_hash FROM qms.users WHERE id=$1',
      [user.id],
    );
    if (!(await verifyPassword(input.currentPassword, u.password_hash)))
      throw new HttpError(400, 'Current password is incorrect.');
    if (input.currentPassword === input.newPassword)
      throw new HttpError(400, 'Choose a different password.');
    const token = randomToken();
    const [changed] = await query<{ changed: boolean }>(
      'SELECT qms.change_password($1,$2,$3,$4) changed',
      [
        user.id,
        u.password_hash,
        await hashPassword(input.newPassword),
        await sha256(token),
      ],
    );
    if (!changed.changed)
      throw new HttpError(409, 'Your account changed. Please sign in again.');
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
  }),
];
