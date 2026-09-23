'use client';
import { useState, useEffect } from 'react';
import {
  Download,
  BarChart3,
  Clock3,
  CheckCircle2,
  Users,
  RefreshCw,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, today, formatDate } from '@/lib/client';
import { SERVICES, type Ticket } from '@qms/shared';
type Report = {
  rows: (Ticket & { service_minutes: string | null; wait_minutes: string })[];
  summary: {
    tickets: number;
    completed: number;
    no_show: number;
    average_service_minutes: number;
    average_wait_minutes: number;
  };
  byService: {
    service_id: string;
    service_name: string;
    department: string;
    tickets: number;
    completed: number;
    average_service_minutes: number;
  }[];
  total: number;
  from: string;
  to: string;
};
export default function Reports({
  onTicket,
}: {
  onTicket: (id: string) => void;
}) {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [service, setService] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const params = new URLSearchParams({
    from,
    to,
    service,
    page: String(page),
  }).toString();
  useEffect(() => {
    let active = true;
    setBusy(true);
    api<Report>('reports?' + params)
      .then((r) => {
        if (active) {
          setData(r);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [params]);
  function setRange(days: number) {
    const end = today();
    const start = new Date(end + 'T12:00:00Z');
    start.setUTCDate(start.getUTCDate() - days + 1);
    setFrom(start.toISOString().slice(0, 10));
    setTo(end);
    setPage(1);
  }
  const [identifiers, setIdentifiers] = useState(false);
  async function exportCsv() {
    setBusy(true);
    try {
      const response = await fetch(
        '/api/reports?' +
          params +
          '&format=csv' +
          (identifiers ? '&identifiers=true' : ''),
        { credentials: 'same-origin' },
      );
      if (!response.ok) {
        const error = (await response.json()) as { error: string };
        throw new Error(error.error);
      }
      const blob = await response.blob();
      const uri = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = uri;
      a.download = `samana-qms-${from}-${to}.csv`;
      a.click();
      URL.revokeObjectURL(uri);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack" aria-busy={busy}>
      <div className="report-presets">
        <fieldset className="service-tabs" aria-label="Report date presets">
          {[
            [1, 'Today'],
            [7, 'Last 7 days'],
            [30, 'Last 30 days'],
          ].map(([days, label]) => {
            const start = new Date(today() + 'T12:00:00Z');
            start.setUTCDate(start.getUTCDate() - Number(days) + 1);
            const selected =
              to === today() && from === start.toISOString().slice(0, 10);
            return (
              <button
                key={days}
                aria-pressed={selected}
                className={selected ? 'active' : ''}
                onClick={() => setRange(Number(days))}
              >
                {label}
              </button>
            );
          })}
        </fieldset>
        <output>
          {busy
            ? 'Updating report…'
            : data
              ? `${data.from} — ${data.to} · Dubai time`
              : 'Choose a date range'}
        </output>
      </div>
      <section className="report-filters panel">
        <div>
          <label htmlFor="report-from">From (Dubai)</label>
          <Input
            id="report-from"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="report-to">To (Dubai)</label>
          <Input
            id="report-to"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label htmlFor="report-service">Service</label>
          <select
            id="report-service"
            value={service}
            onChange={(e) => {
              setService(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All services</option>
            {SERVICES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.department} · {s.name}
              </option>
            ))}
          </select>
        </div>
        <label
          className="filter-check"
          style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}
        >
          <input
            type="checkbox"
            checked={identifiers}
            onChange={(e) => setIdentifiers(e.target.checked)}
          />
          Include mobile, Emirates ID and passport
        </label>
        <Button
          onClick={exportCsv}
          disabled={busy || !data?.total}
          variant="outline"
        >
          <Download size={15} /> Export CSV
        </Button>
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="stats-grid">
            {[
              [
                'Total visits',
                data.summary.tickets,
                'In selected date range',
                Users,
              ],
              [
                'Completed',
                data.summary.completed,
                `${data.summary.no_show} no-shows`,
                CheckCircle2,
              ],
              [
                'Average wait',
                data.summary.average_wait_minutes + ' min',
                'Tickets that have been called',
                Clock3,
              ],
              [
                'Average service',
                data.summary.average_service_minutes + ' min',
                'Completed, started interactions',
                BarChart3,
              ],
            ].map(([title, value, caption, Icon]) => {
              const I = Icon as typeof Users;
              return (
                <article className="stat-card" key={String(title)}>
                  <div className="stat-label">
                    {String(title)}
                    <I size={18} />
                  </div>
                  <strong>{String(value)}</strong>
                  <small>{String(caption)}</small>
                </article>
              );
            })}
          </div>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Visits by service</h2>
                <p>Understand demand across your customer service floor.</p>
              </div>
              {busy && <RefreshCw size={16} className="spin" />}
            </div>
            {data.byService.length ? (
              <div className="chart-area">
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart
                    data={data.byService.map((s) => ({
                      ...s,
                      label:
                        s.department === 'General Query'
                          ? 'Walk-in'
                          : s.service_name,
                    }))}
                    margin={{ top: 10, right: 25, left: 0, bottom: 5 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="#e9edef"
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: '#778b95' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: '#778b95' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip cursor={{ fill: '#f5f8f0' }} />
                    <Legend
                      iconType="circle"
                      iconSize={7}
                      wrapperStyle={{ fontSize: 11, paddingTop: 15 }}
                    />
                    <Bar
                      dataKey="tickets"
                      name="Tickets"
                      fill="#5c8365"
                      radius={[5, 5, 0, 0]}
                      maxBarSize={70}
                    />
                    <Bar
                      dataKey="completed"
                      name="Completed"
                      fill="#c8b487"
                      radius={[5, 5, 0, 0]}
                      maxBarSize={70}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="empty-state">
                <BarChart3 size={30} />
                <h3>No visits in this period</h3>
                <p>Choose another date range to explore activity.</p>
              </div>
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Visit report</h2>
                <p>
                  {data.total} tickets · Export includes closing notes;
                  customer identifiers only when ticked. Every export is
                  recorded in the activity log.
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {[
                      'TICKET',
                      'CUSTOMER / UNIT',
                      'SERVICE',
                      'AGENT',
                      'ISSUED',
                      'WAIT',
                      'SERVICE TIME',
                      'STATUS',
                    ].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((ticket) => (
                    <tr key={ticket.id}>
                      <td>
                        <button
                          className="btn-link ticket-number"
                          onClick={() => onTicket(ticket.id)}
                        >
                          {ticket.number}
                        </button>
                      </td>
                      <td>
                        <strong>{ticket.customer_name}</strong>
                        <span className="ticket-meta">
                          {ticket.project_name}{' '}
                          {ticket.unit_name ? '· ' + ticket.unit_name : ''}
                        </span>
                      </td>
                      <td>
                        {ticket.service_name}
                        <span className="ticket-meta">{ticket.department}</span>
                      </td>
                      <td>{ticket.assigned_name || '—'}</td>
                      <td>{formatDate(ticket.created_at)}</td>
                      <td>{ticket.wait_minutes}m</td>
                      <td>
                        {ticket.service_minutes
                          ? ticket.service_minutes + 'm'
                          : '—'}
                      </td>
                      <td>
                        <span className={'badge ' + ticket.status}>
                          {ticket.status.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!data.rows.length && (
                    <tr>
                      <td colSpan={8}>
                        <div className="empty-state">
                          No tickets for this date range.
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {data.total
                  ? `${(page - 1) * 100 + 1}–${Math.min(page * 100, data.total)} of ${data.total}`
                  : '0 tickets'}
              </span>
              <div className="section-actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 1 || busy}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page * 100 >= data.total || busy}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
