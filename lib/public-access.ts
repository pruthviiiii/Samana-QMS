import { randomToken, sha256 } from './security';
import { transaction } from './db';
import type { Customer } from './domain';
import {
  HttpError,
  requireUser,
  sessionCookie,
  json,
  rateLimit,
  clientRateLimit,
} from './http';
const encoder = new TextEncoder();
async function signature(value: string) {
  const secret = process.env.QR_SIGNING_SECRET;
  if (!secret)
    throw new HttpError(503, 'Mobile check-in has not been configured.');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(value)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export async function checkinLink() {
  const expires = Math.floor(Date.now() / 1000) + 300;
  const payload = `checkin.${expires}`;
  const token = payload + '.' + (await signature(payload));
  const origin = process.env.APP_ORIGIN;
  if (!origin) throw new HttpError(503, 'App origin is not configured.');
  return {
    url: origin + '/check-in?invite=' + token,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}
export async function startGuest(request: Request, invite: string) {
  const match = invite.match(/^checkin\.(\d{10})\.([a-f0-9]{64})$/);
  if (!match)
    throw new HttpError(403, 'Scan the current check-in QR code at reception.');
  const expires = Number(match[1]);
  if (
    expires < Math.floor(Date.now() / 1000) ||
    expires > Math.floor(Date.now() / 1000) + 305 ||
    (await sha256(match[2])) !==
      (await sha256(await signature(`checkin.${expires}`)))
  )
    throw new HttpError(
      403,
      'This QR code has expired. Please scan the current code.',
    );
  try {
    const existing = await requireUser(request);
    if (existing.role !== 'display') return json({ ok: true });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401) throw e;
  }
  await clientRateLimit(request, 'invite', 10, 300);
  await rateLimit('invite:global', 300, 300);
  await rateLimit('invite:' + match[2].slice(0, 20), 150, 300);
  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256(token);
  await transaction(async (q) => {
    await q(
      "INSERT INTO qms.users(id,username,name,role,enabled,must_change_password) VALUES($1,$2,'Customer visit','customer',true,false)",
      [id, 'visit-' + id],
    );
    await q(
      "INSERT INTO qms.sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '45 minutes')",
      [tokenHash, id],
    );
  });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, 2700) });
}
export function publicCustomer(customer: Customer) {
  const name = customer.firstName || customer.name || 'Customer';
  return {
    registered: customer.registered,
    salesforceId: null,
    name: name.split(' ')[0],
    firstName: name.split(' ')[0],
    middleName: '',
    lastName: '',
    mobile: null,
    emiratesId: null,
    passportNumber: null,
    units: customer.units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      project: unit.project,
      bookingNumber: '',
      ownerId: null,
      ownerName: null,
      managerId: null,
      managerName: null,
    })),
  };
}
export function receipt(ticket: Record<string, unknown>) {
  const fields = [
    'id',
    'number',
    'service_name',
    'department',
    'status',
    'project_name',
    'unit_name',
    'created_at',
    'assigned_name',
    'counter',
    'public_token',
  ];
  return Object.fromEntries(fields.map((k) => [k, ticket[k]]));
}
