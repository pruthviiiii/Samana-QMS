import { z } from 'zod';
import { changePassword, issueSession, setPresence } from '../data/functions';
import {
  loginCandidates,
  passwordHashOf,
  rehashPassword,
  revokeSession,
  userById,
} from '../data/users';
import {
  HttpError,
  body,
  json,
  sessionCookie,
  sessionToken,
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
import { SERVICES } from '@qms/shared';
import { define, publicRoute, sessionRoute } from '../router';
import { audit, dummyHash, passwordSchema } from './shared';
const loginSchema = z.object({
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export const authRoutes = [
  define(
    'POST',
    'auth/login',
    publicRoute,
    'Sign in with username or email',
    async ({ request }) => {
      const input = loginSchema.parse(await body(request));
      const username = input.username.toLowerCase();
      // Bound expensive password work even if an attacker rotates usernames.
      await clientRateLimit(request, 'login', 20, 300);
      await rateLimit('login:global', 120, 60);
      await rateLimit('login:' + (await sha256(username)), 8, 300);
      // Two rows detect ambiguous usernames or emails without choosing a user.
      const candidates = await loginCandidates(username);
      const usernameMatches = candidates.filter((c) => c.usernameMatch);
      // A unique username takes precedence. Ambiguous usernames never fall back.
      const found =
        usernameMatches.length === 1
          ? usernameMatches[0]
          : usernameMatches.length === 0 && candidates.length === 1
            ? candidates[0]
            : undefined;
      // Username and email are aliases for one account and share one budget.
      if (found) await rateLimit('login-account:' + found.user.id, 8, 300);
      // Hash even unknown accounts to avoid fast username enumeration.
      const valid = await verifyPassword(
        input.password,
        found?.passwordHash || dummyHash,
      );
      if (!found || !found.passwordHash || !valid) {
        // Failed attempts are audited without the typed identifier, which may
        // be a password entered in the wrong field.
        await audit(found?.user.id ?? null, 'login_failed', {
          reason: found ? 'password' : candidates.length ? 'ambiguous' : 'unknown',
        });
        throw new HttpError(401, 'Incorrect username or password.', 'BAD_CREDENTIALS');
      }
      const token = randomToken();
      if (!(await issueSession(found.user.id, found.passwordHash, await sha256(token))))
        throw new HttpError(401, 'Your account changed. Please sign in again.', 'ACCOUNT_CHANGED');
      // Transparently upgrade hashes created with an older work factor.
      if (needsRehash(found.passwordHash))
        await rehashPassword(found.user.id, found.passwordHash, await hashPassword(input.password));
      await audit(found.user.id, 'login');
      const user = await userById(found.user.id);
      return json({ user }, 200, { 'Set-Cookie': sessionCookie(token) });
    },
    loginSchema,
  ),
  define(
    'GET',
    'auth/me',
    sessionRoute,
    'Current session and the service catalogue',
    async ({ user }) => json({ user, services: SERVICES }),
  ),
  define(
    'POST',
    'auth/logout',
    sessionRoute,
    'Sign out and revoke the session',
    async ({ request, user }) => {
      const token = sessionToken(request);
      if (token) await revokeSession(await sha256(token));
      if (user.role !== 'customer') await audit(user.id, 'logout');
      // Ending authentication is always allowed. Keep active service ownership
      // intact; the separate presence action still guards against abandonment.
      try {
        await setPresence(user.id, false);
      } catch {
        console.info(JSON.stringify({ event: 'logout_presence_unchanged' }));
      }
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    },
  ),
  define(
    'PUT',
    'auth/password',
    sessionRoute,
    'Change the password; other sessions are signed out',
    async ({ request, user }) => {
      if (user.role === 'customer')
        throw new HttpError(403, 'Customer visits cannot set passwords.', 'FORBIDDEN');
      const input = passwordChangeSchema.parse(await body(request));
      await rateLimit('password:' + user.id, 5, 300);
      const currentHash = await passwordHashOf(user.id);
      if (!currentHash || !(await verifyPassword(input.currentPassword, currentHash)))
        throw new HttpError(400, 'Current password is incorrect.', 'BAD_CREDENTIALS');
      if (input.currentPassword === input.newPassword)
        throw new HttpError(400, 'Choose a different password.', 'INVALID_INPUT');
      const token = randomToken();
      const changed = await changePassword(
        user.id,
        currentHash,
        await hashPassword(input.newPassword),
        await sha256(token),
      );
      if (!changed)
        throw new HttpError(409, 'Your account changed. Please sign in again.', 'ACCOUNT_CHANGED');
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
    },
    passwordChangeSchema,
  ),
];
