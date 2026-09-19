const origin =
  process.env.WORKER_ORIGIN ||
  process.env.APP_ORIGIN ||
  'http://localhost:3000';
if (!process.env.WORKER_SECRET) throw new Error('WORKER_SECRET is required.');
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
    const response = await fetch(origin + '/api/jobs/run', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WORKER_SECRET },
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok)
      console.error(
        JSON.stringify({ event: 'scheduler_failed', status: response.status }),
      );
    else
      console.log(
        JSON.stringify({
          event: 'scheduler_tick',
          at: new Date().toISOString(),
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
