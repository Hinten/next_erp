import { expect, test } from '@playwright/test';
import {
  CHAT_ETIQUETA_RED,
  cleanupConversas,
  e2ePrefix,
  seedConversas,
  seedSearchMessages,
  type SeededChat,
  type SeededSearchMessages,
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
  let searchSeed: SeededSearchMessages;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    seeded = await seedConversas(prefix);
    // Two token-bearing messages (old in BLUE, recent in RED) for global search.
    searchSeed = await seedSearchMessages(prefix, seeded);
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

  test('opening a conversa renders the thread messages', async ({ page }) => {
    await page.goto(`/chat/${seeded.vermelha.id}`);
    // The thread (PR-C3) renders the seeded inbound message as a bubble.
    await expect(page.getByText(seeded.vermelha.previewText).last()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('entering the conversa reveals the composer and a typed reply renders optimistically', async ({
    page,
  }) => {
    await page.goto(`/chat/${seeded.vermelha.id}`);
    await expect(page.getByText(seeded.vermelha.previewText).last()).toBeVisible({
      timeout: 20_000,
    });

    // The seeded conversa has `usuarios: null` → the gate shows "Entrar na
    // conversa" on the first run, and joining reveals the full composer (the e2e
    // user holds all perms). This test runs in a `describe.serial` block, so on a
    // retry the operator may ALREADY have joined a prior attempt — then the button
    // is absent and the composer is shown directly. `count()` is a non-throwing
    // deterministic probe (unlike `isVisible()`, which needs the element to
    // exist): click the join button only when it is actually present.
    const entrar = page.getByRole('button', { name: 'Entrar na conversa' });
    if ((await entrar.count()) > 0) {
      await entrar.click();
    }

    const composer = page.getByPlaceholder(/Digite uma mensagem/);
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const replyText = `${prefix}-reply-e2e`;
    await composer.fill(replyText);
    await page.getByLabel('Enviar').click();

    // The optimistic bubble shows the reply immediately (client-side), before
    // any server round-trip; a delivery-status icon confirms it's an outbound.
    await expect(page.getByText(replyText).last()).toBeVisible({ timeout: 15_000 });
    // Degraded-tolerant: any of the outbound status icons may show depending on
    // whether the #529 sender trigger is deployed to staging (salva / enviando /
    // erro), so this is a soft check.
    await expect
      .soft(
        page
          .getByLabel('Salva')
          .or(page.getByLabel('Enviando'))
          .or(page.getByLabel('Erro no envio'))
          .first(),
      )
      .toBeVisible({ timeout: 15_000 });
  });

  test('search mode highlights matches and shows a counter', async ({ page }) => {
    await page.goto(`/chat/${seeded.vermelha.id}`);
    await expect(page.getByText(seeded.vermelha.previewText).last()).toBeVisible({
      timeout: 20_000,
    });

    // Toggle the in-thread search and query a substring of the seeded message.
    await page.getByLabel('Buscar na conversa').click();
    const searchInput = page.getByLabel('Buscar mensagens');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('ultima');

    // The matched substring is wrapped in a <mark>, and the counter shows ≥ 1/N.
    await expect(page.locator('mark').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/\d+\/\d+/).first()).toBeVisible();
  });

  test('the conversa actions menu opens with its gated items (PR-C4)', async ({ page }) => {
    await page.goto(`/chat/${seeded.vermelha.id}`);
    await expect(page.getByText(seeded.vermelha.previewText).last()).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'Ações da conversa' }).click();
    // Always-present items + the whatsapp-only "Enviar mensagem padrão" (the
    // seeded conversa is origem `whatsapp`).
    await expect(page.getByRole('menuitem', { name: 'Renomear' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('menuitem', { name: 'Definir etiqueta' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Enviar mensagem padrão' })).toBeVisible();
  });

  // Cross-conversation search (PR-C5): the token hits BOTH seeded conversas;
  // clicking the OLD match opens the thread in target-window mode; "Voltar ao
  // presente" restores the live window. Runs BEFORE renomear (which mutates the
  // RED conversa's name — this test keys on message snippets, not names).
  test('global search finds the token across conversas and jumps into target mode', async ({
    page,
  }) => {
    await page.goto('/chat');

    // Enter global search mode from the list-pane header, then query the token.
    await page.getByRole('button', { name: 'Buscar em todas as conversas' }).click();
    const input = page.getByRole('textbox', { name: 'Buscar em todas as conversas' });
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(searchSeed.token);

    // Both conversas surface as grouped results (recent RED first, old BLUE next).
    await expect(page.getByText(/mensagem recente com/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/mensagem antiga com/).first()).toBeVisible({ timeout: 20_000 });

    // Click the OLD match → the BLUE thread opens in TARGET mode (?msg=&ts=).
    await page
      .getByText(/mensagem antiga com/)
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/chat/${searchSeed.oldConversaId}\\?.*msg=`), {
      timeout: 15_000,
    });

    // The target message is visible and "Voltar ao presente" is offered.
    await expect(page.getByText(/mensagem antiga com/).last()).toBeVisible({ timeout: 20_000 });
    const voltar = page.getByRole('button', { name: 'Voltar ao presente' });
    await expect(voltar).toBeVisible({ timeout: 15_000 });

    // Returning to the present clears the target and hides the button.
    await voltar.click();
    await expect(voltar).toHaveCount(0, { timeout: 10_000 });
    await expect(page).not.toHaveURL(/msg=/);
  });

  // Runs LAST (serial): it renames the RED conversa, so later name-keyed
  // assertions must not follow. The new name keeps the run prefix, so
  // `cleanupConversas` (which sweeps by the `nome` prefix range) still reaps it.
  // The target name folds in `testInfo.retry` so a retry picks a name the
  // conversa doesn't already carry — otherwise the "Renomear" submit stays
  // disabled (new === current) and the retry can't proceed.
  test('renomear round-trip updates the conversa header (PR-C4)', async ({ page }, testInfo) => {
    const novoNome = `${prefix}-renomeada-r${testInfo.retry}`;
    await page.goto(`/chat/${seeded.vermelha.id}`);
    await expect(page.getByText(seeded.vermelha.previewText).last()).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('button', { name: 'Ações da conversa' }).click();
    await page.getByRole('menuitem', { name: 'Renomear' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByLabel('Novo nome').fill(novoNome);
    await dialog.getByRole('button', { name: 'Renomear' }).click();

    // The live doc snapshot re-renders the header <Title> with the new name.
    await expect(page.getByRole('heading', { name: novoNome })).toBeVisible({ timeout: 20_000 });
  });
});
