'use client';
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useDeferredValue,
  lazy,
  Suspense,
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
  Menu,
  PanelsTopLeft,
  List,
  Eye,
  EyeOff,
  CalendarDays,
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
const Reports = lazy(() => import('./reports'));
import Settings from './settings';
import TVDisplay from './tv-display';
import { ServicePulse, QueueBoard, QueueSkeleton } from './experience';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [queueLayout, setQueueLayout] = useState<'table' | 'board'>('table');
  const notificationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (event.key === 'Escape') setNotificationsOpen(false);
    };
    const outside = (event: PointerEvent) => {
      if (
        notificationRef.current &&
        !notificationRef.current.contains(event.target as Node)
      )
        setNotificationsOpen(false);
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('pointerdown', outside);
    };
  }, []);
  const lastNotice = useRef<number | null>(null);
  const [updated, setUpdated] = useState('');
  const manager = user ? isManager(user.role) : false;
  const canShowQr =
    !!user &&
    ['admin', 'hod', 'manager', 'reception', 'display'].includes(user.role);
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
    setMenuOpen(false);
    setCommandOpen(false);
    setPage(1);
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
      ? 'Your service floor'
      : view === 'agent'
        ? 'Your service desk'
        : viewNames[view] || 'Workspace';
  const visibleTickets =
    view === 'agent'
      ? data?.tickets.filter((t) => t.assigned_to === user.id) || []
      : data?.tickets || [];
  return (
    <div className={'workspace view-' + view}>
      <a className="skip-link" href="#workspace-main">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <a className="brand" href="/">
          SAMANA<span>DEVELOPERS</span>
        </a>
        <div className="workspace-label">CUSTOMER EXPERIENCE</div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              key={item.id}
              aria-current={view === item.id ? 'page' : undefined}
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
          {canShowQr && (
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
          <button
            className="mobile-menu-button icon-button"
            aria-label="Open navigation"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={21} />
          </button>
          <span>
            Operations <span className="slash">/</span>{' '}
            {viewNames[view] || title}
          </span>
          <div className="topbar-actions">
            <button
              className="workspace-search"
              onClick={() => setCommandOpen(true)}
              aria-label="Search workspace, Control or Command K"
            >
              <Search size={16} />
              <span>Quick actions</span>
              <kbd>⌘ K</kbd>
            </button>
            {serviceStaff && (
              <button
                className={'presence-toggle ' + (user.online ? 'online' : '')}
                onClick={presence}
              >
                <span
                  className={'status-dot ' + (user.online ? 'green' : '')}
                />
                {user.online ? 'Online' : 'Offline'}
              </button>
            )}
            <span className="subtle">Dubai · GST</span>
            <div className="notification-wrapper" ref={notificationRef}>
              <button
                className="icon-button"
                aria-label="Notifications"
                aria-expanded={notificationsOpen}
                aria-controls="notifications-panel"
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
                <section
                  className="notification-popover"
                  id="notifications-panel"
                  aria-label="Notifications"
                >
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
                </section>
              )}
            </div>
          </div>
        </header>
        <main className="main-content" id="workspace-main">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {view === 'overview'
                  ? 'CUSTOMER EXPERIENCE · DUBAI'
                  : 'SAMANA CUSTOMER EXPERIENCE'}
              </p>
              <h1>{title}</h1>
              <p>
                {view === 'agent'
                  ? 'Your customers. Your next great interaction.'
                  : view === 'team'
                    ? 'The right people, in the right place, at the right time.'
                    : view === 'reports'
                      ? 'Turn every visit into a clearer picture of your service.'
                      : 'Every visit matters. Make today exceptional.'}
              </p>
            </div>
            <div className="heading-actions">
              <span className="workspace-date">
                <CalendarDays size={16} />
                {new Date().toLocaleDateString('en-GB', {
                  timeZone: 'Asia/Dubai',
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
              {canIssue && (
                <Button
                  className="primary-action"
                  onClick={() => setIssueOpen(true)}
                >
                  <Plus size={17} />
                  New visit
                </Button>
              )}
            </div>
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
                          : 'Go online when you are ready to assist customers.'}
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" onClick={presence}>
                    {user.online ? 'Go offline' : 'Go online'}
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
                      'Successful customer interactions',
                      CheckCircle2,
                      'closed',
                    ],
                  ].map(([label, value, caption, Icon, filter]) => {
                    const I = Icon as typeof Users;
                    return (
                      <button
                        className={'stat-card metric-' + filter}
                        aria-pressed={status === filter}
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
              <div
                className={
                  view === 'overview' ? 'operations-grid' : 'queue-workspace'
                }
              >
                <section className="panel queue-panel">
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
                          : 'Manage arrivals and keep each visit moving.'}
                      </p>
                    </div>
                    <div className="row queue-view-actions">
                      <fieldset
                        className="view-switch"
                        aria-label="Queue layout"
                      >
                        <button
                          aria-label="Table view"
                          aria-pressed={queueLayout === 'table'}
                          onClick={() => setQueueLayout('table')}
                        >
                          <List size={17} />
                        </button>
                        <button
                          aria-label="Board view"
                          aria-pressed={queueLayout === 'board'}
                          onClick={() => setQueueLayout('board')}
                        >
                          <PanelsTopLeft size={17} />
                        </button>
                      </fieldset>
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
                        <RefreshCw
                          size={16}
                          className={loading ? 'spin' : ''}
                        />
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
                          aria-pressed={department === id}
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
                  {(department || search || status !== 'active') && (
                    <div className="active-filters">
                      <span>Filtered by</span>
                      {department && (
                        <button
                          onClick={() => {
                            setDepartment('');
                            setPage(1);
                          }}
                        >
                          {department} ×
                        </button>
                      )}
                      {search && (
                        <button
                          onClick={() => {
                            setSearch('');
                            setPage(1);
                          }}
                        >
                          “{search}” ×
                        </button>
                      )}
                      {status !== 'active' && (
                        <button
                          onClick={() => {
                            setStatus('active');
                            setPage(1);
                          }}
                        >
                          {status.replace('_', ' ')} ×
                        </button>
                      )}
                      <button
                        className="clear-filters"
                        onClick={() => {
                          setDepartment('');
                          setSearch('');
                          setStatus('active');
                          setPage(1);
                        }}
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                  {!data && loading ? (
                    <QueueSkeleton />
                  ) : queueLayout === 'board' ? (
                    <QueueBoard
                      tickets={visibleTickets}
                      loading={loading}
                      onTicket={setSelected}
                    />
                  ) : (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {[
                              'TICKET',
                              'CUSTOMER / UNIT',
                              'SERVICE',
                              'ASSIGNED TO',
                              'TOTAL WAIT',
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
                                  {new Date(
                                    ticket.created_at,
                                  ).toLocaleTimeString('en-AE', {
                                    timeZone: 'Asia/Dubai',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                              </td>
                              <td>
                                <strong className="customer-cell">
                                  {ticket.customer_name}
                                </strong>
                                <span className="ticket-meta">
                                  {ticket.project_name || 'Walk-in customer'}
                                  {ticket.unit_name
                                    ? ' · ' + ticket.unit_name
                                    : ''}
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
                                  <span className="unassigned">Unassigned</span>
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
                  )}
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
                  <ServicePulse
                    services={data?.services || []}
                    unassigned={data?.statistics.unassigned || 0}
                    onDepartment={(department) => {
                      setDepartment(department);
                      setStatus('active');
                      navigate('queue');
                    }}
                    onWaiting={() => {
                      setDepartment('');
                      setStatus('waiting');
                      navigate('queue');
                    }}
                    onQr={canShowQr ? () => setQrOpen(true) : undefined}
                  />
                )}
              </div>
            </>
          )}
          {view === 'team' && manager && <Team user={user} />}{' '}
          {view === 'reports' && manager && (
            <Suspense fallback={<QueueSkeleton />}>
              <Reports onTicket={setSelected} />
            </Suspense>
          )}{' '}
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
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="mobile-navigation">
          <DialogTitle className="brand">
            SAMANA<span>DEVELOPERS</span>
          </DialogTitle>
          <DialogDescription>Customer experience workspace</DialogDescription>
          <nav aria-label="Mobile navigation">
            {navigation.map((item) => (
              <button
                key={item.id}
                className={view === item.id ? 'nav-item selected' : 'nav-item'}
                aria-current={view === item.id ? 'page' : undefined}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={19} />
                {item.name}
              </button>
            ))}
          </nav>
          <div className="mobile-nav-tools">
            {canShowQr && (
              <Button
                variant="outline"
                onClick={() => {
                  setMenuOpen(false);
                  setQrOpen(true);
                }}
              >
                <QrCode size={17} />
                Check-in QR
              </Button>
            )}
            {manager && (
              <a href="/display" target="_blank" rel="noreferrer">
                <Monitor size={17} />
                Open TV display
              </a>
            )}
            <p>
              {user.name}
              <small>{user.role}</small>
            </p>
            <Button variant="ghost" onClick={logout}>
              <LogOut size={16} />
              Sign out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
        <DialogContent className="command-dialog">
          <DialogTitle className="visually-hidden">Quick actions</DialogTitle>
          <DialogDescription className="visually-hidden">
            Search pages and actions. Use arrow keys to choose and Enter to
            open.
          </DialogDescription>
          <Command>
            <CommandInput placeholder="Where would you like to go?" />
            <CommandList>
              <CommandEmpty>No matching actions.</CommandEmpty>
              <CommandGroup heading="Workspace">
                {navigation.map((item) => (
                  <CommandItem key={item.id} onSelect={() => navigate(item.id)}>
                    <item.icon size={18} />
                    {item.name}
                  </CommandItem>
                ))}
              </CommandGroup>
              {canIssue && (
                <CommandGroup heading="Actions">
                  <CommandItem
                    onSelect={() => {
                      setCommandOpen(false);
                      setIssueOpen(true);
                    }}
                  >
                    <Plus size={18} />
                    Issue a customer ticket
                  </CommandItem>
                  {canShowQr && (
                    <CommandItem
                      onSelect={() => {
                        setCommandOpen(false);
                        setQrOpen(true);
                      }}
                    >
                      <QrCode size={18} />
                      Show reception QR
                    </CommandItem>
                  )}
                </CommandGroup>
              )}
            </CommandList>
            <div className="command-hint">
              <span>↑ ↓ to navigate</span>
              <span>↵ to open</span>
              <span>esc to close</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
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
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
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
          src="/images/samana-ocean-bay-sunset.jpg"
          alt="Sunset over the pool at SAMANA Ocean Bay"
        />
        <div className="login-shade" />
        <a className="brand" href="/">
          SAMANA<span>DEVELOPERS</span>
        </a>
        <div className="login-copy">
          <p className="eyebrow">WHERE DREAMS TAKE SHAPE</p>
          <h1>
            Extraordinary places.
            <br />
            <em>Exceptional care.</em>
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
        <small>
          SAMANA OCEAN BAY · DUBAI ISLANDS <span>01 / CUSTOMER EXPERIENCE</span>
        </small>
      </section>
      <section className="login-form-panel">
        <div className="login-form-content">
          <span className="workspace-pill">
            <Building2 size={15} /> THE SAMANA WORKSPACE
          </span>
          <h2>
            Welcome back<span>.</span>
          </h2>
          <p>
            Great experiences start with you.
            <br />
            Sign in to your customer experience workspace.
          </p>
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
              <div className="password-field">
                <Input
                  className="form-control"
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  onKeyUp={(event) =>
                    setCapsLock(event.getModifierState('CapsLock'))
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
              {capsLock && (
                <output className="caps-lock">Caps Lock is on</output>
              )}
            </div>
            <Button type="submit" className="primary-action" disabled={busy}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <>
                  Enter workspace
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
