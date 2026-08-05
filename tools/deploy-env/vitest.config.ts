import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/deploy-env',
    environment: 'node',
    include: ['*.test.js'],
  },
});
