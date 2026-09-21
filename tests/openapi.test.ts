import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { routes } from '../lib/api';
import { openApiDocument } from '../lib/openapi';
// The published API document must match what the route table generates, so
// a route change without `npm run api:docs` fails here.
describe('API document', () => {
  const document = openApiDocument(routes);
  it('matches docs/openapi.json (run npm run api:docs after changing a route)', () => {
    const published = JSON.parse(
      readFileSync(new URL('../docs/openapi.json', import.meta.url), 'utf8'),
    );
    expect(published).toEqual(document);
  });
  it('describes every route with a summary and its access', () => {
    for (const route of routes)
      expect(route.summary.length, route.method + ' ' + route.path).toBeGreaterThan(10);
    expect(Object.keys(document.paths)).toHaveLength(
      new Set(routes.map((r) => r.path)).size,
    );
    for (const [path, methods] of Object.entries(document.paths))
      for (const operation of Object.values(methods))
        expect((operation as { security: unknown[] }).security, path).toBeDefined();
  });
  it('carries the request schema of routes that take a body', () => {
    const login = document.paths['/api/auth/login'].post as {
      requestBody: {
        content: Record<string, { schema: { required: string[] } }>;
      };
    };
    expect(login.requestBody.content['application/json'].schema.required).toEqual([
      'username',
      'password',
    ]);
    const member = document.paths['/api/team'].post as {
      requestBody: {
        content: Record<string, { schema: { properties: Record<string, unknown> } }>;
      };
    };
    expect(
      Object.keys(member.requestBody.content['application/json'].schema.properties),
    ).toContain('services');
  });
});
