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
import { usePathname, useRouter } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { ViewBoundary } from './view-boundary';
import {
  LayoutDashboard,
  Layers,
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
  ShieldCheck,
  Loader2,
  QrCode,
  Check,
  History,
  Menu,
  PanelsTopLeft,
  List,
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
import { ApiError, api, post, send } from '@/lib/client';
import {
  type User,
  canShowCheckinQr,
  isManager,
  isServingRole,
  isWorkspaceRole,
  roleLabel,
} from '@/lib/domain';
import CheckIn from './check-in';
import TicketDetail from './ticket-detail';
import Login from './login';
import QueueTable from './queue-table';
import { useQueue } from './use-queue';
import { useAutoClear, useCheckinLink, useHeartbeat } from './use-workspace';
import { ServicePulse, QueueBoard, QueueSkeleton } from './experience';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
// Each workspace view is its own bundle, loaded when the role first opens it.
const Team = lazy(() => import('./team'));
const Queues = lazy(() => import('./queues'));
const Reports = lazy(() => import('./reports'));
const Settings = lazy(() => import('./settings'));
const TVDisplay = lazy(() => import('./tv-display'));
const Audit = lazy(() => import('./audit'));
const viewNames: Record<string, string> = {
  overview: 'Overview',
  queue: 'Live queue',
  agent: 'Agent console',
  team: 'Team',
  queues: 'Queues',
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
  const router = useRouter();
  const pathname = usePathname();
  // The address is the view. Next.js keeps the two in step, including the
  // browser's back and forward buttons, so there is no history listener here.
  const view = pathname === '/' ? 'overview' : pathname.slice(1).split('/')[0] || initialView;
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [department, setDepartment] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
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
  const manager = isManager(user?.role);
  const canShowQr = canShowCheckinQr(user?.role);
  const serviceStaff = isServingRole(user?.role);
  const canIssue = isWorkspaceRole(user?.role);
  const queueEnabled = canIssue && !user?.must_change_password;
  const { data, error, loading, updated, live, refresh, setError } = useQueue({
    enabled: queueEnabled,
    params: {
      search: deferredSearch,
      department,
      status,
      page,
      mine: view === 'agent',
    },
    onAssigned: (_notice, text) => {
      setToast(text);
      // Reach an agent whose tab is in the background.
      if (
        document.hidden &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      )
        new Notification('Samana QMS', { body: text, tag: 'qms-assignment' });
    },
    onSignedOut: () => setUser(null),
  });
  const refreshIdentity = useCallback(async () => {
    try {
      const result = await api<{ user: User }>('auth/me');
      setUser(result.user);
      if (result.user.role === 'customer') {
        window.location.replace('/check-in');
        return;
      }
      if (result.user.role === 'display' && view !== 'display')
        router.replace('/display');
    } catch (e) {
      if ((e as ApiError).status !== 401) setError((e as Error).message);
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, [setError, router, view]);
  useEffect(() => {
    void refreshIdentity();
  }, [refreshIdentity]);
  useHeartbeat(
    !!user?.online && serviceStaff && !user.must_change_password,
    setError,
  );
  useAutoClear(toast, setToast);
  const qr = useCheckinLink(qrOpen, setError);
  function navigate(next: string) {
    setMenuOpen(false);
    setCommandOpen(false);
    setPage(1);
    router.push(next === 'overview' ? '/' : '/' + next);
  }
  async function presence() {
    if (!user) return;
    // Going online is the natural moment to ask for desktop notifications.
    if (
      !user.online &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    )
      void Notification.requestPermission();
    try {
      await send('PUT', 'presence', { online: !user.online });
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
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function clearNotices() {
    if (!data) return;
    try {
      await send('PATCH', 'notifications', {
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
        <ViewBoundary name="settings">
          <Suspense fallback={<QueueSkeleton />}>
            <Settings user={user} onPasswordChanged={refreshIdentity} />
          </Suspense>
        </ViewBoundary>
        <Button variant="ghost" onClick={logout}>
          Sign out
        </Button>
      </div>
    );
  if (view === 'display' || user.role === 'display')
    return (
      <ViewBoundary name="display">
        <Suspense fallback={<div className="app-loading">Loading display…</div>}>
          <TVDisplay />
        </Suspense>
      </ViewBoundary>
    );
  const navigation = [
    { id: 'overview', name: 'Overview', icon: LayoutDashboard },
    { id: 'queue', name: 'Live queue', icon: ListOrdered },
    ...(serviceStaff
      ? [{ id: 'agent', name: 'Agent console', icon: Headphones }]
      : []),
    ...(manager
      ? [
          { id: 'team', name: 'Team', icon: Users },
          { id: 'queues', name: 'Queues', icon: Layers },
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
              <small>{roleLabel(user.role)}</small>
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
                          : live
                            ? 'Live updates'
                            : data
                              ? 'Auto-refresh'
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
                    <QueueTable
                      tickets={visibleTickets}
                      loading={loading}
                      search={search}
                      agentView={view === 'agent'}
                      canIssue={canIssue}
                      onTicket={setSelected}
                      onIssue={() => setIssueOpen(true)}
                    />
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
          <ViewBoundary name={view}>
            <Suspense fallback={<QueueSkeleton />}>
              {view === 'team' && manager && <Team user={user} />}
              {view === 'queues' && manager && <Queues />}
              {view === 'reports' && manager && (
                <Reports onTicket={setSelected} />
              )}
              {view === 'settings' && (
                <Settings user={user} onPasswordChanged={refreshIdentity} />
              )}
              {view === 'audit' && manager && <Audit />}
            </Suspense>
          </ViewBoundary>
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
              <small>{roleLabel(user.role)}</small>
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
          <CheckIn onIssued={() => refresh(true)} allowWalkIn />
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
