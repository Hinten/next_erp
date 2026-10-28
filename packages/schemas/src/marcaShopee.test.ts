import { describe, expect, it } from 'vitest';

import * as barrel from './index';
import {
  docIdDaMarcaShopee,
  linhaDeMarcaParaGravarShopee,
  marcaParaRascunhoShopee,
  marcaShopeeArmazenadaSchema,
  marcasDaContaShopee,
  type MarcaDaContaShopee,
} from './marcaShopee';
import { conteudoRascunhoShopeeSchema } from './produto/collection/shopeeRascunho';
import type { MarcaDto } from './taxonomiaShopeeDto';

/**
 * The Shopee brand shortlist (#1911, D10, P9): the typed `brandshopee` row,
 * THE reader of a conta's rows, the pair a draft stores, and the row a
 * registration writes.
 *
 * Identity is the integer `brand_id` and nothing else, so every grouping test
 * comes in pairs: what must collapse into ONE brand, and the near-miss that
 * must stay DISTINCT. Fixture ids only.
 */

/** A legacy-shaped row: the Flutter model's three fields (display an explicit null). */
function legado(
  brand_id: unknown,
  original_brand_name: unknown,
  display_brand_name: unknown = null,
): Record<string, unknown> {
  return { brand_id, original_brand_name, display_brand_name };
}

describe('the barrel exposes THESE objects — one copy', () => {
  it('index.ts re-exports the same values', () => {
    expect(barrel.marcaShopeeArmazenadaSchema).toBe(marcaShopeeArmazenadaSchema);
    expect(barrel.marcasDaContaShopee).toBe(marcasDaContaShopee);
    expect(barrel.marcaParaRascunhoShopee).toBe(marcaParaRascunhoShopee);
    expect(barrel.linhaDeMarcaParaGravarShopee).toBe(linhaDeMarcaParaGravarShopee);
    expect(barrel.docIdDaMarcaShopee).toBe(docIdDaMarcaShopee);
  });

  it('integracao.ts keeps its loose RULES surface — this module did not replace it', () => {
    // The rules domain stays the pass-through: an arbitrary key set still parses there.
    expect(barrel.brandShopeeSchema.safeParse({ qualquer: 1 }).success).toBe(true);
    expect(barrel.brandShopeeSchema).not.toBe(marcaShopeeArmazenadaSchema);
    expect(barrel.brandShopeeMeta.collectionPath).toBe('integracao/{integracaoId}/brandshopee');
  });
});

describe('marcaShopeeArmazenadaSchema — the stored row, legacy-tolerant', () => {
  it('reads the legacy row: explicit null display, the stamps and stray keys survive', () => {
    const lido = marcaShopeeArmazenadaSchema.parse({
      ...legado(1001, 'Marca Exemplo'),
      docId: 'abc',
      createTime: 1_700_000_000_000,
      extra: { x: 1 },
    });
    expect(lido).toEqual({
      brand_id: 1001,
      original_brand_name: 'Marca Exemplo',
      display_brand_name: null,
      docId: 'abc',
      createTime: 1_700_000_000_000,
      extra: { x: 1 },
    });
  });

  it("an absent display defaults to null; a legacy '' name is LEGAL", () => {
    expect(marcaShopeeArmazenadaSchema.parse({ brand_id: 5, original_brand_name: '' })).toEqual({
      brand_id: 5,
      original_brand_name: '',
      display_brand_name: null,
    });
  });

  it('brand 0 ("No Brand") is a readable row', () => {
    expect(marcaShopeeArmazenadaSchema.safeParse(legado(0, 'No Brand')).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ["a digit STRING '123' (no coercion)", '123'],
    ['a negative id', -1],
    ['a fraction', 1.5],
    ['an id past MAX_SAFE_INTEGER (lost precision)', 2 ** 53],
    ['null', null],
    ['absent', undefined],
  ])('REFUSES brand_id: %s', (_n, brand_id) => {
    expect(marcaShopeeArmazenadaSchema.safeParse(legado(brand_id, 'Nike')).success).toBe(false);
  });

  it('the largest safe id still reads (Shopee ids exceed int32)', () => {
    const lido = marcaShopeeArmazenadaSchema.safeParse(legado(Number.MAX_SAFE_INTEGER, 'Nike'));
    expect(lido.success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['null', null],
    ['a number', 7],
  ])('REFUSES original_brand_name: %s', (_n, nome) => {
    expect(marcaShopeeArmazenadaSchema.safeParse(legado(7, nome)).success).toBe(false);
  });
});

describe('marcasDaContaShopee — grouping by the integer brand_id ONLY', () => {
  it("NEAR-MISS: two 'Nike' rows at ids 1 and 2 stay TWO brands (never grouped by name)", () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'aaa', data: legado(1, 'Nike') },
      { id: 'bbb', data: legado(2, 'Nike') },
    ]);
    expect(marcas.map((m) => [m.brandId, m.originalBrandName, m.docIds])).toEqual([
      [1, 'Nike', ['aaa']],
      [2, 'Nike', ['bbb']],
    ]);
  });

  it("EQUAL PAIR: 'Nike' and 'NIKE' at ONE id are ONE brand carrying both doc ids", () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'bbb', data: legado(7, 'NIKE') },
      { id: 'aaa', data: legado(7, 'Nike') },
    ]);
    expect(marcas).toHaveLength(1);
    expect(marcas[0]).toMatchObject({
      brandId: 7,
      originalBrandName: 'Nike',
      docIds: ['aaa', 'bbb'],
    });
  });

  it('NEAR-MISS: 123 and 1234 are two brands', () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'x1', data: legado(123, 'A') },
      { id: 'x2', data: legado(1234, 'B') },
    ]);
    expect(marcas.map((m) => m.brandId)).toEqual([123, 1234]);
  });

  it("NEAR-MISS: a STRING '123' is UNREADABLE, never merged into brand 123", () => {
    const leitura = marcasDaContaShopee([
      { id: 'num', data: legado(123, 'Nike') },
      { id: 'str', data: legado('123', 'Nike') },
    ]);
    expect(leitura.marcas).toEqual([
      {
        brandId: 123,
        originalBrandName: 'Nike',
        displayBrandName: null,
        rotulo: 'Nike',
        docIds: ['num'],
      },
    ]);
    expect(leitura.ilegiveis).toEqual(['str']);
    expect(leitura.semMarca).toEqual([]);
  });

  it('duplicate docs of one brand ⇒ docIds lists EVERY one (a removal deletes all N)', () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'q', data: legado(9, 'Marca Exemplo') },
      { id: 'p', data: legado(9, '') },
      { id: 'r', data: legado(9, 'Marca Exemplo') },
    ]);
    expect(marcas).toHaveLength(1);
    expect(marcas[0]!.docIds).toEqual(['q', 'p', 'r']);
    expect(new Set(marcas[0]!.docIds).size).toBe(3);
  });
});

describe('marcasDaContaShopee — brand 0 and unreadable rows', () => {
  it('a brand_id 0 row goes to semMarca and NEVER into the list ("Sem marca" is the picker\'s)', () => {
    const leitura = marcasDaContaShopee([
      { id: 'z0', data: legado(0, 'No Brand') },
      { id: 'a0', data: legado(0, '') },
      { id: 'n1', data: legado(1, 'Nike') },
    ]);
    expect(leitura.semMarca).toEqual(['a0', 'z0']);
    expect(leitura.marcas.map((m) => m.brandId)).toEqual([1]);
    expect(leitura.marcas.some((m) => m.brandId === 0)).toBe(false);
  });

  it('every unreadable shape is listed by doc id, code-unit order, and merged into nothing', () => {
    const leitura = marcasDaContaShopee([
      { id: 'd', data: null },
      { id: 'c', data: ['not', 'an', 'object'] },
      { id: 'b', data: 'texto' },
      { id: 'a', data: { brand_id: 4 } },
      { id: 'e', data: legado(-4, 'Neg') },
      { id: 'f', data: legado(4, 'Ok') },
    ]);
    expect(leitura.ilegiveis).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(leitura.marcas.map((m) => [m.brandId, m.docIds])).toEqual([[4, ['f']]]);
  });

  it('no rows ⇒ an empty reading', () => {
    expect(marcasDaContaShopee([])).toEqual({ marcas: [], semMarca: [], ilegiveis: [] });
  });
});

describe('marcasDaContaShopee — the canonical row and the names', () => {
  it('the row at String(brand_id) is canonical even when a blank auto-id row sorts BEFORE it', () => {
    // '0…' < '9…' in code units: a "first by doc id" rule would pick the blank row.
    const { marcas } = marcasDaContaShopee([
      { id: '0AutoIdLegado0000000', data: legado(900, '') },
      { id: '900', data: legado(900, 'Nike') },
    ]);
    expect(marcas[0]).toMatchObject({
      originalBrandName: 'Nike',
      docIds: ['900', '0AutoIdLegado0000000'],
    });
  });

  it('the row at String(brand_id) is canonical over an EARLIER named row too (its names win)', () => {
    const { marcas } = marcasDaContaShopee([
      { id: '0legado', data: legado(900, 'Nike antiga', 'Antiga') },
      { id: '900', data: legado(900, 'Nike', null) },
    ]);
    expect(marcas[0]).toMatchObject({
      originalBrandName: 'Nike',
      displayBrandName: null,
      docIds: ['900', '0legado'],
    });
  });

  it('NEAR-MISS: a doc id that only LOOKS like the brand id is not its deterministic row', () => {
    const { marcas } = marcasDaContaShopee([
      { id: '0900', data: legado(900, '') },
      { id: 'zzz', data: legado(900, 'Nike') },
    ]);
    expect(marcas[0]).toMatchObject({ originalBrandName: 'Nike', docIds: ['zzz', '0900'] });
  });

  it('with no deterministic row, the FIRST row carrying a name (doc-id order) is canonical', () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'ccc', data: legado(5, 'Segunda') },
      { id: 'aaa', data: legado(5, '   ') },
      { id: 'bbb', data: legado(5, 'Primeira') },
    ]);
    expect(marcas[0]).toMatchObject({
      originalBrandName: 'Primeira',
      docIds: ['bbb', 'aaa', 'ccc'],
    });
  });

  it("all rows nameless ⇒ the first by doc id is canonical and the name is null, never ''", () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'bbb', data: legado(5, '') },
      { id: 'aaa', data: legado(5, ' \t') },
    ]);
    expect(marcas[0]).toMatchObject({
      originalBrandName: null,
      displayBrandName: null,
      rotulo: 'Marca 5',
      docIds: ['aaa', 'bbb'],
    });
  });

  it("FOLDS a blank name to null: '' and whitespace-only (the draft write's own test)", () => {
    for (const nome of ['', '   ', '\n\t ']) {
      const { marcas } = marcasDaContaShopee([{ id: 'a', data: legado(3, nome, nome) }]);
      expect(marcas[0]!.originalBrandName).toBeNull();
      expect(marcas[0]!.displayBrandName).toBeNull();
    }
  });

  it('NEAR-MISS: a name WITH text is kept VERBATIM — edge spaces and case are not folded', () => {
    const { marcas } = marcasDaContaShopee([{ id: 'a', data: legado(3, ' Nike ', ' NIKE BR ') }]);
    expect(marcas[0]).toMatchObject({
      originalBrandName: ' Nike ',
      displayBrandName: ' NIKE BR ',
      rotulo: 'NIKE BR',
    });
  });
});

describe('marcasDaContaShopee — rotulo and display order (display only)', () => {
  it('rotulo = display (trimmed) ?? original (trimmed) ?? "Marca <id>"', () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'a', data: legado(1, 'Original', 'Exibida') },
      { id: 'b', data: legado(2, 'Só original', '  ') },
      { id: 'c', data: legado(3, '', null) },
    ]);
    expect(marcas.map((m) => [m.brandId, m.rotulo])).toEqual([
      [1, 'Exibida'],
      [3, 'Marca 3'],
      [2, 'Só original'],
    ]);
  });

  it('sorted by rotulo in pt-BR (an accent is not after Z), then by brandId on a tie', () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'a', data: legado(30, 'Zebra') },
      { id: 'b', data: legado(20, 'Avião') },
      { id: 'c', data: legado(10, 'Árvore') },
      { id: 'd', data: legado(41, 'Mesma') },
      { id: 'e', data: legado(40, 'Mesma') },
    ]);
    expect(marcas.map((m) => [m.rotulo, m.brandId])).toEqual([
      ['Árvore', 10],
      ['Avião', 20],
      ['Mesma', 40],
      ['Mesma', 41],
      ['Zebra', 30],
    ]);
  });

  it('the reading depends on the SET of rows, never on their order', () => {
    const linhas = [
      { id: 'k', data: legado(9, 'Nove') },
      { id: '9', data: legado(9, 'Nove canônica') },
      { id: 'b', data: legado(2, 'Dois') },
      { id: 'z', data: legado(0, 'No Brand') },
      { id: 'x', data: legado('2', 'Dois') },
      { id: 'a', data: legado(2, '') },
    ];
    const esperado = marcasDaContaShopee(linhas);
    expect(marcasDaContaShopee([...linhas].reverse())).toEqual(esperado);
    expect(
      marcasDaContaShopee([linhas[3]!, linhas[0]!, linhas[5]!, linhas[1]!, linhas[4]!, linhas[2]!]),
    ).toEqual(esperado);
    expect(esperado.marcas.map((m) => [m.brandId, m.docIds])).toEqual([
      [2, ['b', 'a']],
      [9, ['9', 'k']],
    ]);
  });
});

describe('marcaParaRascunhoShopee — the pair a picked row gives the draft', () => {
  function marca(originalBrandName: string | null): MarcaDaContaShopee {
    return {
      brandId: 77,
      originalBrandName,
      displayBrandName: 'Exibida',
      rotulo: 'Exibida',
      docIds: ['77'],
    };
  }

  it("carries the row's name whenever the row has one", () => {
    expect(marcaParaRascunhoShopee(marca('Marca Exemplo'))).toEqual({
      brand_id: 77,
      original_brand_name: 'Marca Exemplo',
    });
  });

  it('carries the original name, never the display one', () => {
    expect(marcaParaRascunhoShopee(marca('Original')).original_brand_name).toBe('Original');
  });

  it("a nameless ROW gives a null name — any stored-name rule is the tab's, applied on top", () => {
    expect(marcaParaRascunhoShopee(marca(null))).toEqual({
      brand_id: 77,
      original_brand_name: null,
    });
  });

  it('the pair is EXACTLY the marca the draft write accepts (strict, name verbatim)', () => {
    const par = marcaParaRascunhoShopee(marca(' Marca Exemplo '));
    expect(Object.keys(par).sort()).toEqual(['brand_id', 'original_brand_name']);
    expect(conteudoRascunhoShopeeSchema.parse({ marca: par })).toEqual({ marca: par });
  });

  it('end to end: a legacy nameless row and a named one, read then picked', () => {
    const { marcas } = marcasDaContaShopee([
      { id: 'a', data: legado(11, '') },
      { id: 'b', data: legado(12, 'Doze') },
    ]);
    expect(marcas.map(marcaParaRascunhoShopee)).toEqual([
      { brand_id: 12, original_brand_name: 'Doze' },
      { brand_id: 11, original_brand_name: null },
    ]);
  });
});

describe('linhaDeMarcaParaGravarShopee — the row a registration writes', () => {
  function dto(
    brandId: number,
    originalBrandName: string,
    displayBrandName: string | null = null,
  ): MarcaDto {
    return { brandId, originalBrandName, displayBrandName };
  }

  it('writes at String(brandId), the names VERBATIM, exactly three keys', () => {
    const linha = linhaDeMarcaParaGravarShopee(dto(1001, 'Marca Exemplo', 'Exemplo BR'));
    expect(linha).toEqual({
      docId: '1001',
      data: {
        brand_id: 1001,
        original_brand_name: 'Marca Exemplo',
        display_brand_name: 'Exemplo BR',
      },
    });
    expect(Object.keys(linha!.data).sort()).toEqual([
      'brand_id',
      'display_brand_name',
      'original_brand_name',
    ]);
    expect(linha!.docId).toBe(docIdDaMarcaShopee(1001));
  });

  it('NEAR-MISS: an edge-spaced name is kept as Shopee spelled it (never trimmed)', () => {
    expect(linhaDeMarcaParaGravarShopee(dto(5, ' Nike '))?.data.original_brand_name).toBe(' Nike ');
  });

  it('a blank display name is written null; a display with text is verbatim', () => {
    expect(linhaDeMarcaParaGravarShopee(dto(5, 'Nike', '  '))?.data.display_brand_name).toBeNull();
    expect(linhaDeMarcaParaGravarShopee(dto(5, 'Nike', ''))?.data.display_brand_name).toBeNull();
    expect(linhaDeMarcaParaGravarShopee(dto(5, 'Nike', ' N '))?.data.display_brand_name).toBe(
      ' N ',
    );
  });

  it.each<[string, number]>([
    ['0 ("Sem marca" is the picker\'s, never a row)', 0],
    ['a negative id', -5],
    ['a fraction', 1.5],
    ['an unsafe integer', 2 ** 53],
  ])('REFUSES brandId %s', (_n, brandId) => {
    expect(linhaDeMarcaParaGravarShopee(dto(brandId, 'Nike'))).toBeNull();
  });

  it('NEAR-MISS: brand 1 (the smallest positive id) is accepted', () => {
    expect(linhaDeMarcaParaGravarShopee(dto(1, 'Nike'))?.docId).toBe('1');
  });

  it.each<[string, string]>([
    ['empty', ''],
    ['whitespace-only', ' \t '],
  ])("REFUSES an originalBrandName %s — a new row never carries ''", (_n, nome) => {
    expect(linhaDeMarcaParaGravarShopee(dto(5, nome))).toBeNull();
  });

  it('round trip: the written row parses as stored and reads back as its brand, canonical', () => {
    const linha = linhaDeMarcaParaGravarShopee(dto(4321, 'Marca Exemplo'))!;
    expect(marcaShopeeArmazenadaSchema.parse(linha.data)).toEqual(linha.data);
    const { marcas } = marcasDaContaShopee([
      { id: 'legadoAutoId', data: legado(4321, '') },
      { id: linha.docId, data: linha.data },
    ]);
    expect(marcas).toEqual([
      {
        brandId: 4321,
        originalBrandName: 'Marca Exemplo',
        displayBrandName: null,
        rotulo: 'Marca Exemplo',
        docIds: ['4321', 'legadoAutoId'],
      },
    ]);
    expect(marcaParaRascunhoShopee(marcas[0]!)).toEqual({
      brand_id: 4321,
      original_brand_name: 'Marca Exemplo',
    });
  });
});
