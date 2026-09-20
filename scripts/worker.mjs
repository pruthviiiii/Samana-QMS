import { schedulerConfig, schedulerTick } from './scheduler.mjs';
const config = schedulerConfig();
let stop = false;
process.on('SIGINT', () => {
  stop = true;
});
process.on('SIGTERM', () => {
  stop = true;
});
console.log('Samana QMS scheduler started.');
while (!stop) {
  const start = Date.now();
  try {
    const result = await schedulerTick(config);
    console.log(
      JSON.stringify({
        event: 'scheduler_tick',
        at: new Date().toISOString(),
        ...result,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'scheduler_unreachable', type: error.name }),
    );
  }
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(1000, 15000 - (Date.now() - start))),
  );
}
