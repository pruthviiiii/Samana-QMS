import { query } from '../lib/db';
import { processJobs } from '../lib/jobs';
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
console.log('Samana QMS background scheduler started.');
while (!stopping) {
  const started = Date.now();
  try {
    await query('SELECT qms.route_due()');
    const result = await processJobs();
    console.log(
      JSON.stringify({
        event: 'scheduler_tick',
        at: new Date().toISOString(),
        jobs: result.processed,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'scheduler_failed',
        type: error instanceof Error ? error.name : 'Error',
      }),
    );
  }
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(1000, 15000 - (Date.now() - started))),
  );
}
