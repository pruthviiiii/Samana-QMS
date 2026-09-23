import { routes } from '../api';
import { config } from '../config';
import { endpoint, HttpError } from '../http';
import { dispatch } from '../router';
import { sha256 } from '../security';
// The whole API as one function from request to response: logging and error
// mapping (endpoint), then the declared route table (dispatch), which enforces
// each route's access rule before its handler runs. The Node host in
// server/api.ts serves this function; the API tests call it directly.
//
// When API_PROXY_TOKEN is set, every request must carry it in x-internal-token.
// The web tier adds the header to everything it forwards, so a client that
// reaches the API's address directly is refused before any route runs. The
// load balancer's readiness probe is the one exception, and it reveals nothing.
const READINESS = '/api/health';
async function requireProxyToken(request: Request) {
  const expected = config().API_PROXY_TOKEN;
  if (!expected) return;
  if (new URL(request.url).pathname === READINESS) return;
  const given = request.headers.get('x-internal-token') ?? '';
  if ((await sha256(given)) !== (await sha256(expected)))
    throw new HttpError(
      401,
      'This address serves the web tier only.',
      'NOT_VIA_WEB_TIER',
    );
}
export const handle = (request: Request): Promise<Response> =>
  endpoint(request, async () => {
    await requireProxyToken(request);
    return dispatch(routes, request);
  });
