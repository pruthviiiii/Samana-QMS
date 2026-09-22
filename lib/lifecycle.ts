import { assertConfig } from './config';
import { closeDb } from './db';
import { closeListener } from './events';
// Server lifecycle for the Node runtime: validate settings before the first
// request, and drain connections when the host asks the process to stop.
let closing = false;
export function startServer() {
  assertConfig();
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      console.log(JSON.stringify({ event: 'shutdown', signal }));
      void Promise.allSettled([closeListener(), closeDb()]);
    });
}
