import { defineConfig } from 'vitest/config';

// Node environment, zero network (D11): `semRede.ts` replaces the global `fetch`
// with one that throws, so nothing in this suite can reach AWS or Amazon. The
// CDK synthesises in-process; no test runs the `cdk` CLI.
//
// 60-s ceilings: one CDK synth (aws-cdk-lib's module graph plus the offline
// CloudFormation validator's WASM engine) takes seconds, and more on a loaded
// CI runner. The heavy work sits in ONE `beforeAll`; no test asserts a time.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/_setup/semRede.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
