import { describe, it, expect } from 'vitest';
import { routes } from '../lib/api';
import { match } from '../lib/router';
// Every API route must say who may call it. This guards the declaration
// table without a database.
describe('API route table', () => {
  it('declares method, path and access for every route, with no duplicates', () => {
    const seen = new Set<string>();
    for (const route of routes) {
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(route.method);
      expect(route.path).toMatch(/^[a-z0-9\-/:]+$/);
      expect(['public', 'worker', 'session', 'roles']).toContain(
        route.auth.kind,
      );
      if (route.auth.kind === 'roles')
        expect(route.auth.roles.length).toBeGreaterThan(0);
      const key = route.method + ' ' + route.path;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });
  it('keeps unauthenticated routes to the intended set', () => {
    const open = routes
      .filter((r) => r.auth.kind === 'public' || r.auth.kind === 'worker')
      .map((r) => r.method + ' ' + r.path)
      .sort();
    expect(open).toEqual([
      'GET health',
      'GET health/scheduler',
      'GET public/status/:token',
      'POST auth/login',
      'POST jobs/run',
      'POST public/session',
    ]);
  });
  it('never lets a guest reach staff data', () => {
    const guestReachable = routes
      .filter((r) => r.auth.kind === 'roles' && r.auth.roles.includes('customer'))
      .map((r) => r.method + ' ' + r.path)
      .sort();
    expect(guestReachable).toEqual([
      'GET tickets/:id',
      'GET tickets/:id/print',
      'POST customers/lookup',
      'POST tickets',
    ]);
  });
  it('matches path parameters and refuses unknown verbs', () => {
    const found = match(routes, 'GET', 'tickets/abc/print');
    expect(found?.route.path).toBe('tickets/:id/print');
    expect(found?.params.id).toBe('abc');
    expect(match(routes, 'DELETE', 'tickets/abc')).toBeNull();
    expect(match(routes, 'GET', 'no/such/route')).toBeNull();
  });
});
