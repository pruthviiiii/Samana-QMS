import { ZodError } from 'zod';
import { config } from './config';
import { one, rateLimitRow } from './data/rows';
import { findSessionUser } from './data/users';
import { query } from './db';
import { HttpError, ruleError } from './errors';
import { sha256 } from './security';
import type { Role } from '@qms/shared';
export { HttpError } from './errors';
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
const MAX_BODY_BYTES = 32768;
export async function body(request: Request) {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new HttpError(415, 'Send JSON content.', 'UNSUPPORTED_MEDIA_TYPE');
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES)
    throw new HttpError(413, 'Request is too large.', 'PAYLOAD_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Invalid JSON.', 'INVALID_JSON');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, 'Request is too large.', 'PAYLOAD_TOO_LARGE');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON.', 'INVALID_JSON');
  }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== config().APP_ORIGIN)
    throw new HttpError(403, 'Request origin is not allowed.', 'BAD_ORIGIN');
}
const SESSION_COOKIE = /(?:^|;\s*)qms_session=([a-f0-9]{64})(?:;|$)/;
export const sessionToken = (request: Request) =>
  request.headers.get('cookie')?.match(SESSION_COOKIE)?.[1] ?? null;
export async function requireUser(request: Request, roles?: Role[]) {
  const token = sessionToken(request);
  if (!token) throw new HttpError(401, 'Please sign in.', 'NOT_SIGNED_IN');
  const user = await findSessionUser(await sha256(token));
  if (!user)
    throw new HttpError(
      401,
      'Your session has expired. Please sign in.',
      'SESSION_EXPIRED',
    );
  if (roles && !roles.includes(user.role))
    throw new HttpError(
      403,
      'You do not have permission for this action.',
      'FORBIDDEN',
    );
  return user;
}
export function sessionCookie(token: string, maxAge = 28800) {
  const secure = config().SESSION_COOKIE_SECURE;
  return `qms_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
// Every failure becomes one of three things: a rule the database enforces, a
// validation failure, or an unexpected fault. Only the last is a 500, so an
// uptime monitor and a load balancer can trust the status.
function failure(error: unknown, requestId: string) {
  const rule = ruleError(error);
  if (rule)
    return json({ error: rule.message, code: rule.code }, rule.status);
  if (error instanceof HttpError)
    return json(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      error.status,
    );
  if (error instanceof ZodError)
    return json(
      {
        error: error.issues.map((x) => x.message).join(' '),
        code: 'INVALID_INPUT',
      },
      400,
    );
  console.error(
    JSON.stringify({
      event: 'request_failed',
      requestId,
      errorType: error instanceof Error ? error.name : 'Unknown',
      // The message can carry customer data, so only the shape is logged.
      databaseCode:
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code: unknown }).code).slice(0, 12)
          : undefined,
    }),
  );
  return json(
    {
      error: 'The request could not be completed. Please retry.',
      code: 'INTERNAL_ERROR',
      requestId,
    },
    500,
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
/**
 * Fixed-window limiter. One row per key holds the window start and the count;
 * the whole decision is a single atomic statement, so two requests arriving
 * together can never open two windows and double the budget.
 */
export async function rateLimit(key: string, limit = 10, windowSeconds = 300) {
  const result = await query(
    `INSERT INTO qms.rate_limits(key,window_start,count) VALUES($1,now(),1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN qms.rate_limits.window_start > now()-make_interval(secs=>$2) THEN qms.rate_limits.count+1 ELSE 1 END,
       window_start = CASE WHEN qms.rate_limits.window_start > now()-make_interval(secs=>$2) THEN qms.rate_limits.window_start ELSE now() END
     RETURNING count`,
    [key, windowSeconds],
  );
  if (one(rateLimitRow, result, 'rate limit').count > limit)
    throw new HttpError(
      429,
      'Too many attempts. Please try again later.',
      'RATE_LIMITED',
    );
}

export async function clientRateLimit(
  request: Request,
  scope: string,
  limit: number,
  windowSeconds: number,
) {
  // Honor a proxy header only when explicitly configured behind a trusted edge.
  // Never use arbitrary forwarded headers as the sole abuse safeguard.
  const header = config().TRUSTED_CLIENT_IP_HEADER;
  if (!header) return;
  // A proxy appends the address it saw to the end of the list, so the last
  // entry is the one it vouches for; earlier entries are whatever the client
  // sent and can be forged.
  const parts = request.headers.get(header)?.split(',') ?? [];
  const value = parts[parts.length - 1]?.trim();
  if (!value || !/^[a-fA-F0-9:.]{3,64}$/.test(value)) return;
  await rateLimit(
    scope + ':client:' + (await sha256(value)),
    limit,
    windowSeconds,
  );
}
// Integer query parameters: absent means the fallback; anything that is not a
// plain integer in range is a 400 with a message, never a database error.
export function intParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw))
    throw new HttpError(400, `Invalid ${name}.`, 'INVALID_INPUT');
  const value = Number(raw);
  if (value < min || value > max)
    throw new HttpError(
      400,
      `${name} must be between ${min} and ${max}.`,
      'INVALID_INPUT',
    );
  return value;
}
