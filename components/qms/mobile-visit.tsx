'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, ArrowRight, PhoneCall } from 'lucide-react';
import { api, post } from '@/lib/client';
import CheckIn from './check-in';
import type { Ticket } from '@/lib/domain';
export default function MobileVisit({ statusToken }: { statusToken?: string }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [ticket, setTicket] = useState<{
    number: string;
    service_name: string;
    status: string;
    counter: string;
    waiting_ahead: number;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (statusToken) {
      const load = () =>
        api<{
          number: string;
          service_name: string;
          status: string;
          counter: string;
          waiting_ahead: number;
        }>('public/status/' + statusToken)
          .then((result) => {
            if (active) {
              setTicket(result);
              setError('');
            }
          })
          .catch((e) => {
            if (active) setError(e.message);
          });
      void load();
      const timer = setInterval(load, 5000);
      return () => {
        active = false;
        clearInterval(timer);
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
                <p>
                  Please take a seat. <strong>{ticket.waiting_ahead}</strong>{' '}
                  tickets are ahead of you in this service queue.
                </p>
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
          <CheckIn onIssued={issued} />
        ) : (
          !error && <div className="empty-state">Preparing your check-in…</div>
        )}
      </div>
      <footer>Samana Developers · Customer Experience</footer>
    </main>
  );
}
