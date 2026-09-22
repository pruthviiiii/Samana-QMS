import { z } from 'zod';
// Shapes of the rows that come back from raw SQL: the queue engine's functions,
// the ticket view, aggregates and the two atomic statements. Every raw result
// is parsed against one of these before it is used, so a column that goes
// missing or changes type fails here, with the row named, rather than reaching
// a screen as `undefined`. Records read through the Prisma client do not need
// this: their types come from prisma/schema.prisma at compile time.
//
// Timestamps arrive as Date objects from the driver and as ISO strings when a
// function returns a row as JSON; both serialise the same way, so both pass.
const timestamp = z.union([z.string(), z.date()]);
const nullableTimestamp = timestamp.nullable();
// PostgreSQL numerics arrive as strings so no precision is lost; floats as numbers.
const decimal = z.union([z.string(), z.number()]);

export const ticketStatus = z.enum(['waiting', 'called', 'serving', 'closed', 'no_show']);
export const identifierType = z.enum(['mobile', 'emiratesId', 'passportNumber']);

/** A row of qms.ticket_view, also what issue_ticket and ticket_action return. */
export const ticketRow = z.looseObject({
  id: z.string(),
  number: z.string(),
  service_id: z.string(),
  department: z.string(),
  service_name: z.string(),
  status: ticketStatus,
  customer_name: z.string(),
  customer_id: z.string().nullable(),
  unit_id: z.string().nullable(),
  unit_name: z.string().nullable(),
  project_name: z.string().nullable(),
  booking_number: z.string().nullable(),
  assigned_to: z.string().nullable(),
  assigned_name: z.string().nullable(),
  counter: z.string().nullable(),
  created_at: timestamp,
  assigned_at: nullableTimestamp,
  called_at: nullableTimestamp,
  started_at: nullableTimestamp,
  closed_at: nullableTimestamp,
  routing_reason: z.string(),
  comments: z.string().nullable(),
  version: z.number().int(),
  identifier_type: identifierType,
  mobile: z.string().nullable().optional(),
  emirates_id: z.string().nullable().optional(),
  passport_number: z.string().nullable().optional(),
  public_token: z.string().optional(),
});
export type TicketRecord = z.infer<typeof ticketRow>;

/** The ticket as the delivery worker needs it: the view plus agent and email. */
export const deliveryTicketRow = ticketRow.extend({
  agent_sf_id: z.string().nullable(),
  agent_email: z.string().nullable(),
  customer_email: z.string().nullable(),
});

/** A claimed delivery from qms.outbox. */
export const jobRow = z.object({
  id: z.string(),
  ticket_id: z.string(),
  kind: z.enum(['sms', 'salesforce']),
  attempts: z.number().int(),
  revision: z.number().int(),
  lease_token: z.string(),
});
export type JobRecord = z.infer<typeof jobRow>;

/** A closing note, as sent to Salesforce with the ticket. */
export const commentRow = z.object({
  body: z.string().nullable(),
  byName: z.string().nullable(),
  at: timestamp,
});

export const countRow = z.object({ total: z.number().int() });
export const checkedRow = z.object({ checked: z.number().int() });

/** Headline numbers on the live queue. */
export const queueStatisticsRow = z.object({
  waiting: z.number().int(),
  serving: z.number().int(),
  completed: z.number().int(),
  avg_wait: z.number(),
  unassigned: z.number().int(),
});

/** One service with its live counts. */
export const serviceCountRow = z.object({
  id: z.string(),
  name: z.string(),
  department: z.string(),
  prefix: z.string(),
  waiting: z.number().int(),
  serving: z.number().int(),
});

/** What the reception TV shows for one ticket. */
export const boardRow = z.object({
  number: z.string(),
  service_name: z.string(),
  department: z.string(),
  status: ticketStatus,
  counter: z.string().nullable(),
  called_at: nullableTimestamp,
});

/** What a customer's phone may see about their own ticket. */
export const publicStatusRow = z.object({
  number: z.string(),
  service_name: z.string(),
  status: ticketStatus,
  counter: z.string().nullable(),
  waiting_ahead: z.number().int(),
});

/** Report rows: the view plus two computed durations. */
export const reportRow = ticketRow.extend({
  service_minutes: decimal.nullable(),
  wait_minutes: decimal.nullable(),
});
export const reportSummaryRow = z.object({
  tickets: z.number().int(),
  completed: z.number().int(),
  no_show: z.number().int(),
  average_service_minutes: z.number(),
  average_wait_minutes: z.number(),
});
export const reportServiceRow = z.object({
  service_id: z.string(),
  service_name: z.string(),
  department: z.string(),
  tickets: z.number().int(),
  completed: z.number().int(),
  average_service_minutes: z.number(),
});

/** Result of a rate-limit upsert. */
export const rateLimitRow = z.object({ count: z.number().int() });

/** Parses every row of a result set against one schema, naming the query on failure. */
export function rows<T extends z.ZodType>(schema: T, result: unknown[], label: string): z.infer<T>[] {
  return result.map((row, index) => {
    const parsed = schema.safeParse(row);
    if (!parsed.success)
      throw new Error(
        `Unexpected row shape from ${label} (row ${index}): ` +
          parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; '),
      );
    return parsed.data;
  });
}
/** Parses exactly one row, which must exist. */
export function one<T extends z.ZodType>(schema: T, result: unknown[], label: string): z.infer<T> {
  if (!result.length) throw new Error(`Expected one row from ${label}, got none.`);
  return rows(schema, [result[0]], label)[0];
}
