import { expect, test } from '@playwright/test';
import { PERM } from '@delfrance/auth';
import { requireSuAuthEnv } from './_helpers/auth';
import {
  deleteAuthUserByEmail,
  deleteCargoById,
  deleteUsuarioDoc,
  getUserPermissionsClaim,
} from './_helpers/admin-cleanup';
import { getRunId } from './_helpers/run-id';

/**
 * End-to-end coverage for the User+Cargo CRUD flow against Firebase staging.
 *
 * Pre-reqs (one-time per test Firebase project):
 *   1. Create a test superuser: e.g. `e2e-su@delfrance.test` with known password.
 *   2. Grant ALL_PERMS:
 *        pnpm --filter @delfrance/test-fixtures \
 *          exec tsx src/grant-all-perms.ts e2e-su@delfrance.test
 *   3. Set env vars when running tests:
 *        E2E_SU_EMAIL, E2E_SU_PASSWORD,
 *        FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT (or *_PATH),
 *        NEXT_PUBLIC_INTEGRATIONS_URL (defaults to http://localhost:3001 in dev)
 *
 * Tests run serially (`describe.serial`): later steps consume entities created
 * in earlier steps. `afterAll` cleans up every doc/user it touched.
 *
 * #31: E2E_SU_EMAIL/E2E_SU_PASSWORD missing is a hard failure here
 * (`requireSuAuthEnv()`), not a silent skip — this is the one suite that
 * actually needs the SU session, so a misconfigured secret should fail loud.
 */

test.describe.serial('Configuracoes — cargo + usuario CRUD', () => {
  test.beforeAll(() => {
    requireSuAuthEnv();
  });
  test.use({ storageState: 'e2e/.auth/su.json' });

  const runId = getRunId();
  const cargoNome = `E2E Cargo ${runId}`;
  const userNome = `E2E User ${runId}`;
  const userEmail = `e2e-user-${runId}@delfrance.test`;
  const userPassword = 'E2EpasswordTest!1';

  // bits we'll grant to the cargo: cliente.read | cliente.write
  const initialBits = PERM.cliente.read | PERM.cliente.write;
  // after edit: + cliente.delete
  const editedBits = initialBits | PERM.cliente.delete;

  let cargoId = '';
  let userUid = '';

  test.afterAll(async () => {
    if (userUid) {
      await deleteUsuarioDoc(userUid).catch(() => {});
    }
    await deleteAuthUserByEmail(userEmail).catch(() => {});
    if (cargoId) {
      await deleteCargoById(cargoId).catch(() => {});
    }
  });

  test('cria cargo via /configuracoes/cargos/novo', async ({ page }) => {
    await page.goto('/configuracoes/cargos/novo');
    await expect(page.getByRole('heading', { name: 'Novo cargo' })).toBeVisible();

    await page.getByLabel('Nome').fill(cargoNome);

    // PermissionEditor renders one Card per domain. Scope by card text.
    const clientesCard = page.locator('.mantine-Card-root').filter({ hasText: 'Clientes' }).first();
    await clientesCard.getByLabel('Ler').check();
    await clientesCard.getByLabel('Editar').check();

    await page.getByRole('button', { name: 'Criar' }).click();

    // Redirects to detail page; URL ends with the new doc id.
    await page.waitForURL(/\/configuracoes\/cargos\/[^/]+$/);
    const segments = page.url().split('/');
    cargoId = segments[segments.length - 1] ?? '';
    expect(cargoId).not.toBe('');

    await expect(page.getByRole('heading', { name: cargoNome })).toBeVisible();
    await expect(page.getByText('Clientes: Ler')).toBeVisible();
    await expect(page.getByText('Clientes: Editar')).toBeVisible();
  });

  test('edita cargo: adiciona cliente.delete', async ({ page }) => {
    expect(cargoId).not.toBe('');
    await page.goto(`/configuracoes/cargos/${cargoId}/editar`);
    await expect(page.getByRole('heading', { name: 'Editar cargo' })).toBeVisible();

    const clientesCard = page.locator('.mantine-Card-root').filter({ hasText: 'Clientes' }).first();
    await clientesCard.getByLabel('Excluir').check();

    await page.getByRole('button', { name: /Salvar/i }).click();
    await page.waitForURL(`/configuracoes/cargos/${cargoId}`);
    await expect(page.getByText('Clientes: Excluir')).toBeVisible();
  });

  test('cria usuario via endpoint admin + claim agregada', async ({ page }) => {
    expect(cargoId).not.toBe('');
    await page.goto('/configuracoes/usuarios/novo');
    await expect(page.getByRole('heading', { name: 'Novo usuário' })).toBeVisible();

    await page.getByLabel('Nome').fill(userNome);
    await page.getByLabel('E-mail').fill(userEmail);
    await page.getByLabel('Senha provisória').fill(userPassword);

    // Mantine MultiSelect: click the field, pick the option by visible text.
    await page.getByLabel('Cargos').click();
    await page.getByRole('option', { name: cargoNome }).click();
    await page.keyboard.press('Escape');

    const createResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/admin/users') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Criar usuário' }).click();
    const response = await createResp;
    expect(response.status()).toBe(201);
    const body = (await response.json()) as { uid: string };
    userUid = body.uid;
    expect(userUid).not.toBe('');

    await page.waitForURL(`/configuracoes/usuarios/${userUid}`);

    // Admin SDK: claim.permissions must be the aggregated bitmask.
    const perms = await getUserPermissionsClaim(userEmail);
    expect(perms).toBe(editedBits.toString());
  });

  test('edita usuario: remove cargo aciona refreshClaims e zera bits', async ({ page }) => {
    expect(userUid).not.toBe('');
    await page.goto(`/configuracoes/usuarios/${userUid}/editar`);
    await expect(page.getByRole('heading', { name: 'Editar usuário' })).toBeVisible();

    // Remove the cargo pill from the MultiSelect. Mantine v9 renders an
    // aria-label="remove" button on each Pill.
    const pill = page.locator('.mantine-Pill-root').filter({ hasText: cargoNome }).first();
    await pill.getByLabel(/remove|remover/i).click();

    const refreshResp = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/admin/users/${userUid}/claims`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /Salvar/i }).click();
    const response = await refreshResp;
    expect(response.status()).toBe(200);

    await page.waitForURL(`/configuracoes/usuarios/${userUid}`);

    const perms = await getUserPermissionsClaim(userEmail);
    expect(perms).toBe('0');
  });
});
