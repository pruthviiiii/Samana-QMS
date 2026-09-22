import { NextResponse, type NextRequest } from 'next/server';
// Runs before every request (Next.js "proxy", formerly middleware): refuses
// hidden paths and sets the browser security headers on every response.
//
// The script policy is nonce based. A fresh nonce is minted per request, put
// on the response policy and passed to the renderer on the request, which
// Next.js uses to mark its own inline bootstrap script; 'strict-dynamic' then
// covers the chunks that script loads. Nothing else may execute, so an
// injected inline script is refused by the browser even if it reaches the page.
// This is why the pages render dynamically: a prerendered page would carry a
// nonce from build time that no longer matches.
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
  const response = hidden
    ? new NextResponse('Not found', { status: 404 })
    : NextResponse.next({ request: { headers: requestHeaders } });
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
