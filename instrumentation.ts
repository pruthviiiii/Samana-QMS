// Runs once when the server starts, before it accepts traffic.
//
// Two jobs: prove the configuration is complete, so a bad deployment fails at
// boot with a message naming the variable instead of at the counter; and close
// the database pool and the change listener on shutdown, so a deploy drains
// instead of cutting connections. Both live in a Node-only module so this file
// stays valid for every runtime Next.js compiles it for.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startServer } = await import('./lib/lifecycle');
  startServer();
}
