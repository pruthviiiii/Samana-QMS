import { z } from 'zod';
import { issueTicket, ticketAction } from '../data/functions';
import * as lookups from '../data/lookups';
import { HttpError, body, json, rateLimit } from '../http';
import { normalizeIdentifier, SERVICE_IDS, type Customer } from '@qms/shared';
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
        throw new HttpError(400, (e as Error).message, 'INVALID_INPUT');
      }
      if (input.walkIn && user.role === 'customer')
        throw new HttpError(403, 'Please ask reception for help.', 'FORBIDDEN');
      let customer: Customer;
      let reused = false;
      if (input.walkIn) customer = walkInCustomer();
      else {
        // The same identifier looked up again within two minutes (a retry or
        // a second screen) reuses the registered snapshot instead of asking
        // Salesforce twice.
        const recent = await lookups.recentRegistered(input.type, value);
        if (recent) {
          customer = recent;
          reused = true;
        } else customer = await lookupCustomer(input.type, value);
      }
      if (input.type === 'emiratesId') customer.emiratesId = value;
      if (input.type === 'passportNumber') customer.passportNumber = value;
      const lookup = await lookups.create(user.id, input.type, value, customer);
      await audit(user.id, 'customer_lookup', {
        type: input.type,
        registered: customer.registered,
        ...(input.walkIn ? { degraded: true } : {}),
        ...(reused ? { reused: true } : {}),
      });
      return json({
        lookupId: lookup.id,
        expiresAt: lookup.expiresAt,
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
      const ticket = await issueTicket({
        lookupId: input.lookupId,
        serviceId: input.serviceId,
        unitId: input.unitId,
        requestId: input.requestId,
        actorId: user.id,
      });
      return json(user.role === 'customer' ? receipt(ticket) : ticket, 201);
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
        user.role === 'customer' ? { ticket: receipt(details.ticket) } : details,
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
      return json({ ticket: receipt(details.ticket) });
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
      const ticket = await ticketAction({
        ticketId: id,
        action: input.action,
        actorId: user.id,
        version: input.version,
        comment: input.comment || null,
        targetId: input.targetId || null,
      });
      return json(ticket);
    },
    actionSchema,
  ),
];
