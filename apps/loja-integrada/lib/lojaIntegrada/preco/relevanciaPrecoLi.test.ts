/**
 * `relevanciaPrecoLi.ts` (master plan step 13, PR 13-e): the price trigger's relevance, from the
 * payload alone. Its answer drops a write at ZERO reads, so folding too much LOSES a price edit:
 * every "did not move" verdict is pinned beside a near-miss that must move (root `CLAUDE.md`, the
 * fold rule). Every value is invented.
 */
import { describe, expect, it } from 'vitest';
import type { LeituraTabelaPrecoLi } from '@delfrance/schemas';

import { CAMPOS_PRODUTO_PRECO_LI } from './leituraPrecoErp';
import {
  CAMPOS_RELEVANCIA_PRECO_LI,
  type DadosProdutoPrecoLi,
  mesmaLeituraTabelaPrecoLi,
  relevanciaEventoPrecoLi,
  tabelaDaContaMoveuLi,
  tabelasMovidasLi,
} from './relevanciaPrecoLi';

const P = 'prod-li-1';
const N = 'tab-normal';
const PR = 'tab-promo';

const precos = (entradas: Readonly<Record<string, unknown>>): DadosProdutoPrecoLi => ({
  precos: entradas,
});

const ev = (antes: DadosProdutoPrecoLi | null, depois: DadosProdutoPrecoLi | null, id = P) => ({
  produtoId: id,
  antes,
  depois,
});

const relevante = (antes: DadosProdutoPrecoLi | null, depois: DadosProdutoPrecoLi | null) =>
  relevanciaEventoPrecoLi(ev(antes, depois)).relevante;

/** The tabelas a write moved, sorted. */
const movidas = (antes: DadosProdutoPrecoLi, depois: DadosProdutoPrecoLi) =>
  [...tabelasMovidasLi(antes, depois)].sort();

describe('what relevance reads', () => {
  it('EXACTLY the send run’s mask: a write moving none of those three fields cannot move a target', () => {
    expect([...CAMPOS_RELEVANCIA_PRECO_LI].sort()).toEqual([...CAMPOS_PRODUTO_PRECO_LI].sort());
  });

  it('a create (no before) and a delete (no after) are never relevant | near-miss: the same payloads as an update ARE', () => {
    const a = precos({ [N]: { valor: 11.11 } });
    const b = precos({ [N]: { valor: 22.22 } });
    expect(relevante(null, b)).toBe(false);
    expect(relevante(a, null)).toBe(false);
    expect(relevante(null, null)).toBe(false);
    expect(relevante(a, b)).toBe(true);
  });

  it('identical payloads are not relevant', () => {
    const a = {
      ...precos({ [N]: { valor: 11.11 } }),
      paiId: 'pai-1',
      propagatePriceToChildren: true,
    };
    expect(relevante(a, structuredClone(a))).toBe(false);
  });

  it('⚠️ the custo is NOT a signal (11.11 → 22.22) | near-miss: the custo AND the normal entry ⇒ relevant', () => {
    const base = precos({ [N]: { valor: 11.11 } });
    expect(relevante({ ...base, custo: 11.11 }, { ...base, custo: 22.22 })).toBe(false);
    expect(
      relevante({ ...base, custo: 11.11 }, { ...precos({ [N]: { valor: 22.22 } }), custo: 22.22 }),
    ).toBe(true);
  });

  it('⚠️ a NEW counting link (the anchor gains the conta) is NOT a signal | near-miss: the same write moving a price ⇒ relevant', () => {
    const base = precos({ [N]: { valor: 11.11 } });
    expect(
      relevante(
        { ...base, integracoesComProduto: [] },
        { ...base, integracoesComProduto: ['conta-li-a'] },
      ),
    ).toBe(false);
    expect(
      relevante(
        { ...base, integracoesComProduto: [] },
        { ...precos({ [N]: { valor: 22.22 } }), integracoesComProduto: ['conta-li-a'] },
      ),
    ).toBe(true);
  });

  it.each([
    ['the name', { nome: 'Antes' }, { nome: 'Depois' }],
    ['the photos', { fotos: ['a'] }, { fotos: ['a', 'b'] }],
    ['publicado', { publicado: false }, { publicado: true }],
    ['a kit rollup', { pesoKg: 1.1, altura: 2 }, { pesoKg: 2.2, altura: 3 }],
    ['the modification stamp', { ultimaModificacao: 1 }, { ultimaModificacao: 2 }],
    [
      'a channel mirror',
      { statusProdutosMarketplace: {} },
      { statusProdutosMarketplace: { x: 1 } },
    ],
  ])('%s alone is not relevant', (_r, a, b) => {
    const base = precos({ [N]: { valor: 11.11 } });
    expect(relevante({ ...base, ...a }, { ...base, ...b })).toBe(false);
  });

  it('property: adding or changing ANY key outside the three never changes the answer', () => {
    // A small seeded sweep; mulberry32, no dependency.
    let s = 0x5eed_0013;
    const aleatorio = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(aleatorio() * xs.length)] as T;
    const valores = [undefined, null, 0, 11.11, 'x', [], {}, true];
    const relevantes = [
      {},
      precos({ [N]: { valor: 11.11 } }),
      precos({ [N]: { valor: 22.22 } }),
      { paiId: 'pai-1' },
      { propagatePriceToChildren: false },
    ];
    let vistos = 0;
    for (let i = 0; i < 400; i += 1) {
      const a: Record<string, unknown> = { ...pick(relevantes) };
      const b: Record<string, unknown> = { ...pick(relevantes) };
      const base = relevante(a, b);
      const extraA = { ...a };
      const extraB = { ...b };
      for (const campo of ['custo', 'nome', 'integracoesComProduto', 'publicado', 'precosX']) {
        const va = pick(valores);
        const vb = pick(valores);
        if (va !== undefined) extraA[campo] = va;
        if (vb !== undefined) extraB[campo] = vb;
      }
      expect(relevante(extraA, extraB)).toBe(base);
      if (base) vistos += 1;
    }
    // Anti-vacuity: both answers occurred.
    expect(vistos).toBeGreaterThan(40);
    expect(vistos).toBeLessThan(360);
  });
});

describe('a tabela reading moved — through the shared reader and the shared centavos fold', () => {
  it.each([
    ['10 → 10.004 (float residue)', 10, 10.004],
    ['22.22 → 22.2200001', 22.22, 22.2200001],
  ])('⚠️ EQUAL: %s moves NOTHING', (_r, a, b) => {
    expect(movidas(precos({ [N]: { valor: a } }), precos({ [N]: { valor: b } }))).toEqual([]);
    expect(relevante(precos({ [N]: { valor: a } }), precos({ [N]: { valor: b } }))).toBe(false);
  });

  it.each([
    ['10 → 10.01', 10, 10.01],
    ['49.99 → 50', 49.99, 50],
    ['49.991 → 50 (a < 0.01 tolerance would equate them)', 49.991, 50],
    ['11.11 → 11.10', 11.11, 11.1],
  ])('⚠️ NEAR-MISS: %s MOVES the tabela', (_r, a, b) => {
    expect(movidas(precos({ [N]: { valor: a } }), precos({ [N]: { valor: b } }))).toEqual([N]);
    expect(relevante(precos({ [N]: { valor: a } }), precos({ [N]: { valor: b } }))).toBe(true);
  });

  it('EQUAL: an absent entry ≡ a {valor: 0} one (both ausente) | near-miss: {valor: 0} → {valor: 0.01} moves', () => {
    expect(movidas(precos({}), precos({ [N]: { valor: 0 } }))).toEqual([]);
    expect(movidas(precos({ [N]: { valor: 0 } }), precos({ [N]: { valor: 0.004 } }))).toEqual([]);
    expect(movidas(precos({ [N]: { valor: 0 } }), precos({ [N]: { valor: 0.01 } }))).toEqual([N]);
  });

  it.each([
    ['an unreadable value against a readable one (fail-open)', { valor: '10' }, { valor: 10 }],
    ['a legacy bare number against a price', 10, { valor: 10 }],
    ['a negative value rounding to 0 (unreadable) against absent', { valor: -0.004 }, { valor: 0 }],
    ['an entry with no valor against a price', {}, { valor: 10 }],
  ])('⚠️ NEAR-MISS: %s MOVES the tabela', (_r, a, b) => {
    expect(movidas(precos({ [N]: a }), precos({ [N]: b }))).toEqual([N]);
  });

  it('EQUAL: two unreadable values ("10" → "11") move nothing — the run holds the child either way', () => {
    expect(movidas(precos({ [N]: { valor: '10' } }), precos({ [N]: { valor: '11' } }))).toEqual([]);
    expect(movidas(precos({ [N]: 7 }), precos({ [N]: { valor: Number.NaN } }))).toEqual([]);
  });

  it.each([['a/b'], ['__x__'], ['.'], ['..'], ['']])(
    '⚠️ a ghost key %j (no ERP document id) never names a tabela: 1 → 2 is NOT relevant',
    (chave) => {
      const a = precos({ [chave]: { valor: 1 } });
      const b = precos({ [chave]: { valor: 2 } });
      expect(movidas(a, b)).toEqual([]);
      expect(relevante(a, b)).toBe(false);
    },
  );

  it('near-miss: a VALID key of another tabela 1 → 2 IS relevant, naming that tabela only', () => {
    const r = relevanciaEventoPrecoLi(
      ev(precos({ 'tab-outra': { valor: 1 } }), precos({ 'tab-outra': { valor: 2 } })),
    );
    expect(r.relevante).toBe(true);
    if (r.relevante) expect([...r.tabelasMovidas]).toEqual(['tab-outra']);
  });

  it('a key over 1 500 bytes is no document id either', () => {
    const chave = 'x'.repeat(1501);
    expect(movidas(precos({ [chave]: { valor: 1 } }), precos({ [chave]: { valor: 2 } }))).toEqual(
      [],
    );
  });

  it('an INHERITED precos key is not read', () => {
    const herdado = Object.create({ [N]: { valor: 11.11 } }) as Record<string, unknown>;
    expect(movidas(precos({}), precos(herdado))).toEqual([]);
    // …and an inherited `precos` itself is not stored data.
    const semPrecosProprios = Object.create({
      precos: { [N]: { valor: 22.22 } },
    }) as DadosProdutoPrecoLi;
    expect(movidas(precos({}), semPrecosProprios)).toEqual([]);
  });

  it('precos not a plain object on one side (null, an array, a number) ⇒ the other side’s keys move', () => {
    for (const nada of [null, [{ valor: 11.11 }], 5, 'x']) {
      expect(movidas({ precos: nada }, precos({ [N]: { valor: 11.11 } }))).toEqual([N]);
      expect(movidas(precos({ [N]: { valor: 11.11 } }), { precos: nada })).toEqual([N]);
    }
    // Both sides not an object: nothing to compare.
    expect(movidas({ precos: null }, { precos: [] })).toEqual([]);
  });

  it('only the keys that moved are named; several at once', () => {
    expect(
      movidas(
        precos({ [N]: { valor: 11.11 }, [PR]: { valor: 9.99 }, x: { valor: 1 } }),
        precos({ [N]: { valor: 22.22 }, [PR]: { valor: 9.99 }, y: { valor: 1 } }),
      ),
    ).toEqual([N, 'x', 'y']);
  });
});

describe('the propagation flag, FOLDED', () => {
  const flag = (antes: unknown, depois: unknown) => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    if (antes !== undefined) a.propagatePriceToChildren = antes;
    if (depois !== undefined) b.propagatePriceToChildren = depois;
    return relevanciaEventoPrecoLi(ev(a, b));
  };

  it.each([
    ['absent → false', undefined, false],
    ['true → false', true, false],
    ['false → absent', false, undefined],
    ['false → 0', false, 0],
    ["false → 'false'", false, 'false'],
  ])('%s flips it ⇒ relevant, flagMudou', (_r, a, b) => {
    expect(flag(a, b)).toMatchObject({ relevante: true, flagMudou: true });
  });

  it.each([
    ['absent → true', undefined, true],
    ["'false' (a string) → absent", 'false', undefined],
    ['true → 1', true, 1],
    ['0 → null', 0, null],
  ])('⚠️ NEAR-MISS: %s does not flip it (both propagate) ⇒ not relevant', (_r, a, b) => {
    expect(flag(a, b)).toEqual({ relevante: false });
  });

  it('propagaDepois is the folded flag of the AFTER side', () => {
    expect(flag(true, false)).toMatchObject({ propagaDepois: false });
    expect(flag(false, undefined)).toMatchObject({ propagaDepois: true });
  });
});

describe('the parent, through paiDoProdutoErp', () => {
  const pai = (antes: unknown, depois: unknown, id = P) => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    if (antes !== undefined) a.paiId = antes;
    if (depois !== undefined) b.paiId = depois;
    return relevanciaEventoPrecoLi(ev(a, b, id));
  };

  it.each([
    ["absent → '' (both roots)", undefined, ''],
    ["'' → the produto's own id (both roots)", '', P],
    ['null → a number (both roots)', null, 7],
    ["'pai-1' → 'pai-1'", 'pai-1', 'pai-1'],
  ])('⚠️ NEAR-MISS: %s does not move it ⇒ not relevant', (_r, a, b) => {
    expect(pai(a, b)).toEqual({ relevante: false });
  });

  it.each([
    ["'pai-1' → 'pai-2'", 'pai-1', 'pai-2', 'pai-1', 'pai-2'],
    ["'pai-1' → absent", 'pai-1', undefined, 'pai-1', null],
    ["absent → 'pai-1'", undefined, 'pai-1', null, 'pai-1'],
    ["'pai-1' → 'PAI-1' (ids are exact)", 'pai-1', 'PAI-1', 'pai-1', 'PAI-1'],
    ["'' → 'pai-1'", '', 'pai-1', null, 'pai-1'],
  ])('%s moves it ⇒ relevant, paiMudou', (_r, a, b, paiAntes, paiDepois) => {
    expect(pai(a, b)).toMatchObject({ relevante: true, paiMudou: true, paiAntes, paiDepois });
  });

  it('the parent is reported as paiDoProdutoErp reads it: a self-parent and "" are null', () => {
    const r = relevanciaEventoPrecoLi(
      ev(
        { paiId: P, ...precos({ [N]: { valor: 1 } }) },
        { paiId: '', ...precos({ [N]: { valor: 2 } }) },
      ),
    );
    expect(r).toMatchObject({ relevante: true, paiAntes: null, paiDepois: null, paiMudou: false });
  });
});

describe('tabelaDaContaMoveuLi — the tabelas THIS conta prices at', () => {
  const comPromo = { tabelaNormalId: N, tabelaPromocionalId: PR };

  it('its normal tabela moved ⇒ true; its promotional one ⇒ true', () => {
    expect(tabelaDaContaMoveuLi(new Set([N]), comPromo)).toBe(true);
    expect(tabelaDaContaMoveuLi(new Set([PR]), comPromo)).toBe(true);
  });

  it('⚠️ NEAR-MISS: a promo equal to the normal one reads as "no promo list" — another key never counts through it', () => {
    expect(tabelaDaContaMoveuLi(new Set([PR]), { tabelaNormalId: N, tabelaPromocionalId: N })).toBe(
      false,
    );
    expect(tabelaDaContaMoveuLi(new Set([N]), { tabelaNormalId: N, tabelaPromocionalId: N })).toBe(
      true,
    );
  });

  it('⚠️ NEAR-MISS: no promotional tabela, or another tabela altogether ⇒ false', () => {
    expect(
      tabelaDaContaMoveuLi(new Set([PR]), { tabelaNormalId: N, tabelaPromocionalId: null }),
    ).toBe(false);
    expect(tabelaDaContaMoveuLi(new Set(['tab-x']), comPromo)).toBe(false);
    expect(tabelaDaContaMoveuLi(new Set(), comPromo)).toBe(false);
  });
});

describe('mesmaLeituraTabelaPrecoLi — the EQUAL / DISTINCT table', () => {
  const v = (valor: number): LeituraTabelaPrecoLi => ({ valor });

  it.each([
    ['10 ≡ 10 (the reader already rounds 10.004 to 10)', v(10), v(10)],
    ['ausente ≡ ausente', 'ausente' as const, 'ausente' as const],
    ['ilegivel ≡ ilegivel', 'ilegivel' as const, 'ilegivel' as const],
  ])('EQUAL: %s', (_r, a, b) => {
    expect(mesmaLeituraTabelaPrecoLi(a, b)).toBe(true);
  });

  it.each([
    ['49.99 vs 50', v(49.99), v(50)],
    ['49.991 vs 50 (raw, as a caller could hand it)', v(49.991), v(50)],
    ['ilegivel vs a price', 'ilegivel' as const, v(10)],
    ['ausente vs a price', 'ausente' as const, v(10)],
    ['ausente vs ilegivel', 'ausente' as const, 'ilegivel' as const],
    ['a value past a safe integer of centavos, against ITSELF', v(1e17), v(1e17)],
  ])('⚠️ DISTINCT: %s', (_r, a, b) => {
    expect(mesmaLeituraTabelaPrecoLi(a, b)).toBe(false);
    expect(mesmaLeituraTabelaPrecoLi(b, a)).toBe(false);
  });
});

describe('total over an unvalidated body', () => {
  it.each([
    ['a precos entry whose valor is an object', { precos: { [N]: { valor: { x: 1 } } } }],
    ['a paiId that is an object', { paiId: { id: 'pai-1' } }],
    ['a flag that is an array', { propagatePriceToChildren: [false] }],
  ])('%s never throws', (_r, estranho) => {
    expect(() =>
      relevanciaEventoPrecoLi(ev(estranho, precos({ [N]: { valor: 1 } }))),
    ).not.toThrow();
    expect(() => relevanciaEventoPrecoLi(ev(precos({}), estranho))).not.toThrow();
  });

  it.each([
    ['undefined', undefined],
    ['a number', 7],
    ['a string', 'x'],
  ])('a side that is no object at all (%s) reads as EMPTY, never a throw', (_r, lado) => {
    const estranho = lado as unknown as DadosProdutoPrecoLi;
    const r = relevanciaEventoPrecoLi(ev(estranho, precos({ [N]: { valor: 11.11 } })));
    expect(r).toMatchObject({ relevante: true, paiAntes: null, flagMudou: false });
    if (r.relevante) expect([...r.tabelasMovidas]).toEqual([N]);
    expect(relevanciaEventoPrecoLi(ev(estranho, estranho))).toEqual({ relevante: false });
  });
});
