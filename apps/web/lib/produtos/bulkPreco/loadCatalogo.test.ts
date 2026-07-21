import { describe, expect, it, vi } from 'vitest';
import type { Firestore, QueryDocumentSnapshot } from 'firebase/firestore';
import { custoDoKit, type Produto } from '@delfrance/schemas';

import {
  loadKitResolucao,
  toProdutoPrecoRow,
  type ComponenteProdutoData,
  type ProdutoPrecoRow,
} from './loadCatalogo';

function fakeSnap(id: string, data: Partial<Produto>): QueryDocumentSnapshot<Produto> {
  return { id, data: () => data as Produto } as unknown as QueryDocumentSnapshot<Produto>;
}

describe('toProdutoPrecoRow', () => {
  it('projects the slim fields and extracts categoriaId from the outerRef', () => {
    const row = toProdutoPrecoRow(
      fakeSnap('p1', {
        sku: 'SKU1',
        nome: 'Produto 1',
        custo: 10,
        precos: { lista1: { valor: 20 } },
        categoriaProdutoOuterRef: 'documents/categorias/cat1',
        pesoBrutoKg: 1.5,
        pesoLiquidoKg: 1.2,
        ehKit: false,
        componentesKit: null,
      }),
    );

    expect(row).toEqual<ProdutoPrecoRow>({
      id: 'p1',
      sku: 'SKU1',
      nome: 'Produto 1',
      custo: 10,
      precos: { lista1: { valor: 20 } },
      categoriaId: 'cat1',
      pesoBrutoKg: 1.5,
      pesoLiquidoKg: 1.2,
      ehKit: false,
      componentesKit: null,
    });
  });

  it('handles the trailing-id extraction on a nested (subcollection) outerRef', () => {
    const row = toProdutoPrecoRow(
      fakeSnap('p1', {
        sku: null,
        nome: 'Produto',
        custo: null,
        precos: null,
        categoriaProdutoOuterRef: 'documents/categorias/parentCat/sub/cat9',
        pesoBrutoKg: null,
        pesoLiquidoKg: null,
        ehKit: false,
        componentesKit: null,
      }),
    );
    expect(row.categoriaId).toBe('cat9');
  });

  it('maps a null categoriaProdutoOuterRef (and every other optional field) to null without throwing', () => {
    const row = toProdutoPrecoRow(
      fakeSnap('p2', {
        sku: null,
        nome: 'Produto 2',
        custo: null,
        precos: null,
        categoriaProdutoOuterRef: null,
        pesoBrutoKg: null,
        pesoLiquidoKg: null,
        ehKit: true,
        componentesKit: { c1: { quantidade: 2, limitarEstoque: true, timestamp: null } },
      }),
    );

    expect(row.categoriaId).toBeNull();
    expect(row.sku).toBeNull();
    expect(row.custo).toBeNull();
    expect(row.precos).toBeNull();
    expect(row.ehKit).toBe(true);
    expect(row.componentesKit).toEqual({
      c1: { quantidade: 2, limitarEstoque: true, timestamp: null },
    });
  });
});

describe('loadKitResolucao', () => {
  const kitRow: ProdutoPrecoRow = {
    id: 'kit1',
    sku: 'KIT1',
    nome: 'Kit 1',
    custo: null,
    precos: null,
    categoriaId: null,
    pesoBrutoKg: null,
    pesoLiquidoKg: null,
    ehKit: true,
    componentesKit: { comp1: { quantidade: 1, limitarEstoque: true, timestamp: null } },
  };
  const parentOfComp1: ProdutoPrecoRow = {
    id: 'parentOfComp1',
    sku: 'PAR1',
    nome: 'Parent of comp1',
    custo: 50,
    precos: null,
    categoriaId: null,
    pesoBrutoKg: 2,
    pesoLiquidoKg: 1.8,
    ehKit: false,
    componentesKit: null,
  };
  const produtos = [kitRow, parentOfComp1];
  const db = {} as unknown as Firestore;

  it('seeds every map from the parent rows (own paiId is always null)', async () => {
    const fetch = vi.fn(async () => new Map<string, ComponenteProdutoData>());
    // comp1 (kit1's only component) isn't one of the parent rows, so the
    // fetcher runs for it — but this test only asserts the PARENT rows' own
    // maps were seeded correctly; the next test covers the fetch itself.
    const r = await loadKitResolucao(db, produtos, fetch);
    expect(r.custoByProdutoId.parentOfComp1).toBe(50);
    expect(r.pesoBrutoByProdutoId.parentOfComp1).toBe(2);
    expect(r.pesoLiquidoByProdutoId.parentOfComp1).toBe(1.8);
    expect(r.paiByProdutoId.parentOfComp1).toBeNull();
    expect(r.paiByProdutoId.kit1).toBeNull();
  });

  it('fetches only the kit-component ids that are not already loaded', async () => {
    const fetch = vi.fn(async (_db: unknown, ids: string[]) => {
      expect(ids).toEqual(['comp1']);
      return new Map<string, ComponenteProdutoData>([
        ['comp1', { custo: null, pesoBrutoKg: null, pesoLiquidoKg: null, paiId: 'parentOfComp1' }],
      ]);
    });

    const r = await loadKitResolucao(db, produtos, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.custoByProdutoId.comp1).toBeNull();
    expect(r.paiByProdutoId.comp1).toBe('parentOfComp1');
  });

  it('does not call the fetcher when no kit references an unloaded component', async () => {
    const fetch = vi.fn(async () => new Map<string, ComponenteProdutoData>());
    const selfContained: ProdutoPrecoRow[] = [
      {
        ...kitRow,
        id: 'kit2',
        // Component id happens to equal an already-loaded row's id, so
        // nothing is missing.
        componentesKit: { kit2: { quantidade: 1, limitarEstoque: true, timestamp: null } },
      },
    ];

    await loadKitResolucao(db, selfContained, fetch);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a component that resolves through paiByProdutoId feeds custoDoKit correctly (parent fallback path)', async () => {
    const fetch = async () =>
      new Map<string, ComponenteProdutoData>([
        ['comp1', { custo: null, pesoBrutoKg: null, pesoLiquidoKg: null, paiId: 'parentOfComp1' }],
      ]);

    const r = await loadKitResolucao(db, produtos, fetch);
    const result = custoDoKit(kitRow.componentesKit, r.custoByProdutoId, r.paiByProdutoId);
    // comp1 has no own custo, but its paiId (parentOfComp1) resolves to 50.
    expect(result).toEqual({ custo: 50, faltando: [] });
  });

  it('leaves a still-unresolvable component id absent from every map (no throw, no recursion)', async () => {
    const fetch = async () => new Map<string, ComponenteProdutoData>();
    const r = await loadKitResolucao(db, produtos, fetch);
    expect(r.custoByProdutoId.comp1).toBeUndefined();
    expect(r.paiByProdutoId.comp1).toBeUndefined();
  });
});
