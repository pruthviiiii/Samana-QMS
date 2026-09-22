import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
// The web tier's proxy runs before every request. These tests pin the browser
// policy it sets on pages, how it forwards /api to the API service, and that a
// client cannot smuggle the address header the API trusts.
const at = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest('http://qms.test' + path, { headers }));
const policy = (response: Response) =>
  response.headers.get('content-security-policy') ?? '';
afterEach(() => vi.unstubAllEnvs());
describe('Browser security policy on pages', () => {
  it('mints a different nonce for every request and allows scripts only by it', () => {
    const first = policy(at('/'));
    const second = policy(at('/'));
    const nonce = (value: string) => value.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce(first)).toBeTruthy();
    expect(nonce(second)).toBeTruthy();
    expect(nonce(first)).not.toBe(nonce(second));
    expect(first).toMatch(/script-src [^;]*'strict-dynamic'/);
    expect(first).not.toMatch(/script-src [^;]*'unsafe-inline'/);
  });
  it('hands the same nonce to the renderer so its bootstrap script is allowed', () => {
    const response = at('/');
    const served = response.headers.get('x-middleware-request-x-nonce');
    expect(served).toBeTruthy();
    expect(policy(response)).toContain(`'nonce-${served}'`);
  });
  it('forbids framing, plugins, foreign form targets and base changes', () => {
    const response = at('/queue');
    const value = policy(response);
    expect(value).toContain("frame-ancestors 'none'");
    expect(value).toContain("object-src 'none'");
    expect(value).toContain("form-action 'self'");
    expect(value).toContain("base-uri 'self'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
  });
  it('refuses hidden paths but not the well-known directory', () => {
    expect(at('/.git/config').status).toBe(404);
    expect(at('/queue/.env').status).toBe(404);
    expect(at('/api/.env').status).toBe(404);
    expect(at('/%2e%2e/.hidden').status).toBe(404);
    expect(at('/.well-known/security.txt').status).not.toBe(404);
    expect(at('/queue').status).not.toBe(404);
  });
  it('rejects a path that cannot be decoded instead of guessing', () =>
    expect(at('/%E0%A4%A').status).toBe(400));
  it('sends transport security only when the site is served over https', () => {
    vi.stubEnv('APP_ORIGIN', 'http://qms.test');
    vi.stubEnv('RENDER_EXTERNAL_URL', '');
    expect(at('/').headers.get('strict-transport-security')).toBeNull();
    vi.stubEnv('APP_ORIGIN', 'https://qms.test');
    expect(at('/').headers.get('strict-transport-security')).toContain('max-age=31536000');
  });
});
describe('Forwarding /api to the API service', () => {
  it('rewrites every /api path, with its query string, to the configured API', () => {
    vi.stubEnv('API_URL', 'http://api.internal:3001');
    const response = at('/api/queue?page=2&status=all');
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'http://api.internal:3001/api/queue?page=2&status=all',
    );
  });
  it('accepts a host:port address, as private-network hosts hand it out', () => {
    vi.stubEnv('API_URL', 'samana-qms-api:10000');
    expect(at('/api/health').headers.get('x-middleware-rewrite')).toBe(
      'http://samana-qms-api:10000/api/health',
    );
  });
  it('answers 503 with a stable code when the API address is missing', async () => {
    vi.stubEnv('API_URL', '');
    const response = at('/api/health');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'API_NOT_CONFIGURED' });
  });
  it('passes on the address its edge appended and never one the client sent', () => {
    vi.stubEnv('API_URL', 'http://api.internal:3001');
    const trusted = at('/api/queue', {
      'x-forwarded-for': '198.51.100.7, 203.0.113.9',
      'x-client-address': '10.0.0.1',
    });
    expect(trusted.headers.get('x-middleware-request-x-client-address')).toBe('203.0.113.9');
    const forged = at('/api/queue', { 'x-client-address': '10.0.0.1' });
    expect(forged.headers.get('x-middleware-request-x-client-address')).toBeNull();
  });
  it('adds the proxy token when it has one and drops any a client sent', () => {
    vi.stubEnv('API_URL', 'http://api.internal:3001');
    vi.stubEnv('API_PROXY_TOKEN', 'a-proxy-token-for-the-test-suite');
    const forwarded = at('/api/queue', { 'x-internal-token': 'forged' });
    expect(forwarded.headers.get('x-middleware-request-x-internal-token')).toBe(
      'a-proxy-token-for-the-test-suite',
    );
    vi.stubEnv('API_PROXY_TOKEN', '');
    const without = at('/api/queue', { 'x-internal-token': 'forged' });
    expect(without.headers.get('x-middleware-request-x-internal-token')).toBeNull();
  });
  it('does not put a page policy on API responses', () => {
    vi.stubEnv('API_URL', 'http://api.internal:3001');
    expect(at('/api/health').headers.get('content-security-policy')).toBeNull();
  });
});
