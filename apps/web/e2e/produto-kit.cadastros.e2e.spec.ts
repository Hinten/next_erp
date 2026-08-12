import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoEstoque,
  e2ePrefix,
  getProdutoData,
  getProdutoIdByNome,
  seedComponenteKit,
  seedKitEstoqueFixtures,
  seedKitParaGerar,
} from './_helpers/seed-data';
import { expectToast, fillField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Kit tab (4a — parent kit, the doc-field manager).
 * It proves: marking `ehKit`, adding a component via the picker, recomputing the
 * kit cost (`custoDoKit` over a batched read → the `custo` field), and the
 * `componentesKit` map + derived `componentesKitKeys` round-tripping on the
 * produto doc (a normal field — no enabler/subcollection).
 */
test.describe.serial('Produtos kit e2e — Kit (componentesKit doc field)', () => {
  const prefix = e2ePrefix('prod-kit');
  const nome = `${prefix}-kit`;
  let produtoId = '';
  let componenteId = '';
  let componenteNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const comp = await seedComponenteKit(prefix, 10); // custo 10
    componenteId = comp.id;
    componenteNome = comp.nome;
    await warmRoutes(browser, ['/produtos/novo']);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('produtos', prefix);
  });

  test('creates a kit, adds a component, auto-computes cost, persists componentesKit + keys', async ({
    page,
  }) => {
    await page.goto('/produtos/novo');
    await fillField(page, 'Nome', nome);

    await page.getByRole('tab', { name: 'Kit' }).click();
    await page.getByRole('switch', { name: 'É kit', exact: true }).click();

    // Add the seeded component (option name carries the sku hint → match by RegExp).
    await selectFieldWithSearch(
      page,
      'Adicionar componente',
      componenteNome,
      new RegExp(componenteNome),
    );
    await page.getByLabel('Qtd').fill('3');

    // Kit cost is DYNAMIC (no button): component custo 10 × 3 = 30, auto-filled into
    // the read-only Custo field — wait for the computed value shown on the Kit tab.
    await expect(page.getByText(/Custo do kit:\s*R\$\s*30,00/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Criar', exact: true }).click();

    await expect
      .poll(async () => await getProdutoIdByNome(nome), { timeout: 30_000 })
      .not.toBeNull();
    produtoId = (await getProdutoIdByNome(nome))!;

    const produto = await getProdutoData(produtoId);
    expect(produto?.ehKit).toBe(true);
    expect(produto?.componentesKit).toMatchObject({
      [componenteId]: { quantidade: 3, limitarEstoque: true },
    });
    // The denorm the delete-guard queries mirrors the component ids.
    expect(produto?.componentesKitKeys).toEqual([componenteId]);
    expect(produto?.custo).toBe(30);
  });
});

/**
 * Edit-flow coverage for "Gerar Variações" (4b — the per-variation grid). Proves:
 *  - the per-variation grid renders when the Kit tab is opened DIRECTLY (the
 *    cross-tab fix: the grid's rows are published by the Variações tab, which
 *    must stay live — `keepSectionsMounted` on the produto editor's ObjectView);
 *  - "Gerar Variações" matches each kit-variation to the right component-variation
 *    (Case C1 overlap on size P) and persists `componentesKit` +
 *    `componentesKitKeys` on the variation child after save (the flush runs on the
 *    pristine `NothingChangedError → onAfterSave` path).
 */
test.describe.serial('Produtos kit e2e — Gerar Variações (per-variation grid)', () => {
  const prefix = e2ePrefix('prod-kit-gv');
  let seed: Awaited<ReturnType<typeof seedKitParaGerar>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    seed = await seedKitParaGerar(prefix);
    await warmRoutes(browser, [`/produtos/${seed.kitId}/editar`]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('produtos', prefix);
  });

  test('generates each variation’s components from the parent kit and persists them', async ({
    page,
  }) => {
    await page.goto(`/produtos/${seed.kitId}/editar`);
    await page.getByRole('tab', { name: 'Kit' }).click();

    // The grid renders only when the Variações tab published its rows — proving
    // the cross-tab fix (the Kit tab was opened without visiting Variações).
    await expect(page.getByRole('button', { name: 'Gerar Variações' })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Gerar Variações' }).click();
    await expectToast(page, 'Componentes gerados para as variações.');

    await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();

    // The kit-variation child (size P) now keys the component's size-P variation.
    await expect
      .poll(
        async () => {
          const child = await getProdutoData(seed.varKitPId);
          const kit = child?.componentesKit as Record<string, unknown> | null | undefined;
          return kit ? Object.keys(kit) : null;
        },
        { timeout: 30_000 },
      )
      .toEqual([seed.varCompPId]);

    const child = await getProdutoData(seed.varKitPId);
    expect(child?.componentesKit).toMatchObject({
      [seed.varCompPId]: { quantidade: 2, limitarEstoque: true },
    });
    expect(child?.componentesKitKeys).toEqual([seed.varCompPId]);
  });

  test('un-kitting the parent clears its variation children’s componentesKit', async ({ page }) => {
    // Precondition: the previous test left the size-P child carrying a kit map.
    await expect
      .poll(async () => (await getProdutoData(seed.varKitPId))?.componentesKit != null, {
        timeout: 15_000,
      })
      .toBe(true);

    await page.goto(`/produtos/${seed.kitId}/editar`);
    await page.getByRole('tab', { name: 'Kit' }).click();

    // Toggle "É kit" OFF and save — the parent stops being a kit.
    await page.getByRole('switch', { name: 'É kit', exact: true }).click();
    await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();

    // Kit-status propagation (Flutter parity): the variation child's kit map is
    // cleared on the child doc. This can ONLY come from the propagation use-case
    // — `deriveOnSave` clears the PARENT's map, never the child's.
    await expect
      .poll(
        async () => {
          const c = await getProdutoData(seed.varKitPId);
          return { kit: c?.componentesKit ?? null, ehKit: c?.ehKit ?? null };
        },
        { timeout: 30_000 },
      )
      .toEqual({ kit: null, ehKit: false });
  });
});

/**
 * Display coverage for the kit available-stock computation (#238): the Estoque
 * tab's Disponível cell appends `(own + min over limitarEstoque components of
 * disponivel/quantidade)` for kit produtos — Flutter `getEstoqueDisponivel`
 * parity, fractional and pt-BR-formatted. Stock is Admin-seeded (display-only —
 * no `aplicarEstoque` callable involved).
 */
test.describe.serial('Produtos kit e2e — estoque disponível do kit (Estoque tab)', () => {
  const prefix = e2ePrefix('prod-kit-est');
  let kitId = '';
  let comp1Id = '';
  let comp2Id = '';
  let depositoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const seed = await seedKitEstoqueFixtures(prefix);
    kitId = seed.kitId;
    comp1Id = seed.comp1Id;
    comp2Id = seed.comp2Id;
    depositoNome = seed.depositoNome;
    await warmRoutes(browser, [`/produtos/${kitId}/editar`]);
  });

  test.afterAll(async () => {
    for (const id of [kitId, comp1Id, comp2Id]) {
      if (id) await cleanupProdutoEstoque(id);
    }
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('depositos', prefix);
  });

  test('the Disponível cell appends the computed kit availability', async ({ page }) => {
    await page.goto(`/produtos/${kitId}/editar`);
    await page.getByRole('tab', { name: 'Estoque' }).click();
    await expect(page.getByLabel(`Localização ${kitId} ${depositoNome}`)).toBeVisible({
      timeout: 30_000,
    });

    // own 1,00; components allow min((10−1)/2 = 4.5, 11/3 ≈ 3.67) → 1 + 11/3 → "(4,67)".
    // toHaveText auto-retries through the transient `1,00 (...)` loading state.
    await expect(page.getByLabel(`Disponível ${kitId} ${depositoNome}`)).toHaveText('1,00 (4,67)', {
      timeout: 30_000,
    });
  });
});
