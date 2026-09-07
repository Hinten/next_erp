import { expect, test } from '@playwright/test';
import { getAuth } from 'firebase-admin/auth';
import { getApp } from '@delfrance/test-fixtures';
import { E2E_SU_EMAIL } from './_helpers/auth';
import {
  cleanupAvisos,
  e2ePrefix,
  resetAvisosLeitura,
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
  let suUid = '';

  test.beforeAll(async () => {
    const user = await getAuth(getApp()).getUserByEmail(E2E_SU_EMAIL);
    suUid = user.uid;
    // A previous run left this operator's watermark behind; without the reset
    // everything would already read as read and every assertion below would pass
    // for the wrong reason.
    await resetAvisosLeitura(suUid);
    const seeded = await seedAvisos(prefix);
    ids = seeded.ids;
  });

  test.afterAll(async () => {
    await cleanupAvisos(ids);
    await resetAvisosLeitura(suUid);
  });

  test('mostra apenas os avisos endereçados a este operador', async ({ page }) => {
    await page.goto('/inicio');

    await expect(page.getByText(`${prefix}-loja`)).toBeVisible();
    await expect(page.getByText('Canal sem credencial válida')).toBeVisible();
    // Addressed to another operator: present in the collection, absent here.
    await expect(page.getByText('cancelamento solicitado')).toHaveCount(0);
  });

  test('marcar UMA como lida não afeta as outras, e sobrevive ao reload', async ({ page }) => {
    await page.goto('/inicio');

    const naoLidas = page.locator('[data-testid="aviso-row"][data-nao-lido="true"]');
    await expect(naoLidas).toHaveCount(2);

    await page
      .locator('[data-testid="aviso-row"]')
      .filter({ hasText: `${prefix}-loja` })
      .getByText('Marcar como lida')
      .click();

    await expect(naoLidas).toHaveCount(1);

    await page.reload();
    await expect(page.locator('[data-testid="aviso-row"][data-nao-lido="true"]')).toHaveCount(1);
  });

  test('marcar todas como lidas limpa a contagem e sobrevive ao reload', async ({ page }) => {
    await page.goto('/inicio');

    await page.getByRole('button', { name: 'Marcar todas como lidas' }).click();
    await expect(page.getByText('Tudo lido')).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-testid="aviso-row"][data-nao-lido="true"]')).toHaveCount(0);
    await expect(page.getByText('Tudo lido')).toBeVisible();
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
    await expect(page.locator('[data-testid="aviso-row"][data-nao-lido="true"]')).toHaveCount(1);
  });
});
