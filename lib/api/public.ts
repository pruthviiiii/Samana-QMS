import { z } from 'zod';
import { query } from '../db';
import { HttpError, body, json } from '../http';
import { processJobs } from '../jobs';
import { startGuest } from '../public-access';
import { define, publicRoute, workerRoute } from '../router';
import { uuid } from './shared';
export const publicRoutes = [
  define('GET', 'health', publicRoute, async () => {
    try {
      await query('SELECT 1 FROM qms.migrations LIMIT 1');
      return json({ status: 'ready' });
    } catch {
      return json({ status: 'unavailable' }, 503);
    }
  }),
  // For external uptime monitors: 503 while the routing tick is stale, so a
  // dead scheduler pages someone instead of only showing a banner to staff.
  define('GET', 'health/scheduler', publicRoute, async () => {
    const [worker] = await query<{ updated_at: string }>(
      "SELECT updated_at FROM qms.system_state WHERE key='worker'",
    );
    const lastRun = worker?.updated_at ?? null;
    const healthy =
      !!lastRun && Date.now() - new Date(lastRun).getTime() < 90000;
    return json({ status: healthy ? 'ready' : 'stale', lastRun }, healthy ? 200 : 503);
  }),
  define('POST', 'jobs/run', workerRoute, async () => {
    const result = await query('SELECT qms.route_due() checked');
    const jobs = await processJobs();
    return json({ routing: result[0], jobs });
  }),
  define('POST', 'public/session', publicRoute, async ({ request }) => {
    const input = z
      .object({ invite: z.string().max(150) })
      .parse(await body(request));
    return startGuest(request, input.invite);
  }),
  define('GET', 'public/status/:token', publicRoute, async ({ params }) => {
    const token = uuid.parse(params.token);
    const [ticket] = await query(
      "SELECT number,service_name,status,counter,(SELECT count(*)::int FROM qms.tickets ahead WHERE ahead.service_id=v.service_id AND ahead.status='waiting' AND ahead.created_at<v.created_at) waiting_ahead FROM qms.ticket_view v WHERE public_token=$1 AND (closed_at IS NULL OR closed_at>now()-interval '1 day')",
      [token],
    );
    if (!ticket)
      throw new HttpError(404, 'Ticket link has expired or was not found.');
    return json(ticket);
  }),
];
