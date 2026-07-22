import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  listHistoricoCusto,
  listHistoricoPrecos,
  seedListasDePreco,
  seedProdutoComFilho,
  setProdutoFields,
} from './_helpers/seed-data';
import { clickSave, typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * Real trigger delivery for the produto price/custo history + child-precos
 * propagation (PR A2). The `cadastros` suite proves the `precos` wire shape,
 * the formula recalc engine and the validation UX; THIS spec exercises the
 * deployed produto-write trigger in the functions emulator — a real save
 * fires the write, the emulator-served function records history / propagates
 * precos, and the assertions poll the DERIVED Firestore effect.
 *
 * Decisions this spec proves:
 *  - the trigger exits (no-op) for a non-parent produto (`paiId != null`) —
 *    a variation child never gets its own price history, whether the write
 *    comes from the trigger's own propagation or a direct edit;
 *  - `propagatePriceToChildren` (default true) gates ONLY the children flush —
 *    the history record is written regardless.
 * Duplicate history rows from the still-live legacy Flutter app (no dedup
 * guard) and the deterministic-doc-id redelivery idempotency are covered at
 * the unit level, not here.
 *
 * Emulator-only (`e2e-emulator.yml`): served locally from `firebase.e2e.json`'s
 * functions codebase. NOTE: in the emulator, Admin SDK seed writes ALSO fire
 * the trigger — the fixture produtos are seeded with no `precos`/`custo` field
 * at all, a no-effect write, which doubles as function warm-up.
 */
test.describe.serial('Produtos preço/custo trigger e2e — histórico + propagação', () => {
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
      cleanupProdutoSubcollection(parentId, 'historicoDePrecos'),
      cleanupProdutoSubcollection(parentId, 'historicoDeCusto'),
      cleanupProdutoSubcollection(childId, 'historicoDePrecos'),
      cleanupProdutoSubcollection(noPropParentId, 'historicoDePrecos'),
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

  test('creates the initial historicoDePrecos record when a price is added', async ({ page }) => {
    await openPrecoTab(page, parentId);
    await typeMoney(page, varejoNome, '30');
    await clickSave(page, 'Salvar alterações');

    // Flutter parity: a price added from nothing records valorFinal only.
    await expect
      .poll(async () => (await listHistoricoPrecos(parentId)).length, { timeout: 30_000 })
      .toBe(1);
    const [record] = await listHistoricoPrecos(parentId);
    expect(record).toMatchObject({ valorOriginal: null, valorFinal: 30 });
    expect(String(record!.listaDePrecoHistoricoOuterRef).split('/').pop()).toBe(varejoId);
    expect(typeof record!.timestamp).toBe('number');
  });

  test('records valorOriginal → valorFinal on a price change', async ({ page }) => {
    await openPrecoTab(page, parentId);
    await typeMoney(page, varejoNome, '35');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(
        async () =>
          (await listHistoricoPrecos(parentId)).some(
            (r) => r.valorOriginal === 30 && r.valorFinal === 35,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
  });

  test('records historicoDeCusto on a custo change', async ({ page }) => {
    await openPrecoTab(page, parentId);
    await typeMoney(page, 'Custo', '10');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(async () => (await listHistoricoCusto(parentId)).some((r) => r.valor === 10), {
        timeout: 30_000,
      })
      .toBe(true);
  });

  test('propagates a parent price change to its variation child', async ({ page }) => {
    await openPrecoTab(page, parentId);
    await typeMoney(page, varejoNome, '40');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(async () => (await getProdutoData(childId))?.precos, { timeout: 30_000 })
      .toEqual({ [varejoId]: { valor: 40 } });
  });

  test('propagatePriceToChildren: false records history but leaves the child untouched', async ({
    page,
  }) => {
    await openPrecoTab(page, noPropParentId);
    await typeMoney(page, varejoNome, '50');
    await clickSave(page, 'Salvar alterações');

    // The history record is unconditional — assert it FIRST so the ordering is
    // safe: only once it lands can we trust the trigger actually ran, and only
    // then does "the child is still untouched" mean "propagation was gated
    // off" rather than "the trigger hasn't fired yet".
    await expect
      .poll(
        async () => (await listHistoricoPrecos(noPropParentId)).some((r) => r.valorFinal === 50),
        { timeout: 30_000 },
      )
      .toBe(true);
    // `?? null`: the seeded child never had a `precos` field written at all
    // (absent, not explicit null) — coalesce before asserting so the "never
    // propagated" check doesn't hinge on that distinction.
    expect((await getProdutoData(noPropChildId))?.precos ?? null).toBeNull();
  });

  test('a direct write to a variation child never gets its own price history', async ({ page }) => {
    // Admin-seeded, like the child would be touched by any non-editor path —
    // the trigger must see `paiId != null` and exit before writing anything.
    await setProdutoFields(childId, { precos: { [varejoId]: { valor: 99 } } });

    // Settle anchor: a parent-side save + poll (same idiom as
    // pedidos-estoque.emulator.e2e.spec.ts's no-runaway check) gives the
    // child's (fast, no-op) trigger invocation ample time to have run before
    // the negative assertion below.
    await openPrecoTab(page, parentId);
    await typeMoney(page, varejoNome, '45');
    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(async () => (await listHistoricoPrecos(parentId)).some((r) => r.valorFinal === 45), {
        timeout: 30_000,
      })
      .toBe(true);

    expect(await listHistoricoPrecos(childId)).toHaveLength(0);
  });
});
