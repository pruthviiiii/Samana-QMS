'use client';
import {
  ArrowUpRight,
  ArrowRight,
  Clock3,
  Headphones,
  QrCode,
  Users,
  CheckCircle2,
  CircleDashed,
  Building2,
} from 'lucide-react';
import { type Ticket, minutesBetween } from '@qms/shared';

export type QueueService = {
  id: string;
  name: string;
  department: string;
  waiting: number;
  serving: number;
};

export function ServicePulse({
  services,
  unassigned,
  onDepartment,
  onQr,
  onWaiting,
}: {
  services: QueueService[];
  unassigned: number;
  onDepartment: (department: string) => void;
  onQr?: () => void;
  onWaiting: () => void;
}) {
  const total = services.reduce((sum, s) => sum + s.waiting + s.serving, 0);
  return (
    <aside className="operations-rail">
      <section className="pulse-panel">
        <div className="rail-heading">
          <span className="eyebrow">RIGHT NOW</span>
          <span className="live-indicator">
            <i /> Live
          </span>
        </div>
        <h2>Service floor</h2>
        <p>Every journey, in view.</p>
        <div className="floor-total">
          <strong>{total}</strong>
          <span>
            active
            <br />
            customer visits
          </span>
          <Headphones size={30} strokeWidth={1.2} />
        </div>
        <div
          className="floor-distribution"
          aria-label="Active visits by department"
        >
          {['CRM', 'Collection', 'General Query'].map((department, i) => {
            const count = services
              .filter((s) => s.department === department)
              .reduce((sum, s) => sum + s.waiting + s.serving, 0);
            return (
              count > 0 && (
                <span
                  key={department}
                  className={'distribution-' + i}
                  style={{ flex: count }}
                  title={`${department}: ${count}`}
                />
              )
            );
          })}
        </div>
        <div className="floor-services">
          {['CRM', 'Collection', 'General Query'].map((department, i) => {
            const rows = services.filter((s) => s.department === department);
            const waiting = rows.reduce((sum, s) => sum + s.waiting, 0);
            const serving = rows.reduce((sum, s) => sum + s.serving, 0);
            return (
              <button key={department} onClick={() => onDepartment(department)}>
                <i className={'distribution-' + i} />
                <span>
                  <strong>{department}</strong>
                  <small>
                    {waiting} waiting · {serving} in service
                  </small>
                </span>
                <ArrowUpRight size={16} />
              </button>
            );
          })}
        </div>
        {unassigned > 0 ? (
          <button className="attention-note" onClick={onWaiting}>
            <CircleDashed size={18} />
            <span>
              <strong>{unassigned} awaiting an executive</strong>
              <small>Review the waiting queue</small>
            </span>
            <ArrowRight size={15} />
          </button>
        ) : (
          <div className="floor-clear">
            <CheckCircle2 size={16} /> No visits awaiting assignment
          </div>
        )}
      </section>
      <section className="arrival-card">
        <img
          src="/images/samana-ocean-bay-residences.jpg"
          alt="Poolside residences at SAMANA Ocean Bay"
        />
        <div className="arrival-copy">
          <span className="eyebrow">A WARMER WELCOME</span>
          <h2>
            A beautiful arrival.
            <br />A seamless visit.
          </h2>
          <p>
            Check in from your phone.
            <br />
            We’ll take care of the rest.
          </p>
          {onQr && (
            <button onClick={onQr}>
              <QrCode size={18} /> Reception QR <ArrowUpRight size={17} />
            </button>
          )}
        </div>
      </section>
    </aside>
  );
}

const lanes = [
  { id: 'waiting', label: 'Waiting', icon: Clock3 },
  { id: 'called', label: 'Called', icon: Users },
  { id: 'serving', label: 'In service', icon: Headphones },
  { id: 'closed', label: 'Completed', icon: CheckCircle2 },
  { id: 'no_show', label: 'No-show', icon: CircleDashed },
];
export function QueueBoard({
  tickets,
  onTicket,
  loading,
}: {
  tickets: Ticket[];
  onTicket: (id: string) => void;
  loading: boolean;
}) {
  const visibleLanes = lanes.filter(
    (l) =>
      ['waiting', 'called', 'serving'].includes(l.id) ||
      tickets.some((t) => t.status === l.id),
  );
  return (
    <div
      className="queue-board"
      aria-label="Queue board, current page"
      aria-busy={loading}
    >
      {visibleLanes.map((lane) => {
        const rows = tickets.filter((t) => t.status === lane.id);
        return (
          <section className={'board-lane lane-' + lane.id} key={lane.id}>
            <h3>
              <lane.icon size={16} />
              {lane.label}
              <span>{rows.length}</span>
            </h3>
            {rows.map((ticket) => (
              <button
                className="board-ticket"
                key={ticket.id}
                onClick={() => onTicket(ticket.id)}
              >
                <span className="board-ticket-top">
                  <strong>{ticket.number}</strong>
                  <ArrowUpRight size={16} />
                </span>
                <span className="board-customer">{ticket.customer_name}</span>
                <span className="board-unit">
                  <Building2 size={13} />
                  {[ticket.project_name, ticket.unit_name]
                    .filter(Boolean)
                    .join(' · ') || 'Walk-in visit'}
                </span>
                <span className="board-service">{ticket.service_name}</span>
                <span className="board-ticket-bottom">
                  <span className={ticket.assigned_name ? '' : 'unassigned'}>
                    {ticket.assigned_name || 'Unassigned'}
                  </span>
                  <span>
                    <Clock3 size={12} />
                    {minutesBetween(
                      ticket.created_at,
                      ticket.called_at || ticket.closed_at,
                    ).toFixed(0)}
                    m wait
                  </span>
                </span>
              </button>
            ))}
            {!rows.length && (
              <div className="board-empty">
                <lane.icon size={23} strokeWidth={1.3} />
                <span>{loading ? 'Updating…' : 'No tickets'}</span>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function QueueSkeleton() {
  return (
    <output className="queue-skeleton" aria-label="Loading queue">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i}>
          <i />
          <span />
          <span />
          <span />
        </div>
      ))}
    </output>
  );
}
