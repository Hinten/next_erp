import { describe, expect, it } from 'vitest';
import {
  ESTADO_LISTA_SHOPEE,
  MOTIVO_ENTRADA_SHOPEE_ILEGIVEL,
  MOTIVO_SEM_TABELA_SHOPEE,
  entradaTabelaShopeeSchema,
  indiceDaEntradaShopee,
  lerEntradasShopeeDaConta,
  resolverEntradaShopee,
  type LinhaEntradaShopee,
} from './tabelaDeMedidasShopee';

// Fixture ids only (s18 rules): integração `int-1`; Shopee's own doc-sample ids.
const CONTA = 'int-1';
const CAMISETAS = { categoryId: 400055, size_chart_id: 700024641, name: 'Camisetas' };
const CALCAS = { categoryId: 100087, size_chart_id: 700024613, name: 'Calças' };

const { entradaInvalida, categoriaInvalida, tabelaInvalida, nomeInvalido } =
  MOTIVO_ENTRADA_SHOPEE_ILEGIVEL;

/** The readable/unreadable shape of every linha, for compact assertions. */
function resumo(linhas: readonly LinhaEntradaShopee[]) {
  return linhas.map((l) => [l.indice, l.motivo ?? l.entrada]);
}

describe('the exported constants', () => {
  it('spell exactly the union members (apps/web renders them)', () => {
    expect(Object.values(MOTIVO_ENTRADA_SHOPEE_ILEGIVEL).sort()).toEqual([
      'categoria-invalida',
      'entrada-invalida',
      'nome-invalido',
      'tabela-invalida',
    ]);
    expect(Object.values(ESTADO_LISTA_SHOPEE).sort()).toEqual([
      'campo-invalido',
      'lista',
      'lista-invalida',
      'sem-lista',
    ]);
    expect(Object.values(MOTIVO_SEM_TABELA_SHOPEE).sort()).toEqual([
      'anuncio-sem-categoria',
      'categoria-sem-entrada',
      'conta-sem-entradas',
    ]);
  });
});

describe('entradaTabelaShopeeSchema — the WRITE side (S21)', () => {
  it('accepts the corpus entry, and an empty name (corpus parity)', () => {
    expect(entradaTabelaShopeeSchema.parse(CAMISETAS)).toEqual(CAMISETAS);
    expect(entradaTabelaShopeeSchema.parse({ ...CAMISETAS, name: '' })).toEqual({
      ...CAMISETAS,
      name: '',
    });
  });

  it('accepts MAX_SAFE_INTEGER and 1 — the boundary pair of every refusal below', () => {
    expect(
      entradaTabelaShopeeSchema.safeParse({ ...CAMISETAS, size_chart_id: Number.MAX_SAFE_INTEGER })
        .success,
    ).toBe(true);
    expect(entradaTabelaShopeeSchema.safeParse({ ...CAMISETAS, categoryId: 1 }).success).toBe(true);
  });

  it.each([
    ['an extra key', { ...CAMISETAS, extra: 1 }],
    ['a staged-deletion mark', { ...CAMISETAS, _pendingDelete: true }],
    ['size_chart_id 0 (the DETACH sentinel)', { ...CAMISETAS, size_chart_id: 0 }],
    ['a negative size_chart_id', { ...CAMISETAS, size_chart_id: -1 }],
    ['a fractional size_chart_id', { ...CAMISETAS, size_chart_id: 1.5 }],
    ['size_chart_id 2**53 (precision lost)', { ...CAMISETAS, size_chart_id: 2 ** 53 }],
    ['a NaN size_chart_id', { ...CAMISETAS, size_chart_id: Number.NaN }],
    ['an Infinity size_chart_id', { ...CAMISETAS, size_chart_id: Number.POSITIVE_INFINITY }],
    ['a digit-string size_chart_id', { ...CAMISETAS, size_chart_id: '700024641' }],
    ['a digit-string categoryId', { ...CAMISETAS, categoryId: '400055' }],
    ['categoryId 0', { ...CAMISETAS, categoryId: 0 }],
    ['a missing name', { categoryId: 400055, size_chart_id: 700024641 }],
    ['a null name', { ...CAMISETAS, name: null }],
  ])('refuses %s', (_label, valor) => {
    expect(entradaTabelaShopeeSchema.safeParse(valor).success).toBe(false);
  });
});

describe('lerEntradasShopeeDaConta — the READ slice', () => {
  it('S1 reads the corpus entry verbatim at its raw index', () => {
    expect(lerEntradasShopeeDaConta({ [CONTA]: [CAMISETAS] }, CONTA)).toEqual({
      estado: ESTADO_LISTA_SHOPEE.lista,
      linhas: [{ indice: 0, entrada: CAMISETAS, motivo: null }],
    });
  });

  it('S2/S4 no map, or no key for this conta, reads as sem-lista', () => {
    for (const campo of [null, undefined, {}, { 'int-2': [CAMISETAS] }]) {
      expect(lerEntradasShopeeDaConta(campo, CONTA)).toEqual({
        estado: ESTADO_LISTA_SHOPEE.semLista,
        linhas: [],
      });
    }
  });

  it('S3 a per-conta null or undefined reads as sem-lista — never lista-invalida, never a throw', () => {
    for (const valor of [null, undefined]) {
      expect(lerEntradasShopeeDaConta({ [CONTA]: valor }, CONTA)).toEqual({
        estado: ESTADO_LISTA_SHOPEE.semLista,
        linhas: [],
      });
    }
  });

  it('S3 an empty list is a list with no linhas — not sem-lista', () => {
    expect(lerEntradasShopeeDaConta({ [CONTA]: [] }, CONTA)).toEqual({
      estado: ESTADO_LISTA_SHOPEE.lista,
      linhas: [],
    });
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
    'S5 an inherited %s is not this conta’s key',
    (chave) => {
      expect(lerEntradasShopeeDaConta({}, chave)).toEqual({
        estado: ESTADO_LISTA_SHOPEE.semLista,
        linhas: [],
      });
    },
  );

  it('S5 near-miss: an OWN key with a prototype member’s name IS read (hasOwn, not a blocklist)', () => {
    const campo = JSON.parse(
      '{"__proto__":[{"categoryId":400055,"size_chart_id":700024641,"name":"Camisetas"}]}',
    ) as unknown;
    expect(resumo(lerEntradasShopeeDaConta(campo, '__proto__').linhas)).toEqual([[0, CAMISETAS]]);
    expect(
      resumo(lerEntradasShopeeDaConta({ constructor: [CALCAS] }, 'constructor').linhas),
    ).toEqual([[0, CALCAS]]);
  });

  it('reads a null-prototype map', () => {
    const campo = Object.assign(Object.create(null) as Record<string, unknown>, {
      [CONTA]: [CAMISETAS],
    });
    expect(resumo(lerEntradasShopeeDaConta(campo, CONTA).linhas)).toEqual([[0, CAMISETAS]]);
  });

  it('S6 reads ONLY this conta’s list — the key is never trimmed, case-folded or prefix-matched', () => {
    const campo = {
      'int-1': [CAMISETAS],
      'int-10': [CALCAS],
      'int-11': [CALCAS],
      ' int-1': [CALCAS],
      'INT-1': [CALCAS],
    };
    expect(resumo(lerEntradasShopeeDaConta(campo, 'int-1').linhas)).toEqual([[0, CAMISETAS]]);
    expect(resumo(lerEntradasShopeeDaConta(campo, 'int-10').linhas)).toEqual([[0, CALCAS]]);
    expect(lerEntradasShopeeDaConta(campo, 'int-1 ').estado).toBe(ESTADO_LISTA_SHOPEE.semLista);
    expect(lerEntradasShopeeDaConta(campo, 'int-2').estado).toBe(ESTADO_LISTA_SHOPEE.semLista);
  });

  it('S7 one bad element never costs its neighbours; every indice is the RAW position', () => {
    const lista: unknown[] = [
      null, // 0
      'x', // 1
      CAMISETAS, // 2
      { ...CAMISETAS, categoryId: '400055' }, // 3 — no fold
      { ...CAMISETAS, size_chart_id: 0 }, // 4 — the detach sentinel
      { ...CAMISETAS, categoryId: -1 }, // 5
      { ...CAMISETAS, categoryId: 1.5 }, // 6
      { ...CAMISETAS, categoryId: 2 ** 53 }, // 7
      { ...CAMISETAS, name: 42 }, // 8
      { categoryId: 400055, size_chart_id: 700024641 }, // 9 — no name
      CALCAS, // 10
      [CAMISETAS], // 11 — an array is not an entry
      42, // 12
      true, // 13
      { ...CAMISETAS, size_chart_id: '700024641' }, // 14 — no fold
      { ...CAMISETAS, size_chart_id: Number.NaN }, // 15
      {}, // 16
    ];
    const leitura = lerEntradasShopeeDaConta({ [CONTA]: lista }, CONTA);
    expect(leitura.estado).toBe(ESTADO_LISTA_SHOPEE.lista);
    expect(resumo(leitura.linhas)).toEqual([
      [0, entradaInvalida],
      [1, entradaInvalida],
      [2, CAMISETAS],
      [3, categoriaInvalida],
      [4, tabelaInvalida],
      [5, categoriaInvalida],
      [6, categoriaInvalida],
      [7, categoriaInvalida],
      [8, nomeInvalido],
      [9, nomeInvalido],
      [10, CALCAS],
      [11, entradaInvalida],
      [12, entradaInvalida],
      [13, entradaInvalida],
      [14, tabelaInvalida],
      [15, tabelaInvalida],
      [16, categoriaInvalida],
    ]);
    // No raw value ever rides on an unreadable linha: exactly three keys, a
    // `null` entrada and one of the four motivos.
    for (const linha of leitura.linhas) {
      if (linha.motivo === null) continue;
      expect(Object.keys(linha).sort()).toEqual(['entrada', 'indice', 'motivo']);
      expect(linha.entrada).toBeNull();
      expect(Object.values(MOTIVO_ENTRADA_SHOPEE_ILEGIVEL)).toContain(linha.motivo);
    }
  });

  it('S7 an unreadable element ahead of a readable one: the readable one keeps indice 1 (M5)', () => {
    expect(
      resumo(lerEntradasShopeeDaConta({ [CONTA]: [{ size_chart_id: 1 }, CALCAS] }, CONTA).linhas),
    ).toEqual([
      [0, categoriaInvalida],
      [1, CALCAS],
    ]);
  });

  it('S7 the fields are judged IN ORDER: categoryId, then size_chart_id, then name', () => {
    const lista = [
      { categoryId: '1', size_chart_id: 0, name: 42 },
      { categoryId: 1, size_chart_id: 0, name: 42 },
      { categoryId: 1, size_chart_id: 1, name: 42 },
    ];
    expect(resumo(lerEntradasShopeeDaConta({ [CONTA]: lista }, CONTA).linhas)).toEqual([
      [0, categoriaInvalida],
      [1, tabelaInvalida],
      [2, nomeInvalido],
    ]);
  });

  it('a hole in a sparse list reads as entrada-invalida at its own index', () => {
    const lista: unknown[] = [];
    lista[1] = CAMISETAS;
    expect(resumo(lerEntradasShopeeDaConta({ [CONTA]: lista }, CONTA).linhas)).toEqual([
      [0, entradaInvalida],
      [1, CAMISETAS],
    ]);
  });

  it('S8 extra stored keys (a stray staged-deletion mark included) never reach the entrada', () => {
    const [linha] = lerEntradasShopeeDaConta(
      { [CONTA]: [{ ...CAMISETAS, _pendingDelete: true, extra: 'x' }] },
      CONTA,
    ).linhas;
    expect(linha?.motivo).toBeNull();
    expect(Object.keys(linha?.entrada ?? {}).sort()).toEqual([
      'categoryId',
      'name',
      'size_chart_id',
    ]);
    expect(linha?.entrada).toEqual(CAMISETAS);
  });

  it('an inherited field is not a stored field', () => {
    const herdado = Object.assign(Object.create({ name: 'Camisetas' }) as Record<string, unknown>, {
      categoryId: 400055,
      size_chart_id: 700024641,
    });
    expect(resumo(lerEntradasShopeeDaConta({ [CONTA]: [herdado] }, CONTA).linhas)).toEqual([
      [0, nomeInvalido],
    ]);
  });

  it.each([
    ['an object', {}],
    ['a string', 'x'],
    ['a number', 42],
    ['a boolean', false],
  ])('S9 a per-conta value that is %s reads as lista-invalida', (_label, valor) => {
    expect(lerEntradasShopeeDaConta({ [CONTA]: valor }, CONTA)).toEqual({
      estado: ESTADO_LISTA_SHOPEE.listaInvalida,
      linhas: [],
    });
  });

  it.each([
    ['an array', []],
    ['an array that HAS an own key named like the conta', [[CAMISETAS]]],
    ['a string', 'x'],
    ['a number', 42],
  ])('S10 a map that is %s reads as campo-invalido', (_label, campo) => {
    // `'0'` is an OWN key of a one-element array — the array check must come first.
    for (const conta of [CONTA, '0']) {
      expect(lerEntradasShopeeDaConta(campo, conta)).toEqual({
        estado: ESTADO_LISTA_SHOPEE.campoInvalido,
        linhas: [],
      });
    }
  });

  it('never throws on any value', () => {
    const valores: unknown[] = [
      null,
      undefined,
      0,
      '',
      [],
      {},
      { [CONTA]: [null, undefined, [], {}, () => 1, Symbol('s'), 10n] },
      { [CONTA]: { length: 3 } },
    ];
    for (const campo of valores) {
      expect(() => lerEntradasShopeeDaConta(campo, CONTA)).not.toThrow();
    }
  });
});

describe('indiceDaEntradaShopee — THE selection rule (fold scope: categoryId only)', () => {
  const ler = (lista: unknown[]) => lerEntradasShopeeDaConta({ [CONTA]: lista }, CONTA).linhas;

  it('S11 EQUAL: the same categoryId matches', () => {
    expect(indiceDaEntradaShopee(ler([CALCAS, CAMISETAS]), 400055)).toBe(1);
  });

  it('S11 two entries for one category: the FIRST wins (M6)', () => {
    const copia = { ...CAMISETAS, size_chart_id: 700024642, name: '(Cópia) Camisetas' };
    expect(indiceDaEntradaShopee(ler([CALCAS, CAMISETAS, copia]), 400055)).toBe(1);
    expect(indiceDaEntradaShopee(ler([CALCAS, copia, CAMISETAS]), 400055)).toBe(1);
  });

  it('S12 DISTINCT: categoryId ± 1 never matches', () => {
    const linhas = ler([CAMISETAS]);
    expect(indiceDaEntradaShopee(linhas, 400054)).toBe(-1);
    expect(indiceDaEntradaShopee(linhas, 400056)).toBe(-1);
  });

  it('S12 DISTINCT: size_chart_id is not the key (M7)', () => {
    // An entry whose size_chart_id IS the looked-up number, in another category.
    const linhas = ler([{ categoryId: 1, size_chart_id: 400055, name: 'Outra' }]);
    expect(indiceDaEntradaShopee(linhas, 400055)).toBe(-1);
  });

  it('S12 DISTINCT: name is not the key (M7)', () => {
    // The name spells the looked-up category, the categoryId differs.
    const linhas = ler([{ categoryId: 1, size_chart_id: 2, name: '400055' }]);
    expect(indiceDaEntradaShopee(linhas, 400055)).toBe(-1);
  });

  it('S12 DISTINCT: a digit-string stored categoryId never matches its number (no fold, M4)', () => {
    expect(indiceDaEntradaShopee(ler([{ ...CAMISETAS, categoryId: '400055' }]), 400055)).toBe(-1);
  });

  it.each([Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY])(
    'S12 an impossible categoryId %s matches nothing',
    (categoryId) => {
      expect(indiceDaEntradaShopee(ler([CAMISETAS, CALCAS]), categoryId)).toBe(-1);
    },
  );

  it('S12 an empty list, or only unreadable linhas, matches nothing', () => {
    expect(indiceDaEntradaShopee([], 400055)).toBe(-1);
    expect(indiceDaEntradaShopee(ler([{ ...CAMISETAS, size_chart_id: 0 }, null]), 400055)).toBe(-1);
  });

  it('an unreadable entry of the category never shadows a readable one after it', () => {
    // Raw 0 carries the category with the DETACH sentinel — never selectable.
    expect(
      indiceDaEntradaShopee(ler([{ ...CAMISETAS, size_chart_id: 0 }, CALCAS, CAMISETAS]), 400055),
    ).toBe(2);
  });

  it('M9 on a subsequence the index returned is the linha’s OWN, never a re-numbered one', () => {
    const linhas = ler([CALCAS, null, CAMISETAS, CALCAS, 'x', { ...CAMISETAS, name: 'Outra' }]);
    // The panel passes only the non-marked linhas: say raw 2 was staged for removal.
    const subsequencia = [linhas[0]!, linhas[5]!];
    expect(indiceDaEntradaShopee(subsequencia, 400055)).toBe(5);
    expect(indiceDaEntradaShopee([linhas[2]!, linhas[5]!], 400055)).toBe(2);
  });
});

describe('resolverEntradaShopee — the ONE composition publish and /medidas call', () => {
  const leituraDe = (campo: unknown, conta = CONTA) => lerEntradasShopeeDaConta(campo, conta);
  const semTabela = (motivo: string) => ({ motivo, indice: -1, entrada: null });

  it('S14 categoryId null → anuncio-sem-categoria, even when the conta has entries (M8)', () => {
    expect(resolverEntradaShopee(leituraDe({ [CONTA]: [CAMISETAS] }), null)).toEqual(
      semTabela(MOTIVO_SEM_TABELA_SHOPEE.anuncioSemCategoria),
    );
    expect(resolverEntradaShopee(leituraDe(null), null)).toEqual(
      semTabela(MOTIVO_SEM_TABELA_SHOPEE.anuncioSemCategoria),
    );
  });

  it.each([
    ['no map', null],
    ['no key for this conta', {}],
    ['a per-conta null', { [CONTA]: null }],
    ['an empty list', { [CONTA]: [] }],
    ['only unreadable linhas', { [CONTA]: [null, { ...CAMISETAS, size_chart_id: 0 }] }],
    ['a map that is not an object', 'x'],
    ['a per-conta value that is not a list', { [CONTA]: {} }],
  ])('S15 %s → conta-sem-entradas', (_label, campo) => {
    expect(resolverEntradaShopee(leituraDe(campo), 400055)).toEqual(
      semTabela(MOTIVO_SEM_TABELA_SHOPEE.contaSemEntradas),
    );
  });

  it('S16 another conta HAS an entry for this category → still nothing for this one (M24)', () => {
    const campo = { 'int-2': [CAMISETAS], 'int-10': [CAMISETAS], [CONTA]: null };
    expect(resolverEntradaShopee(leituraDe(campo), 400055)).toEqual(
      semTabela(MOTIVO_SEM_TABELA_SHOPEE.contaSemEntradas),
    );
    const comOutra = { 'int-2': [CAMISETAS], [CONTA]: [CALCAS] };
    expect(resolverEntradaShopee(leituraDe(comOutra), 400055)).toEqual(
      semTabela(MOTIVO_SEM_TABELA_SHOPEE.categoriaSemEntrada),
    );
  });

  it('S17 readable entries, none of this category → categoria-sem-entrada', () => {
    expect(resolverEntradaShopee(leituraDe({ [CONTA]: [CALCAS] }), 400056)).toEqual(
      semTabela(MOTIVO_SEM_TABELA_SHOPEE.categoriaSemEntrada),
    );
  });

  it('S18 a match → the FIRST readable entry of the category and its RAW index', () => {
    const copia = { ...CAMISETAS, size_chart_id: 700024642 };
    const campo = { [CONTA]: [null, CALCAS, CAMISETAS, copia] };
    expect(resolverEntradaShopee(leituraDe(campo), 400055)).toEqual({
      motivo: null,
      indice: 2,
      entrada: CAMISETAS,
    });
  });

  it('one rule: the resolver’s indice IS the selector’s, over a grid of categories', () => {
    const leitura = leituraDe({
      [CONTA]: [
        CALCAS,
        { ...CAMISETAS, size_chart_id: 0 },
        CAMISETAS,
        'x',
        { ...CALCAS, name: 'B' },
      ],
    });
    for (const categoryId of [1, 100086, 100087, 100088, 400054, 400055, 400056]) {
      const resolucao = resolverEntradaShopee(leitura, categoryId);
      const indice = indiceDaEntradaShopee(leitura.linhas, categoryId);
      expect(resolucao.indice).toBe(indice);
      expect(resolucao.entrada).toEqual(
        indice === -1 ? null : leitura.linhas.find((l) => l.indice === indice)?.entrada,
      );
    }
  });
});

describe('RT1 — corpus entry → read → write-parse → stored → read again', () => {
  it('round-trips deep-equal, with both ids still JSON numbers', () => {
    const primeira = lerEntradasShopeeDaConta({ [CONTA]: [CAMISETAS] }, CONTA);
    const entrada = primeira.linhas[0]?.entrada;
    const gravada = entradaTabelaShopeeSchema.parse(entrada);
    // What Firestore stores and hands back: a JSON-shaped copy under the conta.
    const armazenado = JSON.parse(JSON.stringify({ [CONTA]: [gravada] })) as unknown;
    const segunda = lerEntradasShopeeDaConta(armazenado, CONTA);
    expect(segunda).toEqual(primeira);
    expect(segunda.linhas[0]?.entrada).toEqual(CAMISETAS);
    expect(typeof segunda.linhas[0]?.entrada?.categoryId).toBe('number');
    expect(typeof segunda.linhas[0]?.entrada?.size_chart_id).toBe('number');
  });
});
