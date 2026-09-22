import { z } from 'zod';
// The single place the process environment is read. Every value is validated
// once, on first use, and the result is frozen: a missing or malformed setting
// fails immediately with a message naming the variable, instead of surfacing
// later as a 503 in front of a customer.
//
// Two shapes, because there are two kinds of process:
//   config()     the API service and the scheduler: database, Salesforce,
//                SMS, secrets, retention. Asserted at their start.
//   webConfig()  the web tier, which serves screens and forwards /api to the
//                API service. It holds no database or integration credential
//                at all; that absence is the security boundary.
//
// Adding a setting: extend the schema below, document it in .env.example and
// docs/render.md, and read it through config() or webConfig(). Nothing else
// should touch process.env; tests/boundary.test.ts enforces that.

const https = z
  .url()
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'must be an https:// URL',
  });

const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

const positiveDays = z
  .string()
  .regex(/^\d{1,5}$/, 'must be a whole number of days')
  .transform(Number)
  .refine((value) => value > 0, 'must be greater than zero')
  .optional();

const port = z
  .string()
  .regex(/^\d{2,5}$/, 'must be a port number')
  .transform(Number)
  .refine((value) => value > 0 && value < 65536, 'must be a port number')
  .optional();

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

/** Settings for the API service and the scheduler. */
const serverSchema = z
  .object({
    NODE_ENV: nodeEnv,
    // The API listens on API_PORT, or PORT when the host assigns one (Render).
    API_PORT: port,
    PORT: port,
    // Connections. DATABASE_URL is the restricted runtime role; migrations and
    // the role script use MIGRATE_DATABASE_URL when it is set.
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    // Public origin. Used for the origin check on every state change, for QR
    // links and for SMS links, so it must be the address customers reach.
    APP_ORIGIN: z.url({ error: 'APP_ORIGIN must be an absolute URL' }),
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'], {
        message: 'SESSION_COOKIE_SECURE must be exactly "true" or "false"',
      })
      .optional()
      .transform((value) => value !== 'false'),
    // Secrets.
    QR_SIGNING_SECRET: z
      .string()
      .min(16, 'QR_SIGNING_SECRET must be at least 16 characters')
      .optional(),
    WORKER_SECRET: z
      .string()
      .min(16, 'WORKER_SECRET must be at least 16 characters')
      .optional(),
    BOOTSTRAP_PASSWORD: z.string().optional(),
    // Salesforce.
    SALESFORCE_INSTANCE_URL: https
      .refine((value) => new URL(value).hostname.endsWith('.salesforce.com'), {
        message: 'must be a salesforce.com host',
      })
      .optional(),
    SALESFORCE_CLIENT_ID: z.string().optional(),
    SALESFORCE_CLIENT_SECRET: z.string().optional(),
    SALESFORCE_API_VERSION: z.string().optional(),
    SALESFORCE_WRITE_ENABLED: flag,
    // SMS.
    SMS_ENABLED: flag,
    SMS_GATEWAY_URL: https.optional(),
    SMS_GATEWAY_TOKEN: z.string().optional(),
    SMS_SENDER: z.string().max(11).optional(),
    // The header that carries the client address, set only by a proxy the API
    // trusts. The web tier sets x-client-address from the address its own edge
    // appended; a host that fronts the API directly names its header here.
    TRUSTED_CLIENT_IP_HEADER: z
      .enum([
        'x-client-address',
        'cf-connecting-ip',
        'true-client-ip',
        'x-real-ip',
        'x-forwarded-for',
      ])
      .optional(),
    // Retention, off unless a period is set.
    RETENTION_IDENTIFIER_DAYS: positiveDays,
    RETENTION_EVENT_DAYS: positiveDays,
  })
  .superRefine((value, ctx) => {
    if (value.SMS_ENABLED && !(value.SMS_GATEWAY_URL && value.SMS_GATEWAY_TOKEN))
      ctx.addIssue({
        code: 'custom',
        message:
          'SMS_ENABLED is true but SMS_GATEWAY_URL or SMS_GATEWAY_TOKEN is missing',
      });
    if (
      value.SALESFORCE_WRITE_ENABLED &&
      !(value.SALESFORCE_INSTANCE_URL && value.SALESFORCE_CLIENT_ID && value.SALESFORCE_CLIENT_SECRET)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'SALESFORCE_WRITE_ENABLED is true but the Salesforce connection is not configured',
      });
    // The cookie's Secure flag must agree with the origin's scheme. A Secure
    // cookie on an http:// origin is dropped by every browser, so nobody could
    // sign in; an insecure cookie on an https:// origin is a session that can
    // leak. NODE_ENV says nothing here: the production build also runs on a
    // laptop over http, and that is a coherent setup as long as both agree.
    const secureOrigin = new URL(value.APP_ORIGIN).protocol === 'https:';
    if (value.SESSION_COOKIE_SECURE && !secureOrigin)
      ctx.addIssue({
        code: 'custom',
        message:
          'SESSION_COOKIE_SECURE is true but APP_ORIGIN is http://, so browsers would drop the session cookie and nobody could sign in. Use an https origin, or set SESSION_COOKIE_SECURE=false for a local http setup only',
      });
    if (!value.SESSION_COOKIE_SECURE && secureOrigin)
      ctx.addIssue({
        code: 'custom',
        message: 'SESSION_COOKIE_SECURE must not be false when APP_ORIGIN is https://',
      });
  });

/** Settings for the web tier. Deliberately small: it holds no credential. */
const webSchema = z.object({
  NODE_ENV: nodeEnv,
  APP_ORIGIN: z.url({ error: 'APP_ORIGIN must be an absolute URL' }),
  // Where the web tier forwards /api. A full URL, or host:port on hosts that
  // hand out an internal address without a scheme (Render private services).
  API_URL: z
    .string()
    .min(1, 'API_URL is required: the address of the API service')
    .transform((value) => (/^https?:\/\//.test(value) ? value : 'http://' + value))
    .pipe(z.url({ error: 'API_URL must be a URL or host:port' })),
});

export type Config = z.infer<typeof serverSchema>;
export type WebConfig = z.infer<typeof webSchema>;
let resolved: Config | null = null;
let resolvedWeb: WebConfig | null = null;

function trimmed(source: NodeJS.ProcessEnv) {
  // Empty strings are how hosting dashboards express "unset"; treat them so.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  return out;
}

function fail(issues: z.core.$ZodIssue[]): never {
  throw new Error(
    'Invalid configuration:\n' +
      issues
        .map((i) => '  - ' + (i.path.join('.') || 'environment') + ': ' + i.message)
        .join('\n'),
  );
}

/** Validated settings for the API service and the scheduler. */
export function config(): Config {
  if (!resolved) {
    const parsed = serverSchema.safeParse(trimmed(process.env));
    if (!parsed.success) fail(parsed.error.issues);
    resolved = Object.freeze(parsed.data);
  }
  return resolved;
}

/** Validated settings for the web tier. */
export function webConfig(): WebConfig {
  if (!resolvedWeb) {
    const parsed = webSchema.safeParse(trimmed(process.env));
    if (!parsed.success) fail(parsed.error.issues);
    resolvedWeb = Object.freeze(parsed.data);
  }
  return resolvedWeb;
}

/** Called at API and scheduler start so a bad deployment fails before traffic. */
export function assertConfig(): Config {
  const value = config();
  if (new URL(value.APP_ORIGIN).protocol !== 'https:')
    console.warn(
      JSON.stringify({
        event: 'config_insecure_origin',
        appOrigin: value.APP_ORIGIN,
        note: 'sessions travel in clear text; use an https origin for anything but a local setup',
      }),
    );
  console.log(
    JSON.stringify({
      event: 'config_loaded',
      nodeEnv: value.NODE_ENV,
      appOrigin: value.APP_ORIGIN,
      salesforce: !!value.SALESFORCE_CLIENT_ID,
      salesforceWrite: value.SALESFORCE_WRITE_ENABLED,
      sms: value.SMS_ENABLED,
      trustedClientIpHeader: value.TRUSTED_CLIENT_IP_HEADER ?? null,
      retentionIdentifierDays: value.RETENTION_IDENTIFIER_DAYS ?? null,
      retentionEventDays: value.RETENTION_EVENT_DAYS ?? null,
    }),
  );
  return value;
}

/** Called at web start: proves the tier knows where the API is and nothing more. */
export function assertWebConfig(): WebConfig {
  const value = webConfig();
  console.log(
    JSON.stringify({
      event: 'web_config_loaded',
      nodeEnv: value.NODE_ENV,
      appOrigin: value.APP_ORIGIN,
      apiUrl: value.API_URL,
    }),
  );
  return value;
}

/** Test helper: forget the cached values so a test can change the environment. */
export function resetConfigForTests() {
  resolved = null;
  resolvedWeb = null;
}
