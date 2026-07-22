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
import { clickSave, fillField, typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the "Modificações" tab (unified modification
 * history + per-field revert) on the produto edit screen. Where
 * `produto-preco.emulator.e2e.spec.ts` proves the trigger writes the right
 * `historicoDeModificacoes` documents, THIS spec drives the actual revert UI
 * on top of them: list → expand → "Restaurar" → the real produto write (and,
 * for `precos`, the real re-propagation to a variation child).
 *
 * Emulator-only (`e2e-emulator.yml`): the functions emulator must be running
 * for `onProdutoChanged` to fire on every write this spec makes (including
 * the revert writes themselves — a revert is a normal produto write, so it
 * logs its OWN new history entry, which is the "re-propagation is a feature"
 * decision this spec asserts on in scenario (c)).
 *
 * Pipeline gotcha this spec exercises transitively: `isPipelineSupported(db)`
 * reports `true` against the Firestore emulator too (it only checks
 * `typeof db.pipeline === 'function'`, a static SDK capability — see the
 * `firestore-pipelines` skill, §7), while the emulator does NOT implement the
 * Pipelines RPC. `ModificacoesManager` and `ProdutoHistoryButton` therefore
 * gate the pipeline attempt on the build-time
 * `NEXT_PUBLIC_USE_FIREBASE_EMULATOR` flag (the same one
 * `lib/firebase/client.ts` uses to connect the emulator) and go straight to
 * the classic `buildQuery` path in this lane. If this suite's list/expand
 * steps time out waiting for rows, that emulator gate — not this spec — is
 * where to look first.
 */
test.describe.serial('Produto revert e2e — histórico unificado + restauração por campo', () => {
  // Group A: nome revert (scenario a) + conflict revert (scenario b), reusing
  // the same produto across both — (b) picks up from (a)'s restored state.
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

  /** Open the produto's Modificações tab fresh (a full navigation, not a tab
   * re-click) so a `keepMounted` panel from a previous visit can never serve
   * stale rows — the list has no live listener (pipelines/classic queries here
   * are one-shot), so only a remount is guaranteed to refetch. */
  async function openModificacoesTab(page: Page, produtoId: string): Promise<void> {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Modificações' }).click();
    await expect(page.getByTestId('modificacao-entry').first()).toBeVisible({ timeout: 30_000 });
  }

  /** Expand the newest (topmost) `modificacao-entry` row and return its locator,
   * scoped so every subsequent query (Restaurar buttons, the precos warning
   * text) only ever matches within THIS row. */
  async function expandNewestEntry(page: Page) {
    const entry = page.getByTestId('modificacao-entry').first();
    await entry.getByRole('button', { name: 'Detalhes da modificação' }).click();
    return entry;
  }

  test('(a) edits nome via the UI, then Restaurar reverts it and logs a new entry', async ({
    page,
  }) => {
    const edited = `${nomeOriginal}-editado`;
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

    await openModificacoesTab(page, produtoAId);
    const entry = await expandNewestEntry(page);
    const restaurar = entry.getByRole('button', { name: 'Restaurar nome', exact: true });
    await expect(restaurar).toBeVisible({ timeout: 15_000 });
    await restaurar.click();

    // Reverted: the produto doc is back to its pre-edit nome...
    await expect
      .poll(async () => (await getProdutoData(produtoAId))?.nome, { timeout: 30_000 })
      .toBe(nomeOriginal);
    // ...AND the revert write is itself a normal produto write, so the trigger
    // logs a NEW entry recording it (old: edited, new: original) — distinct
    // from the entry we just acted on (old: original, new: edited).
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

    await openModificacoesTab(page, produtoAId);
    const entry = await expandNewestEntry(page);
    const restaurar = entry.getByRole('button', { name: 'Restaurar nome', exact: true });
    await expect(restaurar).toBeVisible({ timeout: 15_000 });

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

    // Confirming anyway restores the ORIGINAL old value recorded on the
    // entry, overriding the third-party write.
    await expect
      .poll(async () => (await getProdutoData(produtoAId))?.nome, { timeout: 30_000 })
      .toBe(nomeOriginal);
  });

  test('(c) reverting a parent precos change re-propagates to its variation child', async ({
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
    const entry = await expandNewestEntry(page);
    // Reverting `precos` on a parent is going to re-fire the trigger and flow
    // to every variation child — surfaced as a warning, not silently done.
    await expect(entry.getByText(/variações/i)).toBeVisible({ timeout: 15_000 });
    const restaurar = entry.getByRole('button', { name: 'Restaurar precos', exact: true });
    await expect(restaurar).toBeVisible();
    await restaurar.click();

    await expect
      .poll(async () => (await getProdutoData(parentCId))?.precos, { timeout: 30_000 })
      .toBeNull();
    // The child follows: the revert write re-fires `onProdutoChanged`, which
    // propagates the parent's (now null) precos to its variation children —
    // the exact re-propagation-on-revert decision this scenario proves.
    await expect
      .poll(async () => (await getProdutoData(childCId))?.precos, { timeout: 30_000 })
      .toBeNull();
  });
});
