'use client';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, formatDate } from '@/lib/client';
type AuditEvent = {
  id: string;
  action: string;
  created_at: string;
  actor_name: string | null;
  number: string | null;
  details: Record<string, unknown> | null;
};
const auditActions = [
  'login',
  'login_failed',
  'logout',
  'presence_online',
  'presence_offline',
  'customer_lookup',
  'issued',
  'assigned',
  'call',
  'start',
  'close',
  'no_show',
  'reassign',
  'team_updated',
  'queue_updated',
  'password_changed',
  'report_view',
  'report_export',
];
function auditSummary(details: Record<string, unknown> | null) {
  if (!details) return '';
  return Object.entries(details)
    .filter(([key, value]) => value !== null && value !== '' && key !== 'user')
    .map(
      ([key, value]) =>
        `${key.replaceAll('_', ' ')}: ${String(value).replaceAll('_', ' ')}`,
    )
    .join(' · ')
    .slice(0, 160);
}
export default function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function exportCsv() {
    setBusy(true);
    try {
      const params = new URLSearchParams({ from, to, action, format: 'csv' });
      const response = await fetch('/api/audit?' + params, {
        credentials: 'same-origin',
      });
      if (!response.ok)
        throw new Error(((await response.json()) as { error: string }).error);
      const blob = await response.blob();
      const uri = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = uri;
      a.download = `samana-qms-audit-${from || 'all'}-${to || 'all'}.csv`;
      a.click();
      URL.revokeObjectURL(uri);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const load = useCallback(
    async (before?: string | null) => {
      setBusy(true);
      try {
        const params = new URLSearchParams({ from, to, action, limit: '100' });
        if (before) params.set('before', before);
        const result = await api<{
          events: AuditEvent[];
          nextBefore: string | null;
        }>('audit?' + params);
        setEvents((current) =>
          before ? [...current, ...result.events] : result.events,
        );
        setNextBefore(result.nextBefore);
        setError('');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [from, to, action],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Operations audit trail</h2>
          <p>
            Sign-ins, availability, ticket, team and reporting events. Filter
            by date and action, load older pages, or export the filtered
            trail as CSV.
          </p>
        </div>
      </div>
      <div className="report-filters">
        <div>
          <label htmlFor="audit-from">From (Dubai)</label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="audit-to">To (Dubai)</label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="audit-action">Action</label>
          <select
            id="audit-action"
            className="form-control"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">All actions</option>
            {auditActions.map((a) => (
              <option key={a} value={a}>
                {a.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>TIME</th>
              <th>ACTION</th>
              <th>TICKET</th>
              <th>ACTOR</th>
              <th>DETAILS</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{formatDate(e.created_at)}</td>
                <td>{e.action.replaceAll('_', ' ')}</td>
                <td>{e.number || '—'}</td>
                <td>{e.actor_name || 'System'}</td>
                <td className="ticket-meta">{auditSummary(e.details)}</td>
              </tr>
            ))}
            {!events.length && (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">
                    {busy ? 'Loading…' : 'No events match these filters.'}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pagination">
        <span>
          {events.length} event{events.length === 1 ? '' : 's'} shown
        </span>
        <div className="section-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !events.length}
            onClick={exportCsv}
          >
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !nextBefore}
            onClick={() => load(nextBefore)}
          >
            Load older
          </Button>
        </div>
      </div>
    </section>
  );
}
