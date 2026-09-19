import MobileVisit from '@/components/qms/mobile-visit';
export default async function VisitPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <MobileVisit statusToken={token} />;
}
