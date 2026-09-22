'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, ArrowRight, PhoneCall } from 'lucide-react';
import { ApiError, api, post } from '@/lib/client';
import CheckIn from './check-in';
import type { Ticket } from '@/lib/domain';
// What the phone shows about one visit. It deliberately carries no view of
// the rest of the queue: the waiting-room television is the board, and putting
// other people's ticket numbers on a customer's phone tells them nothing they
// cannot see on the wall while handing them a record of who else was here.
interface VisitStatus {
  number: string;
  service_name: string;
  status: string;
  counter: string;
  waiting_ahead: number;
}
export default function MobileVisit({ statusToken }: { statusToken?: string }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [ticket, setTicket] = useState<VisitStatus | null>(null);
  useEffect(() => {
    let active = true;
    if (statusToken) {
      let timer: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        if (timer) clearInterval(timer);
        timer = undefined;
      };
      const load = () =>
        api<VisitStatus>('public/status/' + statusToken)
          .then((result) => {
            if (!active) return;
            setTicket(result);
            setError('');
            // A finished visit needs no further updates.
            if (['closed', 'no_show'].includes(result.status)) stop();
          })
          .catch((e) => {
            if (!active) return;
            setError(e.message);
            // A dead link stays dead; stop asking.
            if ((e as ApiError).status === 404) stop();
          });
      void load();
      timer = setInterval(load, 5000);
      return () => {
        active = false;
        stop();
      };
    }
    const invite = new URLSearchParams(window.location.search).get('invite');
    async function start() {
      try {
        if (invite) await post('public/session', { invite });
        else await api('auth/me');
        if (active) setReady(true);
        window.history.replaceState(null, '', '/check-in');
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void start();
    return () => {
      active = false;
    };
  }, [statusToken]);
  function issued(result: Ticket) {
    const token = (result as Ticket & { public_token: string }).public_token;
    if (token) window.location.assign('/visit/' + token);
  }
  return (
    <main className="mobile-visit">
      <div className="mobile-cover">
        <img
          src="/images/samana-project-2.jpg"
          alt="SAMANA Developers residential lifestyle"
        />
        <a className="brand" href="/check-in">
          SAMANA<span>DEVELOPERS</span>
        </a>
        <p>Every visit. A warm welcome.</p>
      </div>
      <div className="mobile-visit-content">
        {error && (
          <p className="error" role="alert">
            {error}
            {!statusToken && (
              <span> Please scan the current QR code at reception.</span>
            )}
          </p>
        )}
        {statusToken ? (
          ticket && (
            <section className="mobile-ticket">
              <div className={'visit-status ' + ticket.status}>
                {['closed', 'no_show'].includes(ticket.status) ? (
                  <CheckCircle2 />
                ) : ticket.status === 'waiting' ? (
                  <Clock3 />
                ) : (
                  <PhoneCall />
                )}
              </div>
              <p className="eyebrow">YOUR SAMANA VISIT</p>
              <h1>{ticket.number}</h1>
              <h2>{ticket.service_name}</h2>
              <div className={'badge ' + ticket.status}>
                {ticket.status === 'waiting'
                  ? 'You’re in the queue'
                  : ticket.status === 'called'
                    ? 'It’s your turn'
                    : ticket.status === 'serving'
                      ? 'Your visit is in progress'
                      : ticket.status === 'closed'
                        ? 'Visit completed'
                        : 'Visit marked no-show'}
              </div>
              {ticket.status === 'waiting' ? (
                // The only thing a waiting customer needs from their phone:
                // how many people are in front of them. Their own number is
                // above; everyone else's is on the television, not here.
                <div className="visit-ahead">
                  <span>CUSTOMERS AHEAD OF YOU</span>
                  <strong>{ticket.waiting_ahead}</strong>
                  <small>
                    {ticket.waiting_ahead === 0
                      ? 'You are next. Please stay nearby and watch for your number.'
                      : 'Please take a seat. Your number will be called and shown on the screen.'}
                  </small>
                </div>
              ) : ['called', 'serving'].includes(ticket.status) ? (
                <div className="mobile-counter">
                  <span>Please proceed to</span>
                  <strong>
                    {ticket.counter || 'the service desk'}{' '}
                    <ArrowRight size={25} />
                  </strong>
                </div>
              ) : (
                <p>
                  Thank you for visiting Samana. We look forward to seeing you
                  again.
                </p>
              )}
              <small>
                This page updates automatically. Keep this private link to
                follow your visit.
              </small>
            </section>
          )
        ) : ready ? (
          <CheckIn onIssued={issued} fullPage />
        ) : (
          !error && <div className="empty-state">Preparing your check-in…</div>
        )}
      </div>
      <footer>Samana Developers · Customer Experience</footer>
    </main>
  );
}
