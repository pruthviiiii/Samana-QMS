import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, resetConfigForTests, webConfig } from '../lib/config';
// Configuration is the one place the environment is read, so its rules are
// tested directly: what is required, what is refused, and which combinations
// are contradictions that must stop a deployment rather than reach a customer.
const base = {
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/samana_qms_test',
  APP_ORIGIN: 'http://qms.test',
  SESSION_COOKIE_SECURE: 'false',
};
const keys = [
  'DATABASE_URL',
  'APP_ORIGIN',
  'API_URL',
  'API_PORT',
  'PORT',
  'NODE_ENV',
  'SESSION_COOKIE_SECURE',
  'QR_SIGNING_SECRET',
  'WORKER_SECRET',
  'BOOTSTRAP_PASSWORD',
  'SALESFORCE_INSTANCE_URL',
  'SALESFORCE_CLIENT_ID',
  'SALESFORCE_CLIENT_SECRET',
  'SALESFORCE_WRITE_ENABLED',
  'SMS_ENABLED',
  'SMS_GATEWAY_URL',
  'SMS_GATEWAY_TOKEN',
  'TRUSTED_CLIENT_IP_HEADER',
  'RETENTION_IDENTIFIER_DAYS',
  'RETENTION_EVENT_DAYS',
];
function stub(values: Record<string, string | undefined>) {
  vi.unstubAllEnvs();
  resetConfigForTests();
  for (const key of keys) vi.stubEnv(key, '');
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) vi.stubEnv(key, value);
  resetConfigForTests();
}
const load = (overrides: Record<string, string | undefined>) => {
  stub({ ...base, ...overrides });
  return config();
};
afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigForTests();
});
describe('API and scheduler configuration', () => {
  it('accepts a minimal valid environment', () => {
    const value = load({});
    expect(value.APP_ORIGIN).toBe('http://qms.test');
    expect(value.NODE_ENV).toBe('development');
    expect(value.SESSION_COOKIE_SECURE).toBe(false);
    expect(value.SALESFORCE_WRITE_ENABLED).toBe(false);
    expect(value.RETENTION_IDENTIFIER_DAYS).toBeUndefined();
    expect(value.API_PORT).toBeUndefined();
  });
  it('names the missing variable instead of failing later', () => {
    expect(() => load({ DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => load({ APP_ORIGIN: undefined })).toThrow(/APP_ORIGIN/);
  });
  it('refuses a value that is neither true nor false', () =>
    expect(() => load({ SESSION_COOKIE_SECURE: 'yes' })).toThrow(
      /SESSION_COOKIE_SECURE/,
    ));
  it('accepts the address header the web tier sets and refuses unknown ones', () => {
    expect(load({ TRUSTED_CLIENT_IP_HEADER: 'x-client-address' }).TRUSTED_CLIENT_IP_HEADER).toBe(
      'x-client-address',
    );
    expect(() => load({ TRUSTED_CLIENT_IP_HEADER: 'x-client-ip' })).toThrow(
      /TRUSTED_CLIENT_IP_HEADER/,
    );
  });
  it('reads the listening port and refuses nonsense', () => {
    expect(load({ API_PORT: '3001' }).API_PORT).toBe(3001);
    expect(load({ PORT: '10000' }).PORT).toBe(10000);
    expect(() => load({ API_PORT: 'eighty' })).toThrow(/API_PORT/);
    expect(() => load({ API_PORT: '99999' })).toThrow(/API_PORT/);
  });
  it('refuses a Salesforce host that is not Salesforce', () =>
    expect(() =>
      load({ SALESFORCE_INSTANCE_URL: 'https://example.com' }),
    ).toThrow(/SALESFORCE_INSTANCE_URL/));
  it('refuses an SMS gateway that is not https', () =>
    expect(() => load({ SMS_GATEWAY_URL: 'http://sms.example' })).toThrow(
      /SMS_GATEWAY_URL/,
    ));
  it('refuses switching SMS on without a gateway', () =>
    expect(() => load({ SMS_ENABLED: 'true' })).toThrow(/SMS_GATEWAY_URL/));
  it('refuses Salesforce write-back without a connection', () =>
    expect(() => load({ SALESFORCE_WRITE_ENABLED: 'true' })).toThrow(
      /not configured/,
    ));
  it('refuses a Secure cookie on an http origin, where nobody could sign in', () =>
    expect(() => load({ SESSION_COOKIE_SECURE: 'true' })).toThrow(
      /nobody could sign in/,
    ));
  it('defaults the cookie to Secure, so an http origin must opt out explicitly', () =>
    expect(() => load({ SESSION_COOKIE_SECURE: undefined })).toThrow(
      /SESSION_COOKIE_SECURE/,
    ));
  it('refuses an insecure cookie on an https origin', () =>
    expect(() =>
      load({ APP_ORIGIN: 'https://qms.test', SESSION_COOKIE_SECURE: 'false' }),
    ).toThrow(/must not be false/));
  it('accepts a local http setup that opts out, and a production https setup', () => {
    expect(load({}).SESSION_COOKIE_SECURE).toBe(false);
    expect(
      load({ APP_ORIGIN: 'https://qms.test', SESSION_COOKIE_SECURE: 'true' })
        .SESSION_COOKIE_SECURE,
    ).toBe(true);
    expect(
      load({ APP_ORIGIN: 'https://qms.test', SESSION_COOKIE_SECURE: undefined })
        .SESSION_COOKIE_SECURE,
    ).toBe(true);
  });
  it('treats an empty value as unset, the way hosting dashboards do', () =>
    expect(load({ QR_SIGNING_SECRET: '' }).QR_SIGNING_SECRET).toBeUndefined());
  it('refuses a signing secret that is too short to be one', () =>
    expect(() => load({ QR_SIGNING_SECRET: 'short' })).toThrow(
      /QR_SIGNING_SECRET/,
    ));
  it('reads retention periods as numbers and rejects nonsense', () => {
    expect(load({ RETENTION_EVENT_DAYS: '365' }).RETENTION_EVENT_DAYS).toBe(365);
    expect(() => load({ RETENTION_EVENT_DAYS: 'forever' })).toThrow(
      /RETENTION_EVENT_DAYS/,
    );
    expect(() => load({ RETENTION_EVENT_DAYS: '0' })).toThrow(
      /RETENTION_EVENT_DAYS/,
    );
  });
  it('accepts a complete production environment', () => {
    const value = load({
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://qms.samana.test',
      SESSION_COOKIE_SECURE: 'true',
      QR_SIGNING_SECRET: 'a-signing-secret-value',
      WORKER_SECRET: 'a-worker-secret-value',
      SALESFORCE_INSTANCE_URL: 'https://example.my.salesforce.com',
      SALESFORCE_CLIENT_ID: 'id',
      SALESFORCE_CLIENT_SECRET: 'secret',
      SALESFORCE_WRITE_ENABLED: 'true',
      TRUSTED_CLIENT_IP_HEADER: 'x-client-address',
      RETENTION_IDENTIFIER_DAYS: '365',
      PORT: '10000',
    });
    expect(value.SALESFORCE_WRITE_ENABLED).toBe(true);
    expect(value.TRUSTED_CLIENT_IP_HEADER).toBe('x-client-address');
    expect(value.RETENTION_IDENTIFIER_DAYS).toBe(365);
    expect(value.PORT).toBe(10000);
  });
});
describe('Web tier configuration', () => {
  it('needs only its origin and the API address, and no credential', () => {
    stub({ APP_ORIGIN: 'https://qms.test', API_URL: 'http://api.internal:3001' });
    const value = webConfig();
    expect(value.API_URL).toBe('http://api.internal:3001');
    expect(Object.keys(value).sort()).toEqual(['API_URL', 'APP_ORIGIN', 'NODE_ENV']);
  });
  it('accepts host:port as private-network hosts hand it out', () => {
    stub({ APP_ORIGIN: 'https://qms.test', API_URL: 'samana-qms-api:10000' });
    expect(webConfig().API_URL).toBe('http://samana-qms-api:10000');
  });
  it('refuses to start without the API address', () => {
    stub({ APP_ORIGIN: 'https://qms.test' });
    expect(() => webConfig()).toThrow(/API_URL/);
  });
  it('refuses an API address that is not one', () => {
    stub({ APP_ORIGIN: 'https://qms.test', API_URL: 'not a url at all' });
    expect(() => webConfig()).toThrow(/API_URL/);
  });
});
