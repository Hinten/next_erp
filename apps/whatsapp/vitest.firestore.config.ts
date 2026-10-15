import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** Runs only under the existing firebase.e2e.json Firestore carve-out, never staging. */
export default defineConfig({
  test: {
    name: '@delfrance/whatsapp-app:firestore',
    environment: 'node',
    include: ['{app,lib,functions}/**/*.firestore.test.ts', '*.firestore.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: { alias: { '@': path.resolve(import.meta.dirname) } },
});
