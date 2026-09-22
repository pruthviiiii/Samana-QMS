import { z } from 'zod';
import { record } from '../data/events';
export const uuid = z.uuid();
export const passwordSchema = z
  .string()
  .min(14, 'Use at least 14 characters.')
  .max(128);
export const salesforceUserId = z
  .string()
  .regex(/^005[a-zA-Z0-9]{12,15}$/, 'Enter a Salesforce user ID (005…).')
  .nullable()
  .optional();
// Verified for unknown accounts so a wrong username costs the same time as a
// wrong password; the work factor matches real hashes.
export const dummyHash =
  'pbkdf2$600000$0123456789abcdef$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** Records an activity-log event; details never carry a customer identifier. */
export const audit = (
  actor: string | null,
  action: string,
  details?: Record<string, unknown>,
) => record(actor, action, details ?? {});
// The route table's access groups are the domain's role groups; there is no
// second list to keep in step.
export {
  WORKSPACE_ROLES as STAFF,
  SERVING_ROLES as SERVING,
  MANAGER_ROLES as MANAGERS,
} from '../domain';
