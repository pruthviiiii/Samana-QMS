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
export type Role =
  | 'admin'
  | 'hod'
  | 'manager'
  | 'agent'
  | 'reception'
  | 'customer'
  | 'display';
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
export const isManager = (role: Role) =>
  ['admin', 'hod', 'manager'].includes(role);
export function normalizeIdentifier(
  type: IdentifierType,
  value: string,
): string {
  const text = value.trim();
  if (type === 'mobile') {
    const digits = text.replace(/[\s()+-]/g, '');
    if (!/^\d{8,15}$/.test(digits))
      throw new Error(
        'Enter a valid mobile number with country code (8–15 digits).',
      );
    return digits;
  }
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
export function smsEligible(
  type: IdentifierType,
  registered: boolean,
  mobile: string | null,
) {
  return type === 'mobile' && registered && !!mobile;
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
export function canTransition(
  from: TicketStatus,
  to: TicketStatus,
  manager = false,
) {
  return (
    (to === 'called' && from === 'waiting') ||
    (to === 'serving' && from === 'called') ||
    (to === 'closed' &&
      (from === 'serving' ||
        (manager && ['waiting', 'called'].includes(from)))) ||
    (to === 'no_show' && from === 'called')
  );
}
