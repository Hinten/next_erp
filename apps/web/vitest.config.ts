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
    // e2e/**/*.test.ts covers plain-node unit tests of e2e infra itself (e.g.
    // globalSetup's mandatory-auth-env guard) — distinct from the Playwright
    // specs under e2e/ (always *.spec.ts, run by `pnpm test:e2e`, not Vitest).
    include: ['{app,lib,components}/**/*.test.{ts,tsx}', 'e2e/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'e2e/**/*.spec.ts', '.next/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
