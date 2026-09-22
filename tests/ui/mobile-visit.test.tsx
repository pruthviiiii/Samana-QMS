import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import MobileVisit from '../../components/qms/mobile-visit';
// The screen a customer watches on their own phone after scanning the QR code.
// It has to answer one question — where am I in the queue — so these tests pin
// that the board is shown with their own ticket marked, and that it carries
// nothing about anybody else beyond what the reception television already
// shows the whole waiting room.
interface Line {
  number: string;
  status: string;
  counter: string | null;
  position: number;
  total: number;
}
function status(overrides: Record<string, unknown> = {}, queue?: Line[]) {
  return {
    number: 'C-014',
    service_name: 'General Query',
    status: 'waiting',
    counter: '',
    waiting_ahead: 2,
    queue: queue ?? [
      { number: 'C-012', status: 'serving', counter: 'Counter 3', position: 1, total: 5 },
      { number: 'C-013', status: 'called', counter: 'Counter 1', position: 2, total: 5 },
      { number: 'C-014', status: 'waiting', counter: null, position: 3, total: 5 },
      { number: 'C-015', status: 'waiting', counter: null, position: 4, total: 5 },
    ],
    ...overrides,
  };
}
function mockStatus(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}
const board = async () => {
  const heading = await screen.findByText(/General Query queue/i);
  return within(heading.closest('.visit-queue') as HTMLElement).getByRole('table');
};
beforeEach(() => vi.useRealTimers());
describe("A customer's own visit screen", () => {
  it('shows the queue as a table with their own ticket marked', async () => {
    mockStatus(status());
    render(<MobileVisit statusToken={crypto.randomUUID()} />);
    const table = await board();
    const rows = within(table).getAllByRole('row').slice(1); // drop the header
    expect(rows).toHaveLength(4);
    expect(within(table).getByText('C-012')).toBeTruthy();
    expect(within(table).getByText('C-015')).toBeTruthy();
    // Their own line, and only theirs, is marked.
    const marked = within(table).getAllByText('You');
    expect(marked).toHaveLength(1);
    expect(marked[0].closest('tr')?.textContent).toContain('C-014');
    expect(marked[0].closest('tr')?.getAttribute('aria-current')).toBe('true');
  });
  it('states their place and that nothing personal is shown', async () => {
    mockStatus(status());
    render(<MobileVisit statusToken={crypto.randomUUID()} />);
    const table = await board();
    const caption = within(table).getByText(/Your place is/i);
    expect(caption.textContent).toContain('3');
    expect(caption.textContent).toContain('5');
    expect(caption.textContent).toMatch(/no personal details/i);
  });
  it('names the counter only for a ticket that has been called', async () => {
    mockStatus(status());
    render(<MobileVisit statusToken={crypto.randomUUID()} />);
    const table = await board();
    const serving = within(table).getByText('C-012').closest('tr') as HTMLElement;
    expect(serving.textContent).toContain('Counter 3');
    const waiting = within(table).getByText('C-015').closest('tr') as HTMLElement;
    expect(waiting.textContent).not.toContain('Counter');
  });
  it('tells someone at the front of the queue that they are next', async () => {
    mockStatus(
      status({ waiting_ahead: 0 }, [
        { number: 'C-014', status: 'waiting', counter: null, position: 1, total: 2 },
        { number: 'C-015', status: 'waiting', counter: null, position: 2, total: 2 },
      ]),
    );
    render(<MobileVisit statusToken={crypto.randomUUID()} />);
    expect(await screen.findByText(/You are next in this queue/i)).toBeTruthy();
  });
  it('drops the board once the visit is over', async () => {
    mockStatus(status({ status: 'closed', waiting_ahead: 0, queue: [] }));
    render(<MobileVisit statusToken={crypto.randomUUID()} />);
    expect(await screen.findByText(/Visit completed/i)).toBeTruthy();
    expect(screen.queryByText(/queue/i)).toBeNull();
  });
});
