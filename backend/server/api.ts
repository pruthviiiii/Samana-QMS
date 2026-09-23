import { serve } from '@hono/node-server';
import { assertApiConfig } from '../config';
import { closeDb } from '../db';
import { closeListener } from '../events';
import { installShutdown } from '../lifecycle';
import { closePrisma } from '../prisma';
import { handle } from './handler';
// The API service. A plain Node HTTP server that hosts the route table; the
// web tier forwards /api to it, and nothing else reaches it. It validates its
// configuration before it listens, so a bad deployment stops here, and it
// drains its connections when the host asks it to stop.
const settings = assertApiConfig();
const port = settings.API_PORT ?? settings.PORT ?? 3001;
const server = serve(
  {
    fetch: (request) => handle(request),
    port,
    hostname: '0.0.0.0',
  },
  (info) =>
    console.log(
      JSON.stringify({
        event: 'api_listening',
        at: new Date().toISOString(),
        address: info.address,
        port: info.port,
      }),
    ),
);
installShutdown([
  () => new Promise<void>((resolve) => server.close(() => resolve())),
  closeListener,
  closePrisma,
  closeDb,
]);
