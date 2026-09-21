import type { ZodType } from 'zod';
import { HttpError, requireUser, sameOrigin } from './http';
import { sha256 } from './security';
import type { Role, User } from './domain';
// Every API route declares, in one place, its method, its path and exactly who
// may call it. The dispatcher enforces the declaration before the handler
// runs, so no handler depends on where it sits in a file.
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Auth =
  | { kind: 'public' } // no session; the handler validates its own inputs
  | { kind: 'worker' } // bearer WORKER_SECRET from the scheduler
  | { kind: 'session' } // any signed-in account, even before a password change
  | { kind: 'roles'; roles: readonly Role[] }; // signed in, password set, role listed
export interface Context {
  request: Request;
  url: URL;
  params: Record<string, string>;
  user: User; // present for session and roles routes; a placeholder otherwise
}
export interface Route {
  method: Method;
  path: string; // e.g. 'tickets/:id/action'
  auth: Auth;
  summary: string; // one line for the generated API document
  handler: (context: Context) => Promise<Response>;
  body?: ZodType; // the JSON body schema the handler validates, when it takes one
}
export const publicRoute: Auth = { kind: 'public' };
export const workerRoute: Auth = { kind: 'worker' };
export const sessionRoute: Auth = { kind: 'session' };
export const roles = (...list: Role[]): Auth => ({ kind: 'roles', roles: list });
export const define = (
  method: Method,
  path: string,
  auth: Auth,
  summary: string,
  handler: Route['handler'],
  body?: ZodType,
): Route => ({ method, path, auth, summary, handler, ...(body ? { body } : {}) });
export function match(routes: Route[], method: string, path: string) {
  const parts = path.split('/');
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split('/');
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = parts[i];
      else if (pattern[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}
const anonymous: User = {
  id: '',
  username: '',
  name: '',
  role: 'customer',
  sf_id: null,
  manager_sf_id: null,
  services: [],
  online: false,
  last_seen: null,
  counter: '',
  enabled: false,
  must_change_password: false,
};
export async function dispatch(routes: Route[], request: Request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const found = match(routes, request.method, path);
  if (!found) throw new HttpError(404, 'Endpoint not found.');
  const { route, params } = found;
  // Browsers must prove same-origin for every state change; the scheduler is
  // server-to-server and proves itself with its own credential instead.
  if (request.method !== 'GET' && route.auth.kind !== 'worker')
    sameOrigin(request);
  let user = anonymous;
  if (route.auth.kind === 'worker') {
    const secret = process.env.WORKER_SECRET;
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (!secret || !token || (await sha256(token)) !== (await sha256(secret)))
      throw new HttpError(401, 'Unauthorized.');
  } else if (route.auth.kind !== 'public') {
    user = await requireUser(request);
    if (route.auth.kind === 'roles') {
      if (user.must_change_password)
        throw new HttpError(
          403,
          'Change your temporary password before continuing.',
        );
      if (!route.auth.roles.includes(user.role))
        throw new HttpError(403, 'You do not have permission for this action.');
    }
  }
  return route.handler({ request, url, params, user });
}
