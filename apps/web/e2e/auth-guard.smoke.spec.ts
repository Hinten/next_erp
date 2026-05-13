import { expect, test } from '@playwright/test';

test.describe('Auth guard', () => {
  test('redirects unauthenticated user from /inicio to /login', async ({
    page,
  }) => {
    // The (app) layout uses useRequireAuth(): when onAuthStateChanged
    // resolves to null (no signed-in user) it calls router.replace('/login').
    // Wait for the URL to change rather than asserting the response code,
    // since the initial GET is a 200 from Next that then runs client logic.
    await page.goto('/inicio');
    await page.waitForURL('**/login', { timeout: 5000 });
    await expect(page.getByRole('heading', { name: 'Delfrance' })).toBeVisible();
    await expect(page.getByLabel('E-mail')).toBeVisible();
  });

  test('redirects unauthenticated user from /clientes to /login', async ({
    page,
  }) => {
    await page.goto('/clientes');
    await page.waitForURL('**/login', { timeout: 5000 });
    await expect(page.getByLabel('Senha')).toBeVisible();
  });
});
