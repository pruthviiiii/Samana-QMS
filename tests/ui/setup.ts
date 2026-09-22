import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
// Every browser test starts from an empty document and a fresh network mock.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
