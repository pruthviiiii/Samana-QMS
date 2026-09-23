import { NextResponse, type NextRequest } from 'next/server';
// Runs before every request to the web tier. Three jobs:
//
// 1. Refuse hidden paths.
// 2. Forward /api to the API service. The browser only ever talks to this
//    origin, so cookies stay first-party and the origin check on every state
//    change keeps working; the API itself is not reachable from outside. The
//    address the edge appended to x-forwarded-for travels on as
//    x-client-address, which the API trusts for per-address limits; a client
//    cannot forge it because this tier always overwrites it.
// 3. Set the browser security headers on every page. The script policy is
//    nonce based: a fresh nonce per request, 'strict-dynamic' for the chunks
//    it loads, and no inline allowance, so an injected script is refused by
//    the browser. Pages therefore render per request (app/layout.tsx).
const API_PREFIX = '/api';
export function proxy(request: NextRequest) {
  let pathname: string;
  try {
    pathname = decodeURIComponent(request.nextUrl.pathname).replaceAll(
      '\\',
      '/',
    );
  } catch {
    return new NextResponse('Bad request', { status: 400 });
  }
  const hidden = pathname
    .split('/')
    .some((part) => part.startsWith('.') && part !== '.well-known');
  if (hidden) return new NextResponse('Not found', { status: 404 });
  if (pathname === API_PREFIX || pathname.startsWith(API_PREFIX + '/')) {
    const api = process.env.API_URL;
    if (!api)
      return NextResponse.json(
        {
          error: 'The API service is not configured on this host.',
          code: 'API_NOT_CONFIGURED',
        },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    const target = new URL(
      pathname + request.nextUrl.search,
      /^https?:\/\//.test(api) ? api : 'http://' + api,
    );
    const headers = new Headers(request.headers);
    headers.delete('x-client-address');
    headers.delete('x-internal-token');
    const forwarded = request.headers.get('x-forwarded-for');
    const client = forwarded?.split(',').pop()?.trim();
    if (client) headers.set('x-client-address', client);
    // The token that makes the API's address usable only through this tier.
    const token = process.env.API_PROXY_TOKEN;
    if (token) headers.set('x-internal-token', token);
    return NextResponse.rewrite(target, { request: { headers } });
  }
  const production = process.env.NODE_ENV === 'production';
  const nonce = btoa(crypto.randomUUID());
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Development needs eval for the dev server's refresh runtime.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? '' : " 'unsafe-eval'"}`,
    // Inline styles remain: React and the design system set style attributes,
    // and a style injection cannot execute code.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${production ? '' : ' ws: wss:'}`,
  ].join('; ');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  if (
    (process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || '').startsWith(
      'https://',
    )
  )
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
}
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
