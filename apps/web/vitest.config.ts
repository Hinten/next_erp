import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@delfrance/web',
    environment: 'jsdom',
    include: ['{app,lib}/**/*.test.{ts,tsx}'],
    // Playwright e2e specs live under e2e/ and are run by `pnpm test:e2e`,
    // not by Vitest.
    exclude: ['node_modules', 'e2e/**', '.next/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
