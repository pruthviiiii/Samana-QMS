import { json } from '../http';
import { auditEvents, reports } from '../operations';
import { integrationHealth } from '../salesforce';
import { define, roles } from '../router';
import { MANAGERS, audit } from './shared';
export const reportRoutes = [
  define(
    'GET',
    'reports',
    roles(...MANAGERS),
    'Ticket reports for a date range (from, to, service, page); format=csv exports',
    async ({ url, user }) => {
      const result = await reports(url);
      const exported = result instanceof Response;
      // Identifiers leave the system only on an explicit request, and the
      // export is recorded with its filters so it can be traced.
      await audit(
        user.id,
        exported ? 'report_export' : 'report_view',
        exported
          ? {
              from: url.searchParams.get('from') || null,
              to: url.searchParams.get('to') || null,
              identifiers: url.searchParams.get('identifiers') === 'true',
            }
          : {},
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
        await audit(user.id, 'audit_export', {
          from: url.searchParams.get('from') || null,
          to: url.searchParams.get('to') || null,
          action: url.searchParams.get('action') || null,
        });
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
