import { z } from 'zod';
import { config } from './config';
import { schedulerHealthy, workerLastRun } from './data/system';
import { HttpError } from './http';
import type { Customer, IdentifierType, Unit } from './domain';

// Apex-only client. The integration user holds "API Enabled" and class access to
// AccountLookupAPI, QMSUserAPI and QMSTicketAPI, and nothing else. No SOQL, no
// /services/data object access; every read and write goes through those classes.
const APEX_PREFIX = '/services/apexrest/api/';
// Carries the status the org returned, so callers branch on a number rather
// than on words inside a sentence.
export class SalesforceError extends HttpError {
  constructor(public readonly salesforceStatus: number) {
    super(
      salesforceStatus === 429 ? 503 : 502,
      `Salesforce request failed (${salesforceStatus}). Please retry or contact your administrator.`,
      'SALESFORCE_REQUEST_FAILED',
    );
  }
}
const SF_USER_ID = /^005[a-zA-Z0-9]{12,15}$/;

let cached: { token: string; expires: number } | null = null;
let pending: Promise<string> | null = null;
function instance() {
  // The protocol and host were validated when the configuration loaded.
  const value = config().SALESFORCE_INSTANCE_URL;
  if (!value)
    throw new HttpError(
      503,
      'Salesforce has not been configured.',
      'SALESFORCE_NOT_CONFIGURED',
    );
  return new URL(value).origin;
}
async function accessToken(force = false) {
  if (!force && cached && cached.expires > Date.now()) return cached.token;
  if (pending) return pending;
  pending = (async () => {
    // Trimmed: values pasted into hosting dashboards often carry whitespace,
    // which Salesforce reports as "Missing Consumer Key Parameter".
    const { SALESFORCE_CLIENT_ID: clientId, SALESFORCE_CLIENT_SECRET: secret } =
      config();
    if (!clientId || !secret)
      throw new HttpError(
        503,
        'Salesforce credentials have not been configured.',
        'SALESFORCE_NOT_CONFIGURED',
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
    if (!response.ok) {
      noteFailure();
      throw new HttpError(
        502,
        'Salesforce authentication failed. Please contact your administrator.',
      );
    }
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
// Circuit breaker: after three consecutive transport or server failures,
// calls fail fast for 30 seconds instead of each waiting out a timeout, so
// reception is offered the walk-in path at once while Salesforce recovers.
let consecutiveFailures = 0;
let pausedUntil = 0;
function noteFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= 3) pausedUntil = Date.now() + 30000;
}
function noteSuccess() {
  consecutiveFailures = 0;
  pausedUntil = 0;
}
export function salesforcePaused() {
  return Date.now() < pausedUntil;
}
async function apexFetch(path: string, init: RequestInit, retry: boolean) {
  if (salesforcePaused())
    throw new HttpError(
      503,
      'Salesforce is paused after repeated failures and will be retried shortly.',
    );
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
  if (response.status >= 500) noteFailure();
  else noteSuccess();
  return response;
}
function transportFailure(error: unknown): never {
  if (error instanceof HttpError) throw error;
  // A body we could not read is the org's problem to report, not a reason to
  // stop calling it; only a failed connection opens the breaker.
  if (error instanceof SyntaxError)
    throw new HttpError(
      502,
      'Salesforce returned a response that could not be read.',
      'SALESFORCE_BAD_RESPONSE',
    );
  noteFailure();
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
      throw new SalesforceError(response.status);
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
/**
 * The forms one national number might have been stored as, most likely first.
 *
 * AccountLookupAPI matches Mobile_Number__c exactly and is not ours to change,
 * so the number has to be offered in the shapes the data actually holds. In
 * POD2 most accounts store the national number alone, a few have the UAE code
 * baked in, and a few carry the trunk zero. The last two entries cover a
 * foreign number typed with its own country code, where the stored value is
 * the tail of what was typed.
 */
export function mobileVariants(national: string): string[] {
  const seen = new Set<string>();
  const add = (value: string) => {
    if (/^\d{7,15}$/.test(value)) seen.add(value);
  };
  add(national);
  add('0' + national);
  add('971' + national);
  if (national.length > 10) {
    add(national.slice(-10));
    add(national.slice(-9));
  }
  return [...seen];
}

/**
 * Finds a customer. For a mobile number this tries each stored form in turn and
 * stops at the first account found.
 *
 * Only an empty result moves on to the next form. Anything thrown -- a timeout,
 * a 5xx, an open circuit breaker -- propagates immediately, so a Salesforce
 * that is merely slow costs one request and not five, and reception is offered
 * the walk-in path as quickly as it was before.
 */
export async function lookupCustomer(type: IdentifierType, value: string) {
  const candidates = type === 'mobile' ? mobileVariants(value) : [value];
  let miss: Customer | null = null;
  for (const candidate of candidates) {
    const raw = await sfRequest(
      APEX_PREFIX +
        'AccountLookupAPI?' +
        new URLSearchParams({ [type]: candidate }),
    );
    const customer = normalizeLookup(raw);
    if (customer.registered) return customer;
    miss ??= customer;
  }
  // mobileVariants always yields at least the number it was given, so this is
  // unreachable rather than a silent empty result.
  if (!miss) throw new HttpError(500, 'No lookup was attempted.');
  return miss;
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
    if (error instanceof SalesforceError && error.salesforceStatus === 404)
      throw new HttpError(
        503,
        'Salesforce user search is not available yet. The QMSUserAPI class must be deployed to this org.',
        'SALESFORCE_CLASS_MISSING',
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

type Probe = { connected: boolean; userSearchAvailable: boolean; error?: string };
let probeCache: { at: number; value: Probe } | null = null;
// Opening Settings costs two Apex calls. Managers open it together after a
// deploy, so the result is held briefly; health that is a minute old is still
// health, and the org's limits are not spent on a page refresh.
async function probeSalesforce(): Promise<Probe> {
  if (probeCache && Date.now() - probeCache.at < 60000) return probeCache.value;
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
  const value = { connected, userSearchAvailable, error };
  probeCache = { at: Date.now(), value };
  return value;
}
export async function integrationHealth() {
  const { connected, userSearchAvailable, error } = await probeSalesforce();
  const settings = config();
  const lastRun = await workerLastRun();
  return {
    database: { connected: true },
    // The first administrator's password must not stay on a running host.
    bootstrapPasswordPresent: !!settings.BOOTSTRAP_PASSWORD,
    salesforce: {
      configured:
        !!settings.SALESFORCE_CLIENT_ID && !!settings.SALESFORCE_CLIENT_SECRET,
      connected,
      paused: salesforcePaused(),
      userSearchAvailable,
      instance: settings.SALESFORCE_INSTANCE_URL || '',
      authMode: 'OAuth client credentials (Apex REST only)',
      error,
      writeEnabled: settings.SALESFORCE_WRITE_ENABLED,
    },
    sms: {
      configured: !!settings.SMS_GATEWAY_URL && !!settings.SMS_GATEWAY_TOKEN,
      enabled: settings.SMS_ENABLED,
    },
    worker: { lastRun, healthy: schedulerHealthy(lastRun) },
  };
}
