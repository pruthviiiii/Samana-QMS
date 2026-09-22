import type { Role, User } from '../domain';
import { SERVICES, SERVING_ROLES } from '../domain';
import type { Prisma } from '../generated/prisma/client';
import { prisma } from '../prisma';
// Staff, guests and their sessions, read through the Prisma client so every
// column and relation is typed from prisma/schema.prisma. Writes that carry a
// rule (creating or editing a member, changing a password) still go through
// the database functions in ./functions.ts.
const ACTIVE = ['waiting', 'called', 'serving'];
export const userSelect = {
  id: true,
  username: true,
  name: true,
  email: true,
  role: true,
  sf_id: true,
  manager_sf_id: true,
  services: true,
  online: true,
  last_seen: true,
  counter: true,
  enabled: true,
  must_change_password: true,
} satisfies Prisma.usersSelect;
type UserRow = Prisma.usersGetPayload<{ select: typeof userSelect }>;
export const toUser = (row: UserRow): User => ({
  ...row,
  role: row.role as Role,
  last_seen: row.last_seen ? row.last_seen.toISOString() : null,
});

/** The account behind a session token that has not expired, if it is enabled. */
export async function findSessionUser(tokenHash: string): Promise<User | null> {
  const session = await prisma().sessions.findFirst({
    where: { token_hash: tokenHash, expires_at: { gt: new Date() }, users: { enabled: true } },
    select: { users: { select: userSelect } },
  });
  return session ? toUser(session.users) : null;
}

export async function userById(id: string): Promise<User | null> {
  const row = await prisma().users.findUnique({ where: { id }, select: userSelect });
  return row ? toUser(row) : null;
}

/**
 * Every enabled account whose username or email matches, case insensitively,
 * so the caller can tell an ambiguous identifier from a unique one without
 * choosing a user. Exact matches are a handful at most; the cap is a guard.
 * Username matches sort first.
 */
export async function loginCandidates(identifier: string) {
  const rows = await prisma().users.findMany({
    where: {
      enabled: true,
      OR: [
        { username: { equals: identifier, mode: 'insensitive' } },
        { email: { equals: identifier, mode: 'insensitive' } },
      ],
    },
    select: { ...userSelect, password_hash: true },
    take: 10,
  });
  return rows
    .map((row) => ({
      user: toUser(row),
      passwordHash: row.password_hash,
      usernameMatch: row.username.toLowerCase() === identifier,
    }))
    .sort((a, b) => Number(b.usernameMatch) - Number(a.usernameMatch));
}

export async function passwordHashOf(id: string) {
  const row = await prisma().users.findUnique({ where: { id }, select: { password_hash: true } });
  return row?.password_hash ?? null;
}

/** Replaces the hash only if it is still the one that was verified. */
export async function rehashPassword(id: string, expectedHash: string, nextHash: string) {
  await prisma().users.updateMany({
    where: { id, password_hash: expectedHash },
    data: { password_hash: nextHash },
  });
}

/**
 * The staff directory with each person's count of active tickets. The count
 * is a separate grouped query: the partial unique index that stops an agent
 * holding two live customers makes Prisma see the assignment as one-to-one,
 * which is right for live tickets and wrong for history.
 */
export async function directory() {
  const [people, active] = await Promise.all([
    prisma().users.findMany({
      where: { role: { not: 'customer' } },
      select: userSelect,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    }),
    prisma().tickets.groupBy({
      by: ['assigned_to'],
      where: { status: { in: ACTIVE }, assigned_to: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const counts = new Map(active.map((row) => [row.assigned_to, row._count._all]));
  return people.map((row) => ({ ...toUser(row), active_tickets: counts.get(row.id) ?? 0 }));
}

/** Queue membership per service, and everyone who could be a member. */
export async function queueMembership() {
  const staff = await prisma().users.findMany({
    where: { role: { in: [...SERVING_ROLES] } },
    select: {
      id: true,
      name: true,
      role: true,
      online: true,
      last_seen: true,
      enabled: true,
      counter: true,
      services: true,
    },
    orderBy: { name: 'asc' },
  });
  const ordered = [...SERVICES].sort(
    (a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name),
  );
  const members = ordered.flatMap((service) =>
    staff
      .filter((person) => person.services.includes(service.id))
      .map(({ services: _services, last_seen, ...person }) => ({
        ...person,
        last_seen: last_seen ? last_seen.toISOString() : null,
        service_id: service.id,
      })),
  );
  const eligible = staff.map(({ id, name, role, enabled }) => ({ id, name, role, enabled }));
  // Priority lives in the database because an administrator changes it; the
  // rest of a service's description is fixed in lib/domain.ts.
  const priorities = await prisma().services.findMany({
    select: { id: true, priority: true },
  });
  const priority = Object.fromEntries(priorities.map((s) => [s.id, s.priority]));
  return { members, eligible, priority };
}

/** A guest account and its session, created together for a QR visit. */
export async function createGuest(id: string, tokenHash: string, minutes: number) {
  await prisma().$transaction([
    prisma().users.create({
      data: {
        id,
        username: 'visit-' + id,
        name: 'Customer visit',
        role: 'customer',
        enabled: true,
        must_change_password: false,
      },
    }),
    prisma().sessions.create({
      data: { token_hash: tokenHash, user_id: id, expires_at: new Date(Date.now() + minutes * 60000) },
    }),
  ]);
}

export async function revokeSession(tokenHash: string) {
  await prisma().sessions.deleteMany({ where: { token_hash: tokenHash } });
}
