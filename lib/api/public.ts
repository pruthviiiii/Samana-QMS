import { z } from 'zod';
import { query } from '../db';
import { HttpError, body, json } from '../http';
import { processJobs } from '../jobs';
import { startGuest } from '../public-access';
import { applyRetention } from '../retention';
import { salesforcePaused } from '../salesforce';
import { define, publicRoute, workerRoute } from '../router';
import { uuid } from './shared';
const sessionSchema = z.object({ invite: z.string().max(150) });
export const publicRoutes = [
  define(
    'GET',
    'health',
    publicRoute,
    'Database readiness for load balancers',
    async () => {
      try {
        await query('SELECT 1 FROM qms.migrations LIMIT 1');
        return json({ status: 'ready' });
      } catch {
        return json({ status: 'unavailable' }, 503);
      }
    },
  ),
  // For external uptime monitors: 503 while the routing tick is stale, so a
  // dead scheduler pages someone instead of only showing a banner to staff.
  define(
    'GET',
    'health/scheduler',
    publicRoute,
    'Scheduler heartbeat; 503 when the routing tick is stale',
    async () => {
      const [worker] = await query<{ updated_at: string }>(
        "SELECT updated_at FROM qms.system_state WHERE key='worker'",
      );
      const lastRun = worker?.updated_at ?? null;
      const healthy =
        !!lastRun && Date.now() - new Date(lastRun).getTime() < 90000;
      return json(
        { status: healthy ? 'ready' : 'stale', lastRun },
        healthy ? 200 : 503,
      );
    },
  ),
  // One address for an uptime monitor to page on: it is 503 while anything
  // needs a person (dead scheduler, deliveries that gave up, Salesforce paused
  // by the circuit breaker). The body says which, without details.
  define(
    'GET',
    'health/alerts',
    publicRoute,
    'One signal for uptime monitors; 503 while anything needs a person',
    async () => {
      const [state] = await query<{ last_run: string | null; failed: number }>(
        "SELECT (SELECT updated_at FROM qms.system_state WHERE key='worker') last_run,(SELECT count(*)::int FROM qms.outbox WHERE status='failed') failed",
      );
      const problems: string[] = [];
      if (
        !state.last_run ||
        Date.now() - new Date(state.last_run).getTime() > 90000
      )
        problems.push('scheduler_stale');
      if (state.failed > 0) problems.push('outbox_failed:' + state.failed);
      if (salesforcePaused()) problems.push('salesforce_paused');
      return json(
        {
          status: problems.length ? 'alert' : 'ready',
          problems,
          lastRun: state.last_run,
        },
        problems.length ? 503 : 200,
      );
    },
  ),
  define(
    'POST',
    'jobs/run',
    workerRoute,
    'Scheduler tick: routing, outbox delivery and retention',
    async () => {
      const result = await query('SELECT qms.route_due() checked');
      const jobs = await processJobs();
      const retention = await applyRetention();
      return json({ routing: result[0], jobs, retention });
    },
  ),
  define(
    'POST',
    'public/session',
    publicRoute,
    'Start a customer session from a QR invite',
    async ({ request }) => {
      const input = sessionSchema.parse(await body(request));
      return startGuest(request, input.invite);
    },
    sessionSchema,
  ),
  define(
    'GET',
    'public/status/:token',
    publicRoute,
    'Minimal ticket status for the private link',
    async ({ params }) => {
      const token = uuid.parse(params.token);
      const [ticket] = await query(
        "SELECT number,service_name,status,counter,(SELECT count(*)::int FROM qms.tickets ahead WHERE ahead.service_id=v.service_id AND ahead.status='waiting' AND ahead.created_at<v.created_at) waiting_ahead FROM qms.ticket_view v WHERE public_token=$1 AND (closed_at IS NULL OR closed_at>now()-interval '1 day')",
        [token],
      );
      if (!ticket)
        throw new HttpError(404, 'Ticket link has expired or was not found.');
      return json(ticket);
    },
  ),
];
