import { describe, it, expect } from 'vitest';
import { listenUrl } from '../lib/events';
describe('Change listener endpoint', () => {
  it('rewrites a pooled Neon host to the direct endpoint', () => {
    expect(
      listenUrl(
        'postgresql://app:secret@ep-fragrant-credit-b2l67srr-pooler.c-6.eu-central-1.aws.neon.tech/samana_qms?sslmode=require',
      ),
    ).toBe(
      'postgresql://app:secret@ep-fragrant-credit-b2l67srr.c-6.eu-central-1.aws.neon.tech/samana_qms?sslmode=require',
    );
  });
  it('leaves a direct host and an unparsable value unchanged', () => {
    const direct = 'postgresql://app:secret@ep-fragrant-credit-b2l67srr.c-6.eu-central-1.aws.neon.tech/samana_qms';
    expect(listenUrl(direct)).toBe(direct);
    expect(listenUrl('not a url')).toBe('not a url');
  });
});
