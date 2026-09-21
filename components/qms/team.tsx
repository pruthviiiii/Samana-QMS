'use client';
import { useEffect, useState } from 'react';
import {
  Plus,
  RefreshCw,
  Users,
  Search,
  Pencil,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { api, post } from '@/lib/client';
import {
  SERVICES,
  STAFF_ROLES,
  roleLabel,
  type User,
  type Role,
} from '@/lib/domain';
// Temporary passwords are generated here, never invented and typed by hand.
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const out: string[] = [];
  while (out.length < 20)
    for (const b of crypto.getRandomValues(new Uint8Array(32)))
      if (b < 216 && out.length < 20) out.push(alphabet[b % alphabet.length]);
  return out.join('');
}
type TeamUser = User & { active_tickets: number };
type SalesforceUser = {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  managerId: string | null;
  managerName: string | null;
};
type EditUser = {
  id?: string;
  username: string;
  name: string;
  email: string;
  role: Role;
  sfId: string;
  managerSfId: string;
  services: string[];
  counter: string;
  enabled: boolean;
  password: string;
};
const blank: EditUser = {
  username: '',
  name: '',
  email: '',
  role: 'agent',
  sfId: '',
  managerSfId: '',
  services: [],
  counter: '',
  enabled: true,
  password: '',
};
export default function Team({ user }: { user: User }) {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState<EditUser | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [sfQuery, setSfQuery] = useState('');
  const [sfResults, setSfResults] = useState<SalesforceUser[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  async function load() {
    setLoading(true);
    try {
      setUsers((await api<{ users: TeamUser[] }>('team')).users);
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
  async function save(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!edit) return;
    const original = edit.id ? users.find((u) => u.id === edit.id) : undefined;
    if (
      original?.enabled &&
      !edit.enabled &&
      !window.confirm(
        `Disable ${edit.name}? Their session ends immediately and they stop receiving tickets.`,
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await post('team', {
        ...edit,
        email: edit.email.trim() || null,
        sfId: edit.sfId || null,
        managerSfId: edit.managerSfId || null,
        password: edit.password || undefined,
      });
      setEdit(null);
      setMessage('Team member saved.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // Nothing is fetched until an administrator searches; results live only in the dialog.
  async function findInSalesforce(e: React.SyntheticEvent) {
    e.preventDefault();
    if (sfQuery.trim().length < 3) {
      setError('Enter at least 3 characters to search Salesforce.');
      return;
    }
    setSearching(true);
    setError('');
    try {
      const result = await api<{ users: SalesforceUser[] }>(
        'integrations/salesforce/users?' +
          new URLSearchParams({ q: sfQuery.trim() }),
      );
      setSfResults(result.users);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }
  function applySalesforceUser(u: SalesforceUser) {
    if (!edit) return;
    setEdit({
      ...edit,
      name: u.name,
      username: edit.username || u.username || u.email || '',
      email: u.email || '',
      sfId: u.id,
      managerSfId: u.managerId || '',
    });
    setSfResults(null);
    setSfQuery('');
  }
  function openEditor(next: EditUser) {
    setError('');
    setSfQuery('');
    setSfResults(null);
    setEdit(next);
  }
  const online = users.filter(
    (u) =>
      u.online && u.last_seen && Date.now() - Date.parse(u.last_seen) < 90000,
  ).length;
  return (
    <div className="stack">
      {error && !edit && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <output className="success">{message}</output>}
      <div className="team-summary">
        <div>
          <Users size={20} />
          <strong>{users.length}</strong> team members
        </div>
        <div>
          <span className="status-dot green" />
          <strong>{online}</strong> online now
        </div>
        <div>
          <ShieldCheck size={20} /> Role-based access
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Your service team</h2>
            <p>
              Add members one at a time from Salesforce, then assign queues
              and counters here.
            </p>
          </div>
          {user.role === 'admin' && (
            <div className="section-actions">
              <Button onClick={() => openEditor({ ...blank, services: [] })}>
                <Plus size={15} />
                Add member
              </Button>
            </div>
          )}
        </div>
        <div className="queue-toolbar">
          <div className="search">
            <Search size={16} />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search team"
              placeholder="Search team members…"
            />
          </div>
          <Button variant="ghost" onClick={load} disabled={loading}>
            <RefreshCw size={14} />
            Refresh
          </Button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>TEAM MEMBER</th>
                <th>ROLE</th>
                <th>SERVICES</th>
                <th>COUNTER</th>
                <th>PRESENCE</th>
                <th>ACTIVE</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users
                .filter((u) =>
                  (u.name + ' ' + u.username)
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((u) => (
                  <tr key={u.id}>
                    <td aria-label={u.name}>
                      <div className="row">
                        <span className="avatar">
                          {u.name
                            .split(' ')
                            .map((x) => x[0])
                            .slice(0, 2)
                            .join('')}
                        </span>
                        <div>
                          <strong>{u.name}</strong>
                          <small className="ticket-meta">
                            {u.username}
                            {u.email ? ' · ' + u.email : ''}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="role-badge">{roleLabel(u.role)}</span>
                    </td>
                    <td>
                      <div className="tags">
                        {u.services.map((s) => (
                          <span key={s}>
                            {SERVICES.find((service) => service.id === s)
                              ?.name || s}
                          </span>
                        ))}
                        {u.services.length === 0 && (
                          <span className="muted">No services mapped</span>
                        )}
                      </div>
                    </td>
                    <td>{u.counter || '—'}</td>
                    <td>
                      <span
                        className={
                          'badge ' +
                          (u.online &&
                          u.last_seen &&
                          Date.now() - Date.parse(u.last_seen) < 90000
                            ? 'serving'
                            : 'neutral')
                        }
                      >
                        {!u.enabled
                          ? 'Disabled'
                          : u.online &&
                              u.last_seen &&
                              Date.now() - Date.parse(u.last_seen) < 90000
                            ? 'Online'
                            : 'Offline'}
                      </span>
                    </td>
                    <td>{u.active_tickets}</td>
                    <td>
                      {user.role === 'admin' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={'Edit ' + u.name}
                          onClick={() => {
                            openEditor({
                              id: u.id,
                              username: u.username,
                              name: u.name,
                              email: u.email || '',
                              role: u.role,
                              sfId: u.sf_id || '',
                              managerSfId: u.manager_sf_id || '',
                              services: u.services,
                              counter: u.counter,
                              enabled: u.enabled,
                              password: '',
                            });
                          }}
                        >
                          <Pencil size={15} />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              {!users.length && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      {loading ? 'Loading team…' : 'No team members found.'}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <Dialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open && !busy) setEdit(null);
        }}
      >
        <DialogContent className="team-dialog">
          <DialogTitle>
            {edit?.id ? 'Edit team member' : 'Add team member'}
          </DialogTitle>
          <DialogDescription>
            Manage account access, Salesforce identity, and assigned service
            queues.
          </DialogDescription>
          {edit && (
            <form onSubmit={save}>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="sf-search">
                <label htmlFor="team-sf-search">Find in Salesforce</label>
                <div className="row">
                  <Input
                    id="team-sf-search"
                    value={sfQuery}
                    onChange={(e) => setSfQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void findInSalesforce(e);
                    }}
                    placeholder="Name, username or email (3+ characters)"
                    maxLength={100}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={findInSalesforce}
                    disabled={searching || sfQuery.trim().length < 3}
                  >
                    <Search size={14} />
                    {searching ? 'Searching…' : 'Search'}
                  </Button>
                </div>
                {sfResults && (
                  <ul className="sf-results">
                    {sfResults.map((u) => (
                      <li key={u.id}>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => applySalesforceUser(u)}
                        >
                          <strong>{u.name}</strong>
                          <span className="ticket-meta">
                            {u.email || u.username || u.id}
                            {u.managerName ? ' · reports to ' + u.managerName : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                    {!sfResults.length && (
                      <li className="muted">No active Salesforce user matched.</li>
                    )}
                  </ul>
                )}
                <small className="field-hint">
                  Selecting a person fills their name, email, Salesforce ID and
                  manager. Only members you save exist in the app.
                </small>
              </div>
              <div className="form-grid">
                <div>
                  <label htmlFor="team-name">Full name</label>
                  <Input
                    id="team-name"
                    value={edit.name}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                    required
                    minLength={2}
                    maxLength={100}
                  />
                </div>
                <div>
                  <label htmlFor="team-username">Username</label>
                  <Input
                    id="team-username"
                    value={edit.username}
                    onChange={(e) =>
                      setEdit({ ...edit, username: e.target.value })
                    }
                    required
                    minLength={3}
                    maxLength={120}
                  />
                </div>
                <div>
                  <label htmlFor="team-email">Email (optional sign-in)</label>
                  <Input
                    id="team-email"
                    type="email"
                    autoComplete="off"
                    value={edit.email}
                    onChange={(e) =>
                      setEdit({ ...edit, email: e.target.value })
                    }
                    placeholder="name@samana-group.com"
                    maxLength={254}
                  />
                </div>
                <div>
                  <label htmlFor="team-role">Role</label>
                  <select
                    id="team-role"
                    className="form-control"
                    value={edit.role}
                    onChange={(e) =>
                      setEdit({ ...edit, role: e.target.value as Role })
                    }
                  >
                    {STAFF_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {roleLabel(r)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="team-counter">Counter / desk</label>
                  <Input
                    id="team-counter"
                    value={edit.counter}
                    onChange={(e) =>
                      setEdit({ ...edit, counter: e.target.value })
                    }
                    maxLength={40}
                  />
                </div>
                <div>
                  <label htmlFor="team-sf">Salesforce user ID</label>
                  <Input
                    id="team-sf"
                    value={edit.sfId}
                    onChange={(e) => setEdit({ ...edit, sfId: e.target.value })}
                    placeholder="005…"
                    maxLength={18}
                    pattern="005[A-Za-z0-9]{12,15}"
                    title="A Salesforce user ID starts with 005 and has 15 or 18 characters"
                  />
                </div>
                <div>
                  <label htmlFor="team-manager">Manager Salesforce ID</label>
                  <Input
                    id="team-manager"
                    value={edit.managerSfId}
                    onChange={(e) =>
                      setEdit({ ...edit, managerSfId: e.target.value })
                    }
                    placeholder="005…"
                    maxLength={18}
                    pattern="005[A-Za-z0-9]{12,15}"
                    title="A Salesforce user ID starts with 005 and has 15 or 18 characters"
                  />
                </div>
              </div>
              <fieldset>
                <legend>Service access</legend>
                <div className="service-checkboxes">
                  {SERVICES.map((s) => (
                    <label key={s.id}>
                      <input
                        type="checkbox"
                        checked={edit.services.includes(s.id)}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            services: e.target.checked
                              ? [...edit.services, s.id]
                              : edit.services.filter((x) => x !== s.id),
                          })
                        }
                      />
                      <span>
                        {s.department} · {s.name}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div>
                <label htmlFor="team-password">
                  {edit.id
                    ? 'Reset temporary password (leave blank to keep current)'
                    : 'Temporary password'}
                </label>
                <div className="row">
                  <Input
                    id="team-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={edit.password}
                    onChange={(e) =>
                      setEdit({ ...edit, password: e.target.value })
                    }
                    required={!edit.id}
                    minLength={14}
                    maxLength={128}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEdit({ ...edit, password: temporaryPassword() });
                      setShowPassword(true);
                    }}
                  >
                    Generate
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </Button>
                </div>
                <small className="field-hint">
                  At least 14 characters. Generate one, hand it over in person,
                  and the member must change it at first sign-in.
                </small>
              </div>
              <label className="row">
                <input
                  type="checkbox"
                  checked={edit.enabled}
                  onChange={(e) =>
                    setEdit({ ...edit, enabled: e.target.checked })
                  }
                />
                Account enabled
              </label>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save team member'}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
