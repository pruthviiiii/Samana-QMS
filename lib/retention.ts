import { query } from './db';
// Retention is a policy the organisation sets, not a default the code picks.
// RETENTION_IDENTIFIER_DAYS anonymises the customer's name and identifiers on
// tickets closed longer ago than that; RETENTION_EVENT_DAYS deletes older
// audit events. Unset or 0 keeps everything. The scheduler tick applies the
// policy at most once an hour (the throttle lives in qms.apply_retention).
function days(name: string) {
  const value = process.env[name];
  return value && /^\d{1,5}$/.test(value) && Number(value) > 0
    ? Number(value)
    : null;
}
export function retentionPolicy() {
  return {
    identifierDays: days('RETENTION_IDENTIFIER_DAYS'),
    eventDays: days('RETENTION_EVENT_DAYS'),
  };
}
export async function applyRetention() {
  const policy = retentionPolicy();
  if (policy.identifierDays === null && policy.eventDays === null) return null;
  const [row] = await query<{ result: Record<string, unknown> }>(
    'SELECT qms.apply_retention($1,$2) result',
    [policy.identifierDays, policy.eventDays],
  );
  return row.result;
}
