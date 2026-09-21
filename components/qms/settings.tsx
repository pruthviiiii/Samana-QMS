'use client';
import { useState, useEffect } from 'react';
import {
  Cloud,
  Database,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Clock3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, post, formatDate } from '@/lib/client';
import { type User, isManager } from '@/lib/domain';
type Integration = {
  database: { connected: boolean };
  salesforce: {
    configured: boolean;
    connected: boolean;
    instance: string;
    authMode: string;
    error?: string;
    writeEnabled: boolean;
  };
  sms: { configured: boolean; enabled: boolean };
  worker: { lastRun: string | null; healthy: boolean };
};
export default function Settings({
  user,
  onPasswordChanged,
}: {
  user: User;
  onPasswordChanged: () => void;
}) {
  const [data, setData] = useState<Integration | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  async function load() {
    setBusy(true);
    try {
      setData(await api<Integration>('integrations'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (isManager(user.role)) void load();
  }, [user.role]);
  async function password(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    // Saving signs out every other session, so a typo must be caught here.
    if (newPassword !== confirmPassword) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('auth/password', {
        currentPassword: oldPassword,
        newPassword,
      });
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setMessage('Password changed. Other sessions have been signed out.');
      onPasswordChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <output className="success">{message}</output>}
      {isManager(user.role) && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Connected systems</h2>
              <p>Live connection checks and operational readiness.</p>
            </div>
            <Button variant="outline" onClick={load} disabled={busy}>
              <RefreshCw size={14} className={busy ? 'spin' : ''} /> Check
              connections
            </Button>
          </div>
          {data ? (
            <div className="integrations-grid">
              <article>
                <Cloud size={26} />
                <h3>Salesforce</h3>
                <span
                  className={
                    'badge ' +
                    (data.salesforce.connected ? 'serving' : 'waiting')
                  }
                >
                  {data.salesforce.connected
                    ? 'Connected'
                    : data.salesforce.configured
                      ? 'Connection needs attention'
                      : 'Not configured'}
                </span>
                <p>{data.salesforce.instance}</p>
                <small>
                  {data.salesforce.error ||
                    'Account lookup and team directory are read-only.'}
                </small>
                <div className="integration-detail">
                  Ticket write-back:{' '}
                  {data.salesforce.writeEnabled
                    ? 'Enabled'
                    : 'Disabled — awaiting approval'}
                </div>
              </article>
              <article>
                <Database size={26} />
                <h3>PostgreSQL</h3>
                <span
                  className={
                    'badge ' + (data.database.connected ? 'serving' : 'waiting')
                  }
                >
                  {data.database.connected ? 'Connected' : 'Unavailable'}
                </span>
                <p>App data, ticket history, and service routing.</p>
                <small>Durable transactions and audit events.</small>
              </article>
              <article>
                <MessageSquare size={26} />
                <h3>SMS notifications</h3>
                <span
                  className={
                    'badge ' +
                    (data.sms.enabled && data.sms.configured
                      ? 'serving'
                      : 'waiting')
                  }
                >
                  {data.sms.enabled && data.sms.configured
                    ? 'Configured'
                    : 'Setup required'}
                </span>
                <p>Registered mobile check-ins only.</p>
                <small>
                  {data.sms.configured
                    ? 'Gateway credentials are present.'
                    : 'An SMS gateway URL and credentials are required.'}
                </small>
              </article>
              <article>
                <Clock3 size={26} />
                <h3>Queue scheduler</h3>
                <span
                  className={
                    'badge ' + (data.worker.healthy ? 'serving' : 'waiting')
                  }
                >
                  {data.worker.healthy ? 'Running' : 'Needs attention'}
                </span>
                <p>
                  Checks every 15 seconds: five-minute reassignment, presence
                  expiry and delivery retries.
                </p>
                <small>
                  Last run:{' '}
                  {data.worker.lastRun
                    ? formatDate(data.worker.lastRun)
                    : 'Not yet recorded'}
                </small>
              </article>
            </div>
          ) : (
            <div className="empty-state">
              {busy
                ? 'Checking connected systems…'
                : 'Connection status could not be loaded.'}
            </div>
          )}
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Account security</h2>
            <p>Update your password for {user.username}.</p>
          </div>
          <ShieldCheck size={22} />
        </div>
        <form className="page-section password-form" onSubmit={password}>
          <div>
            <label htmlFor="current-password">Current password</label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              required
              maxLength={128}
            />
          </div>
          <div>
            <label htmlFor="new-password">New password</label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={14}
              maxLength={128}
            />
            <small className="field-hint">
              At least 14 characters. Other sessions will be signed out.
            </small>
          </div>
          <div>
            <label htmlFor="confirm-password">Confirm new password</label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={14}
              maxLength={128}
            />
          </div>
          <Button
            type="submit"
            disabled={busy || !newPassword || newPassword !== confirmPassword}
          >
            Change password
          </Button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Routing rules</h2>
            <p>
              Fixed by the Samana business requirements. These are not
              settings; changing them is a development change.
            </p>
          </div>
        </div>
        <div className="policy-list">
          <div>
            <strong>CRM routing</strong>
            <p>
              Preferred unit owner → five-minute hold if busy → next available
              agent in the same service.
            </p>
          </div>
          <div>
            <strong>Collection routing</strong>
            <p>
              Preferred unit owner → five-minute hold if busy → calling owner’s
              manager.
            </p>
          </div>
          <div>
            <strong>Agent availability</strong>
            <p>
              Online status requires an active heartbeat. A disconnected agent
              goes offline after 90 seconds.
            </p>
          </div>
          <div>
            <strong>Time and reporting</strong>
            <p>
              Asia/Dubai (UTC+4). Ticket sequences reset daily for each service.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
