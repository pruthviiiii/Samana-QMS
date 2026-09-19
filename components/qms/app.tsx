'use client';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useDeferredValue,
} from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  LayoutDashboard,
  ListOrdered,
  Users,
  BarChart3,
  Settings as SettingsIcon,
  Monitor,
  Plus,
  ArrowUpRight,
  Clock3,
  Headphones,
  CheckCircle2,
  Search,
  Building2,
  RefreshCw,
  Bell,
  LogOut,
  ArrowRight,
  ShieldCheck,
  Loader2,
  QrCode,
  Check,
  History,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { api, post, formatDate } from '@/lib/client';
import {
  type User,
  type Ticket,
  isManager,
  minutesBetween,
} from '@/lib/domain';
import CheckIn from './check-in';
import TicketDetail from './ticket-detail';
import Team from './team';
import Reports from './reports';
import Settings from './settings';
import TVDisplay from './tv-display';
type Notice = {
  id: number;
  ticket_id: string;
  number: string;
  customer_name: string;
  project_name: string;
  unit_name: string;
};
type QueueData = {
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
const viewNames: Record<string, string> = {
  overview: 'Overview',
  queue: 'Live queue',
  agent: 'Agent console',
  team: 'Team',
  reports: 'Reports',
  settings: 'Settings',
  checkin: 'Customer check-in',
  audit: 'Activity log',
};
export default function QmsApp({
  initialView = 'overview',
}: {
  initialView?: string;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState(initialView);
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [department, setDepartment] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qr, setQr] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const lastNotice = useRef<number | null>(null);
  const [updated, setUpdated] = useState('');
  const manager = user ? isManager(user.role) : false;
  const serviceStaff =
    !!user && ['admin', 'hod', 'manager', 'agent'].includes(user.role);
  const canIssue =
    !!user &&
    ['admin', 'hod', 'manager', 'agent', 'reception'].includes(user.role);
  const refreshIdentity = useCallback(async () => {
    try {
      const result = await api<{ user: User }>('auth/me');
      setUser(result.user);
      if (result.user.role === 'customer') {
        window.location.replace('/check-in');
        return;
      }
      if (result.user.role === 'display') setView('display');
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status !== 401) setError((e as Error).message);
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void refreshIdentity();
  }, [refreshIdentity]);
  const refresh = useCallback(
    async (silent = false) => {
      if (
        !user ||
        user.must_change_password ||
        !['admin', 'hod', 'manager', 'agent', 'reception'].includes(user.role)
      )
        return;
      if (!silent) setLoading(true);
      try {
        const result = await api<QueueData>(
          'queue?' +
            new URLSearchParams({
              search: deferredSearch,
              department,
              status,
              page: String(page),
              mine: String(view === 'agent'),
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
        if (
          newest &&
          lastNotice.current !== null &&
          newest.id > lastNotice.current
        )
          setToast(
            `${newest.number} assigned · ${newest.customer_name} · ${newest.project_name || 'Walk-in'} ${newest.unit_name || ''}`,
          );
        if (newest) lastNotice.current = newest.id;
        else if (lastNotice.current === null) lastNotice.current = 0;
      } catch (e) {
        if ((e as Error & { status?: number }).status === 401) {
          setUser(null);
          setData(null);
        } else setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [user, deferredSearch, department, status, page, view],
  );
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(true), 5000);
    return () => clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    if (!user?.online || !serviceStaff || user.must_change_password) return;
    const heartbeat = () =>
      post('presence', { online: true }).catch(() =>
        setError('Unable to update your availability. Check your connection.'),
      );
    void heartbeat();
    const id = setInterval(heartbeat, 30000);
    return () => clearInterval(id);
  }, [user?.online, user?.must_change_password, serviceStaff]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 7000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (!qrOpen) return;
    let active = true;
    const load = () =>
      api<{ url: string }>('checkin-link')
        .then((x) => {
          if (active) setQr(x.url);
        })
        .catch((e) => setError(e.message));
    void load();
    const timer = setInterval(load, 120000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [qrOpen]);
  function navigate(next: string) {
    setView(next);
    window.history.pushState(null, '', next === 'overview' ? '/' : '/' + next);
  }
  useEffect(() => {
    const back = () =>
      setView(window.location.pathname.split('/')[1] || 'overview');
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  async function presence() {
    if (!user) return;
    try {
      await post('presence', { online: !user.online });
      setUser({ ...user, online: !user.online });
      setToast(
        user.online
          ? 'You are now offline.'
          : 'You are online and ready to receive customers.',
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function logout() {
    try {
      await post('auth/logout', {});
      setUser(null);
      setData(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function clearNotices() {
    if (!data) return;
    try {
      await post('notifications/read', {
        ids: data.notifications.map((n) => n.id),
      });
      setNotificationsOpen(false);
      void refresh(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (checking)
    return (
      <div className="app-loading">
        <a className="brand dark-brand" href="/">
          SAMANA<span>DEVELOPERS</span>
        </a>
        <Loader2 className="spin" />
        <p>Connecting your workspace…</p>
      </div>
    );
  if (!user) return <Login onLogin={refreshIdentity} initialError={error} />;
  if (user.must_change_password)
    return (
      <div className="first-login">
        <div className="first-login-heading">
          <ShieldCheck size={29} />
          <h1>Make your account yours</h1>
          <p>Change your temporary password before entering the workspace.</p>
        </div>
        <Settings user={user} onPasswordChanged={refreshIdentity} />
        <Button variant="ghost" onClick={logout}>
          Sign out
        </Button>
      </div>
    );
  if (view === 'display' || user.role === 'display') return <TVDisplay />;
  const navigation = [
    { id: 'overview', name: 'Overview', icon: LayoutDashboard },
    { id: 'queue', name: 'Live queue', icon: ListOrdered },
    ...(serviceStaff
      ? [{ id: 'agent', name: 'Agent console', icon: Headphones }]
      : []),
    ...(manager
      ? [
          { id: 'team', name: 'Team', icon: Users },
          { id: 'reports', name: 'Reports', icon: BarChart3 },
          { id: 'audit', name: 'Activity log', icon: History },
        ]
      : []),
    { id: 'settings', name: 'Settings', icon: SettingsIcon },
  ];
  const title =
    view === 'overview'
      ? 'Queue overview'
      : view === 'agent'
        ? 'Your service desk'
        : viewNames[view] || 'Workspace';
  const visibleTickets =
    view === 'agent'
      ? data?.tickets.filter((t) => t.assigned_to === user.id) || []
      : data?.tickets || [];
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/">
          SAMANA<span>DEVELOPERS</span>
        </a>
        <div className="workspace-label">CUSTOMER EXPERIENCE</div>
        <nav>
          {navigation.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? 'nav-item selected' : 'nav-item'}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              {item.name}
              {item.id === 'queue' && !!data?.statistics.waiting && (
                <span className="nav-count">{data.statistics.waiting}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-shortcuts">
          {canIssue && (
            <button onClick={() => setQrOpen(true)}>
              <QrCode size={16} />
              Mobile check-in QR
            </button>
          )}
          {manager && (
            <a href="/display" target="_blank" rel="noreferrer">
              <Monitor size={16} />
              Open TV display
              <ArrowUpRight size={13} />
            </a>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="branch">
            <Building2 size={18} />
            <div>
              Samana Headquarters<small>Dubai, United Arab Emirates</small>
            </div>
          </div>
          <div className="profile">
            <span className="avatar">
              {user.name
                .split(' ')
                .map((x) => x[0])
                .slice(0, 2)
                .join('')}
            </span>
            <div>
              {user.name}
              <small>
                {user.role === 'hod'
                  ? 'Head of Department'
                  : user.role === 'agent'
                    ? 'Executive'
                    : user.role}
              </small>
            </div>
            <button
              className="logout-button"
              aria-label="Sign out"
              onClick={logout}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            Operations <span className="slash">/</span>{' '}
            {viewNames[view] || title}
          </span>
          <div className="topbar-actions">
            {serviceStaff && (
              <button
                className={'presence-toggle ' + (user.online ? 'online' : '')}
                onClick={presence}
              >
                <span
                  className={'status-dot ' + (user.online ? 'green' : '')}
                />
                {user.online ? 'Available' : 'Offline'}
              </button>
            )}
            <span className="subtle">Dubai · GST</span>
            <div className="notification-wrapper">
              <button
                className="icon-button"
                aria-label="Notifications"
                onClick={() => setNotificationsOpen(!notificationsOpen)}
              >
                <Bell size={18} />
                {!!data?.notifications.length && (
                  <span className="notification-count">
                    {data.notifications.length}
                  </span>
                )}
              </button>
              {notificationsOpen && (
                <div className="notification-popover">
                  <div className="row space-between">
                    <h3>Notifications</h3>
                    <button className="btn-link" onClick={clearNotices}>
                      Mark all read
                    </button>
                  </div>
                  {data?.notifications.length ? (
                    data.notifications.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => {
                          setSelected(n.ticket_id);
                          setNotificationsOpen(false);
                        }}
                      >
                        <strong>
                          {n.number} · {n.customer_name}
                        </strong>
                        <span>
                          {n.project_name || 'Walk-in'} {n.unit_name || ''}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p>You’re all caught up.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {view === 'overview'
                  ? 'YOUR SERVICE FLOOR, AT A GLANCE'
                  : 'SAMANA CUSTOMER EXPERIENCE'}
              </p>
              <h1>{title}</h1>
              <p>
                {view === 'agent'
                  ? 'Make every interaction personal. Your next customer is waiting.'
                  : view === 'team'
                    ? 'The right people, in the right place, at the right time.'
                    : view === 'reports'
                      ? 'Turn every visit into a clearer picture of your service.'
                      : 'Keep every customer moving. Give every interaction your attention.'}
              </p>
            </div>
            {canIssue && (
              <Button
                className="primary-action"
                onClick={() => setIssueOpen(true)}
              >
                <Plus size={17} />
                Issue ticket
              </Button>
            )}
          </div>
          {error && (
            <div className="connection-banner" role="alert">
              <span className="status-dot amber" />
              {error}
              <Button variant="ghost" size="sm" onClick={() => refresh()}>
                Retry
              </Button>
            </div>
          )}
          {data &&
            (!data.workerLastRun ||
              Date.now() - Date.parse(data.workerLastRun) > 90000) && (
              <div className="connection-banner">
                <span className="status-dot amber" />
                Automatic routing needs attention.
                <span>Check the queue scheduler in Settings.</span>
              </div>
            )}
          {['overview', 'queue', 'agent'].includes(view) && (
            <>
              {view === 'agent' && (
                <div className="agent-status">
                  <div>
                    <Headphones size={25} />
                    <div>
                      <strong>{user.counter || 'Your service desk'}</strong>
                      <p>
                        {user.online
                          ? 'You are receiving ticket assignments.'
                          : 'Go available when you are ready to assist customers.'}
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" onClick={presence}>
                    {user.online ? 'Go offline' : 'Go available'}
                  </Button>
                </div>
              )}
              {view !== 'agent' && (
                <div className="stats-grid">
                  {[
                    [
                      'Waiting now',
                      data?.statistics.waiting ?? '—',
                      'Across your service queues',
                      Users,
                      'waiting',
                    ],
                    [
                      'In service',
                      data?.statistics.serving ?? '—',
                      'Customers being assisted',
                      Headphones,
                      'serving',
                    ],
                    [
                      'Average wait',
                      data ? data.statistics.avg_wait + ' min' : '—',
                      'Today, from arrival to call',
                      Clock3,
                      'active',
                    ],
                    [
                      'Completed today',
                      data?.statistics.completed ?? '—',
                      'A better experience, delivered',
                      CheckCircle2,
                      'closed',
                    ],
                  ].map(([label, value, caption, Icon, filter]) => {
                    const I = Icon as typeof Users;
                    return (
                      <button
                        className="stat-card"
                        key={String(label)}
                        onClick={() => {
                          setStatus(String(filter));
                          setPage(1);
                        }}
                      >
                        <div className="stat-label">
                          {String(label)}
                          <I size={18} />
                        </div>
                        <strong>{String(value)}</strong>
                        <small>{String(caption)}</small>
                      </button>
                    );
                  })}
                </div>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      {view === 'agent'
                        ? 'Your assigned tickets'
                        : 'Live queue'}
                      {data && (
                        <span className="count-chip">
                          {view === 'agent'
                            ? visibleTickets.length
                            : data.total}
                        </span>
                      )}
                    </h2>
                    <p>
                      {view === 'agent'
                        ? 'Call a customer, start the interaction, and capture the outcome.'
                        : 'The next great customer experience starts here.'}
                    </p>
                  </div>
                  <div className="row">
                    <span className="badge neutral">
                      <span
                        className={
                          'status-dot ' + (!error && data ? 'green' : '')
                        }
                      />
                      {error
                        ? 'Reconnecting'
                        : data
                          ? 'Live updates'
                          : 'Connecting'}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Refresh queue"
                      onClick={() => refresh()}
                      disabled={loading}
                    >
                      <RefreshCw size={16} className={loading ? 'spin' : ''} />
                    </Button>
                  </div>
                </div>
                <div className="queue-toolbar">
                  <div className="service-tabs">
                    {[
                      ['', 'All services'],
                      ['CRM', 'CRM'],
                      ['Collection', 'Collection'],
                      ['General Query', 'General Query'],
                    ].map(([id, name]) => (
                      <button
                        key={id}
                        className={department === id ? 'active' : ''}
                        onClick={() => {
                          setDepartment(id);
                          setPage(1);
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <div className="queue-filter-tools">
                    <select
                      aria-label="Filter ticket status"
                      value={status}
                      onChange={(e) => {
                        setStatus(e.target.value);
                        setPage(1);
                      }}
                    >
                      {[
                        ['active', 'Active'],
                        ['waiting', 'Waiting'],
                        ['called', 'Called'],
                        ['serving', 'In service'],
                        ['closed', 'Completed'],
                        ['no_show', 'No-show'],
                        ['all', 'All statuses'],
                      ].map(([value, label]) => (
                        <option value={value} key={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <div className="search">
                      <Search size={16} />
                      <Input
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(1);
                        }}
                        aria-label="Search queue"
                        placeholder="Search ticket or customer…"
                      />
                    </div>
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
                          'ASSIGNED TO',
                          'WAIT TIME',
                          'STATUS',
                          '',
                        ].map((h, i) => (
                          <th key={i}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTickets.map((ticket) => (
                        <tr key={ticket.id}>
                          <td>
                            <button
                              className="ticket-number btn-link"
                              onClick={() => setSelected(ticket.id)}
                            >
                              {ticket.number}
                            </button>
                            <span className="ticket-meta">
                              {new Date(ticket.created_at).toLocaleTimeString(
                                'en-AE',
                                {
                                  timeZone: 'Asia/Dubai',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                },
                              )}
                            </span>
                          </td>
                          <td>
                            <strong className="customer-cell">
                              {ticket.customer_name}
                            </strong>
                            <span className="ticket-meta">
                              {ticket.project_name || 'Walk-in customer'}
                              {ticket.unit_name ? ' · ' + ticket.unit_name : ''}
                            </span>
                          </td>
                          <td>
                            {ticket.service_name}
                            <span className="ticket-meta">
                              {ticket.department}
                            </span>
                          </td>
                          <td>
                            {ticket.assigned_name ? (
                              <div className="agent-cell">
                                <span className="avatar small">
                                  {ticket.assigned_name
                                    .split(' ')
                                    .map((x) => x[0])
                                    .slice(0, 2)
                                    .join('')}
                                </span>
                                <span>{ticket.assigned_name}</span>
                              </div>
                            ) : (
                              <span className="unassigned">Awaiting agent</span>
                            )}
                          </td>
                          <td>
                            <span
                              className={
                                ticket.status === 'waiting' &&
                                minutesBetween(ticket.created_at) > 5
                                  ? 'wait-warning'
                                  : 'wait-time'
                              }
                            >
                              <Clock3 size={12} />
                              {minutesBetween(
                                ticket.created_at,
                                ticket.called_at || ticket.closed_at,
                              ).toFixed(0)}{' '}
                              min
                            </span>
                          </td>
                          <td>
                            <span className={'badge ' + ticket.status}>
                              {ticket.status === 'serving'
                                ? 'In service'
                                : ticket.status === 'closed'
                                  ? 'Completed'
                                  : ticket.status === 'no_show'
                                    ? 'No-show'
                                    : ticket.status[0].toUpperCase() +
                                      ticket.status.slice(1)}
                            </span>
                          </td>
                          <td>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={'View ' + ticket.number}
                              onClick={() => setSelected(ticket.id)}
                            >
                              <ChevronRight size={16} />
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {!visibleTickets.length && (
                        <tr>
                          <td colSpan={7}>
                            <div className="empty-state">
                              <ListOrdered size={30} />
                              <h3>
                                {loading
                                  ? 'Loading your service floor…'
                                  : search
                                    ? 'No matching tickets'
                                    : view === 'agent'
                                      ? 'You’re ready for your next customer'
                                      : 'A clear queue. A fresh start.'}
                              </h3>
                              <p>
                                {search
                                  ? 'Try another ticket number, customer, or unit.'
                                  : view === 'agent'
                                    ? 'Go available to receive assignments for your service queues.'
                                    : 'New visits will appear here as customers check in.'}
                              </p>
                              {canIssue && !loading && !search && (
                                <Button
                                  className="empty-cta"
                                  variant="outline"
                                  onClick={() => setIssueOpen(true)}
                                >
                                  <Plus size={14} />
                                  Issue the first ticket
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="pagination">
                  <span>
                    {data?.total
                      ? `${(page - 1) * 20 + 1}–${Math.min(page * 20, data.total)} of ${data.total} tickets`
                      : 'No tickets'}
                    {updated && ' · Updated ' + updated}
                  </span>
                  <div className="section-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => p - 1)}
                      disabled={page === 1 || loading}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={!data || page * 20 >= data.total || loading}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </section>
              {view === 'overview' && (
                <div className="bottom-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Service queues</h2>
                        <p>A clear view of every customer journey</p>
                      </div>
                      <span className="subtle">Waiting / Serving</span>
                    </div>
                    {['CRM', 'Collection', 'General Query'].map((s, i) => {
                      const services =
                        data?.services.filter((row) => row.department === s) ||
                        [];
                      return (
                        <button
                          className="service-row"
                          key={s}
                          onClick={() => {
                            setDepartment(s);
                            setPage(1);
                            navigate('queue');
                          }}
                        >
                          <span className={'service-icon color-' + i}>
                            <Headphones size={19} />
                          </span>
                          <div>
                            <strong>{s}</strong>
                            <small>
                              {i === 0
                                ? 'Relationship management'
                                : i === 1
                                  ? 'Payments & collections'
                                  : 'Walk-in assistance'}
                            </small>
                          </div>
                          <span className="service-count">
                            {services.reduce((a, row) => a + row.waiting, 0)}{' '}
                            <i>/</i>{' '}
                            {services.reduce((a, row) => a + row.serving, 0)}
                          </span>
                          <ArrowUpRight size={17} />
                        </button>
                      );
                    })}
                  </section>
                  <section className="panel photo-feature">
                    <img
                      src="/images/samana-project-1.jpg"
                      alt="SAMANA Developers waterfront residence"
                    />
                    <div>
                      <p className="eyebrow">A WARMER WELCOME</p>
                      <h2>
                        A seamless arrival.
                        <br />A personal experience.
                      </h2>
                      <p>Customers can check in from their own phone.</p>
                      {canIssue && (
                        <Button
                          variant="outline"
                          onClick={() => setQrOpen(true)}
                        >
                          <QrCode size={15} />
                          Show check-in QR
                          <ArrowUpRight size={14} />
                        </Button>
                      )}
                    </div>
                  </section>
                </div>
              )}
            </>
          )}
          {view === 'team' && manager && <Team user={user} />}{' '}
          {view === 'reports' && manager && <Reports onTicket={setSelected} />}{' '}
          {view === 'settings' && (
            <Settings user={user} onPasswordChanged={refreshIdentity} />
          )}{' '}
          {view === 'audit' && manager && <Audit />}
          {!viewNames[view] && (
            <div className="empty-state">
              <h3>Page not found</h3>
              <Button onClick={() => navigate('overview')}>
                Return to overview
              </Button>
            </div>
          )}
        </main>
        <footer>
          Samana QMS <span>Customer experience, thoughtfully connected.</span>
        </footer>
      </div>
      <TicketDetail
        id={selected}
        user={user}
        onClose={() => setSelected(null)}
        onChange={() => refresh(true)}
      />
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent className="checkin-dialog">
          <DialogTitle className="visually-hidden">
            Customer check-in
          </DialogTitle>
          <DialogDescription className="visually-hidden">
            Look up a customer and issue a service ticket.
          </DialogDescription>
          <CheckIn onIssued={() => refresh(true)} />
        </DialogContent>
      </Dialog>
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="qr-dialog">
          <DialogTitle>Welcome customers on their phones</DialogTitle>
          <DialogDescription>
            Display this code at reception. It refreshes automatically and
            grants a short check-in session.
          </DialogDescription>
          <div className="qr-code">
            {qr ? (
              <QRCodeSVG value={qr} size={235} marginSize={2} />
            ) : (
              <Loader2 className="spin" />
            )}
          </div>
          <h3>Scan. Check in. Relax.</h3>
          <p className="muted">
            Customers join the queue, select their unit, and follow their ticket
            from their own phone.
          </p>
          {qr && (
            <Button
              variant="outline"
              onClick={() =>
                navigator.clipboard
                  .writeText(qr)
                  .then(() => setToast('Check-in link copied.'))
                  .catch(() =>
                    setError(
                      'Clipboard unavailable. Scan the QR code instead.',
                    ),
                  )
              }
            >
              Copy check-in link
            </Button>
          )}
        </DialogContent>
      </Dialog>
      {toast && (
        <output className="alert-toast">
          <Check size={16} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            ×
          </button>
        </output>
      )}
    </div>
  );
}
function Login({
  onLogin,
  initialError,
}: {
  onLogin: () => void;
  initialError: string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('auth/login', { username, password });
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-screen">
      <section className="login-visual">
        <img
          src="/images/samana-project-1.jpg"
          alt="SAMANA Developers residential project"
        />
        <div className="login-shade" />
        <a className="brand" href="/">
          SAMANA<span>DEVELOPERS</span>
        </a>
        <div className="login-copy">
          <p className="eyebrow">WHERE DREAMS TAKE SHAPE</p>
          <h1>
            Exceptional living.
            <br />
            Thoughtful service.
          </h1>
          <p>One connected workspace for every customer journey.</p>
          <div>
            <span>CRM</span>
            <i />
            <span>Collection</span>
            <i />
            <span>Customer Experience</span>
          </div>
        </div>
        <small>Image: SAMANA Developers</small>
      </section>
      <section className="login-form-panel">
        <div className="login-form-content">
          <span className="workspace-pill">
            <span className="status-dot green" />
            SAMANA QMS
          </span>
          <h2>Welcome to your workspace</h2>
          <p>Sign in to keep your service floor moving.</p>
          <form onSubmit={submit}>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="username">Username / email</label>
              <Input
                className="form-control"
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                placeholder="Your work account"
              />
            </div>
            <div>
              <label htmlFor="password">Password</label>
              <Input
                className="form-control"
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                maxLength={128}
                placeholder="Enter your password"
              />
            </div>
            <Button type="submit" className="primary-action" disabled={busy}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <>
                  Sign in
                  <ArrowRight size={17} />
                </>
              )}
            </Button>
          </form>
          <div className="login-help">
            <ShieldCheck size={17} />
            <p>
              Access is managed by your QMS administrator.
              <br />
              Contact them if you need an account or password reset.
            </p>
          </div>
        </div>
        <footer>
          Samana Developers <span>Dubai, United Arab Emirates</span>
        </footer>
      </section>
    </main>
  );
}
function Audit() {
  const [events, setEvents] = useState<
    {
      id: number;
      action: string;
      created_at: string;
      actor_name: string;
      number: string;
    }[]
  >([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ events: typeof events }>('audit')
      .then((x) => setEvents(x.events))
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Operations audit trail</h2>
          <p>The latest 100 ticket, team, and reporting events.</p>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>TIME</th>
              <th>ACTION</th>
              <th>TICKET</th>
              <th>ACTOR</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{formatDate(e.created_at)}</td>
                <td>{e.action.replaceAll('_', ' ')}</td>
                <td>{e.number || '—'}</td>
                <td>{e.actor_name || 'Queue routing'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
