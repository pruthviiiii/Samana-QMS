import { prisma } from '../prisma';
// Assignment notices for an agent: one row when a ticket is handed to them,
// shown until read and only while the ticket is still theirs and still open.
const ACTIVE = ['waiting', 'called', 'serving'];

/** Unread notices whose ticket is still assigned to this person and still open. */
export async function unread(userId: string) {
  const list = await prisma().notifications.findMany({
    where: {
      user_id: userId,
      read_at: null,
      tickets: { assigned_to: userId, status: { in: ACTIVE } },
    },
    select: {
      id: true,
      ticket_id: true,
      tickets: { select: { number: true, customer_name: true, project_name: true, unit_name: true } },
    },
    orderBy: { id: 'desc' },
    take: 20,
  });
  // Ids are bigints; they travel as strings and the screen compares them as numbers.
  return list.map(({ id, ticket_id, tickets }) => ({ id: String(id), ticket_id, ...tickets }));
}

export async function markRead(userId: string, ids: number[]) {
  await prisma().notifications.updateMany({
    where: { user_id: userId, id: { in: ids.map((id) => BigInt(id)) } },
    data: { read_at: new Date() },
  });
}
