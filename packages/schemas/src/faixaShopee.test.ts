import { describe, expect, it } from 'vitest';

import {
  descreverFaixaShopee,
  descricaoDoAnuncioShopee,
  dentroDaFaixaShopee,
  textoNaFaixaShopee,
  textoUtilizavelShopee,
  tituloDoAnuncioShopee,
} from './faixaShopee';
import * as barrel from './index';

/**
 * THE band check and text resolution the Shopee publisher applies to a
 * listing's name and description (#1911, P2) — moved from `montagemAnuncio.ts`
 * so the draft editor asks the same questions (#1369).
 *
 * The fold here is "trim, blank ⇒ absent". Pinned from BOTH sides: what it
 * folds (edge whitespace, NBSP, whitespace-only) AND what it must keep distinct
 * (inner whitespace, case, a zero-width space) — a test that it applies cannot
 * show where it stops.
 */

describe('the barrel exposes THESE functions — one copy', () => {
  it('index.ts re-exports the same function objects', () => {
    expect(barrel.textoUtilizavelShopee).toBe(textoUtilizavelShopee);
    expect(barrel.dentroDaFaixaShopee).toBe(dentroDaFaixaShopee);
    expect(barrel.descreverFaixaShopee).toBe(descreverFaixaShopee);
    expect(barrel.textoNaFaixaShopee).toBe(textoNaFaixaShopee);
    expect(barrel.tituloDoAnuncioShopee).toBe(tituloDoAnuncioShopee);
    expect(barrel.descricaoDoAnuncioShopee).toBe(descricaoDoAnuncioShopee);
  });
});

describe('textoUtilizavelShopee — trimmed, blank ⇒ absent', () => {
  it.each<[string, string, string]>([
    ['edge spaces', '  a ', 'a'],
    ['edge tabs and newlines', '\t\nCamiseta\r\n', 'Camiseta'],
    ['an edge NBSP (trim removes it)', ' Camiseta ', 'Camiseta'],
  ])('FOLDS %s', (_n, entrada, saida) => {
    expect(textoUtilizavelShopee(entrada)).toBe(saida);
  });

  it.each<[string, string | null | undefined]>([
    ['the empty string', ''],
    ['only spaces', '   '],
    ['only tabs/newlines', '\t\n\r'],
    ['only an NBSP', ' '],
    ['null', null],
    ['undefined', undefined],
  ])('%s is ABSENT', (_n, entrada) => {
    expect(textoUtilizavelShopee(entrada)).toBeNull();
  });

  it('a non-string (a stored legacy shape) is ABSENT, never coerced', () => {
    expect(textoUtilizavelShopee(123 as unknown as string)).toBeNull();
    expect(textoUtilizavelShopee(['a'] as unknown as string)).toBeNull();
  });

  it.each<[string, string, string]>([
    ['inner whitespace', 'Camiseta  Lisa', 'Camiseta  Lisa'],
    ['case', 'CAMISETA', 'CAMISETA'],
    ['a zero-width space (not whitespace to trim) — PRESENT', '​', '​'],
  ])('NEAR-MISS: KEEPS %s', (_n, entrada, saida) => {
    expect(textoUtilizavelShopee(entrada)).toBe(saida);
  });
});

describe('dentroDaFaixaShopee — both ends inclusive; a null end is NO bound', () => {
  const BANDA = { min: 10, max: 20 };

  it.each<[number, boolean]>([
    [9, false],
    [10, true],
    [15, true],
    [20, true],
    [21, false],
  ])('%d in 10..20 → %s', (valor, esperado) => {
    expect(dentroDaFaixaShopee(valor, BANDA)).toBe(esperado);
  });

  it('`{min: null, max: null}` passes everything', () => {
    for (const valor of [-5, 0, 1, 1e9]) {
      expect(dentroDaFaixaShopee(valor, { min: null, max: null })).toBe(true);
    }
  });

  it('an absent band (null / undefined) passes everything', () => {
    expect(dentroDaFaixaShopee(1e9, null)).toBe(true);
    expect(dentroDaFaixaShopee(-1, undefined)).toBe(true);
  });

  it('one open end bounds only the other side', () => {
    expect(dentroDaFaixaShopee(1e9, { min: 1, max: null })).toBe(true);
    expect(dentroDaFaixaShopee(0, { min: 1, max: null })).toBe(false);
    expect(dentroDaFaixaShopee(-1e9, { min: null, max: 120 })).toBe(true);
    expect(dentroDaFaixaShopee(121, { min: null, max: 120 })).toBe(false);
  });

  it('NEAR-MISS: `min: 0` / `max: 0` ARE bounds — a zero end is a value, never "no bound"', () => {
    expect(dentroDaFaixaShopee(-1, { min: 0, max: null })).toBe(false);
    expect(dentroDaFaixaShopee(1, { min: null, max: 0 })).toBe(false);
    expect(dentroDaFaixaShopee(0, { min: 0, max: 0 })).toBe(true);
  });
});

describe('descreverFaixaShopee — `min..max`, `—` for an open end', () => {
  it.each<[string, { min: number | null; max: number | null } | null | undefined, string]>([
    ['a closed band', { min: 1, max: 120 }, '1..120'],
    ['an open min', { min: null, max: 5000 }, '—..5000'],
    ['an open max (and a zero min, which is a value)', { min: 0, max: null }, '0..—'],
    ['both ends open', { min: null, max: null }, '—..—'],
    ['no band', null, 'sem faixa informada'],
    ['an undefined band', undefined, 'sem faixa informada'],
  ])('%s', (_n, banda, texto) => {
    expect(descreverFaixaShopee(banda)).toBe(texto);
  });
});

describe('textoNaFaixaShopee — the publisher’s name/description check as one call', () => {
  it('measures the TRIMMED text: `"  a "` is ONE character, inside `1..1`', () => {
    expect(textoNaFaixaShopee('  a ', { min: 1, max: 1 })).toStrictEqual({
      estado: 'ok',
      texto: 'a',
      comprimento: 1,
    });
  });

  it('NEAR-MISS: `"  ab "` is two characters — outside `1..1`, and never truncated', () => {
    expect(textoNaFaixaShopee('  ab ', { min: 1, max: 1 })).toStrictEqual({
      estado: 'fora-da-faixa',
      comprimento: 2,
    });
  });

  it('both ends inclusive, through the composition', () => {
    const banda = { min: 3, max: 5 };
    expect(textoNaFaixaShopee('ab', banda)).toStrictEqual({
      estado: 'fora-da-faixa',
      comprimento: 2,
    });
    expect(textoNaFaixaShopee('abc', banda)).toStrictEqual({
      estado: 'ok',
      texto: 'abc',
      comprimento: 3,
    });
    expect(textoNaFaixaShopee('abcde', banda)).toStrictEqual({
      estado: 'ok',
      texto: 'abcde',
      comprimento: 5,
    });
    expect(textoNaFaixaShopee('abcdef', banda)).toStrictEqual({
      estado: 'fora-da-faixa',
      comprimento: 6,
    });
  });

  it.each<[string, string | null | undefined]>([
    ['null', null],
    ['undefined', undefined],
    ['blank', ' \t '],
  ])('%s is `ausente` — whatever the band', (_n, texto) => {
    expect(textoNaFaixaShopee(texto, { min: 0, max: 0 })).toStrictEqual({ estado: 'ausente' });
    expect(textoNaFaixaShopee(texto, null)).toStrictEqual({ estado: 'ausente' });
  });

  it('no band ⇒ any usable text is `ok`', () => {
    const longo = 'x'.repeat(10_000);
    expect(textoNaFaixaShopee(longo, null)).toStrictEqual({
      estado: 'ok',
      texto: longo,
      comprimento: 10_000,
    });
  });

  it('length is UTF-16 code units (`String.length`, the publisher’s measure): an emoji counts 2', () => {
    expect(textoNaFaixaShopee('😀', { min: null, max: 1 })).toStrictEqual({
      estado: 'fora-da-faixa',
      comprimento: 2,
    });
    expect(textoNaFaixaShopee('Ação', null)).toStrictEqual({
      estado: 'ok',
      texto: 'Ação',
      comprimento: 4,
    });
  });
});

describe('tituloDoAnuncioShopee / descricaoDoAnuncioShopee — the link’s text, else the produto’s', () => {
  const RESOLVEDORES = [
    ['tituloDoAnuncioShopee', tituloDoAnuncioShopee],
    ['descricaoDoAnuncioShopee', descricaoDoAnuncioShopee],
  ] as const;

  // [link, produto, expected]: the WHOLE grid, so a resolver that checks the
  // produto first, skips the trim, or treats a blank link as present fails a row.
  const GRADE: readonly [string | null | undefined, string | null | undefined, string | null][] = [
    ['Do anúncio', 'Do produto', 'Do anúncio'],
    ['  Do anúncio  ', 'Do produto', 'Do anúncio'],
    ['Do anúncio', null, 'Do anúncio'],
    ['Do anúncio', '   ', 'Do anúncio'],
    [undefined, 'Do produto', 'Do produto'],
    [null, '  Do produto ', 'Do produto'],
    ['', 'Do produto', 'Do produto'],
    ['   ', 'Do produto', 'Do produto'],
    [' ', 'Do produto', 'Do produto'],
    [null, null, null],
    ['  ', '\t', null],
    [undefined, undefined, null],
    ['', '', null],
  ];

  describe.each(RESOLVEDORES)('%s', (_n, resolver) => {
    it.each(GRADE)('link %j, produto %j → %j', (link, produto, esperado) => {
      expect(resolver(link, produto)).toBe(esperado);
    });

    it('the LINK wins whenever it is usable — even over a longer produto text', () => {
      expect(resolver('A', 'Um texto do produto bem mais longo')).toBe('A');
    });

    it('NEAR-MISS: a zero-width-space link is PRESENT — it does not fall back', () => {
      expect(resolver('​', 'Do produto')).toBe('​');
    });
  });
});
