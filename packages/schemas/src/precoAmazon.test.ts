import { describe, expect, it } from 'vitest';
import {
  CODIGO_ERRO_AMAZON,
  CODIGO_ERRO_ETIQUETA_AMAZON,
  CODIGO_ERRO_NFE_AMAZON,
} from './contaAmazon';
import {
  CODIGO_ERRO_ESTOQUE_AMAZON,
  LIMIAR_FEED_ESTOQUE_AMAZON,
  MAX_ITENS_DIVERGENCIA_ESTOQUE_AMAZON,
  MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON,
  UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON,
  envioEstoqueManualAmazonSchema,
  erroEnvioEstoqueManualAmazonSchema,
  reconciliacaoEstoqueAmazonSchema,
} from './estoqueAmazon';
import { desfechoFeedAmazonSchema, estadoVezFeedAmazonSchema } from './feedAmazon';
import * as barrel from './index';
import * as modulo from './precoAmazon';
import {
  AMOSTRA_REDUCAO_PRECO_AMAZON_REGEX,
  CHAVE_LOTE_PRECO_AMAZON_REGEX,
  CODIGO_ERRO_PRECO_AMAZON,
  DECISAO_EXECUCAO_PRECO_AMAZON,
  DESFECHO_LOTE_PRECO_AMAZON,
  ESTADO_LOTE_RESUMO_PRECO_AMAZON,
  FASE_EXECUCAO_PRECO_AMAZON,
  FRACAO_REDUCAO_EM_MASSA_PRECO_AMAZON,
  LIMIAR_FEED_PRECO_AMAZON,
  LIMIAR_REDUCAO_EM_MASSA_PRECO_AMAZON,
  MAX_AMOSTRA_PRECO_AMAZON,
  MAX_ITENS_DIVERGENCIA_PRECO_AMAZON,
  MAX_LOTES_EXECUCAO_PRECO_AMAZON,
  MAX_PARTES_EXECUCAO_PRECO_AMAZON,
  MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON,
  MOTIVO_FIM_EXECUCAO_PRECO_AMAZON,
  MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON,
  QUEDA_MAXIMA_PRECO_AMAZON,
  RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS,
  TIPO_FAIXA_PRECO_AMAZON,
  TIPO_OFERTA_PRECO_AMAZON,
  TIPO_PRODUTO_PRECO_AMAZON_REGEX,
  contagensExecucaoPrecoAmazonSchema,
  decisaoExecucaoPrecoAmazonSchema,
  desfechoLotePrecoAmazonSchema,
  divergenciaPrecoAmazonSchema,
  envioPrecoManualAmazonSchema,
  erroPrecoAmazonSchema,
  estadoLoteResumoPrecoAmazonSchema,
  execucaoPrecoAmazonSchema,
  faixaDePrecoAmazon,
  faixaPrecoAmazonSchema,
  faseExecucaoPrecoAmazonSchema,
  fontesPrecoDaUnidadeAmazon,
  idDivergenciaPrecoAmazon,
  lotePrecoAmazonSchema,
  lotesExecucaoPrecoAmazonSchema,
  motivoFimExecucaoPrecoAmazonSchema,
  motivoSemEnvioLotePrecoAmazonSchema,
  ofertaPrecoAmazonSchema,
  respostaCancelamentoExecucaoPrecoAmazonSchema,
  respostaInicioExecucaoPrecoAmazonSchema,
  resumoExecucaoPrecoAmazonSchema,
  tabelasDePrecoDaContaAmazon,
  tipoFaixaPrecoAmazonSchema,
  tipoOfertaPrecoAmazonSchema,
  type FontesPrecoAmazon,
  type TabelasDePrecoAmazon,
} from './precoAmazon';
import { ALL_DOMAINS } from './registry';
import { idFromRefOrNull } from './shared/outerRef';
import { TTL_FIELD, TTL_POLICIES, expiraEmApos, ttlExpiry } from './shared/ttl';

const AGORA = 1_800_000_000_000;

/** Shaped like `firebase-admin`'s and `firebase/firestore`'s `Timestamp` alike. */
function timestampFalso(ms: number) {
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  The faixa                                 */
/* -------------------------------------------------------------------------- */

const NORMAL = 'normal';
const PROMO = 'promo';
const TABELAS: TabelasDePrecoAmazon = { normalId: NORMAL, promocionalId: PROMO };

/** A `precos` map as a produto stores it: `{ <tabela>: { valor } }`. */
function precos(entradas: Readonly<Record<string, number>>): Record<string, { valor: number }> {
  return Object.fromEntries(Object.entries(entradas).map(([k, valor]) => [k, { valor }]));
}

/** A unit priced by its own map (no `paiId`: a plain produto or a kit root). */
const propria = (mapa: unknown): FontesPrecoAmazon => ({ precosDaUnidade: mapa, pai: null });

/** The faixa's triple, or the reason there is none. */
function triplo(fontes: FontesPrecoAmazon, tabelas: TabelasDePrecoAmazon = TABELAS) {
  const r = faixaDePrecoAmazon(fontes, tabelas);
  return r.tipo === TIPO_FAIXA_PRECO_AMAZON.faixa
    ? [r.faixa.base, r.faixa.minimo, r.faixa.maximo]
    : r.tipo;
}

describe('★ faixaDePrecoAmazon — the faixa table', () => {
  it('normal 100, promo 80 ⇒ { base 100, minimo 80, maximo 100 }', () => {
    expect(triplo(propria(precos({ normal: 100, promo: 80 })))).toEqual([100, 80, 100]);
  });

  it('NEAR-MISS: the floor is the PROMOTIONAL price, never the normal one while a promo exists', () => {
    const r = faixaDePrecoAmazon(propria(precos({ normal: 100, promo: 80 })), TABELAS);
    expect(r).toEqual({
      tipo: TIPO_FAIXA_PRECO_AMAZON.faixa,
      faixa: { base: 100, minimo: 80, maximo: 100 },
    });
    expect(triplo(propria(precos({ normal: 100, promo: 80 })))).not.toEqual([100, 100, 100]);
  });

  it('no promo tabela, no promo entry, or a promo equal to the normal ⇒ { 100, 100, 100 }', () => {
    expect(
      triplo(propria(precos({ normal: 100, promo: 80 })), {
        normalId: NORMAL,
        promocionalId: null,
      }),
    ).toEqual([100, 100, 100]);
    expect(triplo(propria(precos({ normal: 100 })))).toEqual([100, 100, 100]);
    expect(triplo(propria(precos({ normal: 100, promo: 100 })))).toEqual([100, 100, 100]);
  });

  it('★ a promo that is no price falls back to the normal one: 0, 0.004 (rounds to 0), a negative', () => {
    for (const promo of [0, 0.004, -5]) {
      expect(triplo(propria(precos({ normal: 100, promo }))), String(promo)).toEqual([
        100, 100, 100,
      ]);
    }
    // NEAR-MISS: 0.005 rounds to a centavo, which IS a price.
    expect(triplo(propria(precos({ normal: 100, promo: 0.005 })))).toEqual([100, 0.01, 100]);
  });

  it('★ a promo above the normal price ⇒ faixa-invertida, refused (NEAR-MISS: 100.004 rounds to 100 ⇒ valid)', () => {
    expect(faixaDePrecoAmazon(propria(precos({ normal: 100, promo: 100.01 })), TABELAS)).toEqual({
      tipo: TIPO_FAIXA_PRECO_AMAZON.faixaInvertida,
      base: 100,
      minimo: 100.01,
    });
    expect(triplo(propria(precos({ normal: 100, promo: 100.004 })))).toEqual([100, 100, 100]);
    expect(triplo(propria(precos({ normal: 99.99, promo: 100 })))).toBe('faixa-invertida');
  });

  it('the values are rounded once, by the shared reader: a 3rd decimal never reaches the faixa', () => {
    expect(triplo(propria(precos({ normal: 129.904, promo: 119.905 })))).toEqual([
      129.9, 119.91, 129.9,
    ]);
    expect(triplo(propria(precos({ normal: 0.1 + 0.2 })))).toEqual([0.3, 0.3, 0.3]);
  });

  it('no normal price ⇒ sem-preco; no normal tabela ⇒ sem-tabela-normal (whatever the promo)', () => {
    expect(triplo(propria(precos({ promo: 80 })))).toBe('sem-preco');
    expect(triplo(propria(precos({ normal: 0.004, promo: 80 })))).toBe('sem-preco');
    expect(
      triplo(propria(precos({ normal: 100, promo: 80 })), { normalId: null, promocionalId: PROMO }),
    ).toBe('sem-tabela-normal');
    expect(triplo(propria(null))).toBe('sem-preco');
    expect(triplo(propria(undefined))).toBe('sem-preco');
  });

  it('a bare-number entry or an inherited key is no price (the shared reader’s rule)', () => {
    expect(triplo(propria({ normal: 100 }))).toBe('sem-preco');
    expect(triplo(propria({ normal: { valor: 100 }, promo: 80 }))).toEqual([100, 100, 100]);
    expect(triplo(propria({ normal: { valor: '100' } }))).toBe('sem-preco');
    const herdado = Object.create(precos({ normal: 100 })) as unknown;
    expect(triplo(propria(herdado))).toBe('sem-preco');
    expect(
      triplo(propria(precos({ normal: 100 })), { normalId: 'toString', promocionalId: null }),
    ).toBe('sem-preco');
  });

  it('★ a unit with a paiId under propagation reads the PARENT’s map and ignores its own different one', () => {
    const fontes: FontesPrecoAmazon = {
      precosDaUnidade: precos({ normal: 50, promo: 40 }),
      pai: { precos: precos({ normal: 100, promo: 80 }), propagatePriceToChildren: true },
    };
    expect(triplo(fontes)).toEqual([100, 80, 100]);
    // Absent flag: the schema default propagates.
    expect(
      triplo({
        ...fontes,
        pai: { precos: precos({ normal: 100 }), propagatePriceToChildren: undefined },
      }),
    ).toEqual([100, 100, 100]);
    // Never the child's map as a fallback: the parent has no price ⇒ no price.
    expect(triplo({ ...fontes, pai: { precos: precos({}), propagatePriceToChildren: true } })).toBe(
      'sem-preco',
    );
  });

  it('propagatePriceToChildren false on the parent ⇒ the unit’s own map; the STRING "false" ⇒ propagates', () => {
    const proprio = precos({ normal: 50, promo: 40 });
    const doPai = precos({ normal: 100, promo: 80 });
    expect(
      triplo({ precosDaUnidade: proprio, pai: { precos: doPai, propagatePriceToChildren: false } }),
    ).toEqual([50, 40, 50]);
    expect(
      triplo({
        precosDaUnidade: proprio,
        pai: { precos: doPai, propagatePriceToChildren: 'false' },
      }),
    ).toEqual([100, 80, 100]);
    expect(
      triplo({ precosDaUnidade: proprio, pai: { precos: doPai, propagatePriceToChildren: 0 } }),
    ).toEqual([100, 80, 100]);
  });

  it('the parent document gone, under propagation ⇒ sem-preco (never the unit’s own map)', () => {
    expect(
      triplo({
        precosDaUnidade: precos({ normal: 50 }),
        pai: { precos: undefined, propagatePriceToChildren: undefined },
      }),
    ).toBe('sem-preco');
  });

  it('a member of a family of one (its paiId the wrapper) ⇒ the wrapper’s map; a kit root ⇒ its own map', () => {
    const wrapper = precos({ normal: 70, promo: 60 });
    expect(
      triplo({
        precosDaUnidade: precos({ normal: 1 }),
        pai: { precos: wrapper, propagatePriceToChildren: true },
      }),
    ).toEqual([70, 60, 70]);
    expect(triplo(propria(precos({ normal: 300, promo: 250 })))).toEqual([300, 250, 300]);
  });

  it('★ fontesPrecoDaUnidadeAmazon: a parent the readers could not read (raw null) is a parent with NO prices ⇒ sem-preco, never the unit’s own map (NEAR-MISS: no parent at all ⇒ the unit’s own map)', () => {
    const unidade = { precos: precos({ normal: 50, promo: 40 }), paiId: 'pai-1' };
    expect(fontesPrecoDaUnidadeAmazon(unidade, { raw: null })).toEqual({
      precosDaUnidade: unidade.precos,
      pai: { precos: undefined, propagatePriceToChildren: undefined },
    });
    expect(triplo(fontesPrecoDaUnidadeAmazon(unidade, { raw: null }))).toBe('sem-preco');
    expect(triplo(fontesPrecoDaUnidadeAmazon(unidade, null))).toEqual([50, 40, 50]);
  });

  it('fontesPrecoDaUnidadeAmazon reads the parent’s map under its propagation, and only own fields of both documents', () => {
    const unidade = { precos: precos({ normal: 1 }) };
    const pai = { precos: precos({ normal: 90, promo: 80 }) };
    expect(triplo(fontesPrecoDaUnidadeAmazon(unidade, { raw: pai }))).toEqual([90, 80, 90]);
    expect(
      triplo(
        fontesPrecoDaUnidadeAmazon(unidade, {
          raw: { ...pai, propagatePriceToChildren: false },
        }),
      ),
    ).toEqual([1, 1, 1]);
    const herdado = Object.create({ precos: precos({ normal: 70 }) }) as object;
    expect(fontesPrecoDaUnidadeAmazon(herdado, null)).toEqual({
      precosDaUnidade: undefined,
      pai: null,
    });
    expect(fontesPrecoDaUnidadeAmazon(null, { raw: [pai] })).toEqual({
      precosDaUnidade: undefined,
      pai: { precos: undefined, propagatePriceToChildren: undefined },
    });
  });

  it('every faixa it answers is a valid stored faixa (the schema accepts it)', () => {
    for (const [normal, promo] of [
      [100, 80],
      [100, 100],
      [0.01, 0.01],
      [129.904, 0.005],
      [99999.99, 1],
    ] as const) {
      const r = faixaDePrecoAmazon(propria(precos({ normal, promo })), TABELAS);
      expect(r.tipo).toBe(TIPO_FAIXA_PRECO_AMAZON.faixa);
      if (r.tipo === TIPO_FAIXA_PRECO_AMAZON.faixa) {
        expect(faixaPrecoAmazonSchema.safeParse(r.faixa).success, `${normal}/${promo}`).toBe(true);
      }
    }
  });

  it('the answers, each with its companion', () => {
    expect(tipoFaixaPrecoAmazonSchema.options).toEqual([
      'faixa',
      'sem-tabela-normal',
      'sem-preco',
      'faixa-invertida',
    ]);
    expect(Object.values(TIPO_FAIXA_PRECO_AMAZON).sort()).toEqual(
      [...tipoFaixaPrecoAmazonSchema.options].sort(),
    );
  });
});

describe('★ tabelasDePrecoDaContaAmazon — the ONE parse of the conta’s tabela refs', () => {
  const ler = (ref: unknown) => tabelasDePrecoDaContaAmazon({ tabelaNormalOuterRef: ref }).normalId;

  it('both stored forms of a listaDePrecos ref name the tabela', () => {
    expect(ler('documents/listaDePrecos/abc')).toBe('abc');
    expect(ler('listaDePrecos/abc')).toBe('abc');
    expect(
      tabelasDePrecoDaContaAmazon({
        tabelaNormalOuterRef: 'documents/listaDePrecos/n1',
        tabelaPromocionalOuterRef: 'listaDePrecos/p1',
      }),
    ).toEqual({ normalId: 'n1', promocionalId: 'p1' });
  });

  it('★ NEAR-MISS against the last-segment parse: another collection names NO tabela', () => {
    // The loose reader would take the last segment of any path.
    expect(idFromRefOrNull('documents/depositos/abc')).toBe('abc');
    expect(ler('documents/depositos/abc')).toBeNull();
    expect(ler('depositos/abc')).toBeNull();
    expect(ler('documents/integracao/abc')).toBeNull();
  });

  it.each([
    ['a sub-path', 'listaDePrecos/a/b'],
    ['a deeper canonical path', 'documents/listaDePrecos/a/b'],
    ['an empty id', 'listaDePrecos/'],
    ['a relative name', 'documents/listaDePrecos/..'],
    ['a leading slash', '/documents/listaDePrecos/abc'],
    ['a leading space', ' listaDePrecos/abc'],
    ['another case', 'ListaDePrecos/abc'],
    ['a bare id', 'abc'],
    ['a number', 7],
    ['null', null],
    ['an object', { id: 'abc' }],
  ])('%s names no tabela', (_nome, ref) => {
    expect(ler(ref)).toBeNull();
  });

  it('a conta that is not an object, or names neither ref, names no tabela at all', () => {
    for (const conta of [null, undefined, 'conta', 3, [], {}]) {
      expect(tabelasDePrecoDaContaAmazon(conta), String(conta)).toEqual({
        normalId: null,
        promocionalId: null,
      });
    }
  });

  it('an inherited ref is never read (only the conta’s own fields)', () => {
    const conta = Object.create({ tabelaNormalOuterRef: 'listaDePrecos/abc' }) as unknown;
    expect(tabelasDePrecoDaContaAmazon(conta).normalId).toBeNull();
  });

  it('each ref is parsed on its own: a bad promo ref never hides a good normal one', () => {
    expect(
      tabelasDePrecoDaContaAmazon({
        tabelaNormalOuterRef: 'listaDePrecos/n1',
        tabelaPromocionalOuterRef: 'documents/depositos/x',
      }),
    ).toEqual({ normalId: 'n1', promocionalId: null });
  });
});

describe('★ faixaPrecoAmazonSchema — a faixa as it is stored', () => {
  it('accepts three prices with at most two decimals, floor ≤ price ≤ ceiling', () => {
    for (const faixa of [
      { base: 129.9, minimo: 119.9, maximo: 129.9 },
      { base: 10, minimo: 10, maximo: 10 },
      { base: 0.01, minimo: 0.01, maximo: 0.01 },
      { base: 10.1, minimo: 10.09, maximo: 10.1 },
    ]) {
      expect(faixaPrecoAmazonSchema.safeParse(faixa).success, JSON.stringify(faixa)).toBe(true);
    }
  });

  it.each([
    ['a floor above the price by one centavo', { base: 10, minimo: 10.01, maximo: 10 }],
    ['a ceiling below the price by one centavo', { base: 10, minimo: 10, maximo: 9.99 }],
    ['a price with three decimals', { base: 10.005, minimo: 10, maximo: 10.005 }],
    ['a zero price', { base: 0, minimo: 0, maximo: 0 }],
    ['a negative floor', { base: 10, minimo: -1, maximo: 10 }],
    ['NaN', { base: Number.NaN, minimo: 1, maximo: 10 }],
    ['an infinite ceiling', { base: 10, minimo: 1, maximo: Number.POSITIVE_INFINITY }],
    ['a price as a string', { base: '10', minimo: 1, maximo: 10 }],
    ['a missing ceiling', { base: 10, minimo: 1 }],
  ])('refuses %s', (_nome, faixa) => {
    expect(faixaPrecoAmazonSchema.safeParse(faixa).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The offer as read, and the parts                    */
/* -------------------------------------------------------------------------- */

describe('ofertaPrecoAmazonSchema — Amazon’s offer as a page read it', () => {
  it('a read offer carries its price; an absent floor or ceiling is null', () => {
    expect(ofertaPrecoAmazonSchema.parse({ tipo: 'lida', base: 129.9, minimo: null })).toEqual({
      tipo: 'lida',
      base: 129.9,
      minimo: null,
      maximo: null,
    });
  });

  it('NEAR-MISS: a READ price may hold more decimals than a sent one (Amazon’s value, as read)', () => {
    expect(ofertaPrecoAmazonSchema.safeParse({ tipo: 'lida', base: 129.999 }).success).toBe(true);
    expect(
      faixaPrecoAmazonSchema.safeParse({ base: 129.999, minimo: 129.999, maximo: 129.999 }).success,
    ).toBe(false);
  });

  it('an absent, ambiguous or unreadable offer carries no price at all', () => {
    for (const tipo of ['ausente', 'ambigua', 'ilegivel'] as const) {
      expect(ofertaPrecoAmazonSchema.parse({ tipo })).toEqual({
        tipo,
        base: null,
        minimo: null,
        maximo: null,
      });
      expect(ofertaPrecoAmazonSchema.safeParse({ tipo, base: 10 }).success, tipo).toBe(false);
      expect(ofertaPrecoAmazonSchema.safeParse({ tipo, minimo: 10 }).success, tipo).toBe(false);
      expect(ofertaPrecoAmazonSchema.safeParse({ tipo, maximo: 10 }).success, tipo).toBe(false);
    }
  });

  it.each([
    ['a read offer without its price', { tipo: 'lida' }],
    ['a zero price', { tipo: 'lida', base: 0 }],
    ['a negative floor', { tipo: 'lida', base: 10, minimo: -1 }],
    ['a tipo outside the closed set', { tipo: 'LIDA', base: 10 }],
  ])('refuses %s', (_nome, oferta) => {
    expect(ofertaPrecoAmazonSchema.safeParse(oferta).success).toBe(false);
  });

  it('the four tipos, with their companion', () => {
    expect(tipoOfertaPrecoAmazonSchema.options).toEqual(['lida', 'ausente', 'ambigua', 'ilegivel']);
    expect(Object.values(TIPO_OFERTA_PRECO_AMAZON).sort()).toEqual(
      [...tipoOfertaPrecoAmazonSchema.options].sort(),
    );
  });
});

/** The fields a price run is claimed with (the rest default). */
const RUN = {
  execucaoId: 'f'.repeat(64),
  fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
  baixarPreco: false,
  solicitadaPor: 'uid-operador-1',
  iniciadaEmMs: AGORA,
};

const LOTE = {
  execucaoIdLote: 'lote-0',
  parteInicial: 0,
  partes: 31,
  itens: 31,
};

/** `n` dense batches of one part each. */
const lotes = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, k) => [
      String(k),
      { ...LOTE, execucaoIdLote: `lote-${String(k)}`, parteInicial: k, partes: 1, itens: 1 },
    ]),
  );

const ITEM = {
  sku: 'SKU-1',
  vinculo: 'produtos/p1/prodAmazon/l1',
  unidadeId: 'p1',
  oferta: { tipo: 'lida', base: 50, minimo: 45, maximo: 50 },
  faixa: { base: 45, minimo: 40, maximo: 45 },
  tipoProduto: 'LUGGAGE',
  lidoEmMs: AGORA,
};
const PARTE = { execucaoId: 'run-1', itens: [ITEM], expiraEm: expiraEmApos(AGORA, 7) };

describe('divergenciaPrecoAmazonSchema — a part', () => {
  it('a part round-trips, its TTL stamp the SAME Date', () => {
    const lido = divergenciaPrecoAmazonSchema.parse(PARTE);
    expect(lido).toEqual(PARTE);
    expect(lido.expiraEm).toBe(PARTE.expiraEm);
  });

  it('a part names its run in the run-id grammar (NEAR-MISS: `a b`, `a/b` or an empty id is refused)', () => {
    for (const execucaoId of ['a b', 'a/b', '']) {
      const r = divergenciaPrecoAmazonSchema.safeParse({ ...PARTE, execucaoId });
      expect(r.success, execucaoId).toBe(false);
    }
  });

  it('holds 1 to 300 SKUs: an empty part is refused (a page with nothing sendable writes none)', () => {
    expect(MAX_ITENS_DIVERGENCIA_PRECO_AMAZON).toBe(300);
    const itens = Array.from({ length: 300 }, (_, i) => ({ ...ITEM, sku: `SKU-${String(i)}` }));
    expect(divergenciaPrecoAmazonSchema.safeParse({ ...PARTE, itens }).success).toBe(true);
    expect(
      divergenciaPrecoAmazonSchema.safeParse({ ...PARTE, itens: [...itens, ITEM] }).success,
    ).toBe(false);
    expect(divergenciaPrecoAmazonSchema.safeParse({ ...PARTE, itens: [] }).success).toBe(false);
  });

  it('★ the productType grammar: `luggage` is refused, `LUGGAGE` and `PRODUCT` are kept', () => {
    for (const tipoProduto of ['LUGGAGE', 'PRODUCT', 'A', `A${'B'.repeat(63)}`, 'X_9']) {
      const parte = { ...PARTE, itens: [{ ...ITEM, tipoProduto }] };
      expect(divergenciaPrecoAmazonSchema.safeParse(parte).success, tipoProduto).toBe(true);
    }
    for (const tipoProduto of ['luggage', 'Luggage', '9A', '', `A${'B'.repeat(64)}`, 'A-B']) {
      const parte = { ...PARTE, itens: [{ ...ITEM, tipoProduto }] };
      expect(divergenciaPrecoAmazonSchema.safeParse(parte).success, tipoProduto).toBe(false);
    }
    expect(TIPO_PRODUTO_PRECO_AMAZON_REGEX.source).toBe('^[A-Z][A-Z0-9_]{0,63}$');
  });

  it('keeps a SKU no patch can carry: a feed sends it, so the part must hold it', () => {
    for (const sku of ['a/b', '..', 'com espaço', 'açúcar']) {
      const parte = { ...PARTE, itens: [{ ...ITEM, sku }] };
      expect(divergenciaPrecoAmazonSchema.safeParse(parte).success, sku).toBe(true);
    }
  });

  it.each([
    ['an empty SKU', { sku: '' }],
    ['a link path with the documents/ prefix', { vinculo: 'documents/produtos/p1/prodAmazon/l1' }],
    ['a link path under another channel', { vinculo: 'produtos/p1/prodShopee/l1' }],
    ['a unit id that is a path', { unidadeId: 'produtos/p1' }],
    ['an inverted faixa', { faixa: { base: 45, minimo: 45.01, maximo: 45 } }],
    ['an unread offer carrying a price', { oferta: { tipo: 'ilegivel', base: 50 } }],
    ['a fractional read instant', { lidoEmMs: AGORA + 0.5 }],
    ['a read instant as a digit string', { lidoEmMs: String(AGORA) }],
  ])('refuses a member with %s', (_nome, troca) => {
    const parte = { ...PARTE, itens: [{ ...ITEM, ...troca }] };
    expect(divergenciaPrecoAmazonSchema.safeParse(parte).success).toBe(false);
  });

  it('★ expiraEm is REQUIRED: a part without its stamp, or with null, fails its parse', () => {
    const { expiraEm: _expiraEm, ...semCarimbo } = PARTE;
    expect(divergenciaPrecoAmazonSchema.safeParse(semCarimbo).success).toBe(false);
    expect(divergenciaPrecoAmazonSchema.safeParse({ ...PARTE, expiraEm: null }).success).toBe(
      false,
    );
  });

  it('★ NEAR-MISS: the SAME instant as a numeric epoch is REFUSED (a TTL ignores a number); a read Timestamp is kept', () => {
    const ms = PARTE.expiraEm.getTime();
    expect(divergenciaPrecoAmazonSchema.safeParse({ ...PARTE, expiraEm: ms }).success).toBe(false);
    expect(divergenciaPrecoAmazonSchema.safeParse({ ...PARTE, expiraEm: String(ms) }).success).toBe(
      false,
    );
    const ts = timestampFalso(ms);
    expect(divergenciaPrecoAmazonSchema.parse({ ...PARTE, expiraEm: ts }).expiraEm).toBe(ts);
    expect(ttlExpiry().safeParse(ms).success).toBe(false);
  });

  it('the field is the TTL field, and its policy is declared: one TTL_POLICIES row naming the group and its 7 days', () => {
    expect(TTL_FIELD in divergenciaPrecoAmazonSchema.shape).toBe(true);
    expect(RETENCAO_DIVERGENCIA_PRECO_AMAZON_DIAS).toBe(7);
    const linhas = TTL_POLICIES.filter((p) => p.collectionGroup === 'divergenciasPrecoAmazon');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.motivo).toMatch(/\b7 days\b/);
    // The run document is never stamped, so it has no row.
    expect(TTL_POLICIES.map((p) => p.collectionGroup)).not.toContain('precosAmazon');
  });

  it('the run document is never TTL-stamped: a stray stamp is stripped', () => {
    expect(TTL_FIELD in execucaoPrecoAmazonSchema.shape).toBe(false);
    const lido = execucaoPrecoAmazonSchema.parse({ ...RUN, expiraEm: new Date(AGORA) });
    expect(TTL_FIELD in lido).toBe(false);
  });
});

describe('★ idDivergenciaPrecoAmazon — a part’s id, and the part bound', () => {
  it('<execucaoId>-<n>, split at its LAST `-`', () => {
    const id = idDivergenciaPrecoAmazon('run-a-1', 12);
    expect(id).toBe('run-a-1-12');
    const corte = id.lastIndexOf('-');
    expect([id.slice(0, corte), id.slice(corte + 1)]).toEqual(['run-a-1', '12']);
    expect(idDivergenciaPrecoAmazon('r', 1)).not.toBe(idDivergenciaPrecoAmazon('r', 10));
  });

  it('★ the last part a run may write is index 999; index 1,000 has no id (NEAR-MISS pair)', () => {
    expect(MAX_PARTES_EXECUCAO_PRECO_AMAZON).toBe(1_000);
    expect(idDivergenciaPrecoAmazon('r', MAX_PARTES_EXECUCAO_PRECO_AMAZON - 1)).toBe('r-999');
    expect(() => idDivergenciaPrecoAmazon('r', MAX_PARTES_EXECUCAO_PRECO_AMAZON)).toThrow(
      RangeError,
    );
  });

  it('refuses a run id outside its grammar, or a part that is not a safe integer, naming the rule only', () => {
    expect(() => idDivergenciaPrecoAmazon('a/b', 0)).toThrow(/ID_LOTE_FEED_AMAZON_REGEX/);
    expect(() => idDivergenciaPrecoAmazon('a/b', 0)).not.toThrow(/a\/b/);
    for (const parte of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => idDivergenciaPrecoAmazon('r', parte), String(parte)).toThrow(RangeError);
    }
    expect(() => idDivergenciaPrecoAmazon('r', 2 ** 53)).not.toThrow(/9007199254740992/);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   The run                                  */
/* -------------------------------------------------------------------------- */

describe('execucaoPrecoAmazonSchema — the run', () => {
  it('a claimed run parses to the defaults: nothing walked, no part, no decision, no clock', () => {
    expect(execucaoPrecoAmazonSchema.parse(RUN)).toEqual({
      ...RUN,
      motivo: null,
      confirmarReducaoEmMassa: false,
      cursores: {
        canonica: { ultimoCaminho: null, concluida: false },
        nua: { ultimoCaminho: null, concluida: false },
      },
      proximaPagina: 0,
      proximaParte: 0,
      itensPorParte: [],
      contagens: {
        lidos: 0,
        iguais: 0,
        enviaveis: 0,
        sobe: 0,
        desce: 0,
        quedaExcessiva: 0,
        direcaoDesconhecida: 0,
        reducaoSemConsentimento: 0,
        precoAtualIlegivel: 0,
        faixaInvertida: 0,
        tipoProdutoIlegivel: 0,
        semPreco: 0,
        semCaminho: 0,
        temPrecoComDesconto: 0,
        temOfertaB2B: 0,
        fechada: 0,
        jaVisto: 0,
        naoConfirmados: 0,
        problemasDePreco: 0,
        limiteTaxa: null,
        porChave: {},
      },
      amostraReducoes: [],
      decisao: null,
      lotes: {},
      progressoEmMs: null,
      esperaLotesAteMs: null,
      relogioInicio: null,
    });
  });

  it('every counter defaults FIELD BY FIELD: a counters map lacking one reads it as 0 (NEAR-MISS against a field left optional, which the whole-map default would hide)', () => {
    expect(contagensExecucaoPrecoAmazonSchema.parse({})).toEqual(
      execucaoPrecoAmazonSchema.parse(RUN).contagens,
    );
    expect(contagensExecucaoPrecoAmazonSchema.parse({ desce: 3 }).direcaoDesconhecida).toBe(0);
  });

  it('NEAR-MISS: the mass-decrease confirmation defaults to FALSE, never to true', () => {
    expect(execucaoPrecoAmazonSchema.parse(RUN).confirmarReducaoEmMassa).toBe(false);
    expect(
      execucaoPrecoAmazonSchema.parse({ ...RUN, confirmarReducaoEmMassa: true })
        .confirmarReducaoEmMassa,
    ).toBe(true);
  });

  it('the defaults are fresh objects: two parses never share a counter map, a cursor or a list', () => {
    const a = execucaoPrecoAmazonSchema.parse(RUN);
    const b = execucaoPrecoAmazonSchema.parse(RUN);
    expect(a.contagens).not.toBe(b.contagens);
    expect(a.contagens.porChave).not.toBe(b.contagens.porChave);
    expect(a.cursores.canonica).not.toBe(b.cursores.canonica);
    expect(a.itensPorParte).not.toBe(b.itensPorParte);
    expect(a.lotes).not.toBe(b.lotes);
    a.contagens.porChave.pai = 1;
    a.itensPorParte.push(3);
    expect(b.contagens.porChave).toEqual({});
    expect(b.itensPorParte).toEqual([]);
  });

  it('requires its claim fields: the run, the phase, the consent, the operator and the start', () => {
    for (const campo of Object.keys(RUN)) {
      const semCampo: Record<string, unknown> = { ...RUN };
      delete semCampo[campo];
      expect(execucaoPrecoAmazonSchema.safeParse(semCampo).success, campo).toBe(false);
    }
  });

  it('a run decided into batches round-trips, every field included', () => {
    const relogio = timestampFalso(AGORA + 1_234);
    const doc = {
      ...RUN,
      fase: FASE_EXECUCAO_PRECO_AMAZON.concluida,
      motivo: null,
      baixarPreco: true,
      confirmarReducaoEmMassa: true,
      cursores: {
        canonica: { ultimoCaminho: 'produtos/p9/prodAmazon/l9', concluida: true },
        nua: { ultimoCaminho: null, concluida: true },
      },
      proximaPagina: 67,
      proximaParte: 2,
      itensPorParte: [300, 12],
      contagens: {
        lidos: 20_100,
        iguais: 19_000,
        enviaveis: 312,
        sobe: 200,
        desce: 112,
        quedaExcessiva: 1,
        direcaoDesconhecida: 2,
        reducaoSemConsentimento: 0,
        precoAtualIlegivel: 3,
        faixaInvertida: 2,
        tipoProdutoIlegivel: 1,
        semPreco: 40,
        semCaminho: 1,
        temPrecoComDesconto: 5,
        temOfertaB2B: 0,
        fechada: 2,
        jaVisto: 9,
        naoConfirmados: 4,
        problemasDePreco: 6,
        limiteTaxa: 0.0222,
        porChave: { pai: 30, 'nao-listado': 12, 'asin-divergente': 1 },
      },
      amostraReducoes: ['SKU-1:199.9>19.99', 'a:b>c:50>49.99'],
      decisao: DECISAO_EXECUCAO_PRECO_AMAZON.lotes,
      lotes: {
        '0': { ...LOTE, parteInicial: 0, partes: 2, itens: 312, desfecho: 'concluido' },
      },
      progressoEmMs: AGORA + 400_000,
      esperaLotesAteMs: AGORA + 400_000 + 48 * 3_600_000,
      relogioInicio: relogio,
    };
    const lido = execucaoPrecoAmazonSchema.parse(doc);
    expect(lido).toEqual({
      ...doc,
      lotes: { '0': { ...doc.lotes['0'], motivoSemEnvio: null } },
    });
    expect(lido.relogioInicio).toBe(relogio);
  });

  it('★ relogioInicio round-trips as a Timestamp: the SAME object, never a number or a Date, exactly as the stock run’s', () => {
    const ms = AGORA + 1_234;
    const ts = timestampFalso(ms);
    expect(execucaoPrecoAmazonSchema.parse({ ...RUN, relogioInicio: ts }).relogioInicio).toBe(ts);
    expect(execucaoPrecoAmazonSchema.safeParse({ ...RUN, relogioInicio: ms }).success).toBe(false);
    expect(
      execucaoPrecoAmazonSchema.safeParse({ ...RUN, relogioInicio: new Date(ms) }).success,
    ).toBe(false);
    expect(execucaoPrecoAmazonSchema.shape.relogioInicio).toBe(
      reconciliacaoEstoqueAmazonSchema.shape.relogioInicio,
    );
    expect(execucaoPrecoAmazonSchema.shape.cursores).toBe(
      reconciliacaoEstoqueAmazonSchema.shape.cursores,
    );
  });

  it.each([
    ['a phase outside the closed set', { fase: 'decidida' }],
    ['a motivo outside the closed set', { motivo: 'outro' }],
    ['a decision outside the closed set', { decisao: 'feed' }],
    ['a string consent', { baixarPreco: 'true' }],
    ['a string mass-decrease confirmation', { confirmarReducaoEmMassa: 'true' }],
    ['a run id that is not an id', { execucaoId: 'a b' }],
    ['an operator id that is a path', { solicitadaPor: 'usuarios/u1' }],
    ['a negative counter', { contagens: { desce: -1 } }],
    ['a free-text counter key', { contagens: { porChave: { 'a b': 1 } } }],
    ['a negative rate limit', { contagens: { limiteTaxa: -1 } }],
    ['an infinite rate limit', { contagens: { limiteTaxa: Number.POSITIVE_INFINITY } }],
    ['a fractional page', { proximaPagina: 1.5 }],
    ['a µs-looking fractional progress stamp', { progressoEmMs: AGORA + 0.25 }],
    ['a batch deadline as a digit string', { esperaLotesAteMs: String(AGORA) }],
    ['an empty part (a part has at least one SKU)', { itensPorParte: [3, 0] }],
    ['a part larger than a page', { itensPorParte: [301] }],
    ['a sample entry that is not sku:antes>depois', { amostraReducoes: ['SKU-1 199.9 19.99'] }],
    ['a sample entry with no prices', { amostraReducoes: ['SKU-1:>'] }],
  ])('refuses %s', (_nome, troca) => {
    expect(execucaoPrecoAmazonSchema.safeParse({ ...RUN, ...troca }).success).toBe(false);
  });

  it('the rate limit is a rate: a fraction is kept, null means none was seen', () => {
    for (const limiteTaxa of [0.0222, 5, 0, null]) {
      expect(
        execucaoPrecoAmazonSchema.safeParse({ ...RUN, contagens: { limiteTaxa } }).success,
        String(limiteTaxa),
      ).toBe(true);
    }
  });

  it('★ the decrease sample holds at most 20 entries (NEAR-MISS: 20 kept, 21 refused)', () => {
    expect(MAX_AMOSTRA_PRECO_AMAZON).toBe(20);
    const vinte = Array.from({ length: 20 }, (_, i) => `SKU-${String(i)}:100>${String(50 + i)}`);
    expect(execucaoPrecoAmazonSchema.safeParse({ ...RUN, amostraReducoes: vinte }).success).toBe(
      true,
    );
    expect(
      execucaoPrecoAmazonSchema.safeParse({ ...RUN, amostraReducoes: [...vinte, 'x:2>1'] }).success,
    ).toBe(false);
    for (const ok of ['a:1>0.5', 'a:b:1e+21>9.99', 'açúcar>:10>9']) {
      expect(AMOSTRA_REDUCAO_PRECO_AMAZON_REGEX.test(ok), ok).toBe(true);
    }
  });

  it('a partial merge patch validates (no top-level refinement blocks .partial())', () => {
    expect(execucaoPrecoAmazonSchema.partial().parse({ proximaParte: 3 }).proximaParte).toBe(3);
    expect(execucaoPrecoAmazonSchema.partial().safeParse({ lotes: { '1': LOTE } }).success).toBe(
      false,
    );
  });

  it('the closed vocabularies, each with its companion', () => {
    const pares = [
      [faseExecucaoPrecoAmazonSchema.options, FASE_EXECUCAO_PRECO_AMAZON],
      [motivoFimExecucaoPrecoAmazonSchema.options, MOTIVO_FIM_EXECUCAO_PRECO_AMAZON],
      [decisaoExecucaoPrecoAmazonSchema.options, DECISAO_EXECUCAO_PRECO_AMAZON],
      [desfechoLotePrecoAmazonSchema.options, DESFECHO_LOTE_PRECO_AMAZON],
      [motivoSemEnvioLotePrecoAmazonSchema.options, MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON],
    ] as const;
    for (const [opcoes, companheira] of pares) {
      expect(Object.values(companheira).sort()).toEqual([...opcoes].sort());
    }
    expect(faseExecucaoPrecoAmazonSchema.options).toEqual([
      'paginando',
      'decidindo',
      'concluida',
      'cancelada',
      'truncada',
      'falhou',
    ]);
    expect(motivoFimExecucaoPrecoAmazonSchema.options).toEqual([
      'partes-demais',
      'prazo',
      'cursor-ilegivel',
      'sem-tabela-normal',
      'enfileiramento-falhou',
    ]);
    expect(decisaoExecucaoPrecoAmazonSchema.options).toEqual([
      'nada',
      'tarefas',
      'canario',
      'dry-run',
      'lotes',
      'reducao-em-massa',
    ]);
    expect(motivoSemEnvioLotePrecoAmazonSchema.options).toEqual([
      'simulado',
      'sem-escrita',
      'so-patches',
      'repassado',
      'repasse-abortado',
      'abortado',
      'documento-falhou',
      'recusa-definitiva',
      'lote-expirado',
    ]);
  });

  it('a batch’s end is a submitted feed’s recovery end, or sem-envio (NEAR-MISS: a feed status is not one)', () => {
    expect(desfechoLotePrecoAmazonSchema.options).toEqual([
      ...desfechoFeedAmazonSchema.options,
      'sem-envio',
    ]);
    for (const quase of ['enviado', 'processando', 'pendente', 'sem-desfecho']) {
      expect(desfechoLotePrecoAmazonSchema.safeParse(quase).success, quase).toBe(false);
    }
  });
});

describe('★ the run’s bounds', () => {
  it('★ itensPorParte holds 1,000 parts, never 1,001; proximaParte stops at 1,000 (NEAR-MISS pair)', () => {
    const mil = Array.from({ length: MAX_PARTES_EXECUCAO_PRECO_AMAZON }, () => 1);
    expect(
      execucaoPrecoAmazonSchema.safeParse({
        ...RUN,
        itensPorParte: mil,
        proximaParte: MAX_PARTES_EXECUCAO_PRECO_AMAZON,
      }).success,
    ).toBe(true);
    expect(
      execucaoPrecoAmazonSchema.safeParse({ ...RUN, itensPorParte: [...mil, 1] }).success,
    ).toBe(false);
    expect(
      execucaoPrecoAmazonSchema.safeParse({
        ...RUN,
        proximaParte: MAX_PARTES_EXECUCAO_PRECO_AMAZON + 1,
      }).success,
    ).toBe(false);
  });

  it('★ the batch map: 34 dense batches are kept, a 35th is refused (NEAR-MISS pair)', () => {
    expect(MAX_LOTES_EXECUCAO_PRECO_AMAZON).toBe(34);
    expect(lotesExecucaoPrecoAmazonSchema.safeParse(lotes(34)).success).toBe(true);
    expect(lotesExecucaoPrecoAmazonSchema.safeParse(lotes(35)).success).toBe(false);
    expect(
      execucaoPrecoAmazonSchema.safeParse({ ...RUN, lotes: lotes(MAX_LOTES_EXECUCAO_PRECO_AMAZON) })
        .success,
    ).toBe(true);
    expect(
      execucaoPrecoAmazonSchema.safeParse({
        ...RUN,
        lotes: lotes(MAX_LOTES_EXECUCAO_PRECO_AMAZON + 1),
      }).success,
    ).toBe(false);
  });

  it('the batch map is dense and keyed by plain indices: a gap, a leading zero or a name is refused', () => {
    const { '1': _um, ...comLacuna } = lotes(3);
    expect(lotesExecucaoPrecoAmazonSchema.safeParse(comLacuna).success).toBe(false);
    expect(lotesExecucaoPrecoAmazonSchema.safeParse({ '1': LOTE }).success).toBe(false);
    expect(lotesExecucaoPrecoAmazonSchema.safeParse({ '00': LOTE }).success).toBe(false);
    expect(lotesExecucaoPrecoAmazonSchema.safeParse({ primeiro: LOTE }).success).toBe(false);
    expect(lotesExecucaoPrecoAmazonSchema.safeParse({}).success).toBe(true);
    for (const chave of ['0', '9', '33', '999']) {
      expect(CHAVE_LOTE_PRECO_AMAZON_REGEX.test(chave), chave).toBe(true);
    }
    for (const chave of ['', '01', '-1', '1000', '1.5']) {
      expect(CHAVE_LOTE_PRECO_AMAZON_REGEX.test(chave), chave).toBe(false);
    }
  });

  it('a batch covers parts inside the run: the last one ends at part 999 (NEAR-MISS: one part further is refused)', () => {
    expect(
      lotePrecoAmazonSchema.safeParse({ ...LOTE, parteInicial: 950, partes: 50 }).success,
    ).toBe(true);
    expect(
      lotePrecoAmazonSchema.safeParse({ ...LOTE, parteInicial: 951, partes: 50 }).success,
    ).toBe(false);
    expect(lotePrecoAmazonSchema.safeParse({ ...LOTE, partes: 0 }).success).toBe(false);
    expect(lotePrecoAmazonSchema.safeParse({ ...LOTE, itens: 0 }).success).toBe(false);
  });

  it('a batch ended without a send names why, and only then (both directions)', () => {
    expect(
      lotePrecoAmazonSchema.parse({
        ...LOTE,
        desfecho: DESFECHO_LOTE_PRECO_AMAZON.semEnvio,
        motivoSemEnvio: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.loteExpirado,
      }).motivoSemEnvio,
    ).toBe('lote-expirado');
    expect(lotePrecoAmazonSchema.parse(LOTE)).toEqual({
      ...LOTE,
      desfecho: null,
      motivoSemEnvio: null,
    });
    expect(
      lotePrecoAmazonSchema.safeParse({ ...LOTE, desfecho: DESFECHO_LOTE_PRECO_AMAZON.semEnvio })
        .success,
    ).toBe(false);
    expect(
      lotePrecoAmazonSchema.safeParse({
        ...LOTE,
        desfecho: DESFECHO_LOTE_PRECO_AMAZON.falhou,
        motivoSemEnvio: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.abortado,
      }).success,
    ).toBe(false);
    expect(
      lotePrecoAmazonSchema.safeParse({
        ...LOTE,
        motivoSemEnvio: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.simulado,
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The numbers                                */
/* -------------------------------------------------------------------------- */

describe('the numbers', () => {
  it('THE SWITCH for price IS the stock switch: 30 (NEAR-MISS: Amazon’s 1,500 is not it)', () => {
    expect(LIMIAR_FEED_PRECO_AMAZON).toBe(LIMIAR_FEED_ESTOQUE_AMAZON);
    expect(LIMIAR_FEED_PRECO_AMAZON).toBe(30);
    expect(LIMIAR_FEED_PRECO_AMAZON).not.toBe(1_500);
  });

  it('the manual produto bound IS the stock push’s 50, apart from the switch', () => {
    expect(MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON).toBe(MAX_PRODUTOS_ENVIO_ESTOQUE_MANUAL_AMAZON);
    expect(MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON).toBe(50);
    expect(MAX_PRODUTOS_ENVIO_PRECO_MANUAL_AMAZON).not.toBe(LIMIAR_FEED_PRECO_AMAZON);
  });

  it('a part holds one walk page, the stock block’s size', () => {
    expect(MAX_ITENS_DIVERGENCIA_PRECO_AMAZON).toBe(MAX_ITENS_DIVERGENCIA_ESTOQUE_AMAZON);
  });

  it('the mass-decrease stop’s thresholds: 1,500 decreases, more than half above the switch, a drop of more than half', () => {
    expect(LIMIAR_REDUCAO_EM_MASSA_PRECO_AMAZON).toBe(1_500);
    expect(FRACAO_REDUCAO_EM_MASSA_PRECO_AMAZON).toBe(0.5);
    expect(QUEDA_MAXIMA_PRECO_AMAZON).toBe(0.5);
    expect(LIMIAR_REDUCAO_EM_MASSA_PRECO_AMAZON).not.toBe(LIMIAR_FEED_PRECO_AMAZON);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The price routes                             */
/* -------------------------------------------------------------------------- */

describe('the price routes’ wire shapes', () => {
  it('★ CODIGO_ERRO_PRECO_AMAZON is exactly the seven codes, each AMAZON_PRECO_-prefixed', () => {
    expect(CODIGO_ERRO_PRECO_AMAZON).toEqual({
      CORPO_INVALIDO: 'AMAZON_PRECO_CORPO_INVALIDO',
      SELECAO_EXCEDE_LIMITE: 'AMAZON_PRECO_SELECAO_EXCEDE_LIMITE',
      CONTA_NAO_ENCONTRADA: 'AMAZON_PRECO_CONTA_NAO_ENCONTRADA',
      CONTA_SEM_TABELA_NORMAL: 'AMAZON_PRECO_CONTA_SEM_TABELA_NORMAL',
      EXECUCAO_EM_CURSO: 'AMAZON_PRECO_EXECUCAO_EM_CURSO',
      EXECUCAO_NAO_ENCONTRADA: 'AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA',
      ENFILEIRAMENTO_FALHOU: 'AMAZON_PRECO_ENFILEIRAMENTO_FALHOU',
    });
    for (const codigo of Object.values(CODIGO_ERRO_PRECO_AMAZON)) {
      expect(codigo).toMatch(/^AMAZON_PRECO_[A-Z_]+$/);
    }
  });

  it('★ every value is unique across ALL FIVE sets: a copy of another set’s value reds', () => {
    const todos = [
      ...Object.values(CODIGO_ERRO_AMAZON),
      ...Object.values(CODIGO_ERRO_NFE_AMAZON),
      ...Object.values(CODIGO_ERRO_ETIQUETA_AMAZON),
      ...Object.values(CODIGO_ERRO_ESTOQUE_AMAZON),
      ...Object.values(CODIGO_ERRO_PRECO_AMAZON),
    ];
    expect(new Set(todos).size).toBe(todos.length);
    // NEAR-MISS: the stock push's body code is ANOTHER code than the price push's.
    expect(CODIGO_ERRO_PRECO_AMAZON.CORPO_INVALIDO).not.toBe(
      CODIGO_ERRO_ESTOQUE_AMAZON.CORPO_INVALIDO,
    );
  });

  it('the 200 envelope IS the stock push’s (one wire contract), with no price in it', () => {
    expect(envioPrecoManualAmazonSchema).toBe(envioEstoqueManualAmazonSchema);
    const resposta = {
      listings: [
        {
          produtoId: 'ancora-1',
          produtoNome: 'Âncora 1',
          sku: 'SKU-1',
          resultado: 'enviado',
          mensagem: 'Na fila.',
          preco: 129.9,
        },
      ],
      produtosSemEnvio: [],
      pausadoAte: null,
    };
    const lido = envioPrecoManualAmazonSchema.parse(resposta);
    expect('preco' in (lido.listings[0] ?? {})).toBe(false);
  });

  it('the error envelope is the stock push’s plus the run id (409) and a motivo slug (503)', () => {
    const emCurso = {
      error: 'x',
      code: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO,
      execucaoId: 'run-1',
    };
    expect(erroPrecoAmazonSchema.parse(emCurso)).toEqual(emCurso);
    const fila = {
      error: 'x',
      code: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU,
      motivo: 'fila-desligada',
    };
    expect(erroPrecoAmazonSchema.parse(fila)).toEqual(fila);
    const limite = {
      error: 'x',
      code: CODIGO_ERRO_PRECO_AMAZON.SELECAO_EXCEDE_LIMITE,
      detalhes: {
        limite: LIMIAR_FEED_PRECO_AMAZON,
        unidade: UNIDADE_LIMITE_ENVIO_ESTOQUE_MANUAL_AMAZON.anuncios,
        encontrados: 31,
      },
    };
    expect(erroPrecoAmazonSchema.parse(limite)).toEqual(limite);
    for (const chave of Object.keys(erroEnvioEstoqueManualAmazonSchema.shape)) {
      expect(Object.keys(erroPrecoAmazonSchema.shape), chave).toContain(chave);
    }
    // NEAR-MISS: a run id outside the grammar is refused; a code a newer backend adds still parses.
    expect(erroPrecoAmazonSchema.safeParse({ ...emCurso, execucaoId: 'a b' }).success).toBe(false);
    expect(erroPrecoAmazonSchema.safeParse({ error: 'x', code: 'AMAZON_NOVO' }).success).toBe(true);
  });

  it('the run routes’ answers: the 202 names the run and whether it was re-kicked; the cancel names its phase', () => {
    const inicio = { execucaoId: 'run-1', retomada: true };
    expect(respostaInicioExecucaoPrecoAmazonSchema.parse(inicio)).toEqual(inicio);
    const comTexto = { ...inicio, retomada: 'true' };
    expect(respostaInicioExecucaoPrecoAmazonSchema.safeParse(comTexto).success).toBe(false);
    const semRetomada = { execucaoId: 'run-1' };
    expect(respostaInicioExecucaoPrecoAmazonSchema.safeParse(semRetomada).success).toBe(false);
    const cancelamento = { execucaoId: 'run-1', fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada };
    expect(respostaCancelamentoExecucaoPrecoAmazonSchema.parse(cancelamento)).toEqual(cancelamento);
    for (const fora of [
      { ...cancelamento, fase: 'parada' },
      { ...cancelamento, execucaoId: 'a b' },
    ]) {
      expect(respostaCancelamentoExecucaoPrecoAmazonSchema.safeParse(fora).success).toBe(false);
    }
  });

  it('the status summary: the run’s own fields, its batches by state, `parada` and the feed in flight', () => {
    const pendente = {
      indice: 1,
      execucaoIdLote: 'lote-1',
      parteInicial: 30,
      partes: 1,
      itens: 1,
      estado: ESTADO_LOTE_RESUMO_PRECO_AMAZON.pendente,
      motivoSemEnvio: null,
    };
    const resumo = {
      execucaoId: 'run-1',
      fase: FASE_EXECUCAO_PRECO_AMAZON.concluida,
      motivo: null,
      baixarPreco: true,
      confirmarReducaoEmMassa: false,
      decisao: DECISAO_EXECUCAO_PRECO_AMAZON.lotes,
      contagens: execucaoPrecoAmazonSchema.parse(RUN).contagens,
      amostraReducoes: ['SKU-1:50>40'],
      iniciadaEmMs: AGORA,
      progressoEmMs: AGORA + 1,
      esperaLotesAteMs: AGORA + 2,
      parada: false,
      lotes: [
        {
          indice: 0,
          execucaoIdLote: 'lote-0',
          parteInicial: 0,
          partes: 30,
          itens: 9_000,
          estado: ESTADO_LOTE_RESUMO_PRECO_AMAZON.semEnvio,
          motivoSemEnvio: MOTIVO_SEM_ENVIO_LOTE_PRECO_AMAZON.simulado,
        },
        pendente,
      ],
      feedEmCurso: { estado: 'enviado', idadeMs: 600_000 },
    };
    expect(resumoExecucaoPrecoAmazonSchema.parse(resumo)).toEqual(resumo);
    const livre = resumoExecucaoPrecoAmazonSchema.parse({ ...resumo, feedEmCurso: null });
    expect(livre.feedEmCurso).toBeNull();
    // NEAR-MISS: a free lease is no feed in flight; a batch state or a sample entry outside its set is refused.
    for (const fora of [
      { ...resumo, feedEmCurso: { estado: 'livre', idadeMs: 0 } },
      { ...resumo, lotes: [{ ...pendente, estado: 'enviando' }] },
      { ...resumo, amostraReducoes: ['x'] },
    ]) {
      expect(resumoExecucaoPrecoAmazonSchema.safeParse(fora).success).toBe(false);
    }
  });

  it('a batch’s state on the status route is a recorded end, or pendente / sem-desfecho; the lease states it shows are those of a feed in flight', () => {
    expect(estadoLoteResumoPrecoAmazonSchema.options).toEqual([
      ...desfechoLotePrecoAmazonSchema.options,
      'pendente',
      'sem-desfecho',
    ]);
    expect(Object.values(ESTADO_LOTE_RESUMO_PRECO_AMAZON).sort()).toEqual(
      [...estadoLoteResumoPrecoAmazonSchema.options].sort(),
    );
    const emCurso = resumoExecucaoPrecoAmazonSchema.shape.feedEmCurso.unwrap().shape.estado;
    expect(emCurso.options).toEqual(estadoVezFeedAmazonSchema.options.filter((x) => x !== 'livre'));
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Repo pins                                 */
/* -------------------------------------------------------------------------- */

describe('the module', () => {
  it('is barrel-exported bare, never as a { schema, meta } pair', () => {
    expect(Object.keys(modulo).length).toBeGreaterThan(0);
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });

  it('is NOT registered in ALL_DOMAINS (no rules block, no client access)', () => {
    const esquemas = ALL_DOMAINS.map((d) => d.schema);
    for (const esquema of [execucaoPrecoAmazonSchema, divergenciaPrecoAmazonSchema]) {
      expect(esquemas).not.toContain(esquema);
    }
    const caminhos = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    for (const caminho of ['precosAmazon', 'precosAmazon/{contaId}/divergenciasPrecoAmazon']) {
      expect(caminhos).not.toContain(caminho);
    }
  });
});
