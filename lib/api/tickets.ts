import { z } from 'zod';
import { query } from '../db';
import { HttpError, body, json, rateLimit } from '../http';
import { normalizeIdentifier, SERVICE_IDS, type Customer } from '../domain';
import { lookupCustomer } from '../salesforce';
import { ticketDetail } from '../operations';
import { publicCustomer, receipt } from '../public-access';
import { define, roles } from '../router';
import { SERVING, STAFF, audit, uuid } from './shared';
const walkInCustomer = (): Customer => ({
  registered: false,
  salesforceId: null,
  firstName: '',
  middleName: '',
  lastName: '',
  name: 'Walk-in customer',
  mobile: null,
  emiratesId: null,
  passportNumber: null,
  units: [],
});
const lookupSchema = z.object({
  type: z.enum(['mobile', 'emiratesId', 'passportNumber']),
  value: z.string().max(100),
  // Staff may register a walk-in without Salesforce when it is down.
  walkIn: z.boolean().optional(),
});
const issueSchema = z.object({
  lookupId: uuid,
  serviceId: z.enum(SERVICE_IDS),
  unitId: z.string().max(100).nullable(),
  requestId: uuid,
});
const actionSchema = z.object({
  action: z.enum(['call', 'start', 'close', 'no_show', 'reassign']),
  version: z.number().int().positive(),
  comment: z.string().trim().max(4000).optional(),
  targetId: uuid.optional(),
});
export const ticketRoutes = [
  define(
    'POST',
    'customers/lookup',
    roles(...STAFF, 'customer'),
    'Identify a customer by mobile, Emirates ID or passport',
    async ({ request, user }) => {
      await rateLimit(
        'lookup:' + user.id,
        user.role === 'customer' ? 5 : 30,
        user.role === 'customer' ? 2700 : 60,
      );
      const input = lookupSchema.parse(await body(request));
      let value: string;
      try {
        value = normalizeIdentifier(input.type, input.value);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (input.walkIn && user.role === 'customer')
        throw new HttpError(403, 'Please ask reception for help.');
      let customer: Customer;
      let reused = false;
      if (input.walkIn) customer = walkInCustomer();
      else {
        // The same identifier looked up again within two minutes (a retry or
        // a second screen) reuses the registered snapshot instead of asking
        // Salesforce twice.
        const [recent] = await query<{ customer: Customer }>(
          "SELECT customer FROM qms.lookups WHERE identifier_type=$1 AND identifier_value=$2 AND created_at>now()-interval '2 minutes' AND (customer->>'registered')::boolean ORDER BY created_at DESC LIMIT 1",
          [input.type, value],
        );
        if (recent) {
          customer = recent.customer;
          reused = true;
        } else customer = await lookupCustomer(input.type, value);
      }
      if (input.type === 'emiratesId') customer.emiratesId = value;
      if (input.type === 'passportNumber') customer.passportNumber = value;
      const [lookup] = await query<{ id: string; expires_at: string }>(
        'INSERT INTO qms.lookups(actor_id,identifier_type,identifier_value,customer) VALUES($1,$2,$3,$4::jsonb) RETURNING id,expires_at',
        [user.id, input.type, value, JSON.stringify(customer)],
      );
      await audit(user.id, 'customer_lookup', {
        type: input.type,
        registered: customer.registered,
        ...(input.walkIn ? { degraded: true } : {}),
        ...(reused ? { reused: true } : {}),
      });
      return json({
        lookupId: lookup.id,
        expiresAt: lookup.expires_at,
        customer:
          user.role === 'customer' ? publicCustomer(customer) : customer,
      });
    },
    lookupSchema,
  ),
  define(
    'POST',
    'tickets',
    roles(...STAFF, 'customer'),
    'Issue a ticket from a lookup; idempotent by requestId',
    async ({ request, user }) => {
      const input = issueSchema.parse(await body(request));
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
    },
    issueSchema,
  ),
  define(
    'GET',
    'tickets/:id',
    roles(...STAFF, 'customer'),
    'Ticket detail with its events and delivery state',
    async ({ params, user }) => {
      const details = await ticketDetail(user, uuid.parse(params.id));
      return json(
        user.role === 'customer'
          ? {
              ticket: receipt(
                details.ticket as unknown as Record<string, unknown>,
              ),
            }
          : details,
      );
    },
  ),
  define(
    'GET',
    'tickets/:id/print',
    roles(...STAFF, 'customer'),
    'Printable receipt for a ticket',
    async ({ params, user }) => {
      const details = await ticketDetail(user, uuid.parse(params.id));
      return json({
        ticket: receipt(details.ticket as unknown as Record<string, unknown>),
      });
    },
  ),
  define(
    'POST',
    'tickets/:id/action',
    roles(...SERVING),
    'Call, start, close, no-show or reassign a ticket',
    async ({ request, params, user }) => {
      const id = uuid.parse(params.id);
      const input = actionSchema.parse(await body(request));
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
    },
    actionSchema,
  ),
];
