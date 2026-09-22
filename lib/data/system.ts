import { SCHEDULER_STALE_MS } from '../domain';
import { prisma } from '../prisma';
// Small shared state: when the scheduler last ran.

/** When the routing tick last completed, or null if it never has. */
export async function workerLastRun(): Promise<string | null> {
  const row = await prisma().system_state.findUnique({
    where: { key: 'worker' },
    select: { updated_at: true },
  });
  return row ? row.updated_at.toISOString() : null;
}

/** True while the last tick is recent enough to trust. */
export function schedulerHealthy(lastRun: string | null, windowMs = SCHEDULER_STALE_MS) {
  return !!lastRun && Date.now() - new Date(lastRun).getTime() < windowMs;
}
