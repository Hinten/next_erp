import { expect, test } from '@playwright/test';
import { COLOR_SCHEME_STORAGE_KEY } from '../lib/theme/colorScheme';
import { expectThemeReadable } from './helpers/theme-a11y';

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

  for (const scheme of ['light', 'dark'] as const) {
    test(`follows system ${scheme} before hydration`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript((key) => localStorage.removeItem(key), COLOR_SCHEME_STORAGE_KEY);
      // Leave the inline ColorSchemeScript and CSS enabled; prevent the app
      // bundle from correcting a wrong initial scheme after React mounts.
      await page.route('**/_next/**', async (route) => {
        if (route.request().resourceType() === 'script') await route.abort();
        else await route.continue();
      });
      await page.goto('/login');
      await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
      await expect(page.getByLabel('E-mail')).toBeVisible();
      expect(
        await page.evaluate((key) => localStorage.getItem(key), COLOR_SCHEME_STORAGE_KEY),
      ).toBe(null);
    });

    test(`restores saved ${scheme} before hydration despite the opposite system mode`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme === 'light' ? 'dark' : 'light' });
      await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
        key: COLOR_SCHEME_STORAGE_KEY,
        value: scheme,
      });
      await page.route('**/_next/**', async (route) => {
        if (route.request().resourceType() === 'script') await route.abort();
        else await route.continue();
      });
      await page.goto('/login');
      await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
    });

    for (const route of ['/login', '/recuperar'] as const) {
      test(`${route} is readable in ${scheme}`, async ({ page }, testInfo) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.addInitScript((key) => localStorage.removeItem(key), COLOR_SCHEME_STORAGE_KEY);
        const hydrationErrors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error' && /hydration|did not match/i.test(message.text())) {
            hydrationErrors.push(message.text());
          }
        });
        await page.goto(route);
        const submit = page.getByRole('button', {
          name: route === '/login' ? 'Entrar' : 'Enviar link',
          exact: true,
        });
        await expectThemeReadable(page, testInfo, {
          scheme,
          required: [page.getByLabel('E-mail'), submit],
          focus: [page.getByLabel('E-mail'), submit],
        });
        expect(hydrationErrors).toEqual([]);
      });
    }

    test(`falls back to system ${scheme} for an invalid saved value`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript(
        (key) => localStorage.setItem(key, 'invalid'),
        COLOR_SCHEME_STORAGE_KEY,
      );
      await page.goto('/login');
      await expect(page.getByLabel('E-mail')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
    });
  }
});
