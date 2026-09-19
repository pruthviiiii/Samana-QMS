import { query } from './db';
import { sfRequest } from './salesforce';
type Job = {
  id: string;
  ticket_id: string;
  kind: 'sms' | 'salesforce';
  attempts: number;
  revision: number;
  lease_token: string;
};
export function salesforcePayload(
  ticket: Record<string, unknown>,
  comments: unknown[],
) {
  const seconds = (a: unknown, b: unknown) =>
    typeof a === 'string' && typeof b === 'string'
      ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000))
      : null;
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
    comments,
  };
}
export async function processJobs() {
  const smsEnabled =
    process.env.SMS_ENABLED === 'true' &&
    !!process.env.SMS_GATEWAY_URL &&
    !!process.env.SMS_GATEWAY_TOKEN;
  const sfEnabled = process.env.SALESFORCE_WRITE_ENABLED === 'true';
  await query(
    "UPDATE qms.outbox SET status='disabled',last_error=CASE kind WHEN 'sms' THEN 'SMS gateway is not configured or enabled.' ELSE 'Salesforce write-back is disabled pending approval.' END WHERE status='pending' AND ((kind='sms' AND NOT $1) OR (kind='salesforce' AND NOT $2))",
    [smsEnabled, sfEnabled],
  );
  await query(
    "UPDATE qms.outbox SET status='failed',locked_at=NULL,last_error='Delivery worker stopped during the final attempt. Review before retrying.' WHERE status='processing' AND attempts>=5 AND locked_at<now()-interval '5 minutes'",
  );
  await query(
    "UPDATE qms.outbox SET status='pending',last_error=NULL WHERE status='disabled' AND ((kind='sms' AND $1) OR (kind='salesforce' AND $2))",
    [smsEnabled, sfEnabled],
  );
  const jobs = await query<Job>(
    `WITH selected AS (SELECT id FROM qms.outbox WHERE ((kind='sms' AND $1) OR (kind='salesforce' AND $2)) AND ((status='pending' AND available_at<=now()) OR (status='processing' AND locked_at<now()-interval '5 minutes')) AND attempts<5 ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 10) UPDATE qms.outbox o SET status='processing',locked_at=now(),lease_token=gen_random_uuid(),attempts=attempts+1 FROM selected WHERE o.id=selected.id RETURNING o.*`,
    [smsEnabled, sfEnabled],
  );
  let sent = 0;
  for (const job of jobs) {
    try {
      const [ticket] = await query<Record<string, string | null>>(
        `SELECT v.*,u.sf_id agent_sf_id,u.email agent_email,l.customer->>'email' customer_email FROM qms.ticket_view v LEFT JOIN qms.users u ON u.id=v.assigned_to JOIN qms.lookups l ON l.id=v.lookup_id WHERE v.id=$1`,
        [job.ticket_id],
      );
      let reference = '';
      if (job.kind === 'sms') {
        if (
          ticket.identifier_type !== 'mobile' ||
          !ticket.customer_id ||
          !ticket.mobile
        )
          throw new Error('SMS eligibility changed.');
        const url = new URL(process.env.SMS_GATEWAY_URL!);
        if (url.protocol !== 'https:')
          throw new Error('SMS gateway requires HTTPS.');
        const message = `SAMANA: Your ticket ${ticket.number} for ${ticket.service_name} is ready. Follow your visit: ${process.env.APP_ORIGIN}/visit/${ticket.public_token}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + process.env.SMS_GATEWAY_TOKEN,
            'Content-Type': 'application/json',
            'Idempotency-Key': job.id,
          },
          body: JSON.stringify({
            to: ticket.mobile,
            sender: process.env.SMS_SENDER || 'SAMANA',
            message,
            idempotencyKey: job.id,
          }),
          redirect: 'error',
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
        const comments = await query(
          "SELECT details->>'comment' body,u.name \"byName\",e.created_at at FROM qms.events e LEFT JOIN qms.users u ON u.id=e.actor_id WHERE ticket_id=$1 AND nullif(details->>'comment','') IS NOT NULL ORDER BY e.id",
          [job.ticket_id],
        );
        const result = (await sfRequest('/services/apexrest/api/QMSTicketAPI', {
          method: 'POST',
          body: JSON.stringify(salesforcePayload(ticket, comments)),
        })) as { isSuccess?: boolean; recordId?: string };
        if (!result.isSuccess)
          throw new Error('Salesforce did not accept the ticket payload.');
        reference = result.recordId || '';
      }
      await query(
        "UPDATE qms.outbox SET status=CASE WHEN revision=$2 THEN 'sent' ELSE 'pending' END,locked_at=NULL,lease_token=NULL,last_error=NULL,provider_reference=$3,attempts=CASE WHEN revision=$2 THEN attempts ELSE 0 END,available_at=now() WHERE id=$1 AND lease_token=$4",
        [job.id, job.revision, reference, job.lease_token],
      );
      sent++;
    } catch {
      await query(
        "UPDATE qms.outbox SET status=CASE WHEN revision<>$3 THEN 'pending' WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,attempts=CASE WHEN revision<>$3 THEN 0 ELSE attempts END,available_at=now()+make_interval(secs=>least(3600,power(2,attempts)::int*15)),locked_at=NULL,lease_token=NULL,last_error=$2 WHERE id=$1 AND lease_token=$4",
        [
          job.id,
          job.kind === 'sms'
            ? 'SMS delivery failed. Check gateway configuration.'
            : 'Salesforce synchronization failed. Check the integration contract.',
          job.revision,
          job.lease_token,
        ],
      );
    }
  }
  return { processed: jobs.length, sent };
}
