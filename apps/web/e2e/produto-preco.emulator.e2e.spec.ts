import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  listHistoricoCusto,
  listHistoricoModificacoes,
  listHistoricoPrecos,
  seedListasDePreco,
  seedProdutoComFilho,
  setProdutoFields,
} from './_helpers/seed-data';
import { clickSave, typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * Real trigger delivery for the produto write → unified modification-history
 * trigger + child-precos propagation. The `cadastros` suite proves the
 * `precos` wire shape, the formula recalc engine and the validation UX; THIS
 * spec exercises the deployed produto-write trigger in the functions
 * emulator — a real save fires the write, the emulator-served function
 * records a `historicoDeModificacoes` entry / propagates precos, and the
 * assertions poll the DERIVED Firestore effect.
 *
 * The trigger (`onProdutoChanged`, deployed under the legacy function name
 * `onProdutoPrecoCustoChanged` via an alias export) no longer writes the
 * legacy `historicoDePrecos`/`historicoDeCusto` subcollections at all — it
 * writes ONE `produtos/{id}/historicoDeModificacoes/{eventId}` doc per write,
 * recording every top-level field that actually changed (`campos`/`changes`)
 * against a noise-field ignore list (denormalized/server-owned fields).
 * `changes.<field>.old`/`.new` hold the field's before/after value; a field
 * that didn't exist before coerces to `null`.
 *
 * Decisions this spec proves:
 *  - a variation child (`paiId != null`) never gets an entry naming `precos`
 *    as changed — the trigger suppresses `precos` specifically on children,
 *    so a propagation write (which only ever touches `precos`) produces an
 *    EMPTY diff and so no entry at all, whether the write is the trigger's
 *    own propagation or a direct edit;
 *  - `propagatePriceToChildren` (default true) gates ONLY the children
 *    flush — the modification entry is written regardless;
 *  - the legacy `historicoDePrecos`/`historicoDeCusto` subcollections get no
 *    new docs at all under the new trigger.
 * Duplicate history rows inherited from the legacy app (no dedup guard) and
 * the deterministic-doc-id redelivery idempotency are covered at
 * the unit level, not here.
 *
 * Emulator-only (`e2e-emulator.yml`): served locally from `firebase.e2e.json`'s
 * functions codebase. NOTE: in the emulator, Admin SDK seed writes ALSO fire
 * the trigger — the fixture produtos are seeded with no `precos`/`custo` field
 * at all, a no-effect write (`precos`/`custo` never appear in `campos`),
 * which doubles as function warm-up.
 */
test.describe.serial('Produtos preço/custo trigger e2e — histórico unificado + propagação', () => {
  const prefix = e2ePrefix('prod-preco-trg');
  let parentId = '';
  let childId = '';
  let varejoId = '';
  let varejoNome = '';

  // A second parent/child pair, seeded with propagation gated OFF (task e).
  let noPropParentId = '';
  let noPropChildId = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const [produto, noPropProduto, listas] = await Promise.all([
      seedProdutoComFilho(prefix),
      seedProdutoComFilho(`${prefix}-noprop`),
      seedListasDePreco(prefix),
    ]);
    parentId = produto.parentId;
    childId = produto.childId;
    noPropParentId = noPropProduto.parentId;
    noPropChildId = noPropProduto.childId;
    varejoId = listas.varejoId;
    varejoNome = listas.varejoNome;
    await setProdutoFields(noPropParentId, { propagatePriceToChildren: false });
    await warmRoutes(browser, [`/produtos/${parentId}/editar`]);
  });

  test.afterAll(async () => {
    await Promise.all([
      cleanupProdutoSubcollection(parentId, 'historicoDeModificacoes'),
      cleanupProdutoSubcollection(childId, 'historicoDeModificacoes'),
      cleanupProdutoSubcollection(noPropParentId, 'historicoDeModificacoes'),
    ]);
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('listaDePrecos', prefix);
  });

  async function openPrecoTab(page: Page, produtoId: string) {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Preço e custo' }).click();
    await expect(page.getByRole('textbox', { name: varejoNome })).toBeVisible({
      timeout: 30_000,
    });
  }

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

  test('creates the initial historicoDeModificacoes entry when a price is added', async ({
    page,
  }) => {
    await openPrecoTab(page, parentId);
    await typeMoney(page, varejoNome, '30');
    await clickSave(page, 'Salvar alterações');

    // Flutter parity: a price added from nothing records `old: null`. Note
    // the produto doc already exists (seeded in `beforeAll`), so this
    // write's `kind` is 'update', not 'create' — a genuine document *create*
    // would need a doc that didn't exist before this write. "Initial" here
    // means the first entry to ever carry a `precos` change, identified by
    // `old === null` rather than by the entry's `kind`.
    await expect
      .poll(
        async () =>
          findByChangedField(await listHistoricoModificacoes(parentId), 'precos').some(
            (e) => fieldChange(e, 'precos')?.old === null,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const record = findByChangedField(await listHistoricoModificacoes(parentId), 'precos').find(
      (e) => fieldChange(e, 'precos')?.old === null,
    );
    expect(record).toBeDefined();
    expect(fieldChange(record!, 'precos')?.new).toEqual({ [varejoId]: { valor: 30 } });
    expect(record!.kind).toBe('update');
    expect(record!.path).toBe(`produtos/${parentId}`);
    expect(record!.docId).toBe(parentId);
    expect(record!.subcolecao).toBeNull();
    expect(typeof record!.eventId).toBe('string');
    expect(typeof record!.timestamp).toBe('number');

    // The legacy subcollection gets no new docs at all under the new trigger.
    expect(await listHistoricoPrecos(parentId)).toHaveLength(0);
  });

  test('records changes.precos old/new on a price change', async ({ page }) => {
    await openPrecoTab(page, parentId);
    await typeMoney(page, varejoNome, '35');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(
        async () =>
          findByChangedField(await listHistoricoModificacoes(parentId), 'precos').some((e) => {
            const change = fieldChange(e, 'precos');
            return (
              JSON.stringify(change?.old) === JSON.stringify({ [varejoId]: { valor: 30 } }) &&
              JSON.stringify(change?.new) === JSON.stringify({ [varejoId]: { valor: 35 } })
            );
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test('records custo in campos on a custo change', async ({ page }) => {
    await openPrecoTab(page, parentId);
    await typeMoney(page, 'Custo', '10');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(
        async () =>
          findByChangedField(await listHistoricoModificacoes(parentId), 'custo').some(
            (e) => fieldChange(e, 'custo')?.new === 10,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    // The legacy subcollection gets no new docs at all under the new trigger.
    expect(await listHistoricoCusto(parentId)).toHaveLength(0);
  });

  test('propagates a parent price change to its variation child', async ({ page }) => {
    await openPrecoTab(page, parentId);
    await typeMoney(page, varejoNome, '40');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(async () => (await getProdutoData(childId))?.precos, { timeout: 30_000 })
      .toEqual({ [varejoId]: { valor: 40 } });
  });

  test('propagatePriceToChildren: false records a modification entry but leaves the child untouched', async ({
    page,
  }) => {
    await openPrecoTab(page, noPropParentId);
    await typeMoney(page, varejoNome, '50');
    await clickSave(page, 'Salvar alterações');

    // The modification entry is unconditional — assert it FIRST so the
    // ordering is safe: only once it lands can we trust the trigger actually
    // ran, and only then does "the child is still untouched" mean
    // "propagation was gated off" rather than "the trigger hasn't fired yet".
    await expect
      .poll(
        async () =>
          findByChangedField(await listHistoricoModificacoes(noPropParentId), 'precos').some(
            (e) =>
              JSON.stringify(fieldChange(e, 'precos')?.new) ===
              JSON.stringify({ [varejoId]: { valor: 50 } }),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    // `?? null`: the seeded child never had a `precos` field written at all
    // (absent, not explicit null) — coalesce before asserting so the "never
    // propagated" check doesn't hinge on that distinction.
    expect((await getProdutoData(noPropChildId))?.precos ?? null).toBeNull();
  });

  test('a direct write to a variation child never gets a precos entry', async ({ page }) => {
    // Admin-seeded, like the child would be touched by any non-editor path —
    // the trigger must ignore `precos` on a child (`paiId != null`) and,
    // since that's the only field this write touches, record no entry at all.
    await setProdutoFields(childId, { precos: { [varejoId]: { valor: 99 } } });

    // Settle anchor: a parent-side save + poll (same idiom as
    // pedidos-estoque.emulator.e2e.spec.ts's no-runaway check) gives the
    // child's (fast, no-op) trigger invocation ample time to have run before
    // the negative assertion below.
    await openPrecoTab(page, parentId);
    await typeMoney(page, varejoNome, '45');
    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(
        async () =>
          findByChangedField(await listHistoricoModificacoes(parentId), 'precos').some(
            (e) =>
              JSON.stringify(fieldChange(e, 'precos')?.new) ===
              JSON.stringify({ [varejoId]: { valor: 45 } }),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    // Neither this save's propagation write to the child (also precos-only)
    // nor the direct admin write above ever surfaces a `precos` entry on the
    // child — both are precos-only diffs on a variation child, ignored.
    expect(findByChangedField(await listHistoricoModificacoes(childId), 'precos')).toHaveLength(0);
  });
});
