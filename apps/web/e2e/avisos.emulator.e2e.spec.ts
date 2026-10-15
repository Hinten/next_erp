import { expect, test, type Page } from '@playwright/test';
import { getAuth } from 'firebase-admin/auth';
import { getApp } from '@delfrance/test-fixtures';
import { e2eUserEmail } from './_helpers/run-id';
import {
  cleanupAvisos,
  e2ePrefix,
  escreverAvisoReal,
  resetAvisosLeitura,
  resolverAvisoReal,
  seedAvisoUnico,
  seedAvisos,
} from './_helpers/seed-data';

/**
 * The avisos bell end to end: what the operator sees, what they can dismiss, and
 * what survives a reload.
 *
 * Emulator lane because the read state is a per-user document governed by a
 * hand-written rules block (`avisosLeitura/{uid}`, scoped to
 * `request.auth.uid`), and the point of most assertions is what LANDED — a badge
 * that clears on screen proves the component, not the write. A reload is what
 * separates the two.
 */
test.describe.serial('Avisos — a caixa de avisos do operador', () => {
  const prefix = e2ePrefix('avisos');
  let ids: string[] = [];
  let e2eUid = '';

  // Other suites can deliver legitimate avisos to this same run-scoped
  // operator. Every fixture has prefix-bearing visible copy, so read-state
  // assertions describe our notices rather than an unstable inbox total.
  const ownRows = (page: Page) => page.getByTestId('aviso-row').filter({ hasText: prefix });
  const ownUnreadRows = (page: Page) =>
    page.locator('[data-testid="aviso-row"][data-nao-lido="true"]').filter({ hasText: prefix });

  test.beforeAll(async () => {
    // The signed-in identity here is the EPHEMERAL test user minted per run by
    // `global-setup.ts`, not the SU: `E2E_SU_EMAIL` is only set for the
    // `configuracoes` project and is empty in this lane, which is exactly how the
    // first run of this spec died. Same idiom as `pedidos-estado.vendas.e2e.spec.ts`.
    const user = await getAuth(getApp()).getUserByEmail(e2eUserEmail());
    e2eUid = user.uid;
    // A previous run left this operator's watermark behind; without the reset
    // everything would already read as read and every assertion below would pass
    // for the wrong reason.
    await resetAvisosLeitura(e2eUid);
    const seeded = await seedAvisos(prefix);
    ids = seeded.ids;
  });

  test.afterAll(async () => {
    await cleanupAvisos(ids);
    // Only when `beforeAll` got far enough to resolve it. Without the guard a
    // failed setup reports TWICE — once for the real cause, once for the empty
    // uid here — and the second one is the louder, more misleading of the two.
    if (e2eUid) await resetAvisosLeitura(e2eUid);
  });

  test('mostra apenas os avisos endereçados a este operador', async ({ page }) => {
    await page.goto('/inicio');

    await expect(page.getByText(`${prefix}-loja`)).toBeVisible();
    await expect(ownRows(page).getByText('Canal sem credencial válida')).toBeVisible();
    // Addressed to another operator: present in the collection, absent here.
    await expect(ownRows(page).filter({ hasText: `${prefix}-ped` })).toHaveCount(0);
  });

  test('marcar UMA como lida não afeta as outras, e sobrevive ao reload', async ({ page }) => {
    await page.goto('/inicio');

    const naoLidas = ownUnreadRows(page);
    await expect(naoLidas).toHaveCount(2);

    await page
      .locator('[data-testid="aviso-row"]')
      .filter({ hasText: `${prefix}-loja` })
      .getByText('Marcar como lida')
      .click();

    await expect(naoLidas).toHaveCount(1);
    await expect(ownRows(page).filter({ hasText: `${prefix}-loja` })).toHaveAttribute(
      'data-nao-lido',
      'false',
    );
    await expect(ownRows(page).filter({ hasText: `${prefix}-Shopee` })).toHaveAttribute(
      'data-nao-lido',
      'true',
    );

    await page.reload();
    await expect(ownUnreadRows(page)).toHaveCount(1);
    await expect(ownRows(page).filter({ hasText: `${prefix}-loja` })).toHaveAttribute(
      'data-nao-lido',
      'false',
    );
    await expect(ownRows(page).filter({ hasText: `${prefix}-Shopee` })).toHaveAttribute(
      'data-nao-lido',
      'true',
    );
  });

  test('marcar todas como lidas persiste a leitura de cada aviso após reload', async ({ page }) => {
    await page.goto('/inicio');

    await page.getByRole('button', { name: 'Marcar todas como lidas' }).click();
    await expect(ownUnreadRows(page)).toHaveCount(0);
    await expect(ownRows(page)).toHaveCount(2);

    await page.reload();
    await expect(ownUnreadRows(page)).toHaveCount(0);
    await expect(ownRows(page)).toHaveCount(2);
    // Read notices stay visible; concurrent newly raised notices may correctly
    // keep the global header count positive after this action.
    await expect(ownRows(page).filter({ hasText: `${prefix}-loja` })).toHaveAttribute(
      'data-nao-lido',
      'false',
    );
    await expect(ownRows(page).filter({ hasText: `${prefix}-Shopee` })).toHaveAttribute(
      'data-nao-lido',
      'false',
    );
  });

  test('um aviso levantado DEPOIS de marcar todas volta a contar como não lido', async ({
    page,
  }) => {
    // The watermark covers what existed when it moved, not what comes after —
    // otherwise a problem that recurs once the operator has tidied up would be
    // invisible forever, which is the failure the whole read model exists to
    // avoid.
    const novo = `${prefix}-a4`;
    ids.push(novo);
    await seedAvisoUnico(novo, `${prefix}-nova-loja`);

    await page.goto('/inicio');
    await expect(page.getByText(`${prefix}-nova-loja`)).toBeVisible();
    await expect(ownUnreadRows(page)).toHaveCount(1);
    await expect(ownRows(page).filter({ hasText: `${prefix}-nova-loja` })).toHaveAttribute(
      'data-nao-lido',
      'true',
    );
    await expect(
      page.getByRole('button', { name: /^Avisos \([1-9]\d* não lidos\)$/ }),
    ).toBeVisible();
  });

  test('um aviso lido individualmente volta a contar como não lido quando REABRE, e não quando repete', async ({
    page,
  }) => {
    // The writer reopens a resolved aviso under the SAME id with a fresh
    // `criadoEm`, so the problem that came back re-alerts. A per-item read must
    // cover only the version it saw, or the reopen stays silenced; and a repeat
    // (same `criadoEm`) must NOT re-alert, or dedup is pointless. Both are driven
    // through the real `escreverAviso` / `resolverAviso`.
    const loja = `${prefix}-reaberta`;
    const chave = await escreverAvisoReal(`${prefix}-conta-reaberta`, loja);
    ids.push(chave);
    const linha = () => page.locator('[data-testid="aviso-row"]').filter({ hasText: loja });

    await page.goto('/inicio');
    await expect(linha()).toHaveAttribute('data-nao-lido', 'true');
    await linha().getByText('Marcar como lida').click();
    await expect(linha()).toHaveAttribute('data-nao-lido', 'false');

    // Repeat: same problem, another occurrence — stays read.
    await escreverAvisoReal(`${prefix}-conta-reaberta`, loja);
    await page.reload();
    await expect(linha()).toHaveAttribute('data-nao-lido', 'false');

    // Reopen: resolved, then raised again — unread for this operator again.
    await resolverAvisoReal(chave);
    await escreverAvisoReal(`${prefix}-conta-reaberta`, loja);
    await page.reload();
    await expect(linha()).toHaveAttribute('data-nao-lido', 'true');
  });
});
