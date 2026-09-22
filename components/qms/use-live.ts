'use client';
import { useEffect, useRef, useState } from 'react';
// Subscribes to /api/events (server-sent events raised by PostgreSQL NOTIFY).
// While the stream is connected and the server confirms it is listening, a
// screen refreshes only when something changed; otherwise it falls back to
// its own polling interval. Returns whether live updates are active.
export function useLive(enabled: boolean, onChange: () => void) {
  const [live, setLive] = useState(false);
  // Mirrored in an effect rather than during render: the subscription is set
  // up once, and a discarded render must not write to a ref.
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    let pending: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener('status', (event) => {
      try {
        setLive(JSON.parse((event as MessageEvent).data).listening === true);
      } catch {
        setLive(false);
      }
    });
    source.onmessage = () => {
      // Several changes in quick succession become one refresh.
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => latest.current(), 300);
    };
    source.onerror = () => setLive(false);
    return () => {
      if (pending) clearTimeout(pending);
      source.close();
      setLive(false);
    };
  }, [enabled]);
  return live;
}
