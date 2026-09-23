import type { Customer, IdentifierType } from '@qms/shared';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../prisma';
// Customer lookups: the snapshot of what Salesforce (or the walk-in path) said
// about a customer, held for fifteen minutes so the ticket is issued from a
// consistent view. The routing tick purges expired lookups that issued nothing.

/**
 * A registered lookup of the same identifier within the last two minutes, so
 * a retry or a second screen does not ask Salesforce twice.
 */
export async function recentRegistered(type: IdentifierType, value: string) {
  const row = await prisma().lookups.findFirst({
    where: {
      identifier_type: type,
      identifier_value: value,
      created_at: { gt: new Date(Date.now() - 2 * 60000) },
      customer: { path: ['registered'], equals: true },
    },
    select: { customer: true },
    orderBy: { created_at: 'desc' },
  });
  return row ? (row.customer as unknown as Customer) : null;
}

export async function create(
  actorId: string,
  type: IdentifierType,
  value: string,
  customer: Customer,
) {
  const row = await prisma().lookups.create({
    data: {
      actor_id: actorId,
      identifier_type: type,
      identifier_value: value,
      customer: customer as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, expires_at: true },
  });
  return { id: row.id, expiresAt: row.expires_at.toISOString() };
}
