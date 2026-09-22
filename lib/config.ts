import { z } from 'zod';
// The single place the process environment is read. Every value is validated
// once, on first use, and the result is frozen: a missing or malformed setting
// fails immediately with a message naming the variable, instead of surfacing
// later as a 503 in front of a customer. `assertConfig()` runs at server start
// (instrumentation.ts) and at the top of the worker, so a bad deployment stops
// before it serves traffic.
//
// Adding a setting: extend the schema below, document it in .env.example and
// docs/render.md, and read it through `config()`. Nothing else should touch
// process.env; tests/boundary.test.ts enforces that for application code.

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

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
    // Only set behind a proxy that appends the client address to this header.
    TRUSTED_CLIENT_IP_HEADER: z
      .enum(['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for'])
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

export type Config = z.infer<typeof schema>;
let resolved: Config | null = null;

function read(source: NodeJS.ProcessEnv): Config {
  // Empty strings are how hosting dashboards express "unset"; treat them so.
  const trimmed: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (typeof value === 'string' && value.trim() !== '')
      trimmed[key] = value.trim();
  const parsed = schema.safeParse(trimmed);
  if (!parsed.success)
    throw new Error(
      'Invalid configuration:\n' +
        parsed.error.issues
          .map((i) => '  - ' + (i.path.join('.') || 'environment') + ': ' + i.message)
          .join('\n'),
    );
  return Object.freeze(parsed.data);
}

/** Validated settings. Throws on the first call if the environment is wrong. */
export function config(): Config {
  if (!resolved) resolved = read(process.env);
  return resolved;
}

/** Called at server and worker start so a bad deployment fails before traffic. */
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

/** Test helper: forget the cached value so a test can change the environment. */
export function resetConfigForTests() {
  resolved = null;
}
