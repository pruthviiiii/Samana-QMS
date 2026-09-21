import { query } from '../db';
import { json } from '../http';
import { auditEvents, reports } from '../operations';
import { integrationHealth } from '../salesforce';
import { define, roles } from '../router';
import { MANAGERS } from './shared';
export const reportRoutes = [
  define('GET', 'reports', roles(...MANAGERS), async ({ url, user }) => {
    const result = await reports(url);
    await query('INSERT INTO qms.events(actor_id,action) VALUES($1,$2)', [
      user.id,
      result instanceof Response ? 'report_export' : 'report_view',
    ]);
    return result instanceof Response ? result : json(result);
  }),
  define('GET', 'audit', roles(...MANAGERS), async ({ url }) =>
    json(await auditEvents(url)),
  ),
  define('GET', 'integrations', roles(...MANAGERS), async () =>
    json(await integrationHealth()),
  ),
];
