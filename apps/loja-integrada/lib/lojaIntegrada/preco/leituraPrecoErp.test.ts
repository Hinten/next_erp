/**
 * `leituraPrecoErp.ts` (master plan step 13, PR 13-d): the price run's masked ERP reads. The mask
 * is EXACTLY what the price function reads (no custo, no kit fields), one masked read per produto,
 * a parent read only for an id that names a document, and the stock flow's link readers by
 * identity. A property sweep shows the mask is SUFFICIENT: the price function answers the same on
 * the masked reads as on the whole documents.
 */
import { describe, expect, it, vi } from 'vitest';
import { precoAlvoLi } from '@delfrance/schemas';

import * as leituraEstoque from '../estoque/leituraEstoqueErp';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  CAMPOS_PRODUTO_PRECO_LI,
  lerProdutoPrecoLi,
  lerVinculosDoProdutoLi,
  paiParaLerPrecoLi,
  sondarVinculoDuplicadoLi,
} from './leituraPrecoErp';

describe('the mask', () => {
  it('is EXACTLY what the price function reads — no custo, no componentesKit, no kit flag', () => {
    expect([...CAMPOS_PRODUTO_PRECO_LI]).toEqual(['paiId', 'precos', 'propagatePriceToChildren']);
    for (const campo of ['custo', 'componentesKit', 'ehKit', 'ehKitVirtual', 'preco']) {
      expect(CAMPOS_PRODUTO_PRECO_LI as readonly string[]).not.toContain(campo);
    }
  });
});

describe('lerProdutoPrecoLi: ONE masked point read', () => {
  it('one getAll of the produto, masked: the custo and the kit fields never come back', async () => {
    const db = new FakeDb();
    db.seed('produtos/p-filho-preco', {
      paiId: 'p-pai-preco',
      precos: { 'tab-normal': { valor: 55.55 } },
      propagatePriceToChildren: false,
      custo: 99.99,
      componentesKit: { c1: { quantidade: 1 } },
      sku: 'SKU-INVENTADO',
    });
    // The MASK itself is pinned on the call, spelled out (a widened constant fails too): the
    // reader projects the same fields in code, so its result alone would read the same with an
    // unmasked (dearer) read, or one that also fetched the custo.
    const getAll = vi.spyOn(db, 'getAll');
    const lido = await lerProdutoPrecoLi(asDb(db), 'p-filho-preco');
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0]?.at(-1)).toEqual({
      fieldMask: ['paiId', 'precos', 'propagatePriceToChildren'],
    });
    expect(lido).toEqual({
      id: 'p-filho-preco',
      dados: {
        paiId: 'p-pai-preco',
        precos: { 'tab-normal': { valor: 55.55 } },
        propagatePriceToChildren: false,
      },
    });
    expect(db.leituras).toEqual(['produtos/p-filho-preco']);
    expect(db.consultas).toEqual([]);
  });

  it('a field the document does not hold is absent from `dados`, never `undefined`-keyed', async () => {
    const db = new FakeDb();
    db.seed('produtos/p-raiz-preco', { precos: {} });
    const lido = await lerProdutoPrecoLi(asDb(db), 'p-raiz-preco');
    expect(lido).toEqual({ id: 'p-raiz-preco', dados: { precos: {} } });
    expect(Object.keys(lido?.dados ?? {})).toEqual(['precos']);
  });

  it('an absent produto ⇒ null, after the same one read', async () => {
    const db = new FakeDb();
    expect(await lerProdutoPrecoLi(asDb(db), 'p-nenhum')).toBeNull();
    expect(db.leituras).toEqual(['produtos/p-nenhum']);
  });
});

describe('paiParaLerPrecoLi: the parent to read, never built from a raw paiId', () => {
  it('a child ⇒ its parent id', () => {
    expect(paiParaLerPrecoLi({ id: 'p-filho', dados: { paiId: 'p-pai' } })).toBe('p-pai');
  });

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['blank (a legacy root)', ''],
    ['a self-parent', 'p-filho'],
    ['a number', 7],
    ['null', null],
    ['a path', 'a/b'],
    ['a dot', '.'],
    ['two dots', '..'],
    ['a reserved id', '__x__'],
  ])('⚠️ NEAR-MISS: a paiId that is %s ⇒ null, with ZERO reads', (_r, paiId) => {
    const db = new FakeDb();
    const dados = paiId === undefined ? {} : { paiId };
    expect(paiParaLerPrecoLi({ id: 'p-filho', dados })).toBeNull();
    expect(db.leituras).toEqual([]);
  });
});

describe('the link readers are the stock flow’s, the SAME functions', () => {
  it('re-exported by identity (one copy, one set of index pins)', () => {
    expect(lerVinculosDoProdutoLi).toBe(leituraEstoque.lerVinculosDoProdutoLi);
    expect(sondarVinculoDuplicadoLi).toBe(leituraEstoque.sondarVinculoDuplicadoLi);
  });
});

/* -------------------------------------------------------------------------- */
/*                   Property: the mask is sufficient                          */
/* -------------------------------------------------------------------------- */

/** mulberry32: a deterministic generator in [0, 1). */
function mulberry32(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SORTEIOS = 2_000;
const TABELAS = ['tab-normal', 'tab-promo', 'tab-outra'] as const;
const VALORES: readonly unknown[] = [55.55, 44.44, 11.11, 0, -1, '22.22', null, 0.004];

function escolher<T>(r: () => number, de: readonly T[]): T {
  return de[Math.floor(r() * de.length)] as T;
}

function precosSorteados(r: () => number): unknown {
  const forma = r();
  if (forma < 0.1) return null;
  if (forma < 0.15) return 7;
  const precos: Record<string, unknown> = {};
  for (const t of TABELAS) {
    const x = r();
    if (x < 0.3) continue;
    precos[t] = x < 0.4 ? escolher(r, VALORES) : { valor: escolher(r, VALORES) };
  }
  return precos;
}

/** A produto document with the masked fields drawn and the unmasked noise always present. */
function documentoSorteado(r: () => number, paiId: unknown): DocData {
  const doc: DocData = {
    custo: escolher(r, VALORES),
    componentesKit: { c1: { quantidade: 2, limitarEstoque: true } },
    ehKit: r() < 0.5,
    ruido: escolher(r, VALORES),
    precos: precosSorteados(r),
  };
  if (paiId !== undefined) doc.paiId = paiId;
  const propaga = r();
  if (propaga < 0.33) doc.propagatePriceToChildren = false;
  else if (propaga < 0.66) doc.propagatePriceToChildren = escolher(r, [true, 'false', null, 0]);
  return doc;
}

describe('PROPERTY: the price function answers the same on the masked reads as on the whole documents', () => {
  // CI runners are ~5× slower under load: 2 000 seeded draws through the fake get their own budget.
  it(`${String(SORTEIOS)} seeded draws`, { timeout: 30_000 }, async () => {
    const r = mulberry32(13_004);
    let filhos = 0;
    for (let i = 0; i < SORTEIOS; i++) {
      const db = new FakeDb();
      const ehFilho = r() < 0.7;
      const produtoDoc = documentoSorteado(r, ehFilho ? 'p-pai' : escolher(r, [undefined, '']));
      const paiExiste = r() < 0.85;
      const paiDoc = documentoSorteado(r, undefined);
      db.seed('produtos/p-filho', produtoDoc);
      if (paiExiste) db.seed('produtos/p-pai', paiDoc);
      const tabelaPromocionalId = escolher(r, [null, 'tab-promo', 'tab-normal']);

      const produto = await lerProdutoPrecoLi(asDb(db), 'p-filho');
      if (produto === null) throw new TypeError('o produto semeado sumiu');
      const paiId = paiParaLerPrecoLi(produto);
      const pai = paiId === null ? null : await lerProdutoPrecoLi(asDb(db), paiId);
      const mascarado = precoAlvoLi({
        produto,
        pai: pai?.dados ?? null,
        tabelaNormalId: 'tab-normal',
        tabelaPromocionalId,
      });
      const inteiro = precoAlvoLi({
        produto: { id: 'p-filho', dados: produtoDoc },
        pai: ehFilho && paiExiste ? paiDoc : null,
        tabelaNormalId: 'tab-normal',
        tabelaPromocionalId,
      });
      expect(mascarado, `sorteio ${String(i)}`).toEqual(inteiro);
      if (ehFilho) filhos += 1;
    }
    // Anti-vacuity: the sweep met children (the parent read) and roots alike.
    expect(filhos).toBeGreaterThan(SORTEIOS / 2);
    expect(filhos).toBeLessThan(SORTEIOS);
  });
});
