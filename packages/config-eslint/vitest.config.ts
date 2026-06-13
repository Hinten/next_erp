import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/config-eslint',
    environment: 'node',
    include: ['rules/**/*.test.js'],
  },
});
