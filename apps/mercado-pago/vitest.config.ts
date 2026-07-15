import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@delfrance/mercado-pago-app',
    environment: 'node',
    // `functions/` holds the deploy-artifact-only Cloud Functions codebase (not a
    // pnpm workspace package). The parent app's tasks (tsconfig `**/*.ts`, `eslint .`,
    // this vitest config) cover it, so include its tests here too.
    include: ['{app,lib,functions}/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
