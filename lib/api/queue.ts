import { z } from 'zod';
import { query } from '../db';
import { body, json } from '../http';
import { queue } from '../operations';
import { checkinLink } from '../public-access';
import { define, roles } from '../router';
import { MANAGERS, SERVING, STAFF } from './shared';
export const queueRoutes = [
  define('GET', 'queue', roles(...STAFF), async ({ url, user }) =>
    json(await queue(user, url)),
  ),
  // Availability is a state the agent sets, hence PUT.
  define('PUT', 'presence', roles(...SERVING), async ({ request, user }) => {
    const input = z
      .object({
        online: z.boolean(),
        counter: z.string().trim().max(40).optional(),
      })
      .parse(await body(request));
    await query('SELECT qms.set_presence($1,$2,$3)', [
      user.id,
      input.online,
      input.counter ?? null,
    ]);
    return json({ ok: true });
  }),
  define(
    'GET',
    'checkin-link',
    roles(...MANAGERS, 'reception', 'display'),
    async () => json(await checkinLink()),
  ),
  // Marking notifications read changes part of a resource, hence PATCH.
  define('PATCH', 'notifications', roles(...STAFF), async ({ request, user }) => {
    const input = z
      .object({ ids: z.array(z.coerce.number().int().positive()).max(100) })
      .parse(await body(request));
    await query(
      'UPDATE qms.notifications SET read_at=now() WHERE user_id=$1 AND id=ANY($2::bigint[])',
      [user.id, input.ids],
    );
    return json({ ok: true });
  }),
  define('GET', 'display', roles(...MANAGERS, 'display'), async () => {
    // The board shows one featured ticket and six more; fetch exactly that.
    const tickets = await query(
      "SELECT number,service_name,department,status,counter,called_at FROM qms.ticket_view WHERE status IN ('called','serving') ORDER BY called_at DESC LIMIT 7",
    );
    const [waiting] = await query(
      "SELECT count(*)::int total FROM qms.tickets WHERE status='waiting'",
    );
    return json({ tickets, waiting: waiting.total });
  }),
];
