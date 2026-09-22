import { routes } from '../lib/api';
import { endpoint } from '../lib/http';
import { dispatch } from '../lib/router';
// The whole API as one function from request to response: logging and error
// mapping (endpoint), then the declared route table (dispatch), which enforces
// each route's access rule before its handler runs. The Node host in
// server/api.ts serves this function; the API tests call it directly.
export const handle = (request: Request): Promise<Response> =>
  endpoint(request, () => dispatch(routes, request));
