import { z } from 'zod';
import { query } from '../db';
export const uuid = z.uuid();
export const userColumns =
  'id,username,name,email,role,sf_id,manager_sf_id,services,online,last_seen,counter,enabled,must_change_password';
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
export const audit = (
  actor: string | null,
  action: string,
  details?: Record<string, unknown>,
) =>
  query(
    'INSERT INTO qms.events(actor_id,action,details) VALUES($1,$2,$3::jsonb)',
    [actor, action, JSON.stringify(details ?? {})],
  );
export const STAFF = ['admin', 'hod', 'manager', 'agent', 'reception'] as const;
export const SERVING = ['admin', 'hod', 'manager', 'agent'] as const;
export const MANAGERS = ['admin', 'hod', 'manager'] as const;
