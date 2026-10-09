import { expect, test, type Page } from '@playwright/test';
import { COLOR_SCHEME_STORAGE_KEY } from '../lib/theme/colorScheme';
import { expectThemeReadable } from './helpers/theme-a11y';

async function expectScheme(page: Page, scheme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
}

async function savedScheme(page: Page) {
  return page.evaluate((key) => localStorage.getItem(key), COLOR_SCHEME_STORAGE_KEY);
}

test.describe('Color scheme preference', () => {
  for (const system of ['light', 'dark'] as const) {
    test(`toggles from system ${system} and persists through navigation and reload`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: system, reducedMotion: 'reduce' });
      await page.goto('/inicio');
      const toggle = page.getByRole('button', { name: 'Alternar tema', exact: true });
      await expect(toggle).toBeVisible();
      // The captured authentication state contains no preference. Clear only
      // once, then reload so every later navigation exercises real persistence.
      await page.evaluate((key) => localStorage.removeItem(key), COLOR_SCHEME_STORAGE_KEY);
      await page.reload();
      await expectScheme(page, system);
      expect(await savedScheme(page)).toBeNull();

      const bell = page.getByRole('button', { name: /^Avisos/ });
      await expect(bell).toBeVisible();
      const toggleBounds = await toggle.boundingBox();
      const bellBounds = await bell.boundingBox();
      expect(toggleBounds).not.toBeNull();
      expect(bellBounds).not.toBeNull();
      expect(toggleBounds!.x + toggleBounds!.width).toBeLessThanOrEqual(bellBounds!.x);

      const opposite = system === 'light' ? 'dark' : 'light';
      await toggle.click();
      await expectScheme(page, opposite);
      expect(await savedScheme(page)).toBe(opposite);
      await expectThemeReadable(page, testInfo, {
        scheme: opposite,
        required: [toggle, bell],
        icons: [toggle.locator('svg:visible'), bell.locator('svg')],
        focus: [toggle],
      });

      await page.emulateMedia({ colorScheme: system });
      await expectScheme(page, opposite);
      await page.goto('/produtos');
      await expect(page.getByRole('button', { name: 'Alternar tema' })).toBeVisible();
      await expectScheme(page, opposite);
      await page.reload();
      await expectScheme(page, opposite);

      await toggle.focus();
      await toggle.press('Enter');
      await expectScheme(page, system);
      expect(await savedScheme(page)).toBe(system);
      await toggle.press('Space');
      await expectScheme(page, opposite);
      expect(await savedScheme(page)).toBe(opposite);
    });
  }

  test('tracks system changes until the operator saves an explicit choice', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/inicio');
    await expect(page.getByRole('button', { name: 'Alternar tema' })).toBeVisible();
    await page.evaluate((key) => localStorage.removeItem(key), COLOR_SCHEME_STORAGE_KEY);
    await page.reload();
    await expectScheme(page, 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectScheme(page, 'dark');
    expect(await savedScheme(page)).toBeNull();

    await page.getByRole('button', { name: 'Alternar tema' }).click();
    await expectScheme(page, 'light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectScheme(page, 'light');
    expect(await savedScheme(page)).toBe('light');
  });

  test('synchronizes explicit preferences between tabs', async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/inicio');
    const toggle = page.getByRole('button', { name: 'Alternar tema' });
    await expect(toggle).toBeVisible();
    await page.evaluate((key) => localStorage.setItem(key, 'light'), COLOR_SCHEME_STORAGE_KEY);
    await page.reload();
    const second = await context.newPage();
    await second.goto('/inicio');
    await expect(second.getByRole('button', { name: 'Alternar tema' })).toBeVisible();
    await expectScheme(second, 'light');

    await toggle.click();
    await expectScheme(page, 'dark');
    await expectScheme(second, 'dark');
    await second.getByRole('button', { name: 'Alternar tema' }).click();
    await expectScheme(second, 'light');
    await expectScheme(page, 'light');
  });

  test('preserves the saved choice after logout', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/inicio');
    await expect(page.getByRole('button', { name: 'Alternar tema' })).toBeVisible();
    await page.evaluate((key) => localStorage.setItem(key, 'dark'), COLOR_SCHEME_STORAGE_KEY);
    await page.reload();
    await expectScheme(page, 'dark');
    await page.locator('header').getByRole('button').last().click();
    await page.getByRole('menuitem', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expectScheme(page, 'dark');
    expect(await savedScheme(page)).toBe('dark');
    await page.reload();
    await expectScheme(page, 'dark');
  });

  for (const system of ['light', 'dark'] as const) {
    test(`can toggle from system ${system} for the session when theme storage is unavailable`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: system });
      await page.addInitScript((key) => {
        const getItem = Storage.prototype.getItem;
        const setItem = Storage.prototype.setItem;
        Storage.prototype.getItem = function (item) {
          if (item === key) throw new DOMException('Storage disabled', 'SecurityError');
          return getItem.call(this, item);
        };
        Storage.prototype.setItem = function (item, value) {
          if (item === key) throw new DOMException('Storage disabled', 'SecurityError');
          setItem.call(this, item, value);
        };
      }, COLOR_SCHEME_STORAGE_KEY);
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto('/inicio');
      const toggle = page.getByRole('button', { name: 'Alternar tema' });
      await expect(toggle).toBeVisible();
      // The hydrated provider must resolve auto from the OS before either
      // click. This covers session recovery after the native script's read fails.
      await expectScheme(page, system);
      await toggle.click();
      await expectScheme(page, system === 'light' ? 'dark' : 'light');
      await toggle.click();
      await expectScheme(page, system);
      expect(pageErrors).toEqual([]);
    });
  }
});
