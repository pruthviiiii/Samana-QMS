import { query } from './db';
import { HttpError } from './http';
import { csvCell, type User, type Ticket, isManager } from './domain';
export const ticketColumns =
  'id,number,service_id,department,service_name,status,customer_name,customer_id,unit_id,unit_name,project_name,booking_number,assigned_to,assigned_name,counter,created_at,assigned_at,called_at,started_at,closed_at,routing_reason,comments,version,identifier_type';
export async function queue(user: User, url: URL) {
  const page = Math.max(
    1,
    Math.min(10000, Number(url.searchParams.get('page')) || 1),
  );
  const limit = 20;
  const search = (url.searchParams.get('search') || '').slice(0, 100);
  const department = url.searchParams.get('department') || '';
  const status = url.searchParams.get('status') || 'active';
  const params: unknown[] = [
    user.role === 'agent' || url.searchParams.get('mine') === 'true'
      ? user.id
      : null,
    search,
    department,
    status,
  ];
  const where = `($1::uuid IS NULL OR assigned_to=$1) AND ($2='' OR number ILIKE '%'||$2||'%' OR customer_name ILIKE '%'||$2||'%' OR unit_name ILIKE '%'||$2||'%') AND ($3='' OR department=$3) AND (($4='active' AND status IN ('waiting','called','serving')) OR $4='all' OR status=$4)`;
  const [tickets, counts, statistics, services, notifications, worker] =
    await Promise.all([
      query<Ticket>(
        `SELECT ${ticketColumns} FROM qms.ticket_view WHERE ${where} ORDER BY CASE status WHEN 'serving' THEN 0 WHEN 'called' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,created_at LIMIT 20 OFFSET $5`,
        [...params, (page - 1) * limit],
      ),
      query<{ total: number }>(
        `SELECT count(*)::integer total FROM qms.ticket_view WHERE ${where}`,
        params,
      ),
      query(
        `SELECT count(*) FILTER(WHERE status='waiting')::int waiting,count(*) FILTER(WHERE status IN ('called','serving'))::int serving,count(*) FILTER(WHERE status='closed' AND day=(now() AT TIME ZONE 'Asia/Dubai')::date)::int completed,coalesce(round(avg(extract(epoch from coalesce(called_at,closed_at,now())-created_at)/60) FILTER(WHERE day=(now() AT TIME ZONE 'Asia/Dubai')::date AND status<>'no_show')::numeric,1),0)::float avg_wait,count(*) FILTER(WHERE status='waiting' AND assigned_to IS NULL)::int unassigned FROM qms.tickets WHERE ($1::uuid IS NULL OR assigned_to=$1)`,
        [
          user.role === 'agent' || url.searchParams.get('mine') === 'true'
            ? user.id
            : null,
        ],
      ),
      query(
        `SELECT s.*,count(t.id) FILTER(WHERE t.status='waiting')::int waiting,count(t.id) FILTER(WHERE t.status IN ('called','serving'))::int serving FROM qms.services s LEFT JOIN qms.tickets t ON t.service_id=s.id AND ($1::uuid IS NULL OR t.assigned_to=$1) GROUP BY s.id ORDER BY s.department,s.name`,
        [
          user.role === 'agent' || url.searchParams.get('mine') === 'true'
            ? user.id
            : null,
        ],
      ),
      query(
        `SELECT n.id,n.ticket_id,t.number,t.customer_name,t.project_name,t.unit_name FROM qms.notifications n JOIN qms.tickets t ON t.id=n.ticket_id WHERE n.user_id=$1 AND n.read_at IS NULL AND t.assigned_to=n.user_id AND t.status IN ('waiting','called','serving') ORDER BY n.id DESC LIMIT 20`,
        [user.id],
      ),
      query(`SELECT updated_at FROM qms.system_state WHERE key='worker'`),
    ]);
  return {
    tickets,
    total: counts[0].total,
    page,
    limit,
    statistics: statistics[0],
    services,
    notifications,
    workerLastRun: worker[0]?.updated_at || null,
  };
}
export async function ticketDetail(user: User, id: string) {
  const [ticket] = await query<Ticket>(
    `SELECT * FROM qms.ticket_view WHERE id=$1 AND ($2::uuid IS NULL OR assigned_to=$2 OR created_by=$2)`,
    [id, isManager(user.role) || user.role === 'reception' ? null : user.id],
  );
  if (!ticket) throw new HttpError(404, 'Ticket not found.');
  const [events, outbox] = await Promise.all([
    query(
      `SELECT e.id,e.action,e.details,e.created_at,u.name actor_name FROM qms.events e LEFT JOIN qms.users u ON u.id=e.actor_id WHERE ticket_id=$1 ORDER BY e.id`,
      [id],
    ),
    query(
      `SELECT kind,status,attempts,last_error FROM qms.outbox WHERE ticket_id=$1`,
      [id],
    ),
  ]);
  return { ticket, events, outbox };
}
export async function reports(url: URL) {
  const from =
    url.searchParams.get('from') ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const to = url.searchParams.get('to') || from;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    isNaN(Date.parse(from)) ||
    isNaN(Date.parse(to)) ||
    to < from ||
    Date.parse(to) - Date.parse(from) > 366 * 86400000
  )
    throw new HttpError(400, 'Choose a valid date range of up to one year.');
  const service = url.searchParams.get('service') || '';
  const offset =
    Math.max(0, (Number(url.searchParams.get('page')) || 1) - 1) * 100;
  const csv = url.searchParams.get('format') === 'csv';
  const where =
    "day BETWEEN $1::date AND $2::date AND ($3='' OR service_id=$3)";
  const params = [from, to, service];
  // Count first so an oversized export is refused before any rows are fetched.
  const total = await query<{ total: number }>(
    `SELECT count(*)::int total FROM qms.ticket_view WHERE ${where}`,
    params,
  );
  if (csv && total[0].total > 10000)
    throw new HttpError(
      400,
      'Export exceeds 10,000 tickets. Narrow the date range.',
    );
  const [rows, summary, byService] = await Promise.all([
    query(
      `SELECT *,CASE WHEN started_at IS NOT NULL AND closed_at IS NOT NULL THEN round(extract(epoch FROM closed_at-started_at)::numeric/60,2) ELSE NULL END service_minutes,round(extract(epoch FROM coalesce(called_at,closed_at,now())-created_at)::numeric/60,2) wait_minutes FROM qms.ticket_view WHERE ${where} ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [...params, csv ? 10000 : 100, csv ? 0 : offset],
    ),
    query(
      `SELECT count(*)::int tickets,count(*) FILTER(WHERE status='closed')::int completed,count(*) FILTER(WHERE status='no_show')::int no_show,coalesce(round(avg(extract(epoch FROM closed_at-started_at)/60) FILTER(WHERE status='closed' AND started_at IS NOT NULL)::numeric,2),0)::float average_service_minutes,coalesce(round(avg(extract(epoch FROM called_at-created_at)/60) FILTER(WHERE called_at IS NOT NULL)::numeric,2),0)::float average_wait_minutes FROM qms.ticket_view WHERE ${where}`,
      params,
    ),
    query(
      `SELECT service_id,service_name,department,count(*)::int tickets,count(*) FILTER(WHERE status='closed')::int completed,coalesce(round(avg(extract(epoch FROM closed_at-started_at)/60) FILTER(WHERE status='closed' AND started_at IS NOT NULL)::numeric,2),0)::float average_service_minutes FROM qms.ticket_view WHERE ${where} GROUP BY service_id,service_name,department ORDER BY tickets DESC`,
      params,
    ),
  ]);
  if (csv) {
    const columns = [
      'number',
      'customer_name',
      'project_name',
      'unit_name',
      'booking_number',
      'mobile',
      'emirates_id',
      'passport_number',
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
    return new Response('\uFEFF' + output, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="samana-qms-${from}-${to}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  return {
    rows,
    summary: summary[0],
    byService,
    total: total[0].total,
    from,
    to,
  };
}
const day = /^\d{4}-\d{2}-\d{2}$/;
// Audit trail with a cursor (`before` = last id seen), an action filter and a
// Dubai-day date range, so any dispute can be traced however old it is.
export async function auditEvents(url: URL) {
  const limit = Math.min(
    200,
    Math.max(1, Number(url.searchParams.get('limit')) || 100),
  );
  const before = url.searchParams.get('before') || '';
  const action = (url.searchParams.get('action') || '').slice(0, 40);
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  if ((from && !day.test(from)) || (to && !day.test(to)))
    throw new HttpError(400, 'Choose valid dates.');
  const events = await query<{ id: string }>(
    `SELECT e.id,e.action,e.details,e.created_at,t.number,u.name actor_name FROM qms.events e LEFT JOIN qms.users u ON u.id=e.actor_id LEFT JOIN qms.tickets t ON t.id=e.ticket_id WHERE ($1::bigint IS NULL OR e.id<$1) AND ($2='' OR e.action=$2) AND ($3::date IS NULL OR e.created_at>=($3::date::timestamp AT TIME ZONE 'Asia/Dubai')) AND ($4::date IS NULL OR e.created_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Dubai')) ORDER BY e.id DESC LIMIT $5`,
    [
      /^\d{1,18}$/.test(before) ? before : null,
      action,
      from || null,
      to || null,
      limit,
    ],
  );
  return {
    events,
    nextBefore: events.length === limit ? events[events.length - 1].id : null,
  };
}
