'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Maximize, Volume2, VolumeX, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/client';
import { useLive } from './use-live';
type DisplayTicket = {
  number: string;
  service_name: string;
  department: string;
  status: string;
  counter: string;
  called_at: string;
};
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
      if ((e as Error & { status?: number }).status === 401) {
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
  useEffect(() => {
    const ticket = data.tickets[0];
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
  }, [data, sound]);
  const current = data.tickets[0];
  const stale =
    expired || (!!error && Date.now() - lastSuccess.current > 30000);
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
          {!stale && current ? (
            <div className="now-serving">
              <div>
                <small>TICKET NUMBER</small>
                <strong>{current.number}</strong>
                <p>
                  {current.department} · {current.service_name}
                </p>
              </div>
              <ArrowRight size={48} />
              <div>
                <small>PLEASE PROCEED TO</small>
                <h1>{current.counter || 'Service desk'}</h1>
              </div>
            </div>
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
          <div className="tv-list-heading">
            <span>TICKET</span>
            <span>SERVICE</span>
            <span>COUNTER</span>
          </div>
          {!stale &&
            data.tickets.slice(1, 7).map((ticket) => (
              <div
                className="tv-ticket"
                key={ticket.number + '|' + ticket.called_at}
              >
                <strong>{ticket.number}</strong>
                <span>{ticket.service_name}</span>
                <b>{ticket.counter || 'Service desk'}</b>
              </div>
            ))}
          <div className="tv-waiting">
            <span>{data.waiting} customers waiting</span>
            <span>Thank you for your patience.</span>
          </div>
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
