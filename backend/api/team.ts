import { z } from 'zod';
import { saveUser, setQueueMember, setServicePriority } from '../data/functions';
import { directory, queueMembership } from '../data/users';
import { HttpError, body, json, rateLimit } from '../http';
import { hashPassword } from '../security';
import { MAX_PRIORITY, SERVICES, SERVICE_IDS, STAFF_ROLES } from '@qms/shared';
import { searchUsers } from '../salesforce';
import { define, roles } from '../router';
import { MANAGERS, passwordSchema, salesforceUserId, uuid } from './shared';
const memberSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[a-zA-Z0-9@._+-]+$/),
  name: z.string().trim().min(2).max(100),
  email: z.email().max(254).nullable().optional(),
  role: z.enum(STAFF_ROLES),
  sfId: salesforceUserId,
  managerSfId: salesforceUserId,
  services: z.array(z.enum(SERVICE_IDS)).max(SERVICE_IDS.length),
  counter: z.string().max(40),
  enabled: z.boolean(),
  password: passwordSchema.optional(),
});
async function saveMember(
  id: string | null,
  actorId: string,
  input: z.infer<typeof memberSchema>,
) {
  await saveUser({
    id,
    actorId,
    username: input.username.toLowerCase(),
    name: input.name,
    role: input.role,
    sfId: input.sfId || null,
    managerSfId: input.managerSfId || null,
    services: input.services,
    counter: input.counter,
    enabled: input.enabled,
    passwordHash: input.password ? await hashPassword(input.password) : null,
    email: input.email ? input.email.trim().toLowerCase() : null,
  });
  return json({ ok: true });
}
const prioritySchema = z.object({
  priority: z.number().int().min(0).max(MAX_PRIORITY),
});
const membership =
  (member: boolean) =>
  async ({
    params,
    user,
  }: {
    params: Record<string, string>;
    user: { id: string };
  }) => {
    const serviceId = z.enum(SERVICE_IDS).parse(params.service);
    const userId = uuid.parse(params.user);
    const services = await setQueueMember(serviceId, userId, member, user.id);
    return json({ ok: true, services });
  };
export const teamRoutes = [
  define(
    'GET',
    'team',
    roles(...MANAGERS),
    'Staff directory with active ticket counts',
    async () => json({ users: await directory() }),
  ),
  define(
    'POST',
    'team',
    roles('admin'),
    'Create a staff member',
    async ({ request, user }) =>
      saveMember(null, user.id, memberSchema.parse(await body(request))),
    memberSchema,
  ),
  define(
    'PUT',
    'team/:id',
    roles('admin'),
    "Replace a staff member's details",
    async ({ request, params, user }) =>
      saveMember(
        uuid.parse(params.id),
        user.id,
        memberSchema.parse(await body(request)),
      ),
    memberSchema,
  ),
  // Queue membership is app data only; nothing here touches Salesforce.
  define(
    'GET',
    'queues',
    roles(...MANAGERS),
    'Queue membership per service and the eligible staff',
    async () => json({ services: SERVICES, ...(await queueMembership()) }),
  ),
  define(
    'PUT',
    'queues/:service/members/:user',
    roles(...MANAGERS),
    'Add a member to a service queue',
    membership(true),
  ),
  define(
    'DELETE',
    'queues/:service/members/:user',
    roles(...MANAGERS),
    'Remove a member from a service queue',
    membership(false),
  ),
  // Urgency is a property of the service, hence PUT on the service itself. A
  // waiting customer in a higher-priority service is routed before an older one
  // elsewhere; inside a service, arrival order still decides.
  define(
    'PUT',
    'queues/:service/priority',
    roles(...MANAGERS),
    'Set how urgently a service is routed (0 normal to 9 urgent)',
    async ({ params, request, user }) => {
      const serviceId = z.enum(SERVICE_IDS).parse(params.service);
      const input = prioritySchema.parse(await body(request));
      const priority = await setServicePriority(serviceId, input.priority, user.id);
      return json({ ok: true, priority });
    },
    prioritySchema,
  ),
  // On-demand search through QMSUserAPI; nothing is imported in bulk.
  define(
    'GET',
    'integrations/salesforce/users',
    roles('admin'),
    'Search Salesforce users by name or email (q=, at least 3 characters)',
    async ({ url, user }) => {
      await rateLimit('sfusers:' + user.id, 30, 60);
      const q = z
        .string()
        .trim()
        .min(3, 'Enter at least 3 characters to search.')
        .max(100)
        .parse(url.searchParams.get('q') ?? '');
      if (!q) throw new HttpError(400, 'Enter a search term.', 'INVALID_INPUT');
      return json({ users: await searchUsers(q) });
    },
  ),
];
