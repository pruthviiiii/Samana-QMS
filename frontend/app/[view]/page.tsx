import { notFound } from 'next/navigation';
import QmsApp from '@/components/qms/app';
// Only known workspace views render; any other address is a real 404.
const views = new Set([
  'overview',
  'queue',
  'agent',
  'team',
  'queues',
  'reports',
  'settings',
  'checkin',
  'audit',
  'display',
]);
export default async function Page({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  const { view } = await params;
  if (!views.has(view)) notFound();
  return <QmsApp initialView={view} />;
}
