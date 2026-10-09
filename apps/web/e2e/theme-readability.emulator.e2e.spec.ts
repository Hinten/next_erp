import { errors, expect, test as base, type BrowserContext, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { getApp } from '@delfrance/test-fixtures';
import { e2eUserEmail } from './_helpers/run-id';
import {
  cleanupThemeReadabilityFixtures,
  e2ePrefix,
  resetAvisosLeitura,
  seedThemeReadabilityFixtures,
} from './_helpers/seed-data';
import { readEmulatorAccessConfig } from './_helpers/verify-emulator-access';
import { captureAuthenticatedState } from './global-setup';
import { expectFieldError } from './helpers/object-view';
import { applyTextFilter, expectListMode, searchTableView } from './helpers/table-view';
import { expectThemeReadable } from './helpers/theme-a11y';
import { warmRoutes } from './helpers/warmup';

const prefix = e2ePrefix('theme-readability');

interface ThemeOperator {
  uid: string;
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
}

const test = base.extend<object, { themeOperator: ThemeOperator }>({
  themeOperator: [
    async ({ browser }, provide, workerInfo) => {
      // This fixture belongs only to the named offline lane. Validate both
      // emulator services before an Admin Auth or fixture request can run.
      readEmulatorAccessConfig();
      const baseURL = workerInfo.project.use.baseURL;
      if (!baseURL) throw new Error('Theme operator login requires a Playwright baseURL.');
      const auth = getAuth(getApp());
      const sharedOperator = await auth.getUserByEmail(e2eUserEmail());
      if (!sharedOperator.customClaims)
        throw new Error('The global e2e operator must have claims before Theme login.');
      const email = `e2e-user-${prefix.slice(4)}-operator@example.com`;
      const password = randomUUID();
      const user = await auth.createUser({
        uid: `${prefix}-operator`,
        email,
        password,
        emailVerified: true,
        displayName: 'E2E Theme Operator',
      });
      try {
        // Copy the same permissions and tenant before login mints the token.
        // Only identity changes: other suites cannot move this read watermark.
        await auth.setCustomUserClaims(user.uid, sharedOperator.customClaims);
        const storageState = await captureAuthenticatedState(browser, baseURL, email, password);
        await provide({ uid: user.uid, storageState });
      } finally {
        try {
          await Promise.all([
            cleanupThemeReadabilityFixtures(prefix),
            resetAvisosLeitura(user.uid),
          ]);
        } finally {
          await auth.deleteUser(user.uid);
        }
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  storageState: async ({ themeOperator }, provide) => {
    await provide(themeOperator.storageState);
  },
});

/**
 * Populated browser states complement the static-route smoke audit. The real
 * theme button selects each scheme; Firestore fixtures contain settled
 * messages and stock, and no provider send or stock movement is submitted.
 * Every required locator names content independently of the contrast scanner,
 * so disappearing content cannot turn this matrix into an empty passing audit.
 */
// Each case has its own browser context and only stages/cancels UI edits. CI
// can run cases in separate workers: e2ePrefix gives each worker its own seed
// graph and signed-in operator. Another suite's bulk-read cannot mutate the
// Theme operator's notification state during axe's DOM measurement.
test.describe('Theme readability — populated component states', () => {
  let fixtures: Awaited<ReturnType<typeof seedThemeReadabilityFixtures>>;

  test.beforeAll(async ({ browser, themeOperator }) => {
    test.setTimeout(240_000);
    fixtures = await seedThemeReadabilityFixtures(prefix, themeOperator.uid);
    await warmRoutes(browser, [
      '/categorias',
      '/categorias/novo',
      '/produtos',
      `/produtos/${fixtures.kit.kitId}/editar`,
      `/produtos/${fixtures.stock.parentId}/editar`,
      '/chat',
      `/chat/${fixtures.untagged.id}`,
    ]);
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`${scheme} components remain readable and reachable on ${viewport.name}`, async ({
        page,
      }, testInfo) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.goto('/categorias');
        await expect(page.getByRole('heading', { name: 'Categorias', exact: true })).toBeVisible();
        const toggle = page.getByRole('button', { name: 'Alternar tema', exact: true });
        await expect(toggle).toBeVisible();
        // Exercise the actual button even when auto already resolves to the
        // requested scheme. Subsequent route changes retain its saved choice.
        if ((await page.locator('html').getAttribute('data-mantine-color-scheme')) === scheme) {
          await toggle.click();
        }
        await toggle.click();
        await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);

        const audit = async (
          required: Locator[],
          icons: Locator[] = [],
          options: { scope?: string; focus?: Locator[] } = {},
        ) => {
          // A populated Firestore state must have landed before the scan;
          // skeletons, missing rows, and a loading-only screen are failures.
          for (const target of required) {
            try {
              await target.waitFor({ state: 'visible', timeout: 20_000 });
            } catch (err) {
              if (!(err instanceof errors.TimeoutError)) throw err;
              await testInfo.attach(`theme-${scheme}-readiness.json`, {
                body: JSON.stringify(
                  { phase: 'readiness', scheme, locator: target.toString(), message: err.message },
                  null,
                  2,
                ),
                contentType: 'application/json',
              });
              await testInfo.attach(`theme-${scheme}-readiness.png`, {
                body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
                contentType: 'image/png',
              });
              throw err;
            }
          }
          await expectThemeReadable(page, testInfo, { scheme, required, icons, ...options });
        };

        // An opened foreground surface deliberately covers part of the page.
        // Audit all of that surface's text and controls, while the page itself
        // is checked on both sides of the open/close interaction.
        const foregroundScope = async (surface: Locator): Promise<string> => {
          await expect(surface).toBeVisible();
          const id = await surface.getAttribute('id');
          if (id) return `[id=${JSON.stringify(id)}]`;
          const labelledBy = await surface.getAttribute('aria-labelledby');
          expect(
            labelledBy,
            'Foreground dialog must have an identifiable accessible title',
          ).toBeTruthy();
          return `[aria-labelledby=${JSON.stringify(labelledBy)}]`;
        };

        await test.step('populated TableView and column-filter popover', async () => {
          await applyTextFilter(page, 'Nome', prefix);
          const rowText = page.getByText(`${prefix}-002`, { exact: true });
          await audit(
            [rowText, page.getByRole('link', { name: 'Nova categoria', exact: true }), toggle],
            [toggle, page.getByRole('button', { name: 'Filtrar Nome', exact: true })],
            { focus: [toggle] },
          );
          await page.getByRole('button', { name: 'Filtrar Nome', exact: true }).click();
          const filter = page.getByRole('dialog', { name: 'Filtrar Nome', exact: true });
          await audit(
            [
              filter.getByLabel('Nome contém', { exact: true }),
              filter.getByRole('button', { name: 'Aplicar', exact: true }),
            ],
            [],
            { scope: await foregroundScope(filter) },
          );
          await filter.getByLabel('Nome contém', { exact: true }).press('Escape');
          await expect(filter).not.toBeVisible();
          await audit([rowText]);
        });

        await test.step('notification bell and its populated popover', async () => {
          const bell = page.getByRole('button', { name: /^Avisos(?: \(|$)/ });
          await audit([bell], [bell]);
          await bell.click();
          const popup = page.getByRole('dialog', { name: 'Avisos', exact: true });
          const aviso = page.getByTestId('aviso-row').filter({ hasText: `${prefix}-shop` });
          await audit(
            [
              aviso.getByText('Autorização Shopee expirando', { exact: true }),
              aviso.getByText(new RegExp(`${prefix}-shop`)),
            ],
            [],
            { scope: await foregroundScope(popup) },
          );
          await page.keyboard.press('Escape');
          await expect(popup).not.toBeVisible();
          await audit([bell], [bell]);
        });

        await test.step('expanded sidebar links remain readable and reachable', async () => {
          const menu = page.getByRole('button', { name: 'Alternar menu', exact: true });
          await audit([menu]);
          await menu.click();
          await audit(
            [
              page.getByRole('link', { name: 'Início', exact: true }),
              page.getByRole('link', { name: 'Clientes', exact: true }),
              page.getByRole('link', { name: 'Categorias', exact: true }),
            ],
            [],
            { scope: 'nav.mantine-AppShell-navbar' },
          );
          await menu.click();
          await audit([page.getByRole('heading', { name: 'Categorias', exact: true })]);
        });

        await test.step('ObjectView fields and visible validation errors', async () => {
          await page.goto('/categorias/novo');
          const name = page.getByLabel('Nome', { exact: true });
          const create = page.getByRole('button', { name: 'Criar', exact: true });
          await audit([name, create, page.getByRole('link', { name: 'Cancelar', exact: true })]);
          await create.click();
          await expectFieldError(page, 'Nome');
          // The rendered error is tied to this field rather than a translated
          // Zod message, whose wording is allowed to change independently.
          const error = page.locator('[id$="-error"]').filter({ visible: true });
          await audit([name, error]);
        });

        await test.step('missing product thumbnail and populated product table', async () => {
          await page.goto('/produtos');
          await searchTableView(page, `${prefix}-kit`);
          await expect(page).toHaveURL((url) => url.searchParams.get('q') === `${prefix}-kit`);
          // This term is also the seeded document ID. Wait for its async
          // resolver to select the IDs query and for that single-result query
          // to replace the initial multi-row browse view before auditing it.
          await expectListMode(page, 'static', 'ids');
          await expect(page.getByRole('row')).toHaveCount(2, { timeout: 15_000 });
          const row = page.getByRole('row').filter({ hasText: `${prefix}-kit` });
          await expect(row).toHaveCount(1);
          if (viewport.name === 'mobile') {
            // The docked actions rail intentionally occupies the narrow
            // viewport. Audit its expanded content, then use its real collapse
            // control to reveal the table rather than clicking through it.
            const actions = page.getByRole('complementary', { name: 'Ações', exact: true });
            const collapse = actions.getByRole('button', { name: 'Recolher ações', exact: true });
            await audit(
              [
                collapse,
                actions.getByRole('link', { name: 'Novo produto', exact: true }),
                actions.getByText('0 selecionado(s)', { exact: true }),
              ],
              [collapse],
              { scope: 'aside[aria-label="Ações"]' },
            );
            await collapse.click();
            await expect(
              actions.getByRole('button', { name: 'Expandir ações', exact: true }),
            ).toHaveAttribute('aria-expanded', 'false');
          }
          // The product list uses its cached ProdutoFotoCell, whose missing
          // image state is named "Sem foto" (the pedido thumbnail has a
          // different label). The photo column is already visible here.
          const thumbnail = row.getByRole('img', { name: 'Sem foto', exact: true });
          await audit([row.getByText(`${prefix}-kit`, { exact: true }), thumbnail], [thumbnail]);
        });

        await test.step('seven stored chat-label colors', async () => {
          await page.goto('/chat?tab=todas');
          await audit(
            fixtures.tagged.map(({ nome }) => page.getByRole('link').filter({ hasText: nome })),
            [page.getByRole('button', { name: 'Buscar em todas as conversas', exact: true })],
          );
        });

        await test.step('selected-conversation bulk actions and confirmation dialog', async () => {
          const selection = page.getByRole('button', { name: 'Selecionar em massa', exact: true });
          await selection.click();
          for (const { nome } of fixtures.tagged.slice(0, 2)) {
            await page.getByRole('checkbox', { name: `Selecionar ${nome}`, exact: true }).check();
          }
          const count = page.getByText('2 selecionadas', { exact: true });
          const bulk = count.locator('..');
          const changeLabel = bulk.getByRole('checkbox', { name: 'Alterar etiqueta', exact: true });
          await audit([
            count,
            bulk.getByPlaceholder('Alterar estado…', { exact: true }),
            changeLabel,
          ]);
          await changeLabel.check();
          const color = bulk.getByRole('button', {
            name: `Etiqueta ${fixtures.tagged[0]!.cor}`,
            exact: true,
          });
          await color.click();
          const apply = bulk.getByRole('button', { name: 'Aplicar', exact: true });
          await audit([color, apply], [color]);
          await apply.click();
          const confirmation = page.getByRole('dialog', {
            name: 'Confirmar alterações',
            exact: true,
          });
          const cancel = confirmation.getByRole('button', { name: 'Cancelar', exact: true });
          await audit(
            [cancel, confirmation.getByRole('button', { name: 'Confirmar', exact: true })],
            [],
            { scope: await foregroundScope(confirmation) },
          );
          // Cancellation and leaving selection keep every seeded color intact.
          await cancel.click();
          await expect(confirmation).not.toBeVisible();
          await selection.click();
          await audit([selection], [selection]);
        });

        await test.step('selected conversation, three message roles, quote and referral', async () => {
          await page.goto(`/chat/${fixtures.untagged.id}?tab=todas`);
          const required = [
            page.locator('[data-side="entrada"]').getByText(fixtures.customerText, { exact: true }),
            page.locator('[data-side="saida"]').getByText(fixtures.operatorText, { exact: true }),
            page
              .locator('[data-side="entrada"]')
              .getByText(fixtures.otherOperatorText, { exact: true }),
            page.locator('[data-side="saida"]').getByText(fixtures.customerText, { exact: true }),
            page.getByText(fixtures.referralHeadline, { exact: true }),
            page.getByText(fixtures.referralBody, { exact: true }),
            page.getByPlaceholder('Digite uma mensagem…', { exact: true }),
          ];
          if (viewport.name === 'desktop') {
            required.push(
              page.locator('a[aria-current="true"]').filter({ hasText: fixtures.untagged.nome }),
            );
          }
          await audit(required, [page.getByRole('button', { name: 'Emojis', exact: true })]);
          await page.getByRole('button', { name: 'Ações da conversa', exact: true }).click();
          const actions = page.getByRole('menu');
          await audit(
            [
              page.getByRole('menuitem', { name: 'Renomear', exact: true }),
              page.getByRole('menuitem', { name: 'Definir etiqueta', exact: true }),
            ],
            [],
            { scope: await foregroundScope(actions) },
          );
          await page.keyboard.press('Escape');
          await expect(actions).not.toBeVisible();
          await audit([page.getByPlaceholder('Digite uma mensagem…', { exact: true })]);
          if (viewport.name === 'mobile') {
            const back = page.getByRole('link', { name: 'Voltar às conversas', exact: true });
            const detailsButton = page.getByRole('button', {
              name: 'Mostrar detalhes',
              exact: true,
            });
            await audit([back, detailsButton], [back, detailsButton]);
            await detailsButton.click();
            const details = page.getByRole('dialog', { name: 'Detalhes da conversa', exact: true });
            const closeDetails = details.getByRole('button', {
              name: 'Ocultar detalhes',
              exact: true,
            });
            await audit(
              [details.getByRole('link', { name: 'Abrir cliente', exact: true }), closeDetails],
              [closeDetails],
              { scope: await foregroundScope(details) },
            );
            await closeDetails.click();
            await expect(details).not.toBeVisible();
            await audit([back, detailsButton], [back, detailsButton]);
          }
        });

        await test.step('emoji-picker content and enabled compose controls', async () => {
          await page.getByRole('button', { name: 'Emojis', exact: true }).click();
          const popup = page.getByRole('dialog', { name: 'Emojis', exact: true });
          const picker = page.locator('em-emoji-picker');
          await expect(picker).toBeVisible({ timeout: 20_000 });
          await expect(picker.locator('[data-theme]')).toHaveAttribute('data-theme', scheme);
          const search = picker.locator('input[type="search"]');
          await audit([search], [], { scope: await foregroundScope(popup) });
          await search.fill('grinning');
          // emoji-mart's accessible name is the native glyph, while its search
          // data keeps English keywords even with Portuguese UI controls.
          const emoji = picker.getByRole('button', { name: '😀', exact: true });
          await audit([search, emoji], [], { scope: await foregroundScope(popup) });
          // Picking a glyph edits the draft only. No Enter or send click occurs.
          await emoji.click();
          await expect(popup).not.toBeVisible();
          const send = page.getByRole('button', { name: 'Enviar', exact: true });
          await audit([send], [send]);
        });

        await test.step('highlighted and unmatched stock rows keep usable controls', async () => {
          await page.goto(`/produtos/${fixtures.stock.parentId}/editar`);
          await page.getByRole('tab', { name: 'Estoque', exact: true }).click();
          const filter = page.getByLabel('Filtrar', { exact: true }).filter({ visible: true });
          await filter.fill(fixtures.stock.childSku);
          const location = (id: string) =>
            page.getByLabel(`Localização ${id} ${fixtures.kit.depositoNome}`, { exact: true });
          const edit = (id: string) =>
            page.getByRole('button', {
              name: `Editar estoque ${id} ${fixtures.kit.depositoNome}`,
              exact: true,
            });
          await audit(
            [
              filter,
              location(fixtures.stock.childId),
              location(fixtures.stock.unmatchedId),
              edit(fixtures.stock.childId),
              edit(fixtures.stock.unmatchedId),
            ],
            [edit(fixtures.stock.childId), edit(fixtures.stock.unmatchedId)],
          );
          await edit(fixtures.stock.unmatchedId).click();
          const modal = page.getByRole('dialog', { name: 'Edição de estoque', exact: true });
          await audit(
            [
              modal.getByLabel('Quantidade', { exact: true }),
              modal.getByRole('button', { name: 'Salvar', exact: true }),
            ],
            [],
            { scope: await foregroundScope(modal) },
          );
          await page.keyboard.press('Escape');
          await expect(modal).not.toBeVisible();
          await audit([edit(fixtures.stock.unmatchedId)], [edit(fixtures.stock.unmatchedId)]);
        });

        await test.step('kit alternating rows, staged removal status and undo', async () => {
          await page.goto(`/produtos/${fixtures.kit.kitId}/editar`);
          await page.getByRole('tab', { name: 'Kit', exact: true }).click();
          const expectedComponentLabels = [fixtures.kit.comp1Id, fixtures.kit.comp2Id].map(
            (id) => `${id.toUpperCase().replace(/-/g, '_')} - ${id}`,
          );
          const componentLabels = expectedComponentLabels.map((label) =>
            page.getByText(label, { exact: true }).filter({ visible: true }),
          );
          const costSummary = page.getByText(/^Custo do kit:/);
          // ComponentLabel first renders the ID, then its independent snapshot
          // expands it to SKU + name. The rollup also changes header layout;
          // require the actual seeded data before measuring row reachability.
          for (const label of componentLabels) {
            await expect(label).toBeVisible({ timeout: 20_000 });
          }
          await expect(costSummary).toHaveText(/^Custo do kit:\s*R\$\s*50,00$/, {
            timeout: 20_000,
          });
          const quantity = page.getByLabel('Qtd', { exact: true }).filter({ visible: true });
          const remove = page.getByRole('button', {
            name: `Remover componente ${fixtures.kit.comp2Id}`,
            exact: true,
          });
          await audit(
            [...componentLabels, costSummary, quantity.nth(0), quantity.nth(1), remove],
            [remove],
          );
          await remove.click();
          const undo = page.getByRole('button', {
            name: `Desfazer remoção ${fixtures.kit.comp2Id}`,
            exact: true,
          });
          await audit(
            [
              ...componentLabels,
              costSummary,
              page.getByText('Será removido', { exact: true }),
              undo,
            ],
            [undo],
          );
          await undo.click();
          await audit([...componentLabels, costSummary, remove, quantity.nth(1)], [remove]);
        });
      });
    }
  }
});
