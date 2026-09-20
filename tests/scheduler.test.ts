import { describe, it, expect, vi } from 'vitest';
import { schedulerConfig, schedulerTick } from '../scripts/scheduler.mjs';
describe('Render HTTP scheduler', () => {
  it('requires an explicit secure origin in production', () => {
    for (const origin of [
      '',
      'http://localhost:3000',
      'https://user:password@qms.test',
      'https://qms.test/path',
      'https://qms.test?secret=x',
    ])
      expect(() =>
        schedulerConfig({
          NODE_ENV: 'production',
          WORKER_ORIGIN: origin,
          WORKER_SECRET: 'synthetic',
        }),
      ).toThrow();
    expect(
      schedulerConfig({
        NODE_ENV: 'production',
        WORKER_ORIGIN: 'https://qms.test',
        WORKER_SECRET: 'synthetic',
      }).origin,
    ).toBe('https://qms.test');
  });
  it('permits only loopback HTTP in development and requires a secret', () => {
    expect(schedulerConfig({ WORKER_SECRET: 'synthetic' }).origin).toBe(
      'http://localhost:3000',
    );
    expect(() =>
      schedulerConfig({
        WORKER_ORIGIN: 'http://untrusted.test',
        WORKER_SECRET: 'synthetic',
      }),
    ).toThrow();
    expect(() =>
      schedulerConfig({ WORKER_ORIGIN: 'https://qms.test' }),
    ).toThrow();
  });
  it('calls the authenticated web endpoint without following redirects', async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json({
          routing: { checked: 2 },
          jobs: { processed: 3, sent: 1 },
        }),
      );
    expect(
      await schedulerTick(
        { origin: 'https://qms.test', secret: 'synthetic' },
        request,
      ),
    ).toEqual({ routed: 2, processed: 3, sent: 1 });
    expect(request).toHaveBeenCalledWith(
      'https://qms.test/api/jobs/run',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: { Authorization: 'Bearer synthetic' },
      }),
    );
  });
  it('rejects redirects, errors, and unconfirmed work', async () => {
    for (const response of [
      new Response('', { status: 302 }),
      new Response('', { status: 401 }),
      Response.json({}),
      Response.json({
        routing: { checked: 0 },
        jobs: { processed: 1, sent: 2 },
      }),
    ])
      await expect(
        schedulerTick(
          { origin: 'https://qms.test', secret: 'synthetic' },
          vi.fn().mockResolvedValue(response),
        ),
      ).rejects.toThrow();
  });
});
