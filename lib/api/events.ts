import { listening, subscribe } from '../events';
import { define, roles } from '../router';
import { STAFF } from './shared';
const encoder = new TextEncoder();
const frame = (event: string | null, data: string) =>
  (event ? `event: ${event}\n` : '') + `data: ${data}\n\n`;
export const eventRoutes = [
  // Server-sent events: one open response per screen. A comment line every
  // 25 seconds keeps proxies from closing an idle stream.
  define('GET', 'events', roles(...STAFF, 'display'), async () => {
    let unsubscribe = () => {};
    let ping: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        const cleanup = () => {
          closed = true;
          unsubscribe();
          if (ping) clearInterval(ping);
        };
        send(
          'retry: 5000\n' +
            frame('status', JSON.stringify({ listening: listening() })),
        );
        unsubscribe = subscribe(
          (kind) => send(frame(null, JSON.stringify({ kind }))),
          (ok) => send(frame('status', JSON.stringify({ listening: ok }))),
        );
        ping = setInterval(() => send(': ping\n\n'), 25000);
      },
      cancel() {
        closed = true;
        unsubscribe();
        if (ping) clearInterval(ping);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  }),
];
