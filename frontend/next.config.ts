import path from 'node:path';
import type { NextConfig } from 'next';
// Production is the standalone Node server (dist-node/standalone/server.js on
// Render and in Docker). Browser security headers are set in proxy.ts; the
// static ones are repeated here so assets served without the proxy carry them.
const nextConfig: NextConfig = {
  output: 'standalone',
  // @qms/shared is a workspace package of TypeScript source, not a published
  // build, so Next compiles it rather than treating it as an opaque module.
  transpilePackages: ['@qms/shared'],
  // Standalone tracing starts at the workspace root, otherwise the shared
  // package and the hoisted node_modules are left out of the output.
  outputFileTracingRoot: path.join(import.meta.dirname, '..'),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};
export default nextConfig;
