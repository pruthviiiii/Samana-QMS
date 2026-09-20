'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SERVICES } from '@/lib/domain';
import { api, post, formatDate } from '@/lib/client';
type GroupData = {
  groups: { id: string; name: string; type: string }[];
  mappings: {
    service_id: string;
    sf_group_id: string;
    sf_group_name: string;
    synced_at: string;
  }[];
};
export default function ServiceGroups() {
  const [data, setData] = useState<GroupData | null>(null),
    [selection, setSelection] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    setError('');
    try {
      const d = await api<GroupData>('integrations/salesforce/groups');
      setData(d);
      setSelection(
        Object.fromEntries(
          d.mappings.map((m) => [m.service_id, m.sf_group_id]),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function sync(serviceId: string) {
    setBusy(serviceId);
    setError('');
    setMessage('');
    try {
      const result = await post<{ members: number }>(
        'integrations/salesforce/groups',
        { serviceId, groupId: selection[serviceId] },
      );
      setMessage(
        `${result.members} team members mapped. Activate imported accounts in Team.`,
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Salesforce service groups</h2>
          <p>
            Choose the source queue for each service. Sync updates Salesforce
            staff membership in this app; local staff keep their assigned
            services.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={!!busy || loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
      <div className="page-section stack">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && <output className="success">{message}</output>}
        {!data ? (
          loading ? (
            <p className="muted">Loading Salesforce queues…</p>
          ) : null
        ) : (
          SERVICES.map((s) => (
            <div className="group-mapping" key={s.id}>
              <div>
                <label htmlFor={'group-' + s.id}>
                  {s.department} · {s.name}
                </label>
                <small className="muted">
                  {data.mappings.find((m) => m.service_id === s.id)
                    ? 'Last synced ' +
                      formatDate(
                        data.mappings.find((m) => m.service_id === s.id)!
                          .synced_at,
                      )
                    : 'Individual team mappings'}
                </small>
              </div>
              <select
                className="form-control"
                id={'group-' + s.id}
                value={selection[s.id] || ''}
                onChange={(e) =>
                  setSelection({ ...selection, [s.id]: e.target.value })
                }
              >
                <option value="">Select Salesforce queue / group</option>
                {data.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.type})
                  </option>
                ))}
              </select>
              <Button
                disabled={!!busy || !selection[s.id]}
                onClick={() => sync(s.id)}
              >
                {busy === s.id ? 'Syncing…' : 'Sync group'}
              </Button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
