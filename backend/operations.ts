import * as events from './data/events';
import { unread } from './data/notifications';
import * as outbox from './data/outbox';
import * as reportData from './data/reports';
import { workerLastRun } from './data/system';
import * as tickets from './data/tickets';
import { csvCell, isManager, type User } from '@qms/shared';
import { HttpError, intParam } from './http';
// Read models for the staff screens: the live queue page, a ticket's detail,
// reports and the audit trail. Each composes the typed data layer; nothing here
// touches SQL directly.

export async function queue(user: User, url: URL) {
  const page = intParam(url, 'page', 1, 1, 100000);
  const limit = 20;
  const mine = user.role === 'agent' || url.searchParams.get('mine') === 'true';
  const scope = mine ? user.id : null;
  const [pageData, statistics, services, notifications, lastRun] = await Promise.all([
    tickets.queuePage({
      assignedTo: scope,
      search: url.searchParams.get('search') || '',
      department: url.searchParams.get('department') || '',
      status: url.searchParams.get('status') || 'active',
      offset: (page - 1) * limit,
      limit,
    }),
    tickets.statistics(scope),
    tickets.serviceCounts(scope),
    unread(user.id),
    workerLastRun(),
  ]);
  return {
    tickets: pageData.tickets,
    total: pageData.total,
    page,
    limit,
    statistics,
    services,
    notifications,
    workerLastRun: lastRun,
  };
}

export async function ticketDetail(user: User, id: string) {
  const ticket = await tickets.detail(
    id,
    isManager(user.role) || user.role === 'reception' ? null : user.id,
  );
  if (!ticket) throw new HttpError(404, 'Ticket not found.', 'TICKET_NOT_FOUND');
  const [history, deliveries] = await Promise.all([
    events.forTicket(id),
    outbox.statesFor(id),
  ]);
  return { ticket, events: history, outbox: deliveries };
}

const day = /^\d{4}-\d{2}-\d{2}$/;
export async function reports(url: URL) {
  const from =
    url.searchParams.get('from') ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const to = url.searchParams.get('to') || from;
  if (
    !day.test(from) ||
    !day.test(to) ||
    isNaN(Date.parse(from)) ||
    isNaN(Date.parse(to)) ||
    to < from ||
    Date.parse(to) - Date.parse(from) > 366 * 86400000
  )
    throw new HttpError(400, 'Choose a valid date range of up to one year.', 'INVALID_INPUT');
  const service = url.searchParams.get('service') || '';
  const offset = (intParam(url, 'page', 1, 1, 100000) - 1) * 100;
  const csv = url.searchParams.get('format') === 'csv';
  // Count first so an oversized export is refused before any rows are fetched.
  const total = await reportData.count(from, to, service);
  if (csv && total > 10000)
    throw new HttpError(
      400,
      'Export exceeds 10,000 tickets. Narrow the date range.',
      'EXPORT_TOO_LARGE',
    );
  const { rows, summary, byService } = await reportData.page(
    from,
    to,
    service,
    csv ? 10000 : 100,
    csv ? 0 : offset,
  );
  if (csv) {
    // Identifiers leave the system only when the manager asks for them
    // explicitly (identifiers=true), and the export event records that.
    const identifiers = url.searchParams.get('identifiers') === 'true';
    const columns = [
      'number',
      'customer_name',
      'project_name',
      'unit_name',
      'booking_number',
      ...(identifiers ? ['mobile', 'emirates_id', 'passport_number'] : []),
      'department',
      'service_name',
      'status',
      'assigned_name',
      'created_at',
      'called_at',
      'started_at',
      'closed_at',
      'wait_minutes',
      'service_minutes',
      'comments',
    ];
    const output = [
      columns.map(csvCell).join(','),
      ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(',')),
    ].join('\r\n');
    return new Response('﻿' + output, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="samana-qms-${from}-${to}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  return { rows, summary, byService, total, from, to };
}

// Audit trail with a cursor (`before` = last id seen), an action filter and a
// Dubai-day date range, so any dispute can be traced however old it is.
export async function auditEvents(url: URL) {
  // format=csv exports the filtered trail (up to 10,000 rows) instead of a page.
  const csv = url.searchParams.get('format') === 'csv';
  const limit = csv ? 10000 : intParam(url, 'limit', 100, 1, 200);
  const before = url.searchParams.get('before') || '';
  const action = (url.searchParams.get('action') || '').slice(0, 40);
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  if ((from && !day.test(from)) || (to && !day.test(to)))
    throw new HttpError(400, 'Choose valid dates.', 'INVALID_INPUT');
  const list = await events.page({
    before: /^\d{1,18}$/.test(before) ? before : null,
    action,
    from,
    to,
    limit,
  });
  if (csv) {
    const columns = ['id', 'created_at', 'action', 'actor_name', 'number', 'details'] as const;
    const output = [
      columns.map(csvCell).join(','),
      ...list.map((row) =>
        columns
          .map((key) =>
            csvCell(key === 'details' ? JSON.stringify(row.details ?? {}) : row[key]),
          )
          .join(','),
      ),
    ].join('\r\n');
    return new Response('﻿' + output, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="samana-qms-audit-${from || 'all'}-${to || 'all'}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  return {
    events: list,
    nextBefore: list.length === limit ? list[list.length - 1].id : null,
  };
}
