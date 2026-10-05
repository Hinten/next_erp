import { expect, test } from '@playwright/test';
import { PERM } from '@delfrance/auth';
import {
  createAccessTestActor,
  cleanupAccessTestActor,
  type AccessTestActor,
} from '@delfrance/test-fixtures';
import { submitAccessOperation } from './_helpers/access-operations';
import {
  deleteAuthUserByEmail,
  deleteCargoById,
  deleteUsuarioDoc,
  getUserPermissionsClaim,
} from './_helpers/admin-cleanup';
import { getRunId, workerIndex } from './_helpers/run-id';
import { e2ePrefix } from './_helpers/seed-data';

/**
 * Real HTTP + staging Firestore/Auth coverage of coordinated access changes.
 * Each worker owns an ephemeral actor with both source authorization and claims.
 * The test runner delivers accepted operations to the real worker core; task
 * dispatch/retry transport is independently covered in the Functions suite.
 * This avoids coupling a PR's UI to whichever worker revision staging runs.
 * Parallel push/PR runs exercise the global reservation and retry only 409 busy.
 * No authorization guard or production handler is bypassed.
 */
test.describe.serial('Configuracoes — cargo + usuario CRUD', () => {
  test.setTimeout(180_000);
  test.use({ storageState: { cookies: [], origins: [] } });

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
  let actor: AccessTestActor;
  test.beforeAll(async () => {
    actor = await createAccessTestActor(
      `e2e-user-${runId}-access-w${workerIndex()}@delfrance.test`,
      userPassword,
    );
  });
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(actor.email);
    await page.getByLabel('Senha').fill(userPassword);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL('**/inicio');
  });

  // bits we'll grant to the cargo: cliente.read | cliente.write
  const initialBits = PERM.cliente.read | PERM.cliente.write;
  // after edit: + cliente.delete
  const editedBits = initialBits | PERM.cliente.delete;

  let cargoId = '';
  let userUid = '';

  test.afterAll(async () => {
    if (actor) await cleanupAccessTestActor(actor);
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

    const receipt = await submitAccessOperation(page, actor, '/api/admin/cargos', 'POST', 'Criar');
    cargoId = receipt.targetId;

    await expect(page.getByText('Atualização concluída', { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await page.getByRole('link', { name: 'Abrir registro' }).click();

    // Opens the detail page; URL ends with the new doc id. `/cargos/novo`
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
    // The form only mounts once the versioned editor request resolves (a Skeleton renders
    // until then), so gate on the loaded name before touching a checkbox.
    await expect(page.getByLabel('Nome')).toHaveValue(cargoNome);

    // Scope to the card: an unscoped `Excluir` would also match the red delete
    // button this page renders for callers holding configuracoes.write.
    const clientesCard = page.locator('.mantine-Card-root').filter({ hasText: 'Clientes' }).first();
    await clientesCard.getByLabel('Excluir').check();

    await submitAccessOperation(page, actor, `/api/admin/cargos/${cargoId}`, 'PATCH', /Salvar/i);
    // Completion means the server finished applying the claims, not just accepted the command.
    await expect(page.getByText('Atualização concluída', { exact: true })).toBeVisible({
      timeout: 120_000,
    });

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
    await page.getByLabel('Colaborador interno', { exact: true }).check();

    // Mantine MultiSelect: click the field, pick the option by visible text.
    // Scope to the combobox role, not a bare getByLabel — the open dropdown's
    // listbox carries the same accessible name, which trips strict mode (the
    // same trap documented in produto-variacoes.cadastros.e2e.spec.ts).
    await page.getByRole('combobox', { name: 'Cargos' }).click();
    await page.getByRole('option', { name: cargoNome }).click();
    await page.keyboard.press('Escape');

    const receipt = await submitAccessOperation(
      page,
      actor,
      '/api/admin/users',
      'POST',
      'Criar usuário',
    );
    userUid = receipt.targetId;
    expect(userUid).not.toBe('');

    await expect(page.getByText('Atualização concluída', { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await page.getByRole('link', { name: 'Abrir registro' }).click();
    await page.waitForURL(`/configuracoes/usuarios/${userUid}`);

    // Admin SDK: claim.permissions must be the aggregated bitmask.
    const perms = await getUserPermissionsClaim(userEmail);
    expect(perms).toBe(editedBits.toString());
  });

  test('editar cargo atualiza automaticamente as claims do usuário atribuído', async ({ page }) => {
    await page.goto(`/configuracoes/cargos/${cargoId}`);
    await expect(page.getByLabel('Nome')).toHaveValue(cargoNome);
    const card = page.locator('.mantine-Card-root').filter({ hasText: 'Clientes' }).first();
    await card.getByLabel('Editar').uncheck();
    await card.getByLabel('Excluir').uncheck();
    await submitAccessOperation(page, actor, `/api/admin/cargos/${cargoId}`, 'PATCH', /Salvar/i);
    await expect(page.getByText('Atualização concluída', { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    expect(await getUserPermissionsClaim(userEmail)).toBe(PERM.cliente.read.toString());
  });

  test('edita usuario pelo endpoint e zera os bits ao remover o cargo', async ({ page }) => {
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

    await submitAccessOperation(page, actor, `/api/admin/users/${userUid}`, 'PATCH', /Salvar/i);

    // Completion means the server finished applying the claims, not just accepted the command.
    await expect(page.getByText('Atualização concluída', { exact: true })).toBeVisible({
      timeout: 120_000,
    });

    const perms = await getUserPermissionsClaim(userEmail);
    expect(perms).toBe('0');
  });
});
