import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loginAsSuperUser } from '../_helpers/auth';

// Resolved relative to the package root (apps/web), where Playwright runs.
export const STORAGE_STATE_PATH = 'e2e/.auth/su.json';

/**
 * Logs in the test SU once at the start of the Playwright run and persists
 * the resulting cookies + IndexedDB (Firebase Auth uses IndexedDB persistence)
 * to a file. Tests that need an authenticated context declare
 * `test.use({ storageState })` to skip the login flow per-test.
 *
 * Skipped when E2E_SU_EMAIL/E2E_SU_PASSWORD are not set. Playwright runs
 * `globalSetup` once regardless of `--project` filtering, and only ONE
 * project (`configuracoes`) actually uses the SU session — throwing here
 * would break every other project (smoke, crud-*, emulator) that never
 * touches it, none of which should need SU credentials at all. #31 made
 * auth mandatory where it's actually required: `configuracoes.spec.ts` now
 * fails loud (`requireSuAuthEnv()`) instead of self-skipping when these are
 * missing — this shared setup step stays best-effort on purpose.
 */
async function globalSetup(config: FullConfig): Promise<void> {
  if (!process.env.E2E_SU_EMAIL || !process.env.E2E_SU_PASSWORD) {
    return;
  }
  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  const baseURL = config.projects[0]?.use?.baseURL;
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await loginAsSuperUser(page);
  await context.storageState({ path: STORAGE_STATE_PATH, indexedDB: true });
  await browser.close();
}

export default globalSetup;
