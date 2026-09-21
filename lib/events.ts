import { Client, neonConfig } from '@neondatabase/serverless';
// One database session per web process holds LISTEN qms_changes. Migration
// 013 raises a NOTIFY whenever tickets, notifications or staff availability
// change, and every connected screen is told to refresh. If the listener
// cannot be established the screens keep their own polling interval.
if (typeof WebSocket !== 'undefined')
  neonConfig.webSocketConstructor = WebSocket;
type Listener = (kind: string) => void;
const listeners = new Set<Listener>();
let client: Client | null = null;
let connecting: Promise<void> | null = null;
let retryAt = 0;
export function listening() {
  return client !== null;
}
// Neon's connection pooler (hostnames whose first label ends in "-pooler")
// accepts LISTEN but never forwards NOTIFY messages, so the listener always
// connects to the direct endpoint even when DATABASE_URL is the pooled one.
export function listenUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.replace(/^([^.]*)-pooler./, '$1.');
    return parsed.toString();
  } catch {
    return url;
  }
}
async function connect() {
  if (client) return;
  if (connecting) return connecting;
  if (Date.now() < retryAt) throw new Error('Listener retry pending.');
  connecting = (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_NOT_CONFIGURED');
    const c = new Client({ connectionString: listenUrl(url) });
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
      if (listeners.size)
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
