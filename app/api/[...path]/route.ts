import { endpoint } from '@/lib/http';
import { dispatch } from '@/lib/router';
import { routes } from '@/lib/api';
// Thin entry point: logging and error mapping (endpoint), then the declared
// route table (dispatch). Authentication and roles live on each route.
const handler = (request: Request) =>
  endpoint(request, () => dispatch(routes, request));
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
