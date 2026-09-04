import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@delfrance/shopee-app',
    environment: 'node',
    // `proxy.ts` (the CORS middleware) sits at the app root, outside every
    // directory glob above — name its test explicitly or it never runs.
    include: ['{app,lib}/**/*.test.ts', 'proxy.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
