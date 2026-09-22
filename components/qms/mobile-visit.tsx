'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, ArrowRight, PhoneCall } from 'lucide-react';
import { ApiError, api, post } from '@/lib/client';
import CheckIn from './check-in';
import type { Ticket } from '@/lib/domain';
// One line of the queue the customer can see: a ticket number and its state,
// which is what the reception television already shows the whole waiting room.
// No name, no unit, nothing that identifies the person holding it.
interface QueueLine {
  number: string;
  status: string;
  counter: string | null;
  position: number;
  total: number;
}
interface VisitStatus {
  number: string;
  service_name: string;
  status: string;
  counter: string;
  waiting_ahead: number;
  queue: QueueLine[];
}
const LINE_STATUS: Record<string, string> = {
  serving: 'At the counter',
  called: 'Called now',
  waiting: 'Waiting',
};
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
  // The customer's own line in the window, which carries their place and the
  // size of the queue. Absent once the visit has ended.
  const mine = ticket?.queue.find((line) => line.number === ticket.number) ?? null;
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
                  Please take a seat.{' '}
                  {ticket.waiting_ahead === 0 ? (
                    <>You are next in this queue.</>
                  ) : (
                    <>
                      <strong>{ticket.waiting_ahead}</strong>{' '}
                      {ticket.waiting_ahead === 1 ? 'ticket is' : 'tickets are'}{' '}
                      ahead of you in this service queue.
                    </>
                  )}
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
              {ticket.queue.length > 1 && (
                <div className="visit-queue">
                  <h3>{ticket.service_name} queue</h3>
                  <table>
                    <caption>
                      Your place is {mine?.position ?? ticket.waiting_ahead + 1}{' '}
                      of {mine?.total ?? ticket.queue.length}. Ticket numbers
                      only — no personal details are shown.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Ticket</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ticket.queue.map((line) => {
                        const you = line.number === ticket.number;
                        return (
                          <tr
                            key={line.number}
                            className={you ? 'you' : undefined}
                            aria-current={you ? 'true' : undefined}
                          >
                            <th scope="row">
                              {line.number}
                              {you && <span className="you-tag">You</span>}
                            </th>
                            <td>
                              <span className={'badge ' + line.status}>
                                {LINE_STATUS[line.status] ?? line.status}
                              </span>
                              {line.counter &&
                                ['called', 'serving'].includes(line.status) && (
                                  <em> · {line.counter}</em>
                                )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
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
