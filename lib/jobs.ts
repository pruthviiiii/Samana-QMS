import { config } from './config';
import { comments } from './data/events';
import * as outbox from './data/outbox';
import { sfRequest } from './salesforce';
import { HttpError } from './http';
// Delivery of finished visits to Salesforce and of ticket notices to the SMS
// gateway, from the outbox. Each delivery is claimed with a lease, sent once
// with an idempotency key, and marked sent or scheduled for a retry with
// exponential backoff; five failures park it for a person to review.
export function salesforcePayload(
  ticket: Record<string, unknown>,
  notes: unknown[],
) {
  const epoch = (value: unknown) =>
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  const seconds = (a: unknown, b: unknown) => {
    const start = epoch(a),
      end = epoch(b);
    return Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, Math.round((end - start) / 1000))
      : null;
  };
  return {
    qmsTicketNumber: 'SAMANA-' + ticket.id,
    recordType: ticket.identifier_type === 'mobile' ? 'Mobile' : 'Reception',
    isGuest: !ticket.customer_id,
    customerName: ticket.customer_name,
    customerMobile: ticket.mobile,
    customerEmail: ticket.customer_email,
    emiratesId: ticket.emirates_id,
    passportNumber: ticket.passport_number,
    accountId: ticket.customer_id,
    unitNumber: ticket.unit_name,
    salesBookingReference: ticket.booking_number,
    department: ticket.department,
    reason: ticket.service_id,
    reasonLabel:
      ticket.service_id === 'crm-noc'
        ? 'NOC/Resale'
        : ['general', 'crm-general'].includes(String(ticket.service_id))
          ? 'General Enquiry'
          : ticket.service_name,
    queueId: ticket.service_id,
    handledByEmployeeId: ticket.agent_sf_id,
    handledByName: ticket.assigned_name,
    handledByEmail: ticket.agent_email,
    meetingRoom: ticket.counter,
    outcome:
      ticket.status === 'closed'
        ? 'Completed'
        : ticket.status === 'no_show'
          ? 'No Show'
          : null,
    waitingSeconds: seconds(
      ticket.created_at,
      ticket.called_at || ticket.closed_at,
    ),
    serviceSeconds: seconds(ticket.started_at, ticket.closed_at),
    createdAt: ticket.created_at,
    serviceStartedAt: ticket.started_at,
    completedAt: ticket.closed_at,
    comments: notes,
  };
}
export async function processJobs() {
  const settings = config();
  const gateway = settings.SMS_GATEWAY_URL;
  const gatewayToken = settings.SMS_GATEWAY_TOKEN;
  const smsEnabled = settings.SMS_ENABLED && !!gateway && !!gatewayToken;
  const sfEnabled = settings.SALESFORCE_WRITE_ENABLED;
  await outbox.reconcileEnabled(smsEnabled, sfEnabled);
  const jobs = await outbox.claim(smsEnabled, sfEnabled);
  let sent = 0;
  for (const job of jobs) {
    try {
      const ticket = await outbox.ticketForDelivery(job.ticket_id);
      if (!ticket) throw new Error('The ticket for this delivery no longer exists.');
      let reference = '';
      if (job.kind === 'sms') {
        if (ticket.identifier_type !== 'mobile' || !ticket.customer_id || !ticket.mobile)
          throw new Error('SMS eligibility changed.');
        const message = `SAMANA: Your ticket ${ticket.number} for ${ticket.service_name} is ready. Follow your visit: ${settings.APP_ORIGIN}/visit/${String(ticket.public_token)}`;
        const response = await fetch(new URL(gateway as string), {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + gatewayToken,
            'Content-Type': 'application/json',
            'Idempotency-Key': job.id,
          },
          body: JSON.stringify({
            to: ticket.mobile,
            sender: settings.SMS_SENDER || 'SAMANA',
            message,
            idempotencyKey: job.id,
          }),
          redirect: 'manual', // a 3xx fails the ok check below
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error('SMS gateway rejected the request.');
        const result = (await response.json()) as {
          id?: string;
          success?: boolean;
        };
        if (result.success === false)
          throw new Error('SMS gateway reported failure.');
        reference = result.id || '';
      } else {
        const notes = await comments(job.ticket_id);
        const result = (await sfRequest('/services/apexrest/api/QMSTicketAPI', {
          method: 'POST',
          body: JSON.stringify(salesforcePayload(ticket, notes)),
        })) as { isSuccess?: boolean; statusCode?: number; recordId?: string };
        if (
          result.isSuccess !== true ||
          result.statusCode !== 200 ||
          !result.recordId ||
          !/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(result.recordId)
        )
          throw new Error('Salesforce did not accept the ticket payload.');
        reference = result.recordId;
      }
      await outbox.complete(job.id, job.revision, reference, job.lease_token);
      sent++;
    } catch (error) {
      await outbox.fail(
        job.id,
        job.revision,
        job.kind === 'sms'
          ? 'SMS delivery failed. Check gateway configuration.'
          : error instanceof HttpError
            ? error.message
            : 'Salesforce did not confirm a saved record. Check the integration contract.',
        job.lease_token,
      );
    }
  }
  return { processed: jobs.length, sent };
}
