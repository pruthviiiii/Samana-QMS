import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
// The proxy runs before every request. These tests pin the browser policy it
// sets: a fresh nonce per request, no inline scripts allowed, hidden paths
// refused, and transport security only when the site is served over https.
const at = (path: string) => proxy(new NextRequest('http://qms.test' + path));
const policy = (response: Response) =>
  response.headers.get('content-security-policy') ?? '';
describe('Browser security policy', () => {
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
    vi.unstubAllEnvs();
  });
});
