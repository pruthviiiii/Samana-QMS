import { z } from 'zod';
import { query } from './db';
import { HttpError } from './http';
import type { Customer, IdentifierType } from './domain';
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
export async function sfRequest(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<unknown> {
  if (!path.startsWith('/services/') || path.includes('://'))
    throw new Error('Invalid Salesforce path.');
  try {
    const token = await accessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + token);
    headers.set('Content-Type', 'application/json');
    const response = await fetch(instance() + path, {
      ...init,
      headers,
      redirect: 'manual', // workerd rejects 'error'; 3xx fails the ok check below
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401 && retry) {
      await accessToken(true);
      return sfRequest(path, init, false);
    }
    if (!response.ok)
      throw new HttpError(
        response.status === 429 ? 503 : 502,
        `Salesforce request failed (${response.status}). Please retry or contact your administrator.`,
      );
    return await response.json();
  } catch (error) {
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
}
export async function sfQuery<T>(soql: string) {
  let path =
    '/services/data/v' +
    (process.env.SALESFORCE_API_VERSION || '67.0') +
    '/query?q=' +
    encodeURIComponent(soql);
  const records: T[] = [];
  let pages = 0;
  while (path) {
    const data = (await sfRequest(path)) as {
      records: T[];
      done: boolean;
      nextRecordsUrl?: string;
    };
    if (!Array.isArray(data.records))
      throw new HttpError(
        502,
        'Salesforce returned an invalid query response.',
      );
    records.push(...data.records);
    if (++pages > 20 || records.length > 20000)
      throw new HttpError(
        502,
        'Salesforce query exceeded the supported result size.',
      );
    path = data.done ? '' : data.nextRecordsUrl || '';
  }
  return records;
}
const nullable = z.string().nullable().optional();
const rawUnit = z.object({
  customerUnitId: z.string(),
  unitNumber: nullable,
  salesBookingReference: nullable,
  collectionAgentName: nullable,
  collectionAgentManagerName: nullable,
  collectionAgentEmail: nullable,
  collectionAgentManagerEmail: nullable,
});
const lookupSchema = z.object({
  isSuccess: z.boolean(),
  statusCode: z.number(),
  TotalRecords: z.number(),
  accounts: z.array(
    z.object({
      id: z.string().regex(/^[a-zA-Z0-9]{15,18}$/),
      name: z.string(),
      email: nullable,
      phoneNumber: nullable,
      phoneCountryCode: nullable,
      passportNumber: nullable,
      emiratesId: nullable,
      units: z.array(rawUnit),
    }),
  ),
});
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
  return {
    registered: true,
    salesforceId: account.id,
    name: account.name,
    email: account.email || null,
    firstName: names[0] || '',
    middleName: names.length > 2 ? names.slice(1, -1).join(' ') : '',
    lastName: names.length > 1 ? names.at(-1) || '' : '',
    mobile: account.phoneNumber || null,
    emiratesId: account.emiratesId || null,
    passportNumber: account.passportNumber || null,
    units: account.units.map((u) => ({
      id: u.customerUnitId,
      name: u.unitNumber || 'Unit',
      project: '',
      bookingNumber: u.salesBookingReference || '',
      ownerId: null,
      ownerName: u.collectionAgentName || null,
      managerId: null,
      managerName: u.collectionAgentManagerName || null,
    })),
  };
}
export async function lookupCustomer(type: IdentifierType, value: string) {
  const raw = await sfRequest(
    '/services/apexrest/api/AccountLookupAPI?' +
      new URLSearchParams({ [type]: value }),
  );
  const customer = normalizeLookup(raw);
  if (!customer.registered) return customer;
  const accountId = customer.salesforceId!; // Validated as a Salesforce ID by lookupSchema.
  const [account] = await sfQuery<{
    FirstName: string | null;
    MiddleName: string | null;
    LastName: string | null;
    First_Name__c: string | null;
    Middle_Name__c: string | null;
    Last_Name__c: string | null;
  }>(
    `SELECT FirstName,MiddleName,LastName,First_Name__c,Middle_Name__c,Last_Name__c FROM Account WHERE Id='${accountId}' LIMIT 1`,
  );
  if (account) {
    customer.firstName =
      account.FirstName || account.First_Name__c || customer.firstName;
    customer.middleName = account.MiddleName || account.Middle_Name__c || '';
    customer.lastName =
      account.LastName || account.Last_Name__c || customer.lastName;
  }
  if (customer.units.length) {
    type UnitRow = {
      Id: string;
      Project__r: { Name: string } | null;
      Project_Name__c: string | null;
      Collection_Agent__c: string | null;
      Collection_Agent__r: {
        Name: string;
        ManagerId: string | null;
        Manager: { Name: string } | null;
      } | null;
    };
    type Calling = {
      Customer_Unit__c: string;
      OwnerId: string;
      Department__c: string | null;
      Collection_Agent_Manager__c: string | null;
    };
    const [units, calling] = await Promise.all([
      sfQuery<UnitRow>(
        `SELECT Id,Project__r.Name,Project_Name__c,Collection_Agent__c,Collection_Agent__r.Name,Collection_Agent__r.ManagerId,Collection_Agent__r.Manager.Name FROM Customer_Unit__c WHERE Account__c='${accountId}' AND Unit_Active__c='Yes' ORDER BY Id LIMIT 500`,
      ),
      sfQuery<Calling>(
        `SELECT Customer_Unit__c,OwnerId,Department__c,Collection_Agent_Manager__c FROM Calling_List__c WHERE Account__c='${accountId}' AND Customer_Unit__c!=null ORDER BY LastModifiedDate DESC,Id LIMIT 500`,
      ),
    ]);
    const ownerIds = [
      ...new Set(
        calling
          .map((c) => c.OwnerId)
          .filter((id) => /^005[a-zA-Z0-9]{12,15}$/.test(id)),
      ),
    ];
    const owners = ownerIds.length
      ? await sfQuery<{ Id: string; ManagerId: string | null }>(
          `SELECT Id,ManagerId FROM User WHERE Id IN (${ownerIds.map((id) => "'" + id + "'").join(',')})`,
        )
      : [];
    for (const unit of customer.units) {
      const row = units.find((u) => u.Id === unit.id);
      unit.project =
        row?.Project__r?.Name || row?.Project_Name__c || 'Project unavailable';
      unit.ownerId = row?.Collection_Agent__c || null;
      unit.ownerName = row?.Collection_Agent__r?.Name || unit.ownerName;
      unit.managerId = row?.Collection_Agent__r?.ManagerId || null;
      unit.managerName =
        row?.Collection_Agent__r?.Manager?.Name || unit.managerName;
      unit.owners = {};
      for (const [service, department] of [
        ['crm-general', 'CRM'],
        ['crm-refund', 'CRM'],
        ['crm-noc', 'Resale'],
        ['crm-handover', 'Handover'],
      ]) {
        const call =
          calling.find(
            (c) =>
              c.Customer_Unit__c === unit.id && c.Department__c === department,
          ) ||
          calling.find(
            (c) => c.Customer_Unit__c === unit.id && c.Department__c === 'CRM',
          );
        unit.owners[service] = {
          ownerId: call?.OwnerId?.startsWith('005') ? call.OwnerId : null,
          managerId:
            call?.Collection_Agent_Manager__c ||
            owners.find((o) => o.Id === call?.OwnerId)?.ManagerId ||
            null,
        };
      }
    }
  }
  return customer;
}
export async function syncDirectory() {
  const users = await sfQuery<{
    Id: string;
    Name: string;
    Username: string;
    Email: string;
    ManagerId: string | null;
  }>(
    "SELECT Id,Name,Username,Email,ManagerId FROM User WHERE IsActive=true AND UserType='Standard' ORDER BY Name LIMIT 2000",
  );
  const managerIds = new Set(users.map((u) => u.ManagerId).filter(Boolean));
  await query(
    `INSERT INTO qms.users(username,name,role,sf_id,manager_sf_id,email,enabled,must_change_password)
    SELECT 'sf-'||r.id,r.name,r.role,r.id,r.manager,r.email,false,true
    FROM jsonb_to_recordset($1::jsonb) AS r(id text,name text,role text,manager text,email text)
    ON CONFLICT(sf_id) DO UPDATE SET name=excluded.name,manager_sf_id=excluded.manager_sf_id,email=excluded.email`,
    [
      JSON.stringify(
        users.map((u) => ({
          id: u.Id,
          name: u.Name,
          role: managerIds.has(u.Id) ? 'manager' : 'agent',
          manager: u.ManagerId,
          email: u.Email,
        })),
      ),
    ],
  );
  return { imported: users.length };
}
export async function integrationHealth() {
  let connected = false;
  let error: string | undefined;
  try {
    await sfRequest(
      '/services/data/v' +
        (process.env.SALESFORCE_API_VERSION || '67.0') +
        '/limits',
    );
    connected = true;
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
      instance: process.env.SALESFORCE_INSTANCE_URL || '',
      authMode: 'OAuth client credentials',
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
