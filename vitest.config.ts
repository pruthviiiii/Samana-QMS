import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
Object.assign(process.env, loadEnv('test', process.cwd(), ''));
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
