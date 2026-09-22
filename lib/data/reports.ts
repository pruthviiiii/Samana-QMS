import { query } from '../db';
import { countRow, one, reportRow, reportServiceRow, reportSummaryRow, rows } from './rows';
// Reports over a date range: aggregates that PostgreSQL computes far better
// than application code, read raw and parsed against ./rows.ts.
const where = "day BETWEEN $1::date AND $2::date AND ($3='' OR service_id=$3)";

export async function count(from: string, to: string, service: string) {
  const result = await query(`SELECT count(*)::int total FROM qms.ticket_view WHERE ${where}`, [
    from,
    to,
    service,
  ]);
  return one(countRow, result, 'report count').total;
}

export async function page(from: string, to: string, service: string, limit: number, offset: number) {
  const params = [from, to, service];
  const [list, summary, byService] = await Promise.all([
    query(
      `SELECT *,CASE WHEN started_at IS NOT NULL AND closed_at IS NOT NULL THEN round(extract(epoch FROM closed_at-started_at)::numeric/60,2) ELSE NULL END service_minutes,round(extract(epoch FROM coalesce(called_at,closed_at,now())-created_at)::numeric/60,2) wait_minutes FROM qms.ticket_view WHERE ${where} ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
      [...params, limit, offset],
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
  return {
    rows: rows(reportRow, list, 'report rows'),
    summary: one(reportSummaryRow, summary, 'report summary'),
    byService: rows(reportServiceRow, byService, 'report by service'),
  };
}
