// Graceful shutdown for the API service and the scheduler. On SIGTERM or
// SIGINT the given steps run in order (stop accepting, then close the change
// listener, the data client and the pool), and the process exits when they are
// done or after a bounded wait, so a deploy drains instead of cutting
// connections and never hangs on a step that will not finish.
let closing = false;
export function installShutdown(
  steps: Array<() => Promise<unknown>>,
  timeoutMs = 10000,
) {
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(JSON.stringify({ event: 'shutdown', signal }));
    const deadline = setTimeout(() => {
      console.error(JSON.stringify({ event: 'shutdown_timeout', timeoutMs }));
      process.exit(1);
    }, timeoutMs);
    for (const step of steps)
      await step().catch((error: unknown) =>
        console.error(
          JSON.stringify({
            event: 'shutdown_step_failed',
            type: error instanceof Error ? error.name : 'Error',
          }),
        ),
      );
    clearTimeout(deadline);
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => void shutdown(signal));
}
