import { assertConfig } from '../lib/config';
import { routeDue } from '../lib/data/functions';
import { closeDb } from '../lib/db';
import { processJobs } from '../lib/jobs';
import { closePrisma } from '../lib/prisma';
import { applyRetention } from '../lib/retention';
// Two independent cadences, because they have different deadlines.
//
// Routing is time critical: it expires a screen that stopped answering and
// moves a customer who has waited five minutes. Delivery to Salesforce and the
// SMS gateway is not: it may take as long as the other end takes. Running them
// in one loop let a slow integration delay routing by however long delivery
// ran, so they are separate timers and a slow tick never overlaps itself.
const ROUTING_INTERVAL = 15000;
const DELIVERY_INTERVAL = 15000;
const settings = assertConfig();
if (!settings.DATABASE_URL) throw new Error('DATABASE_URL is required.');
let stopping = false;
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
const fail = (event: string, error: unknown) =>
  console.error(
    JSON.stringify({
      event,
      at: new Date().toISOString(),
      type: error instanceof Error ? error.name : 'Error',
    }),
  );
/** Runs `work` on a fixed cadence, never overlapping, until shutdown. */
function every(interval: number, name: string, work: () => Promise<void>) {
  const run = async () => {
    while (!stopping) {
      const started = Date.now();
      try {
        await work();
      } catch (error) {
        fail(name + '_failed', error);
      }
      const wait = Math.max(1000, interval - (Date.now() - started));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };
  return run();
}
log('scheduler_started', {
  routingIntervalMs: ROUTING_INTERVAL,
  deliveryIntervalMs: DELIVERY_INTERVAL,
});
const routing = every(ROUTING_INTERVAL, 'scheduler', async () => {
  log('scheduler_tick', { checked: await routeDue() });
});
const delivery = every(DELIVERY_INTERVAL, 'delivery', async () => {
  const result = await processJobs();
  const retention = await applyRetention();
  if (result.processed || (retention && !retention.skipped))
    log('delivery_tick', {
      jobs: result.processed,
      sent: result.sent,
      ...(retention && !retention.skipped ? { retention } : {}),
    });
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log('scheduler_stopping', { signal });
  });
await Promise.all([routing, delivery]);
await closePrisma();
await closeDb();
log('scheduler_stopped');
