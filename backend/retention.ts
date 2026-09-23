import { config } from './config';
import { query } from './db';
// Retention is a policy the organisation sets, not a default the code picks.
// RETENTION_IDENTIFIER_DAYS anonymises the customer's name and identifiers on
// tickets closed longer ago than that; RETENTION_EVENT_DAYS deletes older
// audit events. Unset keeps everything. The scheduler applies the policy at
// most once an hour (the throttle lives in qms.apply_retention).
export function retentionPolicy() {
  const settings = config();
  return {
    identifierDays: settings.RETENTION_IDENTIFIER_DAYS ?? null,
    eventDays: settings.RETENTION_EVENT_DAYS ?? null,
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
