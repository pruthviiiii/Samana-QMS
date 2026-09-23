'use client';
import { useEffect, useState } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, send } from '@/lib/client';
import { MAX_PRIORITY, SERVICES, isPresent, priorityLabel, roleLabel } from '@qms/shared';
type Member = {
  id: string;
  name: string;
  role: string;
  online: boolean;
  last_seen: string | null;
  enabled: boolean;
  counter: string;
  service_id: string;
};
type Eligible = { id: string; name: string; role: string; enabled: boolean };
// Queue membership lives in the app database only. Nothing here is read from or
// written to Salesforce; routing reads the same users.services array.
export default function Queues() {
  const [members, setMembers] = useState<Member[]>([]);
  const [eligible, setEligible] = useState<Eligible[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const [priority, setPriority] = useState<Record<string, number>>({});
  async function load() {
    setLoading(true);
    try {
      const data = await api<{
        members: Member[];
        eligible: Eligible[];
        priority: Record<string, number>;
      }>('queues');
      setMembers(data.members);
      setEligible(data.eligible);
      setPriority(data.priority);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  // Urgency between services. A waiting customer in a higher-priority service
  // is routed before an older one elsewhere; inside a service, arrival order
  // still decides, so raising this can never reorder one queue against itself.
  async function changePriority(serviceId: string, next: number) {
    const previous = priority[serviceId] ?? 0;
    setPriority((current) => ({ ...current, [serviceId]: next }));
    setBusy(true);
    try {
      await send('PUT', `queues/${serviceId}/priority`, { priority: next });
      setError('');
    } catch (e) {
      setPriority((current) => ({ ...current, [serviceId]: previous }));
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function change(serviceId: string, userId: string, member: boolean) {
    if (!member) {
      const remaining =
        members.filter((m) => m.service_id === serviceId).length - 1;
      const service =
        SERVICES.find((s) => s.id === serviceId)?.name ?? serviceId;
      if (
        remaining <= 0 &&
        !window.confirm(
          `This is the last member of ${service}. New tickets for it will wait unassigned until someone is added. Remove anyway?`,
        )
      )
        return;
    }
    setBusy(true);
    setError('');
    try {
      await send(
        member ? 'PUT' : 'DELETE',
        `queues/${serviceId}/members/${userId}`,
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const isOnline = (m: Member) => isPresent(m.online, m.last_seen);
  return (
    <div className="stack">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Service queues</h2>
            <p>
              Who receives tickets for each service. Queues live in this app
              only; nothing is read from or written to Salesforce.
            </p>
          </div>
          <Button variant="ghost" onClick={load} disabled={busy || loading}>
            <RefreshCw size={14} />
            Refresh
          </Button>
        </div>
        <div className="queues-grid">
          {SERVICES.map((service) => {
            const list = members.filter((m) => m.service_id === service.id);
            const candidates = eligible.filter(
              (e) => e.enabled && !list.some((m) => m.id === e.id),
            );
            const selected = adding[service.id] || '';
            return (
              <div className="queue-card" key={service.id}>
                <h3>
                  {service.department} · {service.name}
                </h3>
                <p className="muted">
                  {list.length} member{list.length === 1 ? '' : 's'} ·{' '}
                  {list.filter(isOnline).length} online
                </p>
                <div className="queue-priority">
                  <label htmlFor={'priority-' + service.id}>Urgency</label>
                  <select
                    id={'priority-' + service.id}
                    value={priority[service.id] ?? 0}
                    disabled={busy || loading}
                    onChange={(e) =>
                      void changePriority(service.id, Number(e.target.value))
                    }
                  >
                    {[0, 3, 6, MAX_PRIORITY].map((level) => (
                      <option key={level} value={level}>
                        {priorityLabel(level)}
                      </option>
                    ))}
                  </select>
                  {(priority[service.id] ?? 0) > 0 && (
                    <small>Routed ahead of lower-urgency services</small>
                  )}
                </div>
                <ul className="queue-members">
                  {list.map((m) => (
                    <li key={m.id}>
                      <span
                        className={'status-dot ' + (isOnline(m) ? 'green' : '')}
                      />
                      <span>
                        {m.name}
                        <small className="ticket-meta">
                          {' '}
                          {roleLabel(m.role)}
                          {m.counter ? ' · ' + m.counter : ''}
                          {m.enabled ? '' : ' · disabled'}
                        </small>
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={'Remove ' + m.name + ' from ' + service.name}
                        onClick={() => change(service.id, m.id, false)}
                        disabled={busy}
                      >
                        <X size={14} />
                      </Button>
                    </li>
                  ))}
                  {!list.length && (
                    <li className={loading ? 'muted' : 'error'}>
                      {loading
                        ? 'Loading…'
                        : 'No members: tickets for this service will wait unassigned.'}
                    </li>
                  )}
                </ul>
                <div className="row">
                  <select
                    aria-label={'Add a member to ' + service.name}
                    className="form-control"
                    value={selected}
                    onChange={(e) =>
                      setAdding({ ...adding, [service.id]: e.target.value })
                    }
                  >
                    <option value="">Add a member…</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({roleLabel(c.role)})
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !selected}
                    onClick={() => {
                      setAdding({ ...adding, [service.id]: '' });
                      void change(service.id, selected, true);
                    }}
                  >
                    <Plus size={14} />
                    Add
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
