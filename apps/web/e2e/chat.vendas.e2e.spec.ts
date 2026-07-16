import { expect, test } from '@playwright/test';
import {
  CHAT_ETIQUETA_RED,
  cleanupConversas,
  e2ePrefix,
  seedConversas,
  type SeededChat,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the unified chat inbox list pane (PR-C2): tabs +
 * badge, the last-message preview on a tile, the etiqueta filter, opening a
 * conversa into the existing thread, and the `/whatsapp` → `/chat` redirect.
 *
 * Degraded-tolerant: the staging `chat` collection is shared, so assertions key
 * on the run-scoped conversa names (unique per run) and never on absolute
 * counts. The seeded conversas carry the freshest `ultima_modificacao`, so they
 * sit at the top of the "Todas" (ultima desc) list within its 200-doc window.
 */
test.describe.serial('Chat inbox — list pane', () => {
  const prefix = e2ePrefix('chat');
  let seeded: SeededChat;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    seeded = await seedConversas(prefix);
    await warmRoutes(browser, ['/chat', '/chat/__aquecimento__', '/whatsapp']);
  });

  test.afterAll(async () => {
    await cleanupConversas(prefix);
  });

  test('renders the three tabs and lists seeded conversas on Todas', async ({ page }) => {
    await page.goto('/chat?tab=todas');

    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Atendimento/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Pendentes/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Todas/ })).toBeVisible();

    await expect(page.getByText(seeded.vermelha.nome)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(seeded.azul.nome)).toBeVisible();
  });

  test('a tile shows the seeded last-message preview', async ({ page }) => {
    await page.goto('/chat?tab=todas');
    await expect(page.getByText(seeded.vermelha.nome)).toBeVisible({ timeout: 20_000 });
    // The preview is fetched one-shot per tile (orderBy timestamp desc, limit 1).
    await expect(page.getByText(seeded.vermelha.previewText)).toBeVisible({ timeout: 20_000 });
  });

  test('the Pendentes tab surfaces a badge and the pendente conversa', async ({ page }) => {
    await page.goto('/chat?tab=pendentes');
    await expect(page.getByText(seeded.pendente.nome)).toBeVisible({ timeout: 20_000 });
    // The seeded pendente makes the estadoConversa==0 count ≥ 1; the badge text
    // is a digit or "9+". Soft so a global-count edge never fails the suite.
    const pendentesTab = page.getByRole('tab', { name: /Pendentes/ });
    await expect.soft(pendentesTab.locator('text=/\\d|9\\+/')).toBeVisible({ timeout: 15_000 });
  });

  test('the etiqueta filter narrows the list to the tagged conversa', async ({ page }) => {
    await page.goto(`/chat?tab=todas&etiqueta=${CHAT_ETIQUETA_RED}`);
    await expect(page.getByText(seeded.vermelha.nome)).toBeVisible({ timeout: 20_000 });
    // The BLUE + untagged conversas must drop out of the filtered list.
    await expect(page.getByText(seeded.azul.nome)).toHaveCount(0);
    await expect(page.getByText(seeded.pendente.nome)).toHaveCount(0);
  });

  test('opening a conversa renders the existing thread', async ({ page }) => {
    await page.goto('/chat?tab=todas');
    await page.getByText(seeded.vermelha.nome).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${seeded.vermelha.id}`), { timeout: 15_000 });
    // The MensagemThread (unchanged in this PR) shows the seeded message.
    await expect(page.getByText(seeded.vermelha.previewText).last()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('/whatsapp redirects into the unified inbox', async ({ page }) => {
    await page.goto('/whatsapp');
    await expect(page).toHaveURL(/\/chat(\?|$)/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
  });
});
