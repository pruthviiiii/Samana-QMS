import { ZodError } from 'zod';
import { query } from './db';
import { sha256 } from './security';
import type { User, Role } from './domain';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(
  data: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    },
  });
}
export async function body(request: Request) {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new HttpError(415, 'Send JSON content.');
  if (Number(request.headers.get('content-length')) > 32768)
    throw new HttpError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Invalid JSON.');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32768) {
      await reader.cancel();
      throw new HttpError(413, 'Request is too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
  if (!origin || origin !== expected)
    throw new HttpError(403, 'Request origin is not allowed.');
}
export async function requireUser(request: Request, roles?: Role[]) {
  const token = request.headers
    .get('cookie')
    ?.match(/(?:^|;\s*)qms_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) throw new HttpError(401, 'Please sign in.');
  const [user] = await query<User>(
    'SELECT u.id,u.username,u.name,u.role,u.sf_id,u.manager_sf_id,u.services,u.online,u.last_seen,u.counter,u.enabled,u.must_change_password FROM qms.sessions s JOIN qms.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.enabled=true',
    [await sha256(token)],
  );
  if (!user)
    throw new HttpError(401, 'Your session has expired. Please sign in.');
  if (roles && !roles.includes(user.role))
    throw new HttpError(403, 'You do not have permission for this action.');
  return user;
}
export function sessionCookie(token: string, maxAge = 28800) {
  const secure = process.env.SESSION_COOKIE_SECURE !== 'false';
  return `qms_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
// Database exception codes and the message a person at the desk should read.
const known: Record<string, [number, string]> = {
  TICKET_NOT_FOUND: [404, 'That ticket no longer exists.'],
  LOOKUP_EXPIRED: [
    409,
    'The customer lookup has expired. Look the customer up again.',
  ],
  UNIT_REQUIRED: [400, 'Choose the unit this visit is about.'],
  INVALID_SERVICE: [400, 'That service is not available for this customer.'],
  VERSION_CONFLICT: [
    409,
    'This ticket was just updated by someone else. It has been refreshed; please try again.',
  ],
  INVALID_TRANSITION: [
    409,
    "That action is not possible in the ticket's current state.",
  ],
  AGENT_BUSY: [409, 'That team member is already with a customer.'],
  FORBIDDEN: [403, 'You do not have permission for this action.'],
  AGENT_UNAVAILABLE: [409, 'Go online before calling a customer.'],
  INVALID_ASSIGNEE: [
    400,
    'Choose a team member who is online and covers this service.',
  ],
  DUPLICATE_VISIT: [
    409,
    'This customer already has an open ticket for this service.',
  ],
  DATABASE_NOT_CONFIGURED: [503, 'The database is not configured.'],
  IDEMPOTENCY_CONFLICT: [
    409,
    'This request was already used for a different ticket. Start again.',
  ],
  UNIT_NOT_ALLOWED: [400, 'A unit cannot be attached to this visit.'],
  USER_NOT_FOUND: [404, 'That team member was not found.'],
  PASSWORD_REQUIRED: [400, 'Set a temporary password for a new member.'],
};
function failure(error: unknown, requestId: string) {
  if (error instanceof HttpError)
    return json({ error: error.message }, error.status);
  if (error instanceof ZodError)
    return json({ error: error.issues.map((x) => x.message).join(' ') }, 400);
  const message = error instanceof Error ? error.message : '';
  for (const [code, [status, text]] of Object.entries(known))
    if (message.includes(code)) return json({ error: text, code }, status);
  console.error(
    JSON.stringify({
      event: 'request_failed',
      requestId,
      errorType: error instanceof Error ? error.name : 'Unknown',
    }),
  );
  return json(
    { error: 'The request could not be completed. Please retry.', requestId },
    503,
  );
}
// Every API response carries X-Request-Id and writes one JSON log line with the
// method, a masked path, the status and the duration. Ids and tokens in the
// path are replaced so private status links never reach the logs.
export async function endpoint(
  request: Request,
  run: () => Promise<Response>,
) {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  let response: Response;
  try {
    response = await run();
  } catch (error) {
    response = failure(error, requestId);
  }
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  const path = new URL(request.url).pathname.replace(
    /[0-9a-f]{8}-[0-9a-f-]{27}/g,
    ':id',
  );
  console.log(
    JSON.stringify({
      event: 'request',
      method: request.method,
      path,
      status: response.status,
      ms: Date.now() - started,
      requestId,
    }),
  );
  return new Response(response.body, { status: response.status, headers });
}
export async function rateLimit(key: string, limit = 10, windowSeconds = 300) {
  const [r] = await query<{ count: number }>(
    `INSERT INTO qms.rate_limits(key,window_start,count) VALUES($1,to_timestamp(floor(extract(epoch from now())/$2)*$2),1) ON CONFLICT(key,window_start) DO UPDATE SET count=qms.rate_limits.count+1 RETURNING count`,
    [key, windowSeconds],
  );
  if (r.count > limit)
    throw new HttpError(429, 'Too many attempts. Please try again later.');
}

export async function clientRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowSeconds: number,
) {
  // Honor a proxy header only when explicitly configured behind a trusted edge.
  // Never use arbitrary forwarded headers as the sole abuse safeguard.
  const header = process.env.TRUSTED_CLIENT_IP_HEADER;
  if (
    !header ||
    ![
      'cf-connecting-ip',
      'true-client-ip',
      'x-real-ip',
      'x-forwarded-for',
    ].includes(header)
  )
    return;
  const value = request.headers.get(header)?.split(',')[0].trim();
  if (!value || !/^[a-fA-F0-9:.]{3,64}$/.test(value)) return;
  await rateLimit(
    scope + ':client:' + (await sha256(value)),
    limit,
    windowSeconds,
  );
}
