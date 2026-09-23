import { z } from 'zod';
import { setPresence } from '../data/functions';
import { markRead } from '../data/notifications';
import { board } from '../data/tickets';
import { body, json } from '../http';
import { queue } from '../operations';
import { checkinLink } from '../public-access';
import { define, roles } from '../router';
import { MANAGERS, SERVING, STAFF } from './shared';
const presenceSchema = z.object({
  online: z.boolean(),
  counter: z.string().trim().max(40).optional(),
});
const notificationsSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).max(100),
});
export const queueRoutes = [
  define(
    'GET',
    'queue',
    roles(...STAFF),
    'Live queue page with counts, statistics and notifications',
    async ({ url, user }) => json(await queue(user, url)),
  ),
  // Availability is a state the agent sets, hence PUT.
  define(
    'PUT',
    'presence',
    roles(...SERVING),
    'Go online or offline and set the counter',
    async ({ request, user }) => {
      const input = presenceSchema.parse(await body(request));
      await setPresence(user.id, input.online, input.counter ?? null);
      return json({ ok: true });
    },
    presenceSchema,
  ),
  define(
    'GET',
    'checkin-link',
    roles(...MANAGERS, 'reception', 'display'),
    'Rotating QR invite for the check-in page',
    async () => json(await checkinLink()),
  ),
  // Marking notifications read changes part of a resource, hence PATCH.
  define(
    'PATCH',
    'notifications',
    roles(...STAFF),
    'Mark notifications as read',
    async ({ request, user }) => {
      const input = notificationsSchema.parse(await body(request));
      await markRead(user.id, input.ids);
      return json({ ok: true });
    },
    notificationsSchema,
  ),
  define(
    'GET',
    'display',
    roles(...MANAGERS, 'display'),
    'TV board data: called and serving tickets and the waiting count',
    async () => json(await board()),
  ),
];
