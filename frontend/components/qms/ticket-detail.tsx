'use client';
import { useEffect, useState, useRef } from 'react';
import {
  PhoneCall,
  Play,
  CheckCircle2,
  UserRoundX,
  Printer,
  ArrowRightLeft,
  Clock3,
  Info,
  Loader2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, post, formatDate } from '@/lib/client';
import {
  type Ticket,
  type User,
  isManager,
  minutesBetween,
} from '@qms/shared';
type Details = {
  ticket: Ticket;
  events: {
    id: number;
    action: string;
    details: { reason?: string; comment?: string };
    created_at: string;
    actor_name: string | null;
  }[];
  outbox: { kind: string; status: string; last_error: string | null }[];
};
export default function TicketDetail({
  id,
  user,
  onClose,
  onChange,
}: {
  id: string | null;
  user: User;
  onClose: () => void;
  onChange: () => void;
}) {
  const [data, setData] = useState<Details | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [mode, setMode] = useState('');
  const [target, setTarget] = useState('');
  const [team, setTeam] = useState<User[]>([]);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (mode === 'close' || mode === 'no_show') notesRef.current?.focus();
  }, [mode]);
  useEffect(() => {
    setData(null);
    setError('');
    setComment('');
    setMode('');
    setTarget('');
    if (!id) return;
    let alive = true;
    api<Details>('tickets/' + id)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [id, user.role]);
  // The staff list is only needed once the reassignment picker opens.
  useEffect(() => {
    if (mode !== 'reassign') return;
    let alive = true;
    api<{ users: User[] }>('team')
      .then((d) => {
        if (alive) setTeam(d.users);
      })
      .catch(() => {
        /* the picker shows no candidates; the error surfaces on submit */
      });
    return () => {
      alive = false;
    };
  }, [mode]);
  // Keep an open drawer current, so the version sent with an action is the
  // live one and routing changes made meanwhile are visible.
  useEffect(() => {
    if (!id || busy || mode) return;
    const timer = setInterval(() => {
      api<Details>('tickets/' + id)
        .then((d) => setData(d))
        .catch(() => {
          /* the next poll or action reports the failure */
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [id, busy, mode]);
  async function action(action: string) {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      await post('tickets/' + data.ticket.id + '/action', {
        action,
        version: data.ticket.version,
        comment,
        ...(action === 'reassign' ? { targetId: target } : {}),
      });
      setData(await api<Details>('tickets/' + data.ticket.id));
      setMode('');
      setComment('');
      onChange();
    } catch (e) {
      setError((e as Error).message);
      try {
        setData(await api<Details>('tickets/' + data.ticket.id));
      } catch {
        /* Preserve the last visible ticket while disconnected. */
      }
    } finally {
      setBusy(false);
    }
  }
  const ticket = data?.ticket;
  const canAct = user.role === 'agent' || isManager(user.role);
  const active =
    ticket && ['waiting', 'called', 'serving'].includes(ticket.status);
  return (
    <Dialog
      open={!!id}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="ticket-dialog">
        <DialogTitle>
          {ticket ? `Ticket ${ticket.number}` : 'Ticket details'}
        </DialogTitle>
        <DialogDescription>
          {ticket
            ? `${ticket.service_name} · ${ticket.department}`
            : 'Customer information and service history.'}
        </DialogDescription>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!data && !error ? (
          <div className="empty-state">
            <Loader2 className="spin" />
            Loading ticket…
          </div>
        ) : (
          ticket && (
            <>
              <div className="detail-summary">
                <div>
                  <span className="eyebrow">CUSTOMER</span>
                  <h2>{ticket.customer_name}</h2>
                  <p>
                    {ticket.project_name || 'Walk-in visit'}{' '}
                    {ticket.unit_name ? ' · ' + ticket.unit_name : ''}
                  </p>
                </div>
                <span className={'badge ' + ticket.status}>
                  {ticket.status.replace('_', ' ')}
                </span>
              </div>
              <div className="visit-progress" aria-label="Visit progress">
                {[
                  'Arrived',
                  'Called',
                  'In service',
                  ticket.status === 'no_show' ? 'No-show' : 'Completed',
                ].map((label, index) => (
                  <span
                    key={label}
                    className={
                      [
                        true,
                        !!ticket.called_at,
                        !!ticket.started_at,
                        !!ticket.closed_at,
                      ][index]
                        ? 'reached'
                        : ''
                    }
                  >
                    {label}
                  </span>
                ))}
              </div>
              <div className="detail-grid">
                <div>
                  <span className="detail-label">Assigned agent</span>
                  <strong>
                    {ticket.assigned_name || 'Awaiting assignment'}
                  </strong>
                </div>
                <div>
                  <span className="detail-label">Counter</span>
                  <strong>{ticket.counter || '—'}</strong>
                </div>
                <div>
                  <span className="detail-label">Sales booking</span>
                  <strong>{ticket.booking_number || '—'}</strong>
                </div>
                <div>
                  <span className="detail-label">Issued at</span>
                  <strong>{formatDate(ticket.created_at)}</strong>
                </div>
                <div>
                  <span className="detail-label">Waiting time</span>
                  <strong>
                    {minutesBetween(
                      ticket.created_at,
                      ticket.called_at || ticket.closed_at,
                    ).toFixed(1)}{' '}
                    min
                  </strong>
                </div>
                <div>
                  <span className="detail-label">Service time</span>
                  <strong>
                    {ticket.started_at
                      ? minutesBetween(
                          ticket.started_at,
                          ticket.closed_at,
                        ).toFixed(1) + ' min'
                      : 'Not started'}
                  </strong>
                </div>
              </div>
              <div className="routing-note">
                <Info size={16} />
                {ticket.routing_reason.replaceAll('_', ' ')}
              </div>
              {!!data.outbox.length && (
                <details className="detail-disclosure">
                  <summary>Delivery details</summary>
                  {data.outbox.map((item) => (
                    <div className="delivery-note" key={item.kind}>
                      {item.kind.toUpperCase()} delivery:{' '}
                      <strong>{item.status}</strong>
                      {item.last_error && <span> · {item.last_error}</span>}
                    </div>
                  ))}
                </details>
              )}
              <div className="section-actions">
                {canAct && ticket.status === 'waiting' && (
                  <Button
                    onClick={() => action('call')}
                    disabled={busy || !user.online}
                  >
                    <PhoneCall size={15} />
                    Call customer
                  </Button>
                )}
                {canAct &&
                  ticket.status === 'called' &&
                  ticket.assigned_to === user.id && (
                    <Button onClick={() => action('start')} disabled={busy}>
                      <Play size={15} />
                      Start service
                    </Button>
                  )}
                {canAct &&
                  active &&
                  (ticket.status === 'serving' || isManager(user.role)) && (
                    <Button
                      variant="outline"
                      onClick={() => setMode('close')}
                      disabled={busy}
                    >
                      <CheckCircle2 size={15} />
                      Complete
                    </Button>
                  )}
                {canAct && ticket.status === 'called' && (
                  <Button
                    variant="outline"
                    onClick={() => setMode('no_show')}
                    disabled={busy}
                  >
                    <UserRoundX size={15} />
                    No-show
                  </Button>
                )}
                {isManager(user.role) &&
                  ['waiting', 'called'].includes(ticket.status) && (
                    <Button
                      variant="outline"
                      onClick={() => setMode('reassign')}
                      disabled={busy}
                    >
                      <ArrowRightLeft size={15} />
                      Reassign
                    </Button>
                  )}
                <Button
                  variant="outline"
                  onClick={() =>
                    window.open(
                      '/print/' + ticket.id,
                      '_blank',
                      'noopener,noreferrer',
                    )
                  }
                >
                  <Printer size={15} />
                  Print
                </Button>
              </div>
              {mode && (
                <div className="action-form">
                  <h3>
                    {mode === 'reassign'
                      ? 'Reassign this ticket'
                      : mode === 'no_show'
                        ? 'Mark customer as no-show'
                        : 'Complete this interaction'}
                  </h3>
                  {mode === 'reassign' ? (
                    <>
                      <label htmlFor="reassign-agent">
                        Available agent in this service
                      </label>
                      <select
                        id="reassign-agent"
                        value={target}
                        className="form-control"
                        onChange={(e) => setTarget(e.target.value)}
                      >
                        <option value="">Select an agent</option>
                        {team
                          .filter(
                            (u) =>
                              u.enabled &&
                              u.online &&
                              u.services.includes(ticket.service_id) &&
                              u.id !== ticket.assigned_to,
                          )
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name} · {u.counter || 'No counter'}
                            </option>
                          ))}
                      </select>
                    </>
                  ) : (
                    <>
                      <label htmlFor="closure-comments">
                        Interaction notes (optional)
                      </label>
                      <textarea
                        id="closure-comments"
                        ref={notesRef}
                        rows={3}
                        maxLength={4000}
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="Capture the outcome and any follow-up required…"
                      />
                    </>
                  )}
                  <div className="section-actions">
                    <Button
                      onClick={() => action(mode)}
                      disabled={busy || (mode === 'reassign' && !target)}
                    >
                      {busy
                        ? 'Saving…'
                        : 'Confirm ' +
                          (mode === 'close'
                            ? 'completion'
                            : mode === 'no_show'
                              ? 'no-show'
                              : 'reassignment')}
                    </Button>
                    <Button variant="ghost" onClick={() => setMode('')}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {ticket.comments && (
                <div className="closure-note">
                  <h3>Closing notes</h3>
                  <p>{ticket.comments}</p>
                </div>
              )}
              <div className="timeline">
                <h3>
                  <Clock3 size={15} /> Visit history
                </h3>
                {data.events.map((event) => (
                  <div className="timeline-item" key={event.id}>
                    <span />
                    <div>
                      <strong>{event.action.replaceAll('_', ' ')}</strong>
                      <p>
                        {event.actor_name || 'Queue routing'}
                        {event.details.reason
                          ? ' · ' + event.details.reason.replaceAll('_', ' ')
                          : ''}
                      </p>
                      <small>{formatDate(event.created_at)}</small>
                      {event.details.comment && (
                        <p className="comment-text">{event.details.comment}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
