import type { Route } from '../router';
import { authRoutes } from './auth';
import { publicRoutes } from './public';
import { ticketRoutes } from './tickets';
import { queueRoutes } from './queue';
import { teamRoutes } from './team';
import { reportRoutes } from './reports';
import { eventRoutes } from './events';
// The whole API, one declaration per route. tests/routes.test.ts checks that
// every entry names its method, path and who may call it, with no duplicates.
export const routes: Route[] = [
  ...publicRoutes,
  ...authRoutes,
  ...ticketRoutes,
  ...queueRoutes,
  ...teamRoutes,
  ...reportRoutes,
  ...eventRoutes,
];
