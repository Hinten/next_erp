import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  e2ePrefix,
  getProdutoData,
  seedComponenteKit,
  seedKitReferencing,
  seedListasDePreco,
  seedProdutoComFilho,
  setProdutoFields,
} from './_helpers/seed-data';
import { selectField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for `/produtos/recalcular-precos` (#544 bulk price
 * recalculation). Staging has no deployed functions, so the automatic
 * `historicoDePrecos` recording and parent→children propagation (owned by the
 * `onProdutoPrecoCustoChanged` trigger) are NOT assertable here — only covered
 * by the emulator spec from the previous PR in the stack. This suite proves
 * the parent `precos` WRITE and the screen's own UI behavior.
 *
 * Two deliberate design choices, both driven by the fact that `Calcular`
 * scans EVERY parent produto in the shared staging catalog (there is no
 * scoping in the screen itself):
 *
 *  - The results table is virtualized (`useVirtualRows`) over a list whose
 *    total size and alphabetical ordering this suite doesn't control (other
 *    concurrent specs' produtos are in the same scan). Asserting a SPECIFIC
 *    seeded row is "visible in the table" would mean fighting react-virtual's
 *    viewport-limited DOM with brittle scroll-position math. Instead this
 *    verifies per-row correctness against the downloaded CSV — built from the
 *    exact same `rows` array that feeds the table, just never DOM-virtualized
 *    — and keeps the on-screen assertions to the aggregate ok/erro badges
 *    (lower-bounded, since the exact totals depend on whatever the rest of
 *    the catalog looks like at run time).
 *  - The "full run" and "apply-mode gating" scenarios are merged into ONE
 *    Calcular→Aplicar pass (mode `Aumentar preços`) instead of two. A second
 *    full-catalog scan+apply would be pure overhead here: after the first
 *    Aplicar, every resolvable produto in the ENTIRE catalog already carries
 *    a price under this run's lista id, so a second pass would gate almost
 *    everything out anyway. Picking `Aumentar preços` (not the default
 *    `Aplicar tudo`) for the one real apply exercises both outcomes at once —
 *    our null-priced fixtures get written, our already-higher-priced fixture
 *    gets skipped — in a single write pass.
 *
 * NOTE for reviewers: `Aplicar` writes to every parent produto with a
 * resolvable custo in the WHOLE shared staging catalog, not just this suite's
 * own fixtures (the fresh lista id here has never priced anyone else, so
 * every mode includes every null-priced produto). That is inherent to the
 * feature, not a test artifact. The screen exposes no scoping to avoid it, so
 * this spec runs in its own `crud-cadastros-recalculo` Playwright project
 * (`playwright.config.ts`), declared as `dependencies: ['crud-cadastros']` —
 * Playwright runs every OTHER `.cadastros.e2e.spec.ts` (including each spec's
 * own `afterAll` cleanup) to completion first, so by the time `Aplicar` fires
 * here no concurrently-running spec's produto is still alive to pick up a
 * stray `precos` key. Do not fold this spec back into the plain
 * `crud-cadastros` project — that reintroduces the race (it previously broke
 * produto-preco.cadastros.e2e.spec.ts's strict `.precos` equality asserts).
 */
test.describe.serial('Recalcular preços e2e (#544)', () => {
  const prefix = e2ePrefix('recalc');

  let varejoId = '';
  let varejoNome = '';
  let atacadoId = '';
  let atacadoNome = '';
  let simplesId = '';
  let simplesNome = '';
  let parentId = '';
  let parentNome = '';
  let kitId = '';
  let kitNome = '';
  let semCustoId = '';
  let semCustoNome = '';
  let aumentoId = '';
  let aumentoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);

    const [listas, simples, produtoComFilho, kitComp] = await Promise.all([
      seedListasDePreco(prefix),
      seedComponenteKit(prefix, 10, 'simples'),
      seedProdutoComFilho(prefix),
      seedComponenteKit(prefix, 10, 'kitcomp'),
    ]);
    varejoId = listas.varejoId;
    varejoNome = listas.varejoNome;
    atacadoId = listas.atacadoId;
    atacadoNome = listas.atacadoNome;
    simplesId = simples.id;
    simplesNome = simples.nome;
    parentId = produtoComFilho.parentId;
    parentNome = produtoComFilho.parentNome;

    const [kit, semCusto, aumento] = await Promise.all([
      seedKitReferencing(prefix, kitComp.id),
      seedComponenteKit(prefix, 0, 'semcusto'),
      seedComponenteKit(prefix, 10, 'aumento'),
    ]);
    kitId = kit.kitId;
    kitNome = kit.kitNome;
    semCustoId = semCusto.id;
    semCustoNome = semCusto.nome;
    aumentoId = aumento.id;
    aumentoNome = aumento.nome;

    await Promise.all([
      // The parent produto from `seedProdutoComFilho` has no custo by default.
      setProdutoFields(parentId, { custo: 10 }),
      // No custo at all (not `0`, which is its own distinct error branch) —
      // the "sem custo" row.
      setProdutoFields(semCustoId, { custo: null }),
      // Already priced ABOVE what the varejo formula will compute (25) — the
      // "Aumentar preços" gate must leave this one alone.
      setProdutoFields(aumentoId, { precos: { [varejoId]: { valor: 30 } } }),
      warmRoutes(browser, ['/produtos/recalcular-precos']),
    ]);
  });

  test.afterAll(async () => {
    await Promise.all([
      cleanupByNamePrefix('produtos', prefix),
      cleanupByNamePrefix('listaDePrecos', prefix),
    ]);
  });

  test('shows the no-formula warning and disables Calcular for a lista without fórmulas', async ({
    page,
  }) => {
    await page.goto('/produtos/recalcular-precos');
    await expect(page.getByRole('heading', { name: 'Recalcular Preços' })).toBeVisible();

    await selectFieldWithSearch(page, 'Lista de preços', atacadoNome);

    await expect(page.getByRole('alert', { name: /Sem fórmulas de cálculo/ })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('link', { name: 'Edite a lista primeiro.' })).toHaveAttribute(
      'href',
      `/listas-de-precos/${atacadoId}`,
    );
    await expect(page.getByRole('button', { name: 'Calcular', exact: true })).toBeDisabled();
  });

  test('preselects the lista from a `?listaId=` deep link', async ({ page }) => {
    await page.goto(`/produtos/recalcular-precos?listaId=${varejoId}`);
    await expect(page.getByRole('combobox', { name: 'Lista de preços', exact: true })).toHaveValue(
      varejoNome,
      { timeout: 15_000 },
    );
  });

  test('recalculates the catalog, verifies the CSV rows, and applies with "Aumentar preços"', async ({
    page,
  }) => {
    // Two full-catalog round trips (Calcular's scan + Aplicar's chunked
    // writes) with generous sub-timeouts each — see the Select/Aplicar waits
    // below for why the ceiling here is well above their individual budgets.
    test.setTimeout(300_000);

    await page.goto('/produtos/recalcular-precos');
    await selectFieldWithSearch(page, 'Lista de preços', varejoNome);
    await page.getByRole('button', { name: 'Calcular', exact: true }).click();

    const baixarCsv = page.getByRole('button', { name: 'Baixar CSV', exact: true });
    await expect(baixarCsv).toBeVisible({ timeout: 90_000 });

    // Aggregate counters walk the WHOLE shared catalog (see the suite-level
    // comment) — assert lower bounds covering our own fixtures rather than an
    // exact total.
    const ok = await badgeNumber(page, /^\d+ produto\(s\)$/);
    const comErro = await badgeNumber(page, /^\d+ com erro$/);
    expect(ok).toBeGreaterThanOrEqual(4); // simples + parent + kit + aumento
    expect(comErro).toBeGreaterThanOrEqual(1); // semCusto

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await baixarCsv.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^recalculo-precos-.+-\d{8}-\d{4}\.csv$/);
    const csvPath = await download.path();
    if (!csvPath) throw new Error('CSV download produced no local file path');
    const rowsByNome = parseAlteracoesCsv(readFileSync(csvPath, 'utf-8'));

    // C*L+T = 10*2+5 → 25 (same varejo formula as produto-preco.cadastros).
    expect(rowsByNome.get(simplesNome)).toEqual({ precoAtual: '', novoPreco: '25,00', erro: '' });
    expect(rowsByNome.get(parentNome)).toEqual({ precoAtual: '', novoPreco: '25,00', erro: '' });
    expect(rowsByNome.get(kitNome)).toEqual({ precoAtual: '', novoPreco: '25,00', erro: '' });
    expect(rowsByNome.get(aumentoNome)).toEqual({
      precoAtual: '30,00',
      novoPreco: '25,00',
      erro: '',
    });
    expect(rowsByNome.get(semCustoNome)?.novoPreco).toBe('');
    expect(rowsByNome.get(semCustoNome)?.erro).toContain('sem custo');

    await selectField(page, 'Modo de aplicação', 'Aumentar preços');
    const aplicar = page.getByRole('button', { name: 'Aplicar', exact: true });
    // Every null-priced produto (including our 3 successful fixtures) passes
    // the "aumentar" gate under a brand-new lista id, so this is never empty.
    await expect(aplicar).toBeEnabled();
    await aplicar.click();
    await expect(page.getByText('Recálculo concluído')).toBeVisible({ timeout: 90_000 });

    await expect
      .poll(async () => (await getProdutoData(simplesId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 25 } });
    await expect
      .poll(async () => (await getProdutoData(parentId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 25 } });
    await expect
      .poll(async () => (await getProdutoData(kitId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 25 } });
    // Gated out: already priced ABOVE the computed value — "Aumentar" leaves
    // it untouched.
    expect((await getProdutoData(aumentoId))?.precos).toEqual({ [varejoId]: { valor: 30 } });
    // Never entered the apply set at all (erro !== null upstream, filtered
    // before the write step ever sees it).
    expect((await getProdutoData(semCustoId))?.precos).toBeUndefined();
  });
});

/** Read a badge's numeric prefix off the FIRST element matching `pattern`. */
async function badgeNumber(page: Page, pattern: RegExp): Promise<number> {
  const text = (await page.getByText(pattern).first().textContent()) ?? '';
  const match = /\d+/.exec(text);
  if (!match) throw new Error(`No number found in badge text matching ${pattern}: "${text}"`);
  return Number(match[0]);
}

interface AlteracaoCsvRow {
  precoAtual: string;
  novoPreco: string;
  erro: string;
}

/**
 * Naive `;`-split parser for the recalculo CSV (`buildPrecoAlteracoesCsv`),
 * keyed by the `Nome` column. Deliberately NOT a general CSV parser — none of
 * this suite's fixtures produce a value needing `csvCell`'s quote/escape
 * handling (no `;`, `"` or newline in any seeded nome/sku/erro string), so a
 * plain split is exact for what's actually written here.
 */
function parseAlteracoesCsv(content: string): Map<string, AlteracaoCsvRow> {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = withoutBom.split('\r\n').filter((line) => line.length > 0);
  const byNome = new Map<string, AlteracaoCsvRow>();
  for (const line of lines.slice(1)) {
    const cells = line.split(';');
    byNome.set(cells[1] ?? '', {
      precoAtual: cells[2] ?? '',
      novoPreco: cells[3] ?? '',
      erro: cells[5] ?? '',
    });
  }
  return byNome;
}
