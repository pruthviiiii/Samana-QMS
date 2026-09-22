export const SERVICES = [
  { id: 'crm-general', name: 'General Query', department: 'CRM', prefix: 'C' },
  { id: 'crm-noc', name: 'NOC / Resale', department: 'CRM', prefix: 'N' },
  { id: 'crm-refund', name: 'Refund', department: 'CRM', prefix: 'R' },
  { id: 'crm-handover', name: 'Handover', department: 'CRM', prefix: 'H' },
  {
    id: 'collection',
    name: 'Collections',
    department: 'Collection',
    prefix: 'P',
  },
  {
    id: 'general',
    name: 'General Query',
    department: 'General Query',
    prefix: 'G',
  },
] as const;
export type ServiceId = (typeof SERVICES)[number]['id'];
// One source for every service enumeration in API schemas and screens.
export const SERVICE_IDS = SERVICES.map((s) => s.id) as [
  ServiceId,
  ...ServiceId[],
];
export type Role =
  | 'admin'
  | 'hod'
  | 'manager'
  | 'agent'
  | 'reception'
  | 'customer'
  | 'display';
// Roles an administrator may assign; `customer` exists only for QR guests.
export const STAFF_ROLES = [
  'admin',
  'hod',
  'manager',
  'agent',
  'reception',
  'display',
] as const;
// Role groups, defined once and used by both sides: the API route table
// declares access with them (lib/api/shared.ts) and the workspace decides what
// to show with them, so a role can never mean one thing on the server and
// another in the browser.
/** Everyone who works inside the staff workspace. */
export const WORKSPACE_ROLES = [
  'admin',
  'hod',
  'manager',
  'agent',
  'reception',
] as const satisfies readonly Role[];
/** Roles that can hold and serve a customer. */
export const SERVING_ROLES = [
  'admin',
  'hod',
  'manager',
  'agent',
] as const satisfies readonly Role[];
/** Roles that oversee other people's work. */
export const MANAGER_ROLES = ['admin', 'hod', 'manager'] as const satisfies readonly Role[];
/** Roles that may display the rotating check-in QR code. */
export const QR_ROLES = [
  'admin',
  'hod',
  'manager',
  'reception',
  'display',
] as const satisfies readonly Role[];
// How long an agent may go without a heartbeat before the system treats them
// as gone. The database holds the same number in qms.presence_window() and
// tests/schema.test.ts fails if the two drift apart, so a screen never shows
// somebody as available after routing has stopped sending them customers.
export const PRESENCE_WINDOW_MS = 45000;
/** Whether a heartbeat is recent enough to count the person as at their desk. */
export const isPresent = (online: boolean, lastSeen?: string | null) =>
  online && !!lastSeen && Date.now() - Date.parse(lastSeen) < PRESENCE_WINDOW_MS;
// The routing tick runs every 15 seconds (scripts/worker.mjs). Six missed
// ticks means it needs a person: lib/data/system.ts decides the health
// endpoint with this and the workspace banner reads the same number.
export const SCHEDULER_STALE_MS = 90000;
/** How urgently a service is routed: 0 is normal, 9 is most urgent. */
export const MAX_PRIORITY = 9;
export const PRIORITY_LABELS: Record<number, string> = {
  0: 'Normal',
  3: 'Elevated',
  6: 'High',
  9: 'Urgent',
};
export const priorityLabel = (priority: number) =>
  PRIORITY_LABELS[priority] ??
  (priority > 6 ? 'Urgent' : priority > 3 ? 'High' : priority > 0 ? 'Elevated' : 'Normal');
const has = (list: readonly Role[], role: Role | undefined) =>
  !!role && list.includes(role);
export const isWorkspaceRole = (role?: Role) => has(WORKSPACE_ROLES, role);
export const isServingRole = (role?: Role) => has(SERVING_ROLES, role);
export const canShowCheckinQr = (role?: Role) => has(QR_ROLES, role);
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  hod: 'Head of Department',
  manager: 'Manager',
  agent: 'Executive',
  reception: 'Reception',
  customer: 'Customer',
  display: 'TV display',
};
export const roleLabel = (role: string) => ROLE_LABELS[role as Role] ?? role;
export type IdentifierType = 'mobile' | 'emiratesId' | 'passportNumber';
export type TicketStatus =
  | 'waiting'
  | 'called'
  | 'serving'
  | 'closed'
  | 'no_show';
export interface Unit {
  id: string;
  name: string;
  project: string;
  bookingNumber: string;
  ownerId: string | null;
  ownerName: string | null;
  managerId: string | null;
  managerName: string | null;
  owners?: Record<string, { ownerId: string | null; managerId: string | null }>;
}
export interface Customer {
  registered: boolean;
  salesforceId: string | null;
  firstName: string;
  middleName: string;
  lastName: string;
  name: string;
  mobile: string | null;
  email?: string | null;
  emiratesId: string | null;
  passportNumber: string | null;
  units: Unit[];
}
export interface User {
  id: string;
  username: string;
  name: string;
  email?: string | null;
  role: Role;
  sf_id: string | null;
  manager_sf_id: string | null;
  services: string[];
  online: boolean;
  last_seen: string | null;
  counter: string;
  enabled: boolean;
  must_change_password: boolean;
}
export interface Ticket {
  id: string;
  number: string;
  service_id: string;
  department: string;
  service_name: string;
  status: TicketStatus;
  customer_name: string;
  customer_id: string | null;
  unit_id: string | null;
  unit_name: string | null;
  project_name: string | null;
  booking_number: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  counter: string | null;
  created_at: string;
  assigned_at: string | null;
  called_at: string | null;
  started_at: string | null;
  closed_at: string | null;
  routing_reason: string;
  comments: string | null;
  version: number;
  identifier_type: IdentifierType;
  mobile?: string | null;
  emirates_id?: string | null;
  passport_number?: string | null;
}
export const isManager = (role?: Role) => has(MANAGER_ROLES, role);
/**
 * One mobile number, however it was typed.
 *
 * Salesforce keeps the country code in its own field
 * (Account.Mobile_Country_Code__c) and the number in Mobile_Number__c, so the
 * number it matches on is the national one: 529548924, not 971529548924. A
 * customer may type any of +971 52 954 8924, 00971529548924, 0529548924 or
 * 529548924 and mean the same phone, so all of them reduce to the same string
 * here -- which is also what makes two check-ins by one person count as a
 * duplicate visit rather than two strangers.
 *
 * Only the UAE code is stripped. A number kept under another country code is
 * stored the same way, without it, so a foreign number typed plainly still
 * matches; one typed with its own country code is handled by the candidates in
 * lib/salesforce.ts instead of by guessing here which digits are a country.
 */
export function nationalMobile(value: string): string {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Guarded by length: a national number is never itself 971 followed by
  // nothing, and UAE mobiles start 5.
  if (digits.startsWith('971') && digits.length > 9) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1); // trunk prefix
  if (!/^\d{7,15}$/.test(digits))
    throw new Error('Enter a valid mobile number (at least 7 digits).');
  return digits;
}

export function normalizeIdentifier(
  type: IdentifierType,
  value: string,
): string {
  const text = value.trim();
  if (type === 'mobile') return nationalMobile(text);
  if (type === 'emiratesId') {
    if (!/^784-\d{4}-\d{7}-\d$/.test(text))
      throw new Error('Use Emirates ID format 784-XXXX-XXXXXXX-X.');
    return text;
  }
  const passport = text.toUpperCase();
  if (!/^[A-Z0-9]{4,20}$/.test(passport))
    throw new Error('Enter a valid passport number (4–20 letters or digits).');
  return passport;
}
export function minutesBetween(start: string, end?: string | null) {
  return Math.max(
    0,
    ((end ? new Date(end) : new Date()).getTime() - new Date(start).getTime()) /
      60000,
  );
}
export function csvCell(value: unknown) {
  let s =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' ||
            typeof value === 'boolean' ||
            typeof value === 'bigint'
          ? String(value)
          : (JSON.stringify(value) ?? '');
  if (/^[=+\-@\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
