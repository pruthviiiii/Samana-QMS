/** Thrown by every call in this module; carries the HTTP status and the
 *  server's stable error code so callers branch on a value, not on a message. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const response = await fetch('/api/' + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers,
  });
  const result = (await response
    .json()
    .catch(() => ({ error: 'Unexpected server response.' }))) as {
    error?: string;
    code?: string;
  };
  if (!response.ok)
    throw new ApiError(
      result.error || 'Request failed.',
      response.status,
      result.code,
    );
  return result as T;
}
export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';
// State changes use the verb that describes them, so logs and proxies can
// tell a create from an update or a removal.
export const send = <T>(method: WriteMethod, path: string, data?: unknown) =>
  api<T>(path, {
    method,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
export const post = <T>(path: string, data: unknown) =>
  send<T>('POST', path, data);
export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-AE', {
    timeZone: 'Asia/Dubai',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
