import pg from 'pg';
import { config } from './config';
// One database session per web process holds LISTEN qms_changes. Migration
// 013 raises a NOTIFY whenever tickets, notifications or staff availability
// change, and every connected screen is told to refresh. If the listener
// cannot be established the screens keep their own polling interval.
type Listener = (kind: string) => void;
const listeners = new Set<Listener>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;
let retryAt = 0;
let stopped = false;
export function listening() {
  return client !== null;
}
// LISTEN needs a session that stays on one server connection. A pooler in
// transaction mode accepts the command but never forwards notifications, so
// on Neon (hostnames whose first label ends in "-pooler") the listener uses
// the direct endpoint. Any other host is used exactly as configured; put this
// one connection past PgBouncer if you run one.
export function listenUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.replace(/^([^.]*)-pooler\./, '$1.');
    return parsed.toString();
  } catch {
    return url;
  }
}
async function connect() {
  if (client || stopped) return;
  if (connecting) return connecting;
  if (Date.now() < retryAt) throw new Error('Listener retry pending.');
  connecting = (async () => {
    const c = new pg.Client({
      connectionString: listenUrl(config().DATABASE_URL),
    });
    await c.connect();
    await c.query('LISTEN qms_changes');
    c.on('notification', (message) => {
      for (const listener of listeners) listener(message.payload ?? 'change');
    });
    const drop = () => {
      if (client === c) client = null;
      retryAt = Date.now() + 5000;
      c.end().catch(() => {
        /* already closed */
      });
      if (listeners.size && !stopped)
        setTimeout(() => {
          connect().catch(() => {
            /* retried on the next subscription or timer */
          });
        }, 5000);
    };
    c.on('error', drop);
    c.on('end', drop);
    client = c;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}
// Registers a listener and returns the unsubscribe function. `onStatus` is
// told whether the database listener is established.
export function subscribe(listener: Listener, onStatus: (ok: boolean) => void) {
  listeners.add(listener);
  connect()
    .then(() => onStatus(true))
    .catch(() => onStatus(false));
  return () => {
    listeners.delete(listener);
  };
}
/** Closes the listening session on shutdown and stops reconnection attempts. */
export async function closeListener() {
  stopped = true;
  const current = client;
  client = null;
  listeners.clear();
  if (current) await current.end().catch(() => {});
}
