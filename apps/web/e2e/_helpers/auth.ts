import type { Page } from '@playwright/test';

export const E2E_SU_EMAIL = process.env.E2E_SU_EMAIL ?? '';
export const E2E_SU_PASSWORD = process.env.E2E_SU_PASSWORD ?? '';

/**
 * Sign the test superuser in via the real /login UI. Used by the Playwright
 * globalSetup to cache an authenticated storageState (cookies + IndexedDB)
 * so individual tests can reuse it instead of paying the login cost each
 * time. The SU user must be pre-provisioned on the test Firebase project
 * with all permissions granted (see tools/test-fixtures/grant-all-perms).
 */
export async function loginAsSuperUser(page: Page): Promise<void> {
  if (!E2E_SU_EMAIL || !E2E_SU_PASSWORD) {
    throw new Error(
      'E2E_SU_EMAIL and E2E_SU_PASSWORD must be set to run authenticated e2e tests.',
    );
  }
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(E2E_SU_EMAIL);
  await page.getByLabel('Senha').fill(E2E_SU_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL('/inicio', { timeout: 15_000 });
}
