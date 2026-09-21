import { query } from '../db';
import { json } from '../http';
import { auditEvents, reports } from '../operations';
import { integrationHealth } from '../salesforce';
import { define, roles } from '../router';
import { MANAGERS } from './shared';
export const reportRoutes = [
  define(
    'GET',
    'reports',
    roles(...MANAGERS),
    'Ticket reports for a date range (from, to, service, page); format=csv exports',
    async ({ url, user }) => {
      const result = await reports(url);
      const exported = result instanceof Response;
      await query(
        'INSERT INTO qms.events(actor_id,action,details) VALUES($1,$2,$3::jsonb)',
        [
          user.id,
          exported ? 'report_export' : 'report_view',
          JSON.stringify(
            exported
              ? {
                  from: url.searchParams.get('from') || null,
                  to: url.searchParams.get('to') || null,
                  identifiers: url.searchParams.get('identifiers') === 'true',
                }
              : {},
          ),
        ],
      );
      return exported ? result : json(result);
    },
  ),
  define(
    'GET',
    'audit',
    roles(...MANAGERS),
    'Audit trail page (limit, before cursor, action, from, to); format=csv exports',
    async ({ url, user }) => {
      const result = await auditEvents(url);
      if (result instanceof Response) {
        await query(
          'INSERT INTO qms.events(actor_id,action,details) VALUES($1,$2,$3::jsonb)',
          [
            user.id,
            'audit_export',
            JSON.stringify({
              from: url.searchParams.get('from') || null,
              to: url.searchParams.get('to') || null,
              action: url.searchParams.get('action') || null,
            }),
          ],
        );
        return result;
      }
      return json(result);
    },
  ),
  define(
    'GET',
    'integrations',
    roles(...MANAGERS),
    'Connected systems health: database, Salesforce, SMS, scheduler',
    async () => json(await integrationHealth()),
  ),
];
