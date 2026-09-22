import { z } from 'zod';
import { config } from '../config';
import { routeDue } from '../data/functions';
import { failedCount } from '../data/outbox';
import { schedulerHealthy, workerLastRun } from '../data/system';
import { publicStatus } from '../data/tickets';
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
      const lastRun = await workerLastRun();
      const healthy = schedulerHealthy(lastRun);
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
      const [lastRun, failed] = await Promise.all([workerLastRun(), failedCount()]);
      const problems: string[] = [];
      if (!schedulerHealthy(lastRun)) problems.push('scheduler_stale');
      if (failed > 0) problems.push('outbox_failed:' + failed);
      if (salesforcePaused()) problems.push('salesforce_paused');
      // The first administrator's password must leave the host once used;
      // in production its presence pages the monitor instead of relying on a
      // README instruction.
      const settings = config();
      if (settings.NODE_ENV === 'production' && settings.BOOTSTRAP_PASSWORD)
        problems.push('bootstrap_password_present');
      return json(
        {
          status: problems.length ? 'alert' : 'ready',
          problems,
          lastRun,
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
      const checked = await routeDue();
      const jobs = await processJobs();
      const retention = await applyRetention();
      return json({ routing: { checked }, jobs, retention });
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
      const ticket = await publicStatus(uuid.parse(params.token));
      if (!ticket)
        throw new HttpError(404, 'Ticket link has expired or was not found.', 'TICKET_NOT_FOUND');
      return json(ticket);
    },
  ),
];
