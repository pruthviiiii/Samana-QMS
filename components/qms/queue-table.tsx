'use client';
import { ChevronRight, Clock3, ListOrdered, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { type Ticket, minutesBetween } from '@/lib/domain';
export function statusLabel(status: string) {
  return status === 'serving'
    ? 'In service'
    : status === 'closed'
      ? 'Completed'
      : status === 'no_show'
        ? 'No-show'
        : status[0].toUpperCase() + status.slice(1);
}
export default function QueueTable({
  tickets,
  loading,
  search,
  agentView,
  canIssue,
  onTicket,
  onIssue,
}: {
  tickets: Ticket[];
  loading: boolean;
  search: string;
  agentView: boolean;
  canIssue: boolean;
  onTicket: (id: string) => void;
  onIssue: () => void;
}) {
  return (
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
          {tickets.map((ticket) => (
            <tr key={ticket.id}>
              <td>
                <button
                  className="ticket-number btn-link"
                  onClick={() => onTicket(ticket.id)}
                >
                  {ticket.number}
                </button>
                <span className="ticket-meta">
                  {new Date(ticket.created_at).toLocaleTimeString('en-AE', {
                    timeZone: 'Asia/Dubai',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </td>
              <td>
                <strong className="customer-cell">{ticket.customer_name}</strong>
                <span className="ticket-meta">
                  {ticket.project_name || 'Walk-in customer'}
                  {ticket.unit_name ? ' · ' + ticket.unit_name : ''}
                </span>
              </td>
              <td>
                {ticket.service_name}
                <span className="ticket-meta">{ticket.department}</span>
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
                  {statusLabel(ticket.status)}
                </span>
              </td>
              <td>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={'View ' + ticket.number}
                  onClick={() => onTicket(ticket.id)}
                >
                  <ChevronRight size={16} />
                </Button>
              </td>
            </tr>
          ))}
          {!tickets.length && (
            <tr>
              <td colSpan={7}>
                <div className="empty-state">
                  <ListOrdered size={30} />
                  <h3>
                    {loading
                      ? 'Loading your service floor…'
                      : search
                        ? 'No matching tickets'
                        : agentView
                          ? 'You’re ready for your next customer'
                          : 'A clear queue. A fresh start.'}
                  </h3>
                  <p>
                    {search
                      ? 'Try another ticket number, customer, or unit.'
                      : agentView
                        ? 'Go online to receive assignments for your service queues.'
                        : 'New visits will appear here as customers check in.'}
                  </p>
                  {canIssue && !loading && !search && (
                    <Button
                      className="empty-cta"
                      variant="outline"
                      onClick={onIssue}
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
  );
}
