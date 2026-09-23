import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MobileVisit from '@/components/qms/mobile-visit';
// The screen a customer watches on their own phone after scanning the QR code.
// It answers two questions -- what is my number, and how many people are in
// front of me -- and deliberately answers nothing else. The waiting room's
// television is the board; repeating it here would tell the customer nothing
// new while putting other visitors' ticket numbers on a stranger's phone.
function status(overrides: Record<string, unknown> = {}) {
  return {
    number: 'C-014',
    service_name: 'General Query',
    status: 'waiting',
    counter: '',
    waiting_ahead: 2,
    ...overrides,
  };
}
function mockStatus(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}
const token = () => crypto.randomUUID();
beforeEach(() => vi.useRealTimers());
describe("A customer's own visit screen", () => {
  it('shows their ticket number and how many are ahead', async () => {
    mockStatus(status({ waiting_ahead: 2 }));
    render(<MobileVisit statusToken={token()} />);
    expect(await screen.findByText('C-014')).toBeTruthy();
    expect(screen.getByText('General Query')).toBeTruthy();
    expect(screen.getByText(/customers ahead of you/i)).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });
  it('shows nobody else’s ticket number', async () => {
    mockStatus(status({ waiting_ahead: 5 }));
    const { container } = render(<MobileVisit statusToken={token()} />);
    expect(await screen.findByText('C-014')).toBeTruthy();
    // The only ticket number anywhere on the page is the customer's own. No
    // word boundary before the letter: textContent runs adjacent elements
    // together, so the number arrives glued to the label above it.
    const numbers = (container.textContent ?? '').match(/[A-Z]-\d{3,}/g) ?? [];
    expect([...new Set(numbers)]).toEqual(['C-014']);
    // And no board, table or list of anyone else.
    expect(container.querySelector('table')).toBeNull();
  });
  it('tells someone at the front of the queue that they are next', async () => {
    mockStatus(status({ waiting_ahead: 0 }));
    render(<MobileVisit statusToken={token()} />);
    expect(await screen.findByText(/You are next/i)).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
  });
  it('sends them to the counter once they are called', async () => {
    mockStatus(status({ status: 'called', counter: 'Counter 3' }));
    render(<MobileVisit statusToken={token()} />);
    expect(await screen.findByText(/It’s your turn/i)).toBeTruthy();
    expect(screen.getByText(/Counter 3/)).toBeTruthy();
    // The queue position is irrelevant now that they have been called.
    expect(screen.queryByText(/ahead of you/i)).toBeNull();
  });
  it('closes out cleanly when the visit has ended', async () => {
    mockStatus(status({ status: 'closed', waiting_ahead: 0 }));
    render(<MobileVisit statusToken={token()} />);
    expect(await screen.findByText(/Visit completed/i)).toBeTruthy();
    expect(screen.queryByText(/ahead of you/i)).toBeNull();
  });
});
