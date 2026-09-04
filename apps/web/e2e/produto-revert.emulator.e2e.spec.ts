import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  listHistoricoModificacoes,
  seedListasDePreco,
  seedProdutoComFilho,
  setProdutoFields,
} from './_helpers/seed-data';
import {
  clickSave,
  expectFieldValue,
  expectMoneyValue,
  fillField,
  typeMoney,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the "Modificações" tab (unified modification
 * history + per-field revert) on the produto edit screen. Where
 * `produto-preco.emulator.e2e.spec.ts` proves the trigger writes the right
 * `historicoDeModificacoes` documents, THIS spec drives the actual revert UI
 * on top of them.
 *
 * ## Restaurar STAGES; "Salvar alterações" writes (#660)
 *
 * Every scenario below is in two halves, and the seam between them is the
 * point: the click pre-fills the form and leaves Firestore ALONE, and only the
 * operator's own save commits it. That is what makes the revert reviewable, and
 * what stops a dirty form's next save from silently overwriting it — the bug
 * this behaviour replaced.
 *
 * Emulator-only (`e2e-emulator.yml`): the functions emulator must be running
 * for `onProdutoChanged` to fire on every write this spec makes (including the
 * save that commits a revert — it is a normal produto write, so it logs its OWN
 * new history entry, and for `precos` re-propagates to the variation children,
 * which is what scenario (c) asserts).
 */
test.describe.serial('Produto revert e2e — histórico unificado + restauração por campo', () => {
  // Group A: nome revert (a), conflict (b) and discard (d), reusing the same
  // produto across all three — each picks up from the previous one's state.
  const prefixA = e2ePrefix('prod-revert-nome');
  // Group C: precos revert + re-propagation to a variation child (scenario c).
  const prefixC = e2ePrefix('prod-revert-preco');

  let produtoAId = '';
  let produtoAChildId = '';
  let nomeOriginal = '';

  let parentCId = '';
  let childCId = '';
  let varejoId = '';
  let varejoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const [seededA, seededC, listas] = await Promise.all([
      seedProdutoComFilho(prefixA),
      seedProdutoComFilho(prefixC),
      seedListasDePreco(prefixC),
    ]);
    produtoAId = seededA.parentId;
    produtoAChildId = seededA.childId;
    nomeOriginal = seededA.parentNome;
    parentCId = seededC.parentId;
    childCId = seededC.childId;
    varejoId = listas.varejoId;
    varejoNome = listas.varejoNome;
    await warmRoutes(browser, [`/produtos/${produtoAId}/editar`, `/produtos/${parentCId}/editar`]);
  });

  test.afterAll(async () => {
    await Promise.all([
      cleanupProdutoSubcollection(produtoAId, 'historicoDeModificacoes'),
      cleanupProdutoSubcollection(produtoAChildId, 'historicoDeModificacoes'),
      cleanupProdutoSubcollection(parentCId, 'historicoDeModificacoes'),
      cleanupProdutoSubcollection(childCId, 'historicoDeModificacoes'),
    ]);
    await cleanupByNamePrefix('produtos', prefixA);
    await cleanupByNamePrefix('produtos', prefixC);
    await cleanupByNamePrefix('listaDePrecos', prefixC);
  });

  /** Entries whose `campos` names `field` as one of the changed top-level fields. */
  function findByChangedField(
    entries: Array<Record<string, unknown>>,
    field: string,
  ): Array<Record<string, unknown>> {
    return entries.filter(
      (e) => Array.isArray(e.campos) && (e.campos as unknown[]).includes(field),
    );
  }

  /** The `{old, new}` pair an entry recorded for `field`, or undefined if untouched. */
  function fieldChange(
    entry: Record<string, unknown>,
    field: string,
  ): { old: unknown; new: unknown } | undefined {
    const changes = entry.changes as Record<string, { old: unknown; new: unknown }> | undefined;
    return changes?.[field];
  }

  /**
   * Open the produto's Modificações tab on a FRESH navigation, so no staged
   * pre-fill from an earlier scenario is still sitting in the form. (The list
   * itself streams its first page, so a remount is not needed to see new rows —
   * it is the form state a remount clears.)
   */
  async function openModificacoesTab(page: Page, produtoId: string): Promise<void> {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Modificações' }).click();
    await expect(page.getByTestId('modificacao-entry').first()).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Expand history rows newest-first until one offers `Restaurar <field>`, and
   * return that row plus its button — scoped, so every subsequent query (the
   * precos warning, the button itself) only ever matches within THAT row.
   *
   * ⚠️ Taking the topmost row and assuming it carries the field is a race: the
   * produto's own triggers can land a NEWER entry with different `campos`
   * between the poll that waited for our edit and this navigation, and then the
   * first row has no such button at all. Selecting by the affordance the test
   * needs is deterministic whatever else was recorded in between.
   */
  async function expandEntryOferecendoRestaurar(page: Page, field: string) {
    const rows = page.getByTestId('modificacao-entry');
    const total = Math.min(await rows.count(), 5);
    for (let i = 0; i < total; i++) {
      const entry = rows.nth(i);
      await entry.getByRole('button', { name: 'Detalhes da modificação' }).click();
      const restaurar = entry.getByRole('button', { name: `Restaurar ${field}`, exact: true });
      const found = await restaurar
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (found) return { entry, restaurar };
    }
    throw new Error(`Nenhuma das ${total} entradas mais recentes oferece "Restaurar ${field}"`);
  }

  /** Edit `Nome` through the UI and wait for the trigger to record the change. */
  async function editNomeAndSave(page: Page, edited: string): Promise<void> {
    await page.goto(`/produtos/${produtoAId}/editar`);
    await fillField(page, 'Nome', edited);
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(async () => (await getProdutoData(produtoAId))?.nome, { timeout: 30_000 })
      .toBe(edited);
    await expect
      .poll(
        async () =>
          findByChangedField(await listHistoricoModificacoes(produtoAId), 'nome').some(
            (e) => fieldChange(e, 'nome')?.new === edited,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
  }

  test('(a) Restaurar pre-fills the form and writes nothing until Salvar', async ({ page }) => {
    const edited = `${nomeOriginal}-editado`;
    await editNomeAndSave(page, edited);

    await openModificacoesTab(page, produtoAId);
    const { restaurar } = await expandEntryOferecendoRestaurar(page, 'nome');
    await restaurar.click();

    // The click moved the operator to the field's own tab and put the old value
    // in the input — the half that was invisible when the revert wrote directly.
    await expectFieldValue(page, 'Nome', nomeOriginal);
    // …and Firestore still holds the edited value. Nothing is committed until
    // the operator says so.
    expect((await getProdutoData(produtoAId))?.nome).toBe(edited);

    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(async () => (await getProdutoData(produtoAId))?.nome, { timeout: 30_000 })
      .toBe(nomeOriginal);
    // The commit rides the normal save path, so the trigger logs a NEW entry
    // recording it (old: edited, new: original) — distinct from the entry that
    // was restored (old: original, new: edited).
    await expect
      .poll(
        async () =>
          findByChangedField(await listHistoricoModificacoes(produtoAId), 'nome').some((e) => {
            const change = fieldChange(e, 'nome');
            return change?.old === edited && change?.new === nomeOriginal;
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test('(b) a target that changed since the entry was recorded surfaces the conflict modal', async ({
    page,
  }) => {
    const edited = `${nomeOriginal}-conflito`;
    const thirdValue = `${nomeOriginal}-terceiro`;
    await editNomeAndSave(page, edited);

    await openModificacoesTab(page, produtoAId);
    const { restaurar } = await expandEntryOferecendoRestaurar(page, 'nome');

    // Someone else (an Admin-seeded write, standing in for a second user)
    // changes the field AFTER this row's target was loaded but BEFORE
    // Restaurar is clicked — the entry's captured target (old: nomeOriginal,
    // new: edited) is now stale against the live doc (now: thirdValue).
    await setProdutoFields(produtoAId, { nome: thirdValue });
    await expect
      .poll(async () => (await getProdutoData(produtoAId))?.nome, { timeout: 30_000 })
      .toBe(thirdValue);

    await restaurar.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Valor mudou desde a modificação')).toBeVisible({
      timeout: 15_000,
    });
    await dialog.getByRole('button', { name: 'Restaurar mesmo assim', exact: true }).click();

    // Confirming stages the entry's recorded old value; the third-party write
    // still stands in Firestore until the save.
    await expectFieldValue(page, 'Nome', nomeOriginal);
    expect((await getProdutoData(produtoAId))?.nome).toBe(thirdValue);

    await clickSave(page, 'Salvar alterações');

    // The third-party write also collides with the FORM's own baseline, so the
    // save raises ObjectView's tier-3 concurrency guard (ADR 0011). That is a
    // consequence of staging worth having: the old direct write went AROUND
    // this guard and clobbered the concurrent change silently; the revert now
    // goes through it, and the operator confirms the overwrite knowingly.
    const saveConflict = page.getByRole('dialog').filter({ hasText: 'Registro alterado' });
    await expect(saveConflict).toBeVisible({ timeout: 15_000 });
    await saveConflict.getByRole('button', { name: 'Salvar mesmo assim', exact: true }).click();

    await expect
      .poll(async () => (await getProdutoData(produtoAId))?.nome, { timeout: 30_000 })
      .toBe(nomeOriginal);
  });

  test('(d) leaving without saving discards the staged value', async ({ page }) => {
    const edited = `${nomeOriginal}-descartado`;
    await editNomeAndSave(page, edited);

    await openModificacoesTab(page, produtoAId);
    const { restaurar } = await expandEntryOferecendoRestaurar(page, 'nome');
    await restaurar.click();
    await expectFieldValue(page, 'Nome', nomeOriginal);

    // A staged form is a dirty form, so leaving raises the unsaved-changes
    // guard; accept it, which is the operator choosing to throw the revert away.
    page.once('dialog', (d) => void d.accept());
    await page.goto(`/produtos/${produtoAId}/editar`);

    // Reloaded from the server, the field shows the value Firestore actually
    // holds — the revert left no trace, which is the whole point of staging.
    await expectFieldValue(page, 'Nome', edited, 30_000);
    expect((await getProdutoData(produtoAId))?.nome).toBe(edited);
  });

  test('(c) saving a restored parent precos re-propagates to its variation child', async ({
    page,
  }) => {
    await page.goto(`/produtos/${parentCId}/editar`);
    await page.getByRole('tab', { name: 'Preço e custo' }).click();
    await expect(page.getByRole('textbox', { name: varejoNome })).toBeVisible({ timeout: 30_000 });
    await typeMoney(page, varejoNome, '30');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(
        async () =>
          findByChangedField(await listHistoricoModificacoes(parentCId), 'precos').some(
            (e) =>
              JSON.stringify(fieldChange(e, 'precos')?.new) ===
              JSON.stringify({ [varejoId]: { valor: 30 } }),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    // Let the trigger's OWN propagation to the child settle before touching
    // the UI again — otherwise a later "did it re-propagate" assertion could
    // pass on the strength of this first (non-revert) propagation instead of
    // the revert's.
    await expect
      .poll(async () => (await getProdutoData(childCId))?.precos, { timeout: 30_000 })
      .toEqual({ [varejoId]: { valor: 30 } });

    await openModificacoesTab(page, parentCId);
    const { entry, restaurar } = await expandEntryOferecendoRestaurar(page, 'precos');
    // Restoring `precos` on a parent will re-fire the trigger and flow to every
    // variation child when saved — surfaced as a warning, not silently done.
    await expect(entry.getByText(/variações/i)).toBeVisible({ timeout: 15_000 });
    await restaurar.click();

    // The jump landed on Preço e custo AND the staged value is on screen: the
    // entry's `old` side is "no price at all", so the field reads empty. The
    // parent doc still holds 30 — staged, not written.
    await expectMoneyValue(page, varejoNome, null);
    expect((await getProdutoData(parentCId))?.precos).toEqual({ [varejoId]: { valor: 30 } });

    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(async () => (await getProdutoData(parentCId))?.precos, { timeout: 30_000 })
      .toBeNull();
    // The child follows: the save re-fires `onProdutoChanged`, which propagates
    // the parent's (now null) precos to its variation children — the exact
    // re-propagation-on-revert decision this scenario proves.
    await expect
      .poll(async () => (await getProdutoData(childCId))?.precos, { timeout: 30_000 })
      .toBeNull();
  });
});
