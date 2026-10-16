import { describe, expect, it } from 'vitest';
import { ESTADO_ANUNCIO_SHOPEE, estadoAnuncioShopeeSchema } from '@delfrance/schemas';

import {
  COR_ESTADO_ANUNCIO_SHOPEE,
  ROTULO_ESTADO_ANUNCIO_SHOPEE,
  estadoAnuncioShopeeLido,
  formatarInstanteShopee,
  itemIdDoAnuncioShopee,
  ordenarVinculosShopee,
  urlDoAnuncioShopee,
} from './anuncioProduto';

/**
 * T6 (reconcile §4, PR 6): the tab's pure display helpers — the storefront URL,
 * the label maps and the order one conta's links are listed in. The order's
 * "live" is `anuncioShopeeVivo` from `@delfrance/schemas` (K1-m2), so the
 * near-misses below are chosen where a plausible web copy would disagree with it.
 */

describe('urlDoAnuncioShopee', () => {
  it('builds the storefront page from two positive safe integers', () => {
    expect(urlDoAnuncioShopee(987654, 1000001)).toBe(
      'https://shopee.com.br/product/987654/1000001',
    );
  });

  it('gives no URL unless BOTH ids can address something (never /product/null/…)', () => {
    expect(urlDoAnuncioShopee(987654, null)).toBeNull(); // a draft link
    expect(urlDoAnuncioShopee(null, 1000001)).toBeNull(); // a conta never connected
    expect(urlDoAnuncioShopee(undefined, 1000001)).toBeNull();
    expect(urlDoAnuncioShopee(987654, 0)).toBeNull();
    expect(urlDoAnuncioShopee(987654, -1)).toBeNull();
    expect(urlDoAnuncioShopee(987654, 1.5)).toBeNull();
    expect(urlDoAnuncioShopee(987654, Number.NaN)).toBeNull();
    // NEAR-MISS: the right digits as a STRING are not an id the schema stores.
    expect(urlDoAnuncioShopee(987654, '1000001')).toBeNull();
    // NEAR-MISS: finite but past 2^53 — the digits would not be the stored ones.
    expect(urlDoAnuncioShopee(987654, 2 ** 53 + 2)).toBeNull();
  });
});

describe('itemIdDoAnuncioShopee', () => {
  it('prints the stored id of a published listing, and nothing for a draft', () => {
    expect(itemIdDoAnuncioShopee(1000001)).toBe(1000001);
    expect(itemIdDoAnuncioShopee(null)).toBeNull();
    expect(itemIdDoAnuncioShopee(0)).toBeNull();
    // NEAR-MISS: the digits as text are not a stored id.
    expect(itemIdDoAnuncioShopee('1000001')).toBeNull();
  });
});

describe('the estado label maps', () => {
  it('name every member of the folded vocabulary, and nothing else', () => {
    const membros = [...estadoAnuncioShopeeSchema.options].sort();
    expect(Object.keys(ROTULO_ESTADO_ANUNCIO_SHOPEE).sort()).toEqual(membros);
    expect(Object.keys(COR_ESTADO_ANUNCIO_SHOPEE).sort()).toEqual(membros);
  });

  it('reads an unknown or absent stored estado as "never folded", never as a member', () => {
    expect(estadoAnuncioShopeeLido(ESTADO_ANUNCIO_SHOPEE.emRevisao)).toBe(
      ESTADO_ANUNCIO_SHOPEE.emRevisao,
    );
    expect(estadoAnuncioShopeeLido(null)).toBeNull();
    expect(estadoAnuncioShopeeLido(undefined)).toBeNull();
    // NEAR-MISS: a string outside the vocabulary is not "removido" nor "desconhecido".
    expect(estadoAnuncioShopeeLido('arquivado')).toBeNull();
    expect(estadoAnuncioShopeeLido('Removido')).toBeNull();
  });
});

describe('formatarInstanteShopee', () => {
  it('formats a millisecond stamp in São Paulo, whatever the machine’s zone', () => {
    // 2026-10-01T03:00:00Z is São Paulo's midnight.
    expect(formatarInstanteShopee(Date.UTC(2026, 9, 1, 3, 0))).toBe('01/10/2026, 00:00');
  });

  it('answers null for anything that is not a finite number', () => {
    expect(formatarInstanteShopee(null)).toBeNull();
    expect(formatarInstanteShopee('1790823600000')).toBeNull();
    expect(formatarInstanteShopee(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('answers null — never throws — for a finite stamp outside the ECMAScript time range', () => {
    // `Intl.DateTimeFormat#format` throws a RangeError past ±8.64e15: one such
    // stored stamp would crash the whole tab mid-render.
    expect(() => formatarInstanteShopee(8.64e15 + 1)).not.toThrow();
    expect(formatarInstanteShopee(8.64e15 + 1)).toBeNull();
    expect(formatarInstanteShopee(-8.64e15 - 1)).toBeNull();
    expect(formatarInstanteShopee(Number.MAX_VALUE)).toBeNull();
  });

  it('NEAR-MISS: still formats the range’s own edges', () => {
    // +275760-09-13T00:00Z (São Paulo, UTC−3) and its mirror — the last
    // instants a Date can hold. The bound is inclusive.
    expect(formatarInstanteShopee(8.64e15)).toBe('12/09/275760, 21:00');
    expect(formatarInstanteShopee(-8.64e15)).not.toBeNull();
  });
});

describe('ordenarVinculosShopee', () => {
  const v = (id: string, data: Record<string, unknown>) => ({ id, data });
  const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

  it('lists live, then superseded, then removed, whatever the input order', () => {
    const removido = v('a-removido', {
      item_id: 1000001,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      publicadoEm: 300,
    });
    const substituido = v('b-substituido', {
      item_id: 1000002,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      substituidoPorLinkDocId: 'z-vivo',
      publicadoEm: 200,
    });
    const vivo = v('z-vivo', {
      item_id: 1000003,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      publicadoEm: 100,
    });
    expect(ids(ordenarVinculosShopee([removido, substituido, vivo]))).toEqual([
      'z-vivo',
      'b-substituido',
      'a-removido',
    ]);
  });

  it('treats a never-folded link (estadoAnuncio null) as live, and a draft (item_id null) as not', () => {
    const naoVerificado = v('b', { item_id: 1000001, estadoAnuncio: null });
    const pausado = v('c', { item_id: 1000002, estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado });
    const rascunho = v('a', { item_id: null, estadoAnuncio: null });
    expect(ids(ordenarVinculosShopee([rascunho, pausado, naoVerificado]))).toEqual(['b', 'c', 'a']);
  });

  it('takes "live" from the schemas predicate, not a web copy of it (NEAR-MISSES)', () => {
    // `anuncioShopeeVivo` tests `isFinite`, not `isSafeInteger`: an id past
    // 2^53 is still a survivor there, so it must sort with the live ones here.
    const grande = v('b-grande', { item_id: 2 ** 53 + 2, estadoAnuncio: null });
    // …and a STRINGIFIED id is NOT alive there (the recorded false-negative
    // direction), so a `Number(item_id)` copy would wrongly lift it.
    const textual = v('a-textual', { item_id: '1000001', estadoAnuncio: null });
    // A superseded link that is also removed is dead first: not "superseded".
    const substituidoMorto = v('a-subst-morto', {
      item_id: 1000004,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      substituidoPorLinkDocId: 'outro',
      publicadoEm: 999,
    });
    // An EMPTY pointer is "not superseded" for `ehVinculoSubstituido` — its id
    // sorts AFTER the superseded one's, so only the group can put it first.
    const ponteiroVazio = v('e-vazio', {
      item_id: 1000005,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      substituidoPorLinkDocId: '',
    });
    const substituido = v('d-subst', {
      item_id: 1000006,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      substituidoPorLinkDocId: 'e-vazio',
    });
    expect(
      ids(ordenarVinculosShopee([textual, substituidoMorto, substituido, ponteiroVazio, grande])),
    ).toEqual(['b-grande', 'e-vazio', 'd-subst', 'a-subst-morto', 'a-textual']);
  });

  it('within a group: most recently published first, never-published last, then the doc id', () => {
    const antigo = v('a', { item_id: 1, estadoAnuncio: null, publicadoEm: 100 });
    const recente = v('b', { item_id: 2, estadoAnuncio: null, publicadoEm: 200 });
    const semData = v('c', { item_id: 3, estadoAnuncio: null, publicadoEm: null });
    const semDataAntes = v('0', { item_id: 4, estadoAnuncio: null });
    expect(ids(ordenarVinculosShopee([semData, antigo, semDataAntes, recente]))).toEqual([
      'b',
      'a',
      '0',
      'c',
    ]);
  });

  it('returns a new array and leaves the input untouched', () => {
    const entrada = [v('b', { item_id: null }), v('a', { item_id: 1 })];
    const saida = ordenarVinculosShopee(entrada);
    expect(saida).not.toBe(entrada);
    expect(ids(entrada)).toEqual(['b', 'a']);
  });
});
