import { defineWorkspace } from 'vitest/config';

// Vitest workspace lets each package have its own config (jsdom for React,
// node for server packages) while a single `pnpm test` runs them all.
export default defineWorkspace(['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts']);
