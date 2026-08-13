import { expect, test } from '@playwright/test';
import { PERM } from '@delfrance/auth';
import { requireSuAuthEnv } from './_helpers/auth';
import {
  deleteAuthUserByEmail,
  deleteCargoById,
  deleteUsuarioDoc,
  getUserPermissionsClaim,
} from './_helpers/admin-cleanup';
import { getRunId, workerIndex } from './_helpers/run-id';
import { e2ePrefix } from './_helpers/seed-data';

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
 * The last two tests POST to the admin endpoints, which live in
 * `apps/integrations` (:3001) — NOT in apps/web, which has no route handlers at
 * all. Locally, root `pnpm dev` brings that app up alongside web. In CI the
 * vendas lane builds and serves it too (`integrations: true` in
 * e2e-vendas.yml); without it the calls 404 against :3000.
 *
 * Tests run serially (`describe.serial`): later steps consume entities created
 * in earlier steps. `afterAll` cleans up every doc/user it touched.
 *
 * The cargo/usuario `[id]/editar` routes were collapsed into `[id]` by
 * c034a7b — the detail page IS the edit form. So each `[id]` page shows the
 * static entity heading ("Cargo" / "Usuário"), saving redirects to the LIST,
 * and granted permission bits read back as ticked checkboxes rather than a text
 * summary. This suite could not observe that drift for two months: it skipped
 * itself while E2E_SU_EMAIL/E2E_SU_PASSWORD went unset (#674).
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
  // Names carry the standard `e2e-<runId>-` prefix so the orphan sweep can find
  // them (#712). The cargo gets a Firestore auto-id and the usuário's id is the
  // Auth uid, so before this the prefix appeared in neither the id nor a field —
  // and the only cleanup was by captured id, which a cancelled run loses. Both
  // list pages are ordered by `nome` and capped at 50 rows.
  const prefix = e2ePrefix('cfg');
  const cargoNome = `${prefix}-cargo`;
  const userNome = `${prefix}-user`;
  // `e2e-user-` is what `sweepStaleE2EUsers` matches on — keep that shape.
  // ⚠️ Worker-scoped for the same reason `e2ePrefix` is: this group is
  // `describe.serial`, so a retry runs in a FRESH worker while the previous
  // one is still draining `afterAll`. Run-scoped only, the retry's create hits
  // `EMAIL_EXISTS`, or the late `deleteAuthUserByEmail` deletes the account the
  // retry is about to assert claims on. The Auth email is a separate axis that
  // does NOT go through `e2ePrefix`.
  const userEmail = `e2e-user-${runId}-w${workerIndex()}@delfrance.test`;
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

    // Redirects to the detail page; URL ends with the new doc id. `/cargos/novo`
    // ALSO matches a naive `/cargos/[^/]+$` pattern, and waitForURL resolves
    // immediately when the current URL already matches — so exclude the create
    // route explicitly, or `cargoId` silently captures the string "novo".
    await page.waitForURL(
      (url) =>
        /^\/configuracoes\/cargos\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith('/novo'),
    );
    const segments = page.url().split('/');
    cargoId = segments[segments.length - 1] ?? '';
    expect(cargoId).not.toBe('');

    // The detail page carries the static entity heading (see the file header on
    // the collapsed `/editar` routes), and the persisted bits come back as
    // ticked checkboxes — which also proves the doc round-tripped Firestore.
    await expect(page.getByRole('heading', { name: 'Cargo' })).toBeVisible();
    await expect(page.getByLabel('Nome')).toHaveValue(cargoNome);
    await expect(clientesCard.getByLabel('Ler')).toBeChecked();
    await expect(clientesCard.getByLabel('Editar')).toBeChecked();
  });

  test('edita cargo: adiciona cliente.delete', async ({ page }) => {
    expect(cargoId).not.toBe('');
    await page.goto(`/configuracoes/cargos/${cargoId}`);
    await expect(page.getByRole('heading', { name: 'Cargo' })).toBeVisible();
    // The form only mounts once useDocSnapshot resolves (a Skeleton renders
    // until then), so gate on the loaded name before touching a checkbox.
    await expect(page.getByLabel('Nome')).toHaveValue(cargoNome);

    // Scope to the card: an unscoped `Excluir` would also match the red delete
    // button this page renders for callers holding configuracoes.write.
    const clientesCard = page.locator('.mantine-Card-root').filter({ hasText: 'Clientes' }).first();
    await clientesCard.getByLabel('Excluir').check();

    await page.getByRole('button', { name: /Salvar/i }).click();
    // Saving redirects to the LIST, not back to the detail page.
    await page.waitForURL('/configuracoes/cargos');

    // Re-open the record to assert the new bit actually persisted.
    await page.goto(`/configuracoes/cargos/${cargoId}`);
    await expect(page.getByLabel('Nome')).toHaveValue(cargoNome);
    await expect(clientesCard.getByLabel('Excluir')).toBeChecked();
  });

  test('cria usuario via endpoint admin + claim agregada', async ({ page }) => {
    expect(cargoId).not.toBe('');
    await page.goto('/configuracoes/usuarios/novo');
    await expect(page.getByRole('heading', { name: 'Novo usuário' })).toBeVisible();

    await page.getByLabel('Nome').fill(userNome);
    await page.getByLabel('E-mail').fill(userEmail);
    await page.getByLabel('Senha provisória').fill(userPassword);

    // Mantine MultiSelect: click the field, pick the option by visible text.
    // Scope to the combobox role, not a bare getByLabel — the open dropdown's
    // listbox carries the same accessible name, which trips strict mode (the
    // same trap documented in produto-variacoes.cadastros.e2e.spec.ts).
    await page.getByRole('combobox', { name: 'Cargos' }).click();
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
    await page.goto(`/configuracoes/usuarios/${userUid}`);
    await expect(page.getByRole('heading', { name: 'Usuário' })).toBeVisible();
    await expect(page.getByLabel('Nome')).toHaveValue(userNome);

    // Deselect the cargo by toggling its option back off in the dropdown —
    // Mantine's MultiSelect treats a click on an already-selected option as a
    // removal (`onOptionSubmit` filters it out of the value). The Pill's own
    // remove button is an internal detail; #20 flagged relying on its
    // aria-label as a flake risk.
    await page.getByRole('combobox', { name: 'Cargos' }).click();
    await page.getByRole('option', { name: cargoNome }).click();
    await page.keyboard.press('Escape');

    const refreshResp = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/admin/users/${userUid}/claims`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /Salvar/i }).click();
    const response = await refreshResp;
    expect(response.status()).toBe(200);

    // Saving redirects to the LIST, not back to the detail page.
    await page.waitForURL('/configuracoes/usuarios');

    const perms = await getUserPermissionsClaim(userEmail);
    expect(perms).toBe('0');
  });
});
