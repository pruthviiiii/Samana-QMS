// Runs once when the web tier starts, before it accepts traffic.
//
// The web tier serves the screens and forwards /api to the API service. It
// holds no database or integration credential; the only things it must know
// are its own origin and where the API is, and it refuses to start without
// them, so a deployment with the API address missing fails here rather than
// answering every request with an error.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertWebConfig } = await import('./lib/config');
  assertWebConfig();
}
