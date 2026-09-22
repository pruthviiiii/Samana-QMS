'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Maximize, Volume2, VolumeX, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/client';
import { useLive } from './use-live';
type DisplayTicket = {
  number: string;
  service_name: string;
  department: string;
  status: string;
  counter: string;
  called_at: string | null;
  created_at: string;
};
// Room for the board plus the overflow line. The server sends at most this
// many rows (BOARD_ROWS in lib/data/tickets.ts).
const ROWS = 9;
export default function TVDisplay() {
  const [data, setData] = useState<{
    tickets: DisplayTicket[];
    waiting: number;
  }>({ tickets: [], waiting: 0 });
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [clock, setClock] = useState('');
  const [sound, setSoundState] = useState(false);
  const [expired, setExpired] = useState(false);
  const lastCall = useRef('');
  const lastSuccess = useRef(0);
  const stopped = useRef(false);
  // The sound preference survives reloads and power cuts. Browsers still need
  // one interaction on the page before speech is allowed, so the icon stays.
  useEffect(() => {
    try {
      if (localStorage.getItem('qms-tv-sound') === 'on') setSoundState(true);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setSound = (value: boolean) => {
    setSoundState(value);
    try {
      localStorage.setItem('qms-tv-sound', value ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
  };
  const load = useCallback(async () => {
    if (stopped.current) return;
    try {
      const result = await api<{ tickets: DisplayTicket[]; waiting: number }>(
        'display',
      );
      if (stopped.current) return;
      setData(result);
      lastSuccess.current = Date.now();
      setError('');
    } catch (e) {
      if (stopped.current) return;
      // An expired sign-in cannot heal itself: say so instead of blaming the
      // network, and stop asking.
      if ((e as ApiError).status === 401) {
        stopped.current = true;
        setExpired(true);
        setError('');
      } else setError('Connection interrupted. Reconnecting…');
    }
  }, []);
  // Live updates when the server pushes them; a slow poll as the safety net.
  const live = useLive(!expired, () => void load());
  useEffect(() => {
    if (expired) return;
    void load();
    const timer = setInterval(() => void load(), live ? 30000 : 3000);
    return () => clearInterval(timer);
  }, [load, live, expired]);
  useEffect(() => {
    let alive = true;
    async function link() {
      if (stopped.current) return;
      try {
        const result = await api<{ url: string }>('checkin-link');
        if (alive) setQr(result.url);
      } catch {
        if (alive) setQr('');
      }
    }
    void link();
    const qrTimer = setInterval(link, 120000);
    const clockTimer = setInterval(
      () =>
        setClock(
          new Intl.DateTimeFormat('en-AE', {
            timeZone: 'Asia/Dubai',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(new Date()),
        ),
      1000,
    );
    return () => {
      alive = false;
      stopped.current = true;
      clearInterval(qrTimer);
      clearInterval(clockTimer);
    };
  }, []);
  // The ticket being announced: the one most recently called and not yet
  // started. It holds the screen until the agent starts serving, which is what
  // moves it down into the board with its counter beside it.
  const announcing = data.tickets.find((t) => t.status === 'called') ?? null;
  useEffect(() => {
    const ticket = announcing;
    if (!ticket) return;
    const key = ticket.number + '|' + ticket.called_at;
    if (lastCall.current === key) return;
    lastCall.current = key;
    if (sound && 'speechSynthesis' in window) {
      const announcement = new SpeechSynthesisUtterance(
        `Ticket ${ticket.number.replace('-', ' ')}. Please proceed to ${ticket.counter || 'the service desk'}.`,
      );
      announcement.lang = 'en-GB';
      window.speechSynthesis.speak(announcement);
    }
  }, [announcing, sound]);
  const stale =
    expired || (!!error && Date.now() - lastSuccess.current > 30000);
  // Everything else on the board, in the order it will be called. The
  // announced ticket is not repeated here; it is already filling the screen.
  const listed = data.tickets.filter((t) => t !== announcing).slice(0, ROWS - 1);
  // People still waiting beyond the rows that fit. Only this number is shown,
  // and only when there is an overflow: a board that says "12 waiting" while
  // listing them all is telling the room something it can already see.
  const overflow = Math.max(
    0,
    data.waiting - listed.filter((t) => t.status === 'waiting').length,
  );
  return (
    <main className="tv-screen">
      <header className="tv-header">
        <a className="brand" href="/">
          SAMANA<span>DEVELOPERS</span>
        </a>
        <div>
          <span>CUSTOMER EXPERIENCE CENTRE</span>
          <strong>{clock || 'Dubai · GST'}</strong>
        </div>
        <div className="tv-controls">
          <Button
            variant="ghost"
            aria-label={sound ? 'Mute announcements' : 'Enable announcements'}
            onClick={() => setSound(!sound)}
          >
            {sound ? <Volume2 /> : <VolumeX />}
          </Button>
          <Button
            variant="ghost"
            aria-label="Enter full screen"
            onClick={() =>
              document.documentElement.requestFullscreen?.().catch(() => {})
            }
          >
            <Maximize />
          </Button>
        </div>
      </header>
      <div className="tv-content">
        <section className="tv-queue">
          <div className="tv-section-label">
            <span className="status-dot green" /> NOW SERVING{' '}
            <span>يرجى التوجه إلى مكتب الخدمة</span>
          </div>
          {expired && (
            <div className="tv-error" role="alert">
              This display&apos;s sign-in has expired.{' '}
              <a href="/">Sign in again on this screen</a> to resume the board.
            </div>
          )}
          {error && (
            <div className="tv-error" role="alert">
              {error}
            </div>
          )}
          {!stale && announcing ? (
            // A customer has just been called. This is the one moment the
            // screen has a job beyond informing, so it takes the whole panel
            // until the agent starts serving them.
            // `output` is the live region for a value the page has produced:
            // it carries the status role, so a screen reader announces a call
            // without the number being polled for.
            <output className="now-serving">
              <div>
                <small>TICKET NUMBER</small>
                <strong>{announcing.number}</strong>
                <p>
                  {announcing.department} · {announcing.service_name}
                </p>
              </div>
              <ArrowRight size={48} />
              <div>
                <small>PLEASE PROCEED TO</small>
                <h1>{announcing.counter || 'Service desk'}</h1>
              </div>
            </output>
          ) : (
            <div className="tv-welcome">
              <h1>{stale ? 'Reconnecting…' : 'Welcome to Samana'}</h1>
              <p>
                {stale
                  ? 'Please follow the directions of our reception team.'
                  : 'Please scan the QR code to check in. We look forward to assisting you.'}
              </p>
            </div>
          )}
          {!stale && listed.length > 0 && (
            <div className="tv-list">
              <div className="tv-list-heading">
                <span>TICKET</span>
                <span>SERVICE</span>
                <span>COUNTER</span>
              </div>
              {listed.map((ticket) => (
                <div className={'tv-ticket ' + ticket.status} key={ticket.number}>
                  <strong>{ticket.number}</strong>
                  <span>{ticket.service_name}</span>
                  {/* The counter is the answer to "where do I go", so it
                      appears the moment a ticket has one. A ticket still in
                      the queue has none yet and says where it stands instead. */}
                  {ticket.status === 'waiting' ? (
                    <i>Waiting</i>
                  ) : (
                    <b>{ticket.counter || 'Service desk'}</b>
                  )}
                </div>
              ))}
              {overflow > 0 && (
                <div className="tv-more">
                  <span>
                    +{overflow} more {overflow === 1 ? 'customer' : 'customers'}{' '}
                    waiting
                  </span>
                  <span>Thank you for your patience.</span>
                </div>
              )}
            </div>
          )}
        </section>
        <aside className="tv-feature">
          <img
            src="/images/samana-rome-dusk.jpg"
            alt="SAMANA Rome residences at dusk"
          />
          <div className="tv-photo-caption">
            <span>WHERE DREAMS TAKE SHAPE</span>
            <h2>
              Welcome to
              <br />
              the Samana lifestyle.
            </h2>
          </div>
          <div className="tv-qr">
            {qr ? (
              <QRCodeSVG value={qr} size={130} marginSize={1} />
            ) : (
              <div className="qr-placeholder">Please speak to reception</div>
            )}
            <div>
              <h3>Scan. Check in. Relax.</h3>
              <p>Join the queue from your phone.</p>
              <small>امسح الرمز لتسجيل زيارتك</small>
            </div>
          </div>
        </aside>
      </div>
      <footer className="tv-footer">
        <span>SAMANA DEVELOPERS</span>
        <span>Your next chapter begins with a warm welcome.</span>
        <span>Dubai, UAE</span>
      </footer>
    </main>
  );
}
