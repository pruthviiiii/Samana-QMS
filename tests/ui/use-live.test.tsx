import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useLive } from '@/components/qms/use-live';
// The live update mechanism. Every screen depends on it to learn that
// something changed without asking, and falls back to its own polling interval
// when it cannot. These tests pin both halves, because a stream that silently
// reports itself live while delivering nothing would leave every screen on a
// 30-second timer believing it was current.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, (event: MessageEvent) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    this.listeners.set(type, handler);
  }
  close() {
    this.closed = true;
  }
  /** The server's opening frame saying whether the database listener is up. */
  emitStatus(listening: boolean) {
    this.listeners.get('status')?.({
      data: JSON.stringify({ listening }),
    } as MessageEvent);
  }
  emitChange(kind = 'tickets') {
    this.onmessage?.({ data: JSON.stringify({ kind }) } as MessageEvent);
  }
  emitError() {
    this.onerror?.(new Event('error'));
  }
}
function Harness({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const live = useLive(enabled, onChange);
  return <span data-testid="live">{String(live)}</span>;
}
beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.useRealTimers());
const only = () => FakeEventSource.instances[0];
describe('Live updates over server-sent events', () => {
  it('subscribes once and reports live only when the server confirms it', async () => {
    const { getByTestId } = render(<Harness enabled onChange={vi.fn()} />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(only().url).toBe('/api/events');
    // Connected is not the same as listening: until the server says the
    // database listener is established, screens must keep their own timer.
    expect(getByTestId('live').textContent).toBe('false');
    act(() => only().emitStatus(true));
    await waitFor(() => expect(getByTestId('live').textContent).toBe('true'));
  });
  it('falls back when the server reports its listener is down', async () => {
    const { getByTestId } = render(<Harness enabled onChange={vi.fn()} />);
    act(() => only().emitStatus(true));
    await waitFor(() => expect(getByTestId('live').textContent).toBe('true'));
    act(() => only().emitStatus(false));
    await waitFor(() => expect(getByTestId('live').textContent).toBe('false'));
  });
  it('falls back when the stream itself errors', async () => {
    const { getByTestId } = render(<Harness enabled onChange={vi.fn()} />);
    act(() => only().emitStatus(true));
    await waitFor(() => expect(getByTestId('live').textContent).toBe('true'));
    act(() => only().emitError());
    await waitFor(() => expect(getByTestId('live').textContent).toBe('false'));
  });
  it('collapses a burst of changes into one refresh', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Harness enabled onChange={onChange} />);
    act(() => {
      only().emitChange();
      only().emitChange();
      only().emitChange();
    });
    expect(onChange).not.toHaveBeenCalled(); // debounced, not immediate
    act(() => void vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('calls the latest handler, not the one captured at subscribe time', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness enabled onChange={first} />);
    rerender(<Harness enabled onChange={second} />);
    act(() => only().emitChange());
    act(() => void vi.advanceTimersByTime(300));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    // One stream across the re-render, not a new connection each time.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
  it('opens nothing while disabled and closes the stream on unmount', () => {
    const { unmount } = render(<Harness enabled={false} onChange={vi.fn()} />);
    expect(FakeEventSource.instances).toHaveLength(0);
    unmount();
    const live = render(<Harness enabled onChange={vi.fn()} />);
    expect(FakeEventSource.instances).toHaveLength(1);
    live.unmount();
    expect(only().closed).toBe(true);
  });
  it('degrades to polling where the browser has no EventSource', () => {
    vi.stubGlobal('EventSource', undefined);
    const { getByTestId } = render(<Harness enabled onChange={vi.fn()} />);
    expect(getByTestId('live').textContent).toBe('false');
  });
});
