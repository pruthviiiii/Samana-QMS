import { query } from '../db';
import { prisma } from '../prisma';
import { deliveryTicketRow, jobRow, one, rows } from './rows';
// Deliveries to Salesforce and the SMS gateway. A trigger writes one row per
// ticket and kind; the scheduler claims rows with a lease, delivers, and marks
// them sent or schedules a retry. The claim and the two completions stay as
// single SQL statements because each must be one atomic decision under
// concurrency: which rows are mine, and does my lease still hold.

/** Delivery states shown on a ticket's detail. */
export async function statesFor(ticketId: string) {
  return prisma().outbox.findMany({
    where: { ticket_id: ticketId },
    select: { kind: true, status: true, attempts: true, last_error: true },
  });
}

export async function failedCount() {
  return prisma().outbox.count({ where: { status: 'failed' } });
}

/** Parks deliveries whose integration is switched off, and releases them when it is on. */
export async function reconcileEnabled(smsEnabled: boolean, sfEnabled: boolean) {
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
}

/** Claims up to ten due deliveries with a fresh lease; concurrent workers skip each other's rows. */
export async function claim(smsEnabled: boolean, sfEnabled: boolean) {
  const result = await query(
    `WITH selected AS (SELECT id FROM qms.outbox WHERE ((kind='sms' AND $1) OR (kind='salesforce' AND $2)) AND ((status='pending' AND available_at<=now()) OR (status='processing' AND locked_at<now()-interval '5 minutes')) AND attempts<5 ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 10) UPDATE qms.outbox o SET status='processing',locked_at=now(),lease_token=gen_random_uuid(),attempts=attempts+1 FROM selected WHERE o.id=selected.id RETURNING o.id,o.ticket_id,o.kind,o.attempts,o.revision,o.lease_token`,
    [smsEnabled, sfEnabled],
  );
  return rows(jobRow, result, 'outbox claim');
}

/** The ticket as the delivery needs it, or null if it no longer exists. */
export async function ticketForDelivery(ticketId: string) {
  const result = await query(
    `SELECT v.*,u.sf_id agent_sf_id,u.email agent_email,l.customer->>'email' customer_email FROM qms.ticket_view v LEFT JOIN qms.users u ON u.id=v.assigned_to JOIN qms.lookups l ON l.id=v.lookup_id WHERE v.id=$1`,
    [ticketId],
  );
  return result.length ? one(deliveryTicketRow, result, 'delivery ticket') : null;
}

/** Marks a delivery sent, unless the ticket changed underneath it, in which case it goes again. */
export async function complete(jobId: string, revision: number, reference: string, lease: string) {
  await query(
    "UPDATE qms.outbox SET status=CASE WHEN revision=$2 THEN 'sent' ELSE 'pending' END,locked_at=NULL,lease_token=NULL,last_error=NULL,provider_reference=$3,attempts=CASE WHEN revision=$2 THEN attempts ELSE 0 END,available_at=now() WHERE id=$1 AND lease_token=$4",
    [jobId, revision, reference, lease],
  );
}

/** Schedules a retry with exponential backoff, or gives up after five attempts. */
export async function fail(jobId: string, revision: number, message: string, lease: string) {
  await query(
    "UPDATE qms.outbox SET status=CASE WHEN revision<>$3 THEN 'pending' WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,attempts=CASE WHEN revision<>$3 THEN 0 ELSE attempts END,available_at=now()+make_interval(secs=>least(3600,power(2,attempts)::int*15)),locked_at=NULL,lease_token=NULL,last_error=$2 WHERE id=$1 AND lease_token=$4",
    [jobId, message, revision, lease],
  );
}
