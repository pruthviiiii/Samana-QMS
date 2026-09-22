import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '../lib/config';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { handle } from '../server/handler';
// The API service as a real HTTP server on an ephemeral port: the same host
// server/api.ts uses, serving the same function. These tests prove the wire
// behaviour that the in-process API tests cannot: status codes and headers as
// a client sees them, JSON on every error, and the event stream as a live
// response rather than a value.
let server: ServerType;
let base = '';
beforeAll(async () => {
  if (
    !process.env.DATABASE_URL ||
    new URL(process.env.DATABASE_URL).pathname !== '/samana_qms_test'
  )
    throw new Error('Server tests require the isolated samana_qms_test database.');
  await new Promise<void>((resolve) => {
    server = serve({ fetch: (request) => handle(request), port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      base = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
describe('API service over HTTP', () => {
  it('answers health with JSON, a request id and no caching', async () => {
    const response = await fetch(base + '/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('returns JSON errors with stable codes for unknown paths and bad verbs', async () => {
    const missing = await fetch(base + '/api/nothing-here');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'Endpoint not found.' });
    const wrongVerb = await fetch(base + '/api/health', { method: 'DELETE', headers: { origin: 'http://qms.test' } });
    expect(wrongVerb.status).toBe(404);
  });
  it('refuses a state change without a matching origin before touching the body', async () => {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'x' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'BAD_ORIGIN' });
  });
  it('requires a session for the event stream and every staff route', async () => {
    for (const path of ['/api/events', '/api/queue', '/api/team', '/api/audit']) {
      const response = await fetch(base + path);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'NOT_SIGNED_IN' });
    }
  });
  it('caps request bodies and refuses non-JSON content', async () => {
    const tooBig = await fetch(base + '/api/public/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://qms.test' },
      body: JSON.stringify({ invite: 'x'.repeat(40000) }),
    });
    expect(tooBig.status).toBe(413);
    const notJson = await fetch(base + '/api/public/session', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'http://qms.test' },
      body: 'invite=x',
    });
    expect(notJson.status).toBe(415);
  });
  it('serves only the web tier when a proxy token is configured, except readiness', async () => {
    vi.stubEnv('API_PROXY_TOKEN', 'a-proxy-token-for-the-test-suite');
    resetConfigForTests();
    try {
      const direct = await fetch(base + '/api/queue');
      expect(direct.status).toBe(401);
      expect(await direct.json()).toMatchObject({ code: 'NOT_VIA_WEB_TIER' });
      const wrong = await fetch(base + '/api/queue', { headers: { 'x-internal-token': 'not-the-token' } });
      expect((await wrong.json()).code).toBe('NOT_VIA_WEB_TIER');
      const viaWeb = await fetch(base + '/api/queue', { headers: { 'x-internal-token': 'a-proxy-token-for-the-test-suite' } });
      expect(viaWeb.status).toBe(401);
      expect((await viaWeb.json()).code).toBe('NOT_SIGNED_IN');
      const readiness = await fetch(base + '/api/health');
      expect(readiness.status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
      resetConfigForTests();
    }
  });
  it('does not identify the server software or leak stack traces', async () => {
    const response = await fetch(base + '/api/nothing-here');
    expect(response.headers.get('x-powered-by')).toBeNull();
    const text = JSON.stringify(await response.json());
    expect(text).not.toMatch(/at .*\.(ts|js):\d+/);
  });
});
