import { config } from './config';
import { createGuest } from './data/users';
import { randomToken, sha256 } from './security';
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
  const secret = config().QR_SIGNING_SECRET;
  if (!secret)
    throw new HttpError(
      503,
      'Mobile check-in has not been configured.',
      'QR_NOT_CONFIGURED',
    );
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
  const origin = config().APP_ORIGIN;
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
    // A signed-in person keeps their session. A reception TV must keep its
    // own: opening the check-in link there would otherwise sign the screen
    // out and leave the waiting room blank.
    if (existing.role === 'display')
      throw new HttpError(
        409,
        'This screen is signed in as a display. Please scan the QR code with a phone.',
        'DISPLAY_SESSION',
      );
    return json({ ok: true });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401) throw e;
  }
  await clientRateLimit(request, 'invite', 10, 300);
  await rateLimit('invite:global', 300, 300);
  await rateLimit('invite:' + match[2].slice(0, 20), 150, 300);
  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await sha256(token);
  await createGuest(id, tokenHash, 45);
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
