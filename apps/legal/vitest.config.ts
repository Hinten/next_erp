import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    name: '@delfrance/legal',
    environment: 'node',
    include: ['{app,lib,components}/**/*.test.{ts,tsx}'],
  },
  resolve: { alias: { '@': path.resolve(import.meta.dirname) } },
});
