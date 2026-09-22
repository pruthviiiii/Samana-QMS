import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QueueTable, { statusLabel } from '../../components/qms/queue-table';
import type { Ticket } from '../../lib/domain';
// The live queue is the screen every agent watches all day. These tests pin
// what it shows for each ticket state, what it says when there is nothing to
// show, and that the two ways of opening a ticket both reach the caller.
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString();
function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: crypto.randomUUID(),
    number: 'C-001',
    service_id: 'crm-general',
    department: 'CRM',
    service_name: 'General Query',
    status: 'waiting',
    customer_name: 'Synthetic Customer',
    customer_id: null,
    unit_id: null,
    unit_name: null,
    project_name: null,
    booking_number: null,
    assigned_to: null,
    assigned_name: null,
    counter: null,
    created_at: minutesAgo(1),
    assigned_at: null,
    called_at: null,
    started_at: null,
    closed_at: null,
    routing_reason: 'awaiting_agent',
    comments: null,
    version: 1,
    identifier_type: 'mobile',
    ...overrides,
  };
}
function renderTable(
  tickets: Ticket[],
  props: Partial<Parameters<typeof QueueTable>[0]> = {},
) {
  const onTicket = vi.fn();
  const onIssue = vi.fn();
  render(
    <QueueTable
      tickets={tickets}
      loading={false}
      search=""
      agentView={false}
      canIssue
      onTicket={onTicket}
      onIssue={onIssue}
      {...props}
    />,
  );
  return { onTicket, onIssue };
}
describe('Queue table', () => {
  it('shows each ticket with its customer, service, assignee and state', () => {
    renderTable([
      ticket({
        number: 'C-014',
        customer_name: 'Ayesha Test',
        project_name: 'Project A',
        unit_name: 'A-1204',
        assigned_name: 'Omar Executive',
        status: 'serving',
      }),
      ticket({ number: 'G-002', customer_name: 'Walk-in Person' }),
    ]);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByRole('button', { name: 'C-014' })).toBeTruthy();
    expect(first.getByText('Ayesha Test')).toBeTruthy();
    expect(first.getByText('Project A · A-1204')).toBeTruthy();
    expect(first.getByText('Omar Executive')).toBeTruthy();
    expect(first.getByText('In service')).toBeTruthy();
    const second = within(rows[1]);
    expect(second.getByText('Walk-in customer')).toBeTruthy();
    expect(second.getByText('Unassigned')).toBeTruthy();
    expect(second.getByText('Waiting')).toBeTruthy();
  });
  it('flags a customer who has waited more than five minutes', () => {
    renderTable([
      ticket({ number: 'C-001', created_at: minutesAgo(7) }),
      ticket({ number: 'C-002', created_at: minutesAgo(2) }),
    ]);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0].querySelector('.wait-warning')?.textContent).toContain('7');
    expect(rows[1].querySelector('.wait-warning')).toBeNull();
    expect(rows[1].querySelector('.wait-time')?.textContent).toContain('2');
  });
  it('measures the wait up to the call, not to now, once a customer is called', () => {
    renderTable([
      ticket({
        status: 'called',
        created_at: minutesAgo(30),
        called_at: minutesAgo(27),
      }),
    ]);
    expect(screen.getByText(/3 min/)).toBeTruthy();
  });
  it('opens a ticket from its number and from the row action', async () => {
    const user = userEvent.setup();
    const one = ticket({ number: 'C-021' });
    const { onTicket } = renderTable([one]);
    await user.click(screen.getByRole('button', { name: 'C-021' }));
    await user.click(screen.getByRole('button', { name: 'View C-021' }));
    expect(onTicket).toHaveBeenCalledTimes(2);
    expect(onTicket).toHaveBeenNthCalledWith(1, one.id);
    expect(onTicket).toHaveBeenNthCalledWith(2, one.id);
  });
  it('offers to issue the first ticket only when the queue is truly empty', async () => {
    const user = userEvent.setup();
    const { onIssue } = renderTable([]);
    expect(screen.getByText('A clear queue. A fresh start.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Issue the first ticket/ }));
    expect(onIssue).toHaveBeenCalledTimes(1);
  });
  it('explains an empty result differently for a search, a loading state and an agent', () => {
    renderTable([], { search: 'zzz' });
    expect(screen.getByText('No matching tickets')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Issue the first ticket/ })).toBeNull();
    cleanupAndRender([], { loading: true });
    expect(screen.getByText('Loading your service floor…')).toBeTruthy();
    cleanupAndRender([], { agentView: true, canIssue: false });
    expect(screen.getByText('You’re ready for your next customer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Issue the first ticket/ })).toBeNull();
  });
  it('labels every state in plain words', () => {
    expect(statusLabel('waiting')).toBe('Waiting');
    expect(statusLabel('called')).toBe('Called');
    expect(statusLabel('serving')).toBe('In service');
    expect(statusLabel('closed')).toBe('Completed');
    expect(statusLabel('no_show')).toBe('No-show');
  });
});
function cleanupAndRender(
  tickets: Ticket[],
  props: Partial<Parameters<typeof QueueTable>[0]>,
) {
  document.body.innerHTML = '';
  renderTable(tickets, props);
}
