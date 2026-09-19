import QmsApp from '@/components/qms/app';
export default async function Page({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  const { view } = await params;
  return <QmsApp initialView={view} />;
}
