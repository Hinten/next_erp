import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/integrations-whatsapp-cloud-api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
