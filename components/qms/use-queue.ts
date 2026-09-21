'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import type { Ticket } from '@/lib/domain';
import { useLive } from './use-live';
export type Notice = {
  id: number | string;
  ticket_id: string;
  number: string;
  customer_name: string;
  project_name: string;
  unit_name: string;
};
export type QueueData = {
  tickets: Ticket[];
  total: number;
  page: number;
  limit: number;
  statistics: {
    waiting: number;
    serving: number;
    completed: number;
    avg_wait: number;
    unassigned: number;
  };
  services: {
    id: string;
    name: string;
    department: string;
    waiting: number;
    serving: number;
  }[];
  notifications: Notice[];
  workerLastRun: string | null;
};
export type QueueParams = {
  search: string;
  department: string;
  status: string;
  page: number;
  mine: boolean;
};
// The live queue for the staff workspace: one fetch function, one timer, and
// a live-update subscription. Filters change what is fetched without tearing
// the timer down; the timer is only a safety net while live updates work.
export function useQueue({
  enabled,
  params,
  onAssigned,
  onSignedOut,
}: {
  enabled: boolean;
  params: QueueParams;
  onAssigned: (notice: Notice, text: string) => void;
  onSignedOut: () => void;
}) {
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState('');
  const lastNotice = useRef<number | null>(null);
  const latest = useRef({ params, onAssigned, onSignedOut });
  latest.current = { params, onAssigned, onSignedOut };
  const refresh = useCallback(
    async (silent = false) => {
      if (!enabled) return;
      const { params, onAssigned, onSignedOut } = latest.current;
      if (!silent) setLoading(true);
      try {
        const result = await api<QueueData>(
          'queue?' +
            new URLSearchParams({
              search: params.search,
              department: params.department,
              status: params.status,
              page: String(params.page),
              mine: String(params.mine),
            }),
        );
        setData(result);
        setError('');
        setUpdated(
          new Date().toLocaleTimeString('en-AE', {
            hour: '2-digit',
            minute: '2-digit',
          }),
        );
        const newest = result.notifications[0];
        // Ids arrive as strings (bigint); compare as numbers.
        const newestId = newest ? Number(newest.id) : null;
        if (
          newest &&
          newestId !== null &&
          lastNotice.current !== null &&
          newestId > lastNotice.current
        )
          onAssigned(
            newest,
            `${newest.number} assigned · ${newest.customer_name} · ${newest.project_name || 'Walk-in'} ${newest.unit_name || ''}`,
          );
        if (newestId !== null) lastNotice.current = newestId;
        else if (lastNotice.current === null) lastNotice.current = 0;
      } catch (e) {
        if ((e as Error & { status?: number }).status === 401) {
          setData(null);
          onSignedOut();
        } else setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [enabled],
  );
  const key = JSON.stringify(params);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, key, refresh]);
  const live = useLive(enabled, () => void refresh(true));
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void refresh(true), live ? 30000 : 5000);
    return () => clearInterval(timer);
  }, [enabled, live, refresh]);
  return { data, error, loading, updated, live, refresh, setError };
}
