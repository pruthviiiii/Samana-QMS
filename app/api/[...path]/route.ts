import { z } from 'zod';
import { query } from '@/lib/db';
import {
  endpoint,
  json,
  body,
  sameOrigin,
  requireUser,
  HttpError,
  sessionCookie,
  rateLimit,
} from '@/lib/http';
import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
} from '@/lib/security';
import {
  normalizeIdentifier,
  SERVICES,
  type User,
  type Customer,
} from '@/lib/domain';
import { queue, ticketDetail, reports } from '@/lib/operations';
import {
  lookupCustomer,
  integrationHealth,
  syncDirectory,
} from '@/lib/salesforce';
import { processJobs } from '@/lib/jobs';
import { listServiceGroups, syncServiceGroup } from '@/lib/salesforce-groups';
import {
  checkinLink,
  startGuest,
  publicCustomer,
  receipt,
} from '@/lib/public-access';
const uuid = z.uuid();
const userColumns =
  'id,username,name,email,role,sf_id,manager_sf_id,services,online,last_seen,counter,enabled,must_change_password';
const passwordSchema = z
  .string()
  .min(14, 'Use at least 14 characters.')
  .max(128);
async function handler(request: Request) {
  return endpoint(async () => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
    const method = request.method;
    if (path === 'health' && method === 'GET') {
      try {
        await query('SELECT 1 FROM qms.migrations LIMIT 1');
        return json({ status: 'ready' });
      } catch {
        return json({ status: 'unavailable' }, 503);
      }
    }
    if (path === 'jobs/run' && method === 'POST') {
      const secret = process.env.WORKER_SECRET;
      const token = request.headers
        .get('authorization')
        ?.replace(/^Bearer /, '');
      if (!secret || !token || (await sha256(token)) !== (await sha256(secret)))
        throw new HttpError(401, 'Unauthorized.');
      const result = await query('SELECT qms.route_due() checked');
      const jobs = await processJobs();
      return json({ routing: result[0], jobs });
    }
    if (method !== 'GET') sameOrigin(request);
    if (path === 'public/session' && method === 'POST') {
      const input = z
        .object({ invite: z.string().max(150) })
        .parse(await body(request));
      return startGuest(request, input.invite);
    }
    if (path.startsWith('public/status/') && method === 'GET') {
      const token = uuid.parse(path.slice('public/status/'.length));
      const [ticket] = await query(
        "SELECT number,service_name,status,counter,(SELECT count(*)::int FROM qms.tickets ahead WHERE ahead.service_id=v.service_id AND ahead.status='waiting' AND ahead.created_at<v.created_at) waiting_ahead FROM qms.ticket_view v WHERE public_token=$1 AND (closed_at IS NULL OR closed_at>now()-interval '1 day')",
        [token],
      );
      if (!ticket)
        throw new HttpError(404, 'Ticket link has expired or was not found.');
      return json(ticket);
    }
    if (path === 'auth/login' && method === 'POST') {
      const input = z
        .object({
          username: z.string().trim().min(1).max(120),
          password: z.string().min(1).max(128),
        })
        .parse(await body(request));
      const username = input.username.toLowerCase();
      await rateLimit('login:' + (await sha256(username)), 8, 300);
      const [u] = await query<User & { password_hash: string }>(
        // Username first; an email only when exactly one enabled account carries it.
        'SELECT * FROM qms.users u WHERE u.enabled=true AND (lower(u.username)=$1 OR (lower(u.email)=$1 AND (SELECT count(*) FROM qms.users x WHERE lower(x.email)=$1 AND x.enabled=true)=1)) ORDER BY (lower(u.username)=$1) DESC LIMIT 1',
        [username],
      );
      // Hash even unknown accounts to avoid fast username enumeration.
      const valid = await verifyPassword(
        input.password,
        u?.password_hash ||
          'pbkdf2$100000$0123456789abcdef$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
      if (!u || !valid)
        throw new HttpError(401, 'Incorrect username or password.');
      const token = randomToken();
      await query(
        "INSERT INTO qms.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
        [await sha256(token), u.id],
      );
      const [user] = await query(
        `SELECT ${userColumns} FROM qms.users WHERE id=$1`,
        [u.id],
      );
      return json({ user }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    const user = await requireUser(request);
    if (path === 'auth/me' && method === 'GET')
      return json({ user, services: SERVICES });
    if (path === 'auth/logout' && method === 'POST') {
      // Use the same routing lock and active-service guard as the presence toggle.
      await query('SELECT qms.set_presence($1,false)', [user.id]);
      const token = request.headers
        .get('cookie')
        ?.match(/qms_session=([a-f0-9]{64})/)?.[1];
      if (token)
        await query('DELETE FROM qms.sessions WHERE token_hash=$1', [
          await sha256(token),
        ]);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }
    if (path === 'auth/password' && method === 'POST') {
      if (user.role === 'customer')
        throw new HttpError(403, 'Customer visits cannot set passwords.');
      const input = z
        .object({
          currentPassword: z.string().min(1).max(128),
          newPassword: passwordSchema,
        })
        .parse(await body(request));
      await rateLimit('password:' + user.id, 5, 300);
      const [u] = await query<{ password_hash: string }>(
        'SELECT password_hash FROM qms.users WHERE id=$1',
        [user.id],
      );
      if (!(await verifyPassword(input.currentPassword, u.password_hash)))
        throw new HttpError(400, 'Current password is incorrect.');
      if (input.currentPassword === input.newPassword)
        throw new HttpError(400, 'Choose a different password.');
      const token = randomToken();
      const { db } = await import('@/lib/db');
      const sql = db();
      await sql.transaction([
        sql.query(
          'UPDATE qms.users SET password_hash=$1,must_change_password=false WHERE id=$2',
          [await hashPassword(input.newPassword), user.id],
        ),
        sql.query('DELETE FROM qms.sessions WHERE user_id=$1', [user.id]),
        sql.query(
          "INSERT INTO qms.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
          [await sha256(token), user.id],
        ),
      ]);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    if (user.must_change_password)
      throw new HttpError(
        403,
        'Change your temporary password before continuing.',
      );
    const allow = (roles: string[]) => {
      if (!roles.includes(user.role))
        throw new HttpError(403, 'You do not have permission for this action.');
    };
    if (path === 'presence' && method === 'POST') {
      allow(['admin', 'hod', 'manager', 'agent']);
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
    }
    if (path === 'checkin-link' && method === 'GET') {
      allow(['admin', 'hod', 'manager', 'reception', 'display']);
      return json(await checkinLink());
    }
    if (path === 'queue' && method === 'GET') {
      allow(['admin', 'hod', 'manager', 'agent', 'reception']);
      return json(await queue(user, url));
    }
    if (path === 'customers/lookup' && method === 'POST') {
      allow(['admin', 'hod', 'manager', 'agent', 'reception', 'customer']);
      await rateLimit(
        'lookup:' + user.id,
        user.role === 'customer' ? 5 : 30,
        user.role === 'customer' ? 2700 : 60,
      );
      const input = z
        .object({
          type: z.enum(['mobile', 'emiratesId', 'passportNumber']),
          value: z.string().max(100),
        })
        .parse(await body(request));
      let value: string;
      try {
        value = normalizeIdentifier(input.type, input.value);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const customer: Customer = await lookupCustomer(input.type, value);
      if (input.type === 'emiratesId') customer.emiratesId = value;
      if (input.type === 'passportNumber') customer.passportNumber = value;
      const [lookup] = await query<{ id: string; expires_at: string }>(
        'INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES($1,$2,$3,$4::jsonb) RETURNING id,expires_at',
        [user.id, input.type, value, JSON.stringify(customer)],
      );
      await query(
        "INSERT INTO qms.events(actor_id,action,details) VALUES($1,'customer_lookup',$2::jsonb)",
        [
          user.id,
          JSON.stringify({ type: input.type, registered: customer.registered }),
        ],
      );
      return json({
        lookupId: lookup.id,
        expiresAt: lookup.expires_at,
        customer:
          user.role === 'customer' ? publicCustomer(customer) : customer,
      });
    }
    if (path === 'tickets' && method === 'POST') {
      allow(['admin', 'hod', 'manager', 'agent', 'reception', 'customer']);
      const input = z
        .object({
          lookupId: uuid,
          serviceId: z.enum([
            'crm-general',
            'crm-noc',
            'crm-refund',
            'crm-handover',
            'collection',
            'general',
          ]),
          unitId: z.string().max(100).nullable(),
          requestId: uuid,
        })
        .parse(await body(request));
      const [result] = await query<{ ticket: unknown }>(
        'SELECT qms.issue_ticket($1,$2,$3,$4,$5) ticket',
        [
          input.lookupId,
          input.serviceId,
          input.unitId,
          input.requestId,
          user.id,
        ],
      );
      return json(
        user.role === 'customer'
          ? receipt(result.ticket as Record<string, unknown>)
          : result.ticket,
        201,
      );
    }
    const ticketMatch = path.match(
      /^tickets\/([a-f0-9-]{36})(?:\/(action|print))?$/,
    );
    if (ticketMatch) {
      const id = uuid.parse(ticketMatch[1]);
      if (method === 'GET') {
        allow(['admin', 'hod', 'manager', 'agent', 'reception', 'customer']);
        const details = await ticketDetail(user, id);
        return json(
          user.role === 'customer' || ticketMatch[2] === 'print'
            ? {
                ticket: receipt(
                  details.ticket as unknown as Record<string, unknown>,
                ),
              }
            : details,
        );
      }
      if (method === 'POST' && ticketMatch[2] === 'action') {
        allow(['admin', 'hod', 'manager', 'agent']);
        const input = z
          .object({
            action: z.enum(['call', 'start', 'close', 'no_show', 'reassign']),
            version: z.number().int().positive(),
            comment: z.string().trim().max(4000).optional(),
            targetId: uuid.optional(),
          })
          .parse(await body(request));
        const [result] = await query<{ ticket: unknown }>(
          'SELECT qms.ticket_action($1,$2,$3,$4,$5,$6) ticket',
          [
            id,
            input.action,
            user.id,
            input.version,
            input.comment || null,
            input.targetId || null,
          ],
        );
        return json(result.ticket);
      }
    }
    if (path === 'notifications/read' && method === 'POST') {
      const input = z
        .object({ ids: z.array(z.coerce.number().int().positive()).max(100) })
        .parse(await body(request));
      await query(
        'UPDATE qms.notifications SET read_at=now() WHERE user_id=$1 AND id=ANY($2::bigint[])',
        [user.id, input.ids],
      );
      return json({ ok: true });
    }
    if (path === 'team' && method === 'GET') {
      allow(['admin', 'hod', 'manager']);
      const users = await query(
        `SELECT ${userColumns},(SELECT count(*)::int FROM qms.tickets t WHERE t.assigned_to=u.id AND t.status IN ('waiting','called','serving')) active_tickets FROM qms.users u WHERE role<>'customer' ORDER BY role,name`,
      );
      return json({ users });
    }
    if (path === 'team' && method === 'POST') {
      allow(['admin']);
      const input = z
        .object({
          id: uuid.optional(),
          username: z
            .string()
            .trim()
            .min(3)
            .max(120)
            .regex(/^[a-zA-Z0-9@._+-]+$/),
          name: z.string().trim().min(2).max(100),
          email: z.email().max(254).nullable().optional(),
          role: z.enum([
            'admin',
            'hod',
            'manager',
            'agent',
            'reception',
            'display',
          ]),
          sfId: z.string().max(18).nullable().optional(),
          managerSfId: z.string().max(18).nullable().optional(),
          services: z
            .array(
              z.enum([
                'crm-general',
                'crm-noc',
                'crm-refund',
                'crm-handover',
                'collection',
                'general',
              ]),
            )
            .max(6),
          counter: z.string().max(40),
          enabled: z.boolean(),
          password: passwordSchema.optional(),
        })
        .parse(await body(request));
      await query('SELECT qms.save_user($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [
        input.id || null,
        user.id,
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
    if (path === 'integrations' && method === 'GET') {
      allow(['admin', 'hod', 'manager']);
      return json(await integrationHealth());
    }
    if (path === 'integrations/salesforce/sync' && method === 'POST') {
      allow(['admin']);
      return json(await syncDirectory());
    }
    if (path === 'integrations/salesforce/groups') {
      allow(['admin']);
      if (method === 'GET') return json(await listServiceGroups());
      const input = z
        .object({
          serviceId: z.enum([
            'crm-general',
            'crm-noc',
            'crm-refund',
            'crm-handover',
            'collection',
            'general',
          ]),
          groupId: z.string().regex(/^00G[a-zA-Z0-9]{12,15}$/),
        })
        .parse(await body(request));
      return json(
        await syncServiceGroup(input.serviceId, input.groupId, user.id),
      );
    }
    if (path === 'reports' && method === 'GET') {
      allow(['admin', 'hod', 'manager']);
      const result = await reports(url);
      await query('INSERT INTO qms.events(actor_id,action) VALUES($1,$2)', [
        user.id,
        result instanceof Response ? 'report_export' : 'report_view',
      ]);
      return result instanceof Response ? result : json(result);
    }
    if (path === 'display' && method === 'GET') {
      allow(['admin', 'hod', 'manager', 'display']);
      const tickets = await query(
        "SELECT number,service_name,department,status,counter,called_at FROM qms.ticket_view WHERE status IN ('called','serving') ORDER BY called_at DESC LIMIT 12",
      );
      const [waiting] = await query(
        "SELECT count(*)::int total FROM qms.tickets WHERE status='waiting'",
      );
      return json({ tickets, waiting: waiting.total });
    }
    if (path === 'audit' && method === 'GET') {
      allow(['admin', 'hod', 'manager']);
      return json({
        events: await query(
          'SELECT e.id,e.action,e.details,e.created_at,t.number,u.name actor_name FROM qms.events e LEFT JOIN qms.users u ON u.id=e.actor_id LEFT JOIN qms.tickets t ON t.id=e.ticket_id ORDER BY e.id DESC LIMIT 100',
        ),
      });
    }
    throw new HttpError(404, 'Endpoint not found.');
  });
}
export const GET = handler;
export const POST = handler;
