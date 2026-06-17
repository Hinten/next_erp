import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@delfrance/melhor-envio-app',
    environment: 'node',
    include: ['{app,lib}/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
