import { query } from '../db';
import { prisma } from '../prisma';
import {
  boardRow,
  countRow,
  one,
  publicStatusRow,
  queueStatisticsRow,
  rows,
  serviceCountRow,
  ticketRow,
} from './rows';
// Reads of tickets. Anything that joins the ticket with its service and agent
// goes through qms.ticket_view, which the Prisma schema does not model (views
// are outside its language), so those reads are raw SQL parsed against
// ./rows.ts. Plain counts and record lookups use the Prisma client.

/** One ticket with its service and agent, optionally only if this person may see it. */
export async function detail(id: string, restrictTo: string | null) {
  const result = await query(
    'SELECT * FROM qms.ticket_view WHERE id=$1 AND ($2::uuid IS NULL OR assigned_to=$2 OR created_by=$2)',
    [id, restrictTo],
  );
  return result.length ? one(ticketRow, result, 'ticket detail') : null;
}

export interface QueueFilter {
  assignedTo: string | null;
  search: string;
  department: string;
  status: string; // 'active' | 'all' | a status
  offset: number;
  limit: number;
}
const queueWhere = `($1::uuid IS NULL OR assigned_to=$1) AND ($2='' OR number ILIKE '%'||$2||'%' OR customer_name ILIKE '%'||$2||'%' OR unit_name ILIKE '%'||$2||'%') AND ($3='' OR department=$3) AND (($4='active' AND status IN ('waiting','called','serving')) OR $4='all' OR status=$4)`;
export const ticketColumns =
  'id,number,service_id,department,service_name,status,customer_name,customer_id,unit_id,unit_name,project_name,booking_number,assigned_to,assigned_name,counter,created_at,assigned_at,called_at,started_at,closed_at,routing_reason,comments,version,identifier_type';

/** A page of the live queue in service order: serving, called, waiting, then closed. */
export async function queuePage(filter: QueueFilter) {
  const params = [filter.assignedTo, filter.search, filter.department, filter.status];
  const [list, count] = await Promise.all([
    query(
      `SELECT ${ticketColumns} FROM qms.ticket_view WHERE ${queueWhere} ORDER BY CASE status WHEN 'serving' THEN 0 WHEN 'called' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,created_at LIMIT $5 OFFSET $6`,
      [...params, filter.limit, filter.offset],
    ),
    query(`SELECT count(*)::integer total FROM qms.ticket_view WHERE ${queueWhere}`, params),
  ]);
  return { tickets: rows(ticketRow, list, 'queue page'), total: one(countRow, count, 'queue count').total };
}

/**
 * Headline numbers, for everyone or for one agent's own tickets.
 *
 * Every row this needs is either still active or from today, so it says so:
 * without that the aggregate scanned the entire visit history on every refresh
 * of every staff screen. The two halves are read through two indexes
 * (migration 018) and combined, which is why the predicate is an OR rather
 * than a date window -- a ticket left serving across midnight is still active
 * and must keep counting.
 */
export async function statistics(assignedTo: string | null) {
  const result = await query(
    `SELECT count(*) FILTER(WHERE status='waiting')::int waiting,count(*) FILTER(WHERE status IN ('called','serving'))::int serving,count(*) FILTER(WHERE status='closed' AND day=(now() AT TIME ZONE 'Asia/Dubai')::date)::int completed,coalesce(round(avg(extract(epoch from coalesce(called_at,closed_at,now())-created_at)/60) FILTER(WHERE day=(now() AT TIME ZONE 'Asia/Dubai')::date AND status<>'no_show')::numeric,1),0)::float avg_wait,count(*) FILTER(WHERE status='waiting' AND assigned_to IS NULL)::int unassigned FROM qms.tickets WHERE ($1::uuid IS NULL OR assigned_to=$1) AND (status IN ('waiting','called','serving') OR day=(now() AT TIME ZONE 'Asia/Dubai')::date)`,
    [assignedTo],
  );
  return one(queueStatisticsRow, result, 'queue statistics');
}

/**
 * Every service with its waiting and serving counts. The join is restricted to
 * the active statuses the counts already filter on, which changes no result and
 * lets the partial index (migration 018) answer it instead of reading every
 * ticket ever issued.
 */
export async function serviceCounts(assignedTo: string | null) {
  const result = await query(
    `SELECT s.*,count(t.id) FILTER(WHERE t.status='waiting')::int waiting,count(t.id) FILTER(WHERE t.status IN ('called','serving'))::int serving FROM qms.services s LEFT JOIN qms.tickets t ON t.service_id=s.id AND t.status IN ('waiting','called','serving') AND ($1::uuid IS NULL OR t.assigned_to=$1) GROUP BY s.id ORDER BY s.department,s.name`,
    [assignedTo],
  );
  return rows(serviceCountRow, result, 'service counts');
}

/** How many rows the reception television has room for without scrolling. */
export const BOARD_ROWS = 9;

/**
 * The reception television: the live queue, not only the tickets already at a
 * counter. Whoever was called most recently comes first so the screen can
 * announce them, then anyone else being served, then the people still waiting
 * in the order they will be called. `waiting` is the total still waiting, which
 * the screen turns into an overflow line once the board is full.
 */
export async function board(limit = BOARD_ROWS) {
  const [list, waiting] = await Promise.all([
    query(
      `SELECT number,service_name,department,status,counter,called_at,created_at
         FROM qms.ticket_view
        WHERE status IN ('called','serving','waiting')
        ORDER BY CASE WHEN status IN ('called','serving') THEN 0 ELSE 1 END,
                 CASE WHEN status IN ('called','serving') THEN called_at END DESC NULLS LAST,
                 created_at
        LIMIT $1`,
      [limit],
    ),
    prisma().tickets.count({ where: { status: 'waiting' } }),
  ]);
  return { tickets: rows(boardRow, list, 'display board'), waiting };
}

/**
 * What the private status link shows: the customer's own ticket and how many
 * people are in front of it. Nothing about anybody else. The waiting room's
 * television is the board, and a phone that listed other customers' numbers
 * would add nothing to what is already on the wall while handing one visitor a
 * record of who else was there.
 *
 * `waiting_ahead` counts only the people genuinely ahead: same service, still
 * waiting, and checked in earlier.
 */
export async function publicStatus(token: string) {
  const result = await query(
    "SELECT number,service_name,status,counter,(SELECT count(*)::int FROM qms.tickets ahead WHERE ahead.service_id=v.service_id AND ahead.status='waiting' AND ahead.created_at<v.created_at) waiting_ahead FROM qms.ticket_view v WHERE public_token=$1 AND (closed_at IS NULL OR closed_at>now()-interval '1 day')",
    [token],
  );
  return result.length ? one(publicStatusRow, result, 'public status') : null;
}
