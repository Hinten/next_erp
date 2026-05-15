import { expect, test } from '@playwright/test';

// Login page renders without a signed-in user — opt out of the persistent
// session that globalSetup writes for the rest of the suite.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login page', () => {
  test('renders without FOUC and shows the form', async ({ page }) => {
    const response = await page.goto('/login');
    expect(response?.status()).toBeLessThan(400);

    // Title and primary controls present
    await expect(page.getByRole('heading', { name: 'Delfrance' })).toBeVisible();
    await expect(page.getByLabel('E-mail')).toBeVisible();
    await expect(page.getByLabel('Senha')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Esqueci minha senha' })).toBeVisible();

    // Mantine styles applied (button has the Mantine class signature). If
    // styles fail to load (FOUC), the button has no background-color set.
    const button = page.getByRole('button', { name: 'Entrar' });
    const bg = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
  });
});
