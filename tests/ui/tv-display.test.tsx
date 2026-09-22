import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TVDisplay from '../../components/qms/tv-display';
// The reception television. Nobody is watching this screen on behalf of the
// system: if it stops updating it does so in a waiting room full of people, so
// the cases pinned here are the ones where it must say what is wrong rather
// than sit there looking correct, and the ones that decide what a customer
// standing in front of it actually learns.
type Json = Record<string, unknown>;
type Line = {
  number: string;
  service_name: string;
  department: string;
  status: string;
  counter: string;
  called_at: string | null;
  created_at: string;
};
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const line = (overrides: Partial<Line> = {}): Line => ({
  number: 'C-041',
  service_name: 'General Query',
  department: 'CRM',
  status: 'serving',
  counter: 'Counter 3',
  called_at: ago(60),
  created_at: ago(600),
  ...overrides,
});
const board = (tickets: Line[], waiting = 0) => ({ tickets, waiting });
/** Answers /api/display with `status`, and every other call with an empty 200. */
function mockApi(status: number, body: Json | null = null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/display'))
      return new Response(body ? JSON.stringify(body) : JSON.stringify({ error: 'nope' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    return new Response(JSON.stringify({ url: 'https://qms.test/check-in?invite=x' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
/** The announcement panel, which is a status region so it is read aloud too. */
const announcement = () => screen.queryByRole('status');
const rowFor = (number: string) =>
  screen.getByText(number).closest('.tv-ticket') as HTMLElement | null;
beforeEach(() => {
  // No EventSource: the board falls back to its own timer, which is the state
  // these assertions are about.
  vi.stubGlobal('EventSource', undefined);
  try {
    localStorage.clear();
  } catch {
    /* not available */
  }
});
afterEach(() => vi.useRealTimers());
describe('Reception television', () => {
  it('gives the whole panel to a customer who has just been called', async () => {
    mockApi(200, board([line({ number: 'C-042', status: 'called', counter: 'Counter 1' })]));
    render(<TVDisplay />);
    const panel = await screen.findByRole('status');
    expect(within(panel).getByText('C-042')).toBeTruthy();
    expect(within(panel).getByText('Counter 1')).toBeTruthy();
    expect(within(panel).getByText(/PLEASE PROCEED TO/i)).toBeTruthy();
  });
  it('moves them into the board with their counter once service starts', async () => {
    mockApi(200, board([line({ number: 'C-042', status: 'serving', counter: 'Counter 1' })]));
    render(<TVDisplay />);
    await screen.findByText('C-042');
    // No longer shouting: it is a board row now, and the counter is on it.
    expect(announcement()).toBeNull();
    const row = rowFor('C-042');
    expect(row).toBeTruthy();
    expect(within(row!).getByText('Counter 1')).toBeTruthy();
  });
  it('lists the people still queueing, with no counter yet', async () => {
    mockApi(
      200,
      board(
        [
          line({ number: 'C-042', status: 'serving', counter: 'Counter 1' }),
          line({ number: 'C-043', status: 'waiting', counter: '', called_at: null }),
          line({ number: 'C-044', status: 'waiting', counter: '', called_at: null }),
        ],
        2,
      ),
    );
    render(<TVDisplay />);
    await screen.findByText('C-043');
    for (const number of ['C-043', 'C-044']) {
      const row = rowFor(number);
      expect(row, number).toBeTruthy();
      expect(within(row!).getByText('Waiting')).toBeTruthy();
      expect(row!.textContent).not.toMatch(/Counter/);
    }
  });
  it('announces only the most recent call and boards the rest', async () => {
    mockApi(
      200,
      board([
        line({ number: 'C-050', status: 'called', counter: 'Counter 2', called_at: ago(5) }),
        line({ number: 'C-049', status: 'called', counter: 'Counter 4', called_at: ago(90) }),
      ]),
    );
    render(<TVDisplay />);
    const panel = await screen.findByRole('status');
    expect(within(panel).getByText('C-050')).toBeTruthy();
    expect(within(panel).queryByText('C-049')).toBeNull();
    // The earlier call is still information the room needs, with its counter.
    const row = rowFor('C-049');
    expect(row).toBeTruthy();
    expect(within(row!).getByText('Counter 4')).toBeTruthy();
  });
  it('counts the overflow only once the board is full', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      line({
        number: `C-1${i}`,
        status: 'waiting',
        counter: '',
        called_at: null,
        created_at: ago(500 - i),
      }),
    );
    mockApi(200, board(many, 20));
    render(<TVDisplay />);
    await screen.findByText('C-10');
    // 20 waiting, 8 of them listed: the line speaks for the 12 it cannot show.
    expect(screen.getByText(/\+12 more customers waiting/i)).toBeTruthy();
  });
  it('says nothing about an overflow that fits on the board', async () => {
    mockApi(
      200,
      board([line({ number: 'C-060', status: 'waiting', counter: '', called_at: null })], 1),
    );
    render(<TVDisplay />);
    await screen.findByText('C-060');
    // Announcing "1 customer waiting" beside the one row listing them is noise.
    expect(screen.queryByText(/more customer/i)).toBeNull();
  });
  it('draws no empty table when there is no queue at all', async () => {
    mockApi(200, board([], 0));
    render(<TVDisplay />);
    expect(await screen.findByText(/Welcome to Samana/i)).toBeTruthy();
    // The reported defect: column headings ruled across an empty board.
    expect(screen.queryByText('TICKET')).toBeNull();
    expect(screen.queryByText('COUNTER')).toBeNull();
  });
  it('says the sign-in expired instead of blaming the network', async () => {
    mockApi(401);
    render(<TVDisplay />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/sign-in has expired/i);
    expect(alert.querySelector('a')?.getAttribute('href')).toBe('/');
    expect(alert.textContent).not.toMatch(/reconnect/i);
  });
  it('stops asking once the sign-in has expired', async () => {
    const fetchMock = mockApi(401);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<TVDisplay />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const displayCalls = () =>
      fetchMock.mock.calls.filter((c) => `${c[0] as string}`.includes('/api/display')).length;
    const afterExpiry = displayCalls();
    await vi.advanceTimersByTimeAsync(30000);
    // A dead session is not going to recover by being asked again every three
    // seconds for the rest of the day.
    expect(displayCalls()).toBe(afterExpiry);
  });
  it('treats a server fault as a reconnecting network fault, not an expiry', async () => {
    mockApi(500);
    render(<TVDisplay />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Connection interrupted/i);
    expect(alert.textContent).not.toMatch(/sign-in has expired/i);
  });
  it('remembers the sound choice across a reload or power cut', async () => {
    mockApi(200, board([line()]));
    const user = userEvent.setup();
    const first = render(<TVDisplay />);
    await screen.findByText('C-041');
    await user.click(screen.getByLabelText(/Enable announcements/i));
    expect(localStorage.getItem('qms-tv-sound')).toBe('on');
    first.unmount();
    render(<TVDisplay />);
    expect(await screen.findByLabelText(/Mute announcements/i)).toBeTruthy();
  });
  it('renders without storage, where a kiosk browser blocks it', async () => {
    mockApi(200, board([line()]));
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    });
    render(<TVDisplay />);
    expect(await screen.findByText('C-041')).toBeTruthy();
  });
});
