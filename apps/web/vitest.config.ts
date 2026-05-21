import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // The Next.js tsconfig sets `jsx: preserve` so SWC handles the transform in
  // production. Vitest runs source through esbuild instead — tell esbuild to
  // use the automatic JSX runtime so `.tsx` test files don't need a top-level
  // `import React` (matches the new-style React 17+ transform).
  esbuild: { jsx: 'automatic' },
  test: {
    name: '@delfrance/web',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
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
