import { z } from 'zod';
import type { Route } from './router';
// The API document is derived from the route table, so it cannot drift from
// what the server enforces: every path and verb, who may call it, and the
// request body schema the handler validates. scripts/openapi.mjs writes it to
// docs/openapi.json and tests/openapi.test.ts fails when that file is stale.
function access(route: Route) {
  switch (route.auth.kind) {
    case 'public':
      return 'No credentials required.';
    case 'worker':
      return 'Scheduler bearer token (WORKER_SECRET).';
    case 'session':
      return 'Any signed-in session, including one that must still change its temporary password.';
    case 'roles':
      return 'Signed-in session with role ' + route.auth.roles.join(', ') + '.';
  }
}
export function openApiDocument(routes: Route[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = '/api/' + route.path.replace(/:([a-z]+)/g, '{$1}');
    const parameters = [...route.path.matchAll(/:([a-z]+)/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const authenticated = route.auth.kind !== 'public';
    const operation: Record<string, unknown> = {
      summary: route.summary,
      description: access(route),
      security:
        route.auth.kind === 'public'
          ? []
          : route.auth.kind === 'worker'
            ? [{ workerBearer: [] }]
            : [{ sessionCookie: [] }],
      ...(route.auth.kind === 'roles' ? { 'x-roles': [...route.auth.roles] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: z.toJSONSchema(route.body, {
                    target: 'openapi-3.0',
                    unrepresentable: 'any',
                  }),
                },
              },
            },
          }
        : {}),
      responses: {
        '200': { description: 'Success' },
        '400': { description: 'Invalid input; the body carries a human message' },
        ...(authenticated
          ? {
              '401': { description: 'Not signed in' },
              '403': { description: 'Wrong origin, role, or password change pending' },
            }
          : {}),
        '429': { description: 'Rate limit reached' },
        '503': { description: 'Database or integration unavailable' },
      },
    };
    (paths[path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Samana QMS API',
      version: '1.0.0',
      description:
        'Generated from the route table in lib/api by scripts/openapi.mjs. Every state-changing call from a browser must send an Origin header equal to APP_ORIGIN; the scheduler proves itself with a bearer token instead. Errors are JSON with an "error" message and, for database rule violations, a stable "code".',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'qms_session' },
        workerBearer: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
  };
}
