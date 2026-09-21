import { z } from 'zod';
import { query } from './db';
import { HttpError } from './http';
import type { Customer, IdentifierType, Unit } from './domain';

// Apex-only client. The integration user holds "API Enabled" and class access to
// AccountLookupAPI, QMSUserAPI and QMSTicketAPI, and nothing else. No SOQL, no
// /services/data object access; every read and write goes through those classes.
const APEX_PREFIX = '/services/apexrest/api/';
const SF_USER_ID = /^005[a-zA-Z0-9]{12,15}$/;

let cached: { token: string; expires: number } | null = null;
let pending: Promise<string> | null = null;
function instance() {
  const value = process.env.SALESFORCE_INSTANCE_URL?.trim();
  if (!value) throw new HttpError(503, 'Salesforce has not been configured.');
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname.endsWith('.salesforce.com') ||
    parsed.username ||
    parsed.password
  )
    throw new HttpError(503, 'Salesforce instance configuration is invalid.');
  return parsed.origin;
}
async function accessToken(force = false) {
  if (!force && cached && cached.expires > Date.now()) return cached.token;
  if (pending) return pending;
  pending = (async () => {
    // Trimmed: values pasted into hosting dashboards often carry whitespace,
    // which Salesforce reports as "Missing Consumer Key Parameter".
    const clientId = process.env.SALESFORCE_CLIENT_ID?.trim();
    const secret = process.env.SALESFORCE_CLIENT_SECRET?.trim();
    if (!clientId || !secret)
      throw new HttpError(
        503,
        'Salesforce credentials have not been configured.',
      );
    const payload = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
    });
    const response = await fetch(instance() + '/services/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload,
      // 'manual', not 'error': the Cloudflare workerd runtime rejects 'error'
      // with a TypeError. A 3xx still fails below because response.ok is false.
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new HttpError(
        502,
        'Salesforce authentication failed. Please contact your administrator.',
      );
    const result = (await response.json()) as { access_token?: string };
    if (!result.access_token)
      throw new HttpError(
        502,
        'Salesforce returned an invalid authentication response.',
      );
    cached = {
      token: result.access_token,
      expires: Date.now() + 15 * 60 * 1000,
    };
    return result.access_token;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}
function assertApexPath(path: string) {
  if (!path.startsWith(APEX_PREFIX) || path.includes('://'))
    throw new Error('Invalid Salesforce path.');
}
async function apexFetch(path: string, init: RequestInit, retry: boolean) {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + token);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(instance() + path, {
    ...init,
    headers,
    redirect: 'manual', // workerd rejects 'error'; 3xx fails the ok checks
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 401 && retry) {
    await accessToken(true);
    return apexFetch(path, init, false);
  }
  return response;
}
function transportFailure(error: unknown): never {
  if (error instanceof HttpError) throw error;
  const cause =
    error instanceof Error && 'cause' in error ? error.cause : undefined;
  const code =
    cause && typeof cause === 'object' && 'code' in cause
      ? String(cause.code)
      : undefined;
  console.error(
    JSON.stringify({
      event: 'salesforce_transport_failed',
      type: error instanceof Error ? error.name : 'Unknown',
      ...(code && /^[A-Z0-9_]{1,60}$/.test(code) ? { code } : {}),
    }),
  );
  throw new HttpError(
    502,
    'Salesforce is temporarily unreachable. Check the server connection and retry.',
  );
}
export async function sfRequest(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<unknown> {
  assertApexPath(path);
  try {
    const response = await apexFetch(path, init, retry);
    if (!response.ok)
      throw new HttpError(
        response.status === 429 ? 503 : 502,
        `Salesforce request failed (${response.status}). Please retry or contact your administrator.`,
      );
    return await response.json();
  } catch (error) {
    transportFailure(error);
  }
}
// Status-only probe for health checks: never throws on an HTTP error status.
async function apexStatus(path: string): Promise<number> {
  assertApexPath(path);
  try {
    return (await apexFetch(path, {}, true)).status;
  } catch (error) {
    transportFailure(error);
  }
}

const nullable = z.string().nullable().optional();
const rawOwner = z.object({
  department: nullable,
  ownerId: nullable,
  ownerManagerId: nullable,
});
const rawUnit = z.object({
  customerUnitId: z.string(),
  unitNumber: nullable,
  salesBookingReference: nullable,
  projectId: nullable,
  projectName: nullable,
  collectionAgentId: nullable,
  collectionAgentName: nullable,
  collectionAgentManagerId: nullable,
  collectionAgentManagerName: nullable,
  collectionAgentEmail: nullable,
  collectionAgentManagerEmail: nullable,
  callingOwners: z.array(rawOwner).nullable().optional(),
});
const lookupSchema = z.object({
  isSuccess: z.boolean(),
  statusCode: z.number(),
  TotalRecords: z.number(),
  accounts: z.array(
    z.object({
      id: z.string().regex(/^[a-zA-Z0-9]{15,18}$/),
      name: z.string(),
      firstName: nullable,
      middleName: nullable,
      lastName: nullable,
      email: nullable,
      phoneNumber: nullable,
      phoneCountryCode: nullable,
      passportNumber: nullable,
      emiratesId: nullable,
      units: z.array(rawUnit),
    }),
  ),
});
// Which Calling_List__c department feeds each CRM service; CRM is the fallback.
const SERVICE_DEPARTMENTS: [string, string][] = [
  ['crm-general', 'CRM'],
  ['crm-refund', 'CRM'],
  ['crm-noc', 'Resale'],
  ['crm-handover', 'Handover'],
];
const userId = (value: string | null | undefined) =>
  value && SF_USER_ID.test(value) ? value : null;

export function normalizeLookup(payload: unknown): Customer {
  const parsed = lookupSchema.safeParse(payload);
  if (
    !parsed.success ||
    !parsed.data.isSuccess ||
    parsed.data.statusCode !== 200
  )
    throw new HttpError(
      502,
      'Salesforce returned an invalid account lookup response.',
    );
  const account = parsed.data.accounts[0];
  if (!account)
    return {
      registered: false,
      salesforceId: null,
      firstName: '',
      middleName: '',
      lastName: '',
      name: 'Walk-in customer',
      mobile: null,
      emiratesId: null,
      passportNumber: null,
      units: [],
    };
  const names = account.name.trim().split(/\s+/);
  const units: Unit[] = account.units.map((u) => {
    const owners: Unit['owners'] = {};
    const calling = u.callingOwners || [];
    for (const [service, department] of SERVICE_DEPARTMENTS) {
      const row =
        calling.find((c) => c.department === department) ||
        calling.find((c) => c.department === 'CRM');
      owners[service] = {
        ownerId: userId(row?.ownerId),
        managerId: userId(row?.ownerManagerId),
      };
    }
    return {
      id: u.customerUnitId,
      name: u.unitNumber || 'Unit',
      project: u.projectName || 'Project unavailable',
      bookingNumber: u.salesBookingReference || '',
      ownerId: userId(u.collectionAgentId),
      ownerName: u.collectionAgentName || null,
      managerId: userId(u.collectionAgentManagerId),
      managerName: u.collectionAgentManagerName || null,
      owners,
    };
  });
  return {
    registered: true,
    salesforceId: account.id,
    name: account.name,
    email: account.email || null,
    firstName: account.firstName || names[0] || '',
    middleName:
      account.middleName ||
      (names.length > 2 ? names.slice(1, -1).join(' ') : ''),
    lastName:
      account.lastName || (names.length > 1 ? names.at(-1) || '' : ''),
    mobile: account.phoneNumber || null,
    emiratesId: account.emiratesId || null,
    passportNumber: account.passportNumber || null,
    units,
  };
}
export async function lookupCustomer(type: IdentifierType, value: string) {
  const raw = await sfRequest(
    APEX_PREFIX + 'AccountLookupAPI?' + new URLSearchParams({ [type]: value }),
  );
  return normalizeLookup(raw);
}

const userSearchSchema = z.object({
  isSuccess: z.boolean(),
  statusCode: z.number(),
  users: z.array(
    z.object({
      id: z.string().regex(SF_USER_ID),
      name: z.string(),
      username: nullable,
      email: nullable,
      managerId: nullable,
      managerName: nullable,
    }),
  ),
});
export type SalesforceUser = {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  managerId: string | null;
  managerName: string | null;
};
// On-demand staff search through QMSUserAPI. Nothing is imported in bulk; an
// administrator searches, picks one person and saves them on the Team page.
export async function searchUsers(q: string): Promise<SalesforceUser[]> {
  const term = q.trim();
  if (term.length < 3 || term.length > 100)
    throw new HttpError(400, 'Enter between 3 and 100 characters to search.');
  let raw: unknown;
  try {
    raw = await sfRequest(
      APEX_PREFIX + 'QMSUserAPI?' + new URLSearchParams({ q: term }),
    );
  } catch (error) {
    if (error instanceof HttpError && error.message.includes('(404)'))
      throw new HttpError(
        503,
        'Salesforce user search is not available yet. The QMSUserAPI class must be deployed to this org.',
      );
    throw error;
  }
  const parsed = userSearchSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.isSuccess)
    throw new HttpError(
      502,
      'Salesforce returned an invalid user search response.',
    );
  return parsed.data.users.map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username || null,
    email: u.email || null,
    managerId: userId(u.managerId),
    managerName: u.managerName || null,
  }));
}

export async function integrationHealth() {
  let connected = false;
  let userSearchAvailable = false;
  let error: string | undefined;
  try {
    // A parameterless lookup returns 400 from the class itself, which proves
    // authentication and class access without touching any record.
    const lookup = await apexStatus(APEX_PREFIX + 'AccountLookupAPI');
    connected = lookup === 400 || lookup === 200;
    if (!connected)
      error =
        lookup === 401 || lookup === 403
          ? 'The integration user has no access to AccountLookupAPI.'
          : lookup === 404
            ? 'AccountLookupAPI is not deployed in this org.'
            : `Salesforce request failed (${lookup}).`;
    if (connected) {
      const ping = await apexStatus(APEX_PREFIX + 'QMSUserAPI?ping=1');
      userSearchAvailable = ping === 200;
    }
  } catch (e) {
    error = e instanceof HttpError ? e.message : 'Connection failed.';
  }
  const [worker] = await query<{ updated_at: string }>(
    "SELECT updated_at FROM qms.system_state WHERE key='worker'",
  );
  return {
    database: { connected: true },
    salesforce: {
      configured:
        !!process.env.SALESFORCE_CLIENT_ID &&
        !!process.env.SALESFORCE_CLIENT_SECRET,
      connected,
      userSearchAvailable,
      instance: process.env.SALESFORCE_INSTANCE_URL || '',
      authMode: 'OAuth client credentials (Apex REST only)',
      error,
      writeEnabled: process.env.SALESFORCE_WRITE_ENABLED === 'true',
    },
    sms: {
      configured:
        !!process.env.SMS_GATEWAY_URL && !!process.env.SMS_GATEWAY_TOKEN,
      enabled: process.env.SMS_ENABLED === 'true',
    },
    worker: {
      lastRun: worker?.updated_at || null,
      healthy:
        !!worker && Date.now() - new Date(worker.updated_at).getTime() < 90000,
    },
  };
}
