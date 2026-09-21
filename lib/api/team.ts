import { z } from 'zod';
import { query } from '../db';
import { HttpError, body, json, rateLimit } from '../http';
import { hashPassword } from '../security';
import { SERVICES, SERVICE_IDS, STAFF_ROLES } from '../domain';
import { searchUsers } from '../salesforce';
import { define, roles } from '../router';
import {
  MANAGERS,
  passwordSchema,
  salesforceUserId,
  userColumns,
  uuid,
} from './shared';
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
  actor: string,
  input: z.infer<typeof memberSchema>,
) {
  await query('SELECT qms.save_user($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [
    id,
    actor,
    input.username.toLowerCase(),
    input.name,
    input.role,
    input.sfId || null,
    input.managerSfId || null,
    input.services,
    input.counter,
    input.enabled,
    input.password ? await hashPassword(input.password) : null,
    input.email ? input.email.trim().toLowerCase() : null,
  ]);
  return json({ ok: true });
}
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
    const [result] = await query<{ services: string[] }>(
      'SELECT qms.set_queue_member($1,$2,$3,$4) services',
      [serviceId, userId, member, user.id],
    );
    return json({ ok: true, services: result.services });
  };
export const teamRoutes = [
  define(
    'GET',
    'team',
    roles(...MANAGERS),
    'Staff directory with active ticket counts',
    async () =>
      json({
        users: await query(
          `SELECT ${userColumns},(SELECT count(*)::int FROM qms.tickets t WHERE t.assigned_to=u.id AND t.status IN ('waiting','called','serving')) active_tickets FROM qms.users u WHERE role<>'customer' ORDER BY role,name`,
        ),
      }),
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
    async () => {
      const [members, eligible] = await Promise.all([
        query(
          "SELECT u.id,u.name,u.role,u.online,u.last_seen,u.enabled,u.counter,s.id service_id FROM qms.services s JOIN qms.users u ON s.id=ANY(u.services) WHERE u.role IN ('admin','hod','manager','agent') ORDER BY s.department,s.name,u.name",
        ),
        query(
          "SELECT id,name,role,enabled FROM qms.users WHERE role IN ('admin','hod','manager','agent') ORDER BY name",
        ),
      ]);
      return json({ services: SERVICES, members, eligible });
    },
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
      if (!q) throw new HttpError(400, 'Enter a search term.');
      return json({ users: await searchUsers(q) });
    },
  ),
];
