'use client';
import { use, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api, formatDate } from '@/lib/client';
export default function Print({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [ticket, setTicket] = useState<{
    number: string;
    service_name: string;
    department: string;
    project_name: string;
    unit_name: string;
    created_at: string;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ ticket: typeof ticket }>('tickets/' + id + '/print')
      .then((data) => setTicket(data.ticket))
      .catch((e) => setError(e.message));
  }, [id]);
  return (
    <main className="receipt-page">
      {error ? (
        <p role="alert">{error}</p>
      ) : ticket ? (
        <>
          <a className="brand dark-brand" href="/">
            SAMANA<span>DEVELOPERS</span>
          </a>
          <h1>{ticket.number}</h1>
          <h2>{ticket.service_name}</h2>
          <p>{ticket.department}</p>
          <hr />
          <p>{ticket.project_name || 'Samana Headquarters'}</p>
          {ticket.unit_name && <p>Unit {ticket.unit_name}</p>}
          <p>{formatDate(ticket.created_at)} GST</p>
          <hr />
          <p>
            Please take a seat.
            <br />
            Your ticket number will be called.
          </p>
          <small>Thank you for visiting Samana Developers.</small>
          <Button className="no-print" onClick={() => window.print()}>
            Print receipt
          </Button>
        </>
      ) : (
        <p>Preparing your receipt…</p>
      )}
    </main>
  );
}
