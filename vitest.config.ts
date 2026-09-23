import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
Object.assign(process.env, loadEnv('test', process.cwd(), ''));
// Two projects with different runtimes:
//   server   the domain, API, database, delivery and security suites, which
//            run in Node against the isolated samana_qms_test database;
//   browser  component tests for the screens, which run in a DOM.
// Coverage is measured over the code that ships, not the tests or the
// generated interface primitives, and the thresholds hold the line where the
// suite stands today so a change that removes coverage fails the build.
export default defineConfig({
  resolve: {
    alias: {
      '@qms/shared': fileURLToPath(new URL('./shared/domain.ts', import.meta.url)),
      '@backend': fileURLToPath(new URL('./backend', import.meta.url)),
      '@': fileURLToPath(new URL('./frontend', import.meta.url)),
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    coverage: {
      provider: 'v8',
      include: ['backend/**/*.ts', 'shared/**/*.ts', 'frontend/components/qms/**/*.{ts,tsx}', 'frontend/proxy.ts'],
      exclude: ['backend/openapi.ts', 'backend/generated/**'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Measured on 22 September 2026 over lib/, components/qms/ and proxy.ts.
      // A change that lowers any of these fails the run. Raise them when a
      // change raises coverage, so the floor keeps following the suite.
      thresholds: { statements: 46, branches: 40, functions: 37, lines: 47 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 60000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/ui/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/ui/setup.ts'],
          testTimeout: 15000,
        },
      },
    ],
  },
});
