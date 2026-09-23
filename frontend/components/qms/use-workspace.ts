'use client';
import { useEffect, useState } from 'react';
import { api, send } from '@/lib/client';
// Timers the workspace shell runs while a person is signed in. Each has one
// job and its own lifetime, moved out of the shell so the shell reads as
// layout and state rather than as a list of intervals.

/**
 * Tells the server every 15 seconds that this agent is still at the counter.
 * The database treats 45 seconds of silence as gone (migration 015), so a
 * screen that dies stops receiving customers within that window.
 */
export function useHeartbeat(active: boolean, onError: (message: string) => void) {
  useEffect(() => {
    if (!active) return;
    const beat = () =>
      send('PUT', 'presence', { online: true }).catch(() =>
        onError('Unable to update your availability. Check your connection.'),
      );
    void beat();
    const id = setInterval(beat, 15000);
    return () => clearInterval(id);
  }, [active, onError]);
}

/** Clears a transient message after `ms`; a new message restarts the clock. */
export function useAutoClear(
  value: string,
  clear: (next: string) => void,
  ms = 7000,
) {
  useEffect(() => {
    if (!value) return;
    const id = setTimeout(() => clear(''), ms);
    return () => clearTimeout(id);
  }, [value, clear, ms]);
}

/**
 * The rotating check-in link, refreshed every two minutes while the QR
 * dialog is open; each link is signed and valid for five minutes.
 */
export function useCheckinLink(open: boolean, onError: (message: string) => void) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () =>
      api<{ url: string }>('checkin-link')
        .then((x) => {
          if (active) setUrl(x.url);
        })
        .catch((e: Error) => onError(e.message));
    void load();
    const timer = setInterval(load, 120000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, onError]);
  return url;
}
