import { NextResponse, type NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
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
  const response = hidden
    ? new NextResponse('Not found', { status: 404 })
    : NextResponse.next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  const production = process.env.NODE_ENV === 'production';
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      // Vinext streams inline hydration scripts; eval is restricted to development.
      `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      `connect-src 'self'${production ? '' : ' ws: wss:'}`,
    ].join('; '),
  );
  if (
    (
      process.env.APP_ORIGIN ||
      process.env.RENDER_EXTERNAL_URL ||
      ''
    ).startsWith('https://')
  )
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
