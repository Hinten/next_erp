import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';

/**
 * Gate for the behavior suite: present only under `firebase emulators:exec
 * --config firebase.rules.json` (which exports FIRESTORE_EMULATOR_HOST).
 * Locally a bare `pnpm test:rules` skips; in CI that would silently pass the
 * job while testing nothing, so it throws instead.
 */
export const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (!EMULATED && process.env.CI) {
  throw new Error(
    'test:rules ran without FIRESTORE_EMULATOR_HOST in CI — wrap it in ' +
      '`firebase emulators:exec --config firebase.rules.json` (see ci-rules.yml).',
  );
}

// test/helpers.ts → packages/rules-gen → packages → repo root. The suite
// exercises the COMMITTED firestore.rules — the drift check (gen:rules:check)
// guarantees it matches the generator output.
const RULES_PATH = fileURLToPath(new URL('../../../firestore.rules', import.meta.url));

export function createTestEnv(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: 'demo-erp',
    firestore: { rules: readFileSync(RULES_PATH, 'utf8') },
  });
}
