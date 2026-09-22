import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TVDisplay from '../../components/qms/tv-display';
// The reception television. Nobody is watching this screen on behalf of the
// system: if it stops updating it does so in a waiting room full of people, so
// the cases pinned here are the ones where it must say what is wrong rather
// than sit there looking correct. An expired sign-in in particular cannot heal
// itself, and once told it was a network fault the screen waited forever.
type Json = Record<string, unknown>;
const board = (overrides: Json = {}) => ({
  tickets: [
    {
      number: 'C-041',
      service_name: 'General Query',
      department: 'CRM',
      status: 'serving',
      counter: 'Counter 3',
      called_at: new Date().toISOString(),
    },
  ],
  waiting: 4,
  ...overrides,
});
/** Answers /api/display with `status`, and every other call with an empty 200. */
function mockApi(status: number, body: Json | null = null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
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
  it('shows the ticket currently being served', async () => {
    mockApi(200, board());
    render(<TVDisplay />);
    expect(await screen.findByText('C-041')).toBeTruthy();
    expect(screen.getByText(/Counter 3/)).toBeTruthy();
  });
  it('says the sign-in expired instead of blaming the network', async () => {
    mockApi(401);
    render(<TVDisplay />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/sign-in has expired/i);
    // And offers the only thing that actually fixes it.
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
    const later = displayCalls();
    // A dead session is not going to recover by being asked again every three
    // seconds for the rest of the day.
    expect(later).toBe(afterExpiry);
  });
  it('treats a server fault as a reconnecting network fault, not an expiry', async () => {
    mockApi(500);
    render(<TVDisplay />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Connection interrupted/i);
    expect(alert.textContent).not.toMatch(/sign-in has expired/i);
  });
  it('remembers the sound choice across a reload or power cut', async () => {
    mockApi(200, board());
    const user = userEvent.setup();
    const first = render(<TVDisplay />);
    await screen.findByText('C-041');
    await user.click(screen.getByLabelText(/Enable announcements/i));
    expect(localStorage.getItem('qms-tv-sound')).toBe('on');
    first.unmount();
    // A power cut is a fresh mount with the same storage.
    render(<TVDisplay />);
    expect(await screen.findByLabelText(/Mute announcements/i)).toBeTruthy();
  });
  it('renders without storage, where a kiosk browser blocks it', async () => {
    mockApi(200, board());
    const throwing = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('localStorage', throwing);
    render(<TVDisplay />);
    expect(await screen.findByText('C-041')).toBeTruthy();
  });
});
