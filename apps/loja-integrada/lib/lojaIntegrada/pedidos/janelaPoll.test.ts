import { MARCA_DATA_ILEGIVEL_LI } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { lerDataLi } from './dataLi';
import {
  CAMINHO_BUSCA_PEDIDOS_LI,
  FOLGA_RELOGIO_S,
  LIMITE_PEDIDOS_LI,
  LIMITE_VISTOS,
  LOOKBACK_H_MAXIMO,
  LOOKBACK_H_PADRAO,
  OPERACAO_POLL_PEDIDOS_LI,
  SOBREPOSICAO_S,
  TOLERANCIA_FILTRO_S,
  consistenciaDaJanelaLi,
  deveEnfileirarLi,
  filtroIgnoradoLi,
  janelaGrandeDemaisLi,
  lerLookbackHorasLi,
  limiteDeBootstrapLi,
  limiteDeToleranciaLi,
  maiorCursorLi,
  mesclarVistosLi,
  podarVistosLi,
  proximoCursorLi,
  queryDaJanelaLi,
  sinceDaJanelaLi,
  tetoDoCursorLi,
  vistoDaLinhaLi,
  zonaSuspeitaLi,
} from './janelaPoll';
import { MAX_PAGINAS_POLL } from './orcamentoPoll';

const HORA_S = 3_600;
/** 12:00:00.500 UTC = 09:00:00.500 in São Paulo (UTC−3, no daylight saving since 2019). */
const AGORA_MS = Date.UTC(2026, 9, 13, 12, 0, 0, 500);

/** A canonical stamp from naive text — throws on a typo, so a test never runs over `null`. */
function c(texto: string): string {
  const canonica = lerDataLi(texto);
  if (canonica === null) throw new Error(`not a stamp: ${texto}`);
  return canonica;
}

describe('the constants', () => {
  it('the overlap is 120 s for ties plus a 4 h zone margin (3 h, plus 1 h if daylight saving returns)', () => {
    expect(SOBREPOSICAO_S).toBe(14_520);
    expect(SOBREPOSICAO_S).toBe(120 + (3 + 1) * HORA_S);
  });

  it('the filter tolerance is the 4 h zone margin plus the 10 min clock slack', () => {
    expect(TOLERANCIA_FILTRO_S).toBe(15_000);
    expect(TOLERANCIA_FILTRO_S).toBe(4 * HORA_S + FOLGA_RELOGIO_S);
    expect(FOLGA_RELOGIO_S).toBe(600);
  });

  it('the look-back, the vistos cap, the requested page size and the wire names', () => {
    expect(LOOKBACK_H_PADRAO).toBe(72);
    expect(LOOKBACK_H_MAXIMO).toBe(2_160);
    expect(LIMITE_VISTOS).toBe(5_000);
    expect(LIMITE_PEDIDOS_LI).toBe(50);
    expect(CAMINHO_BUSCA_PEDIDOS_LI).toBe('/v1/pedido/search/');
    expect(OPERACAO_POLL_PEDIDOS_LI).toBe('pollPedidos');
  });

  it('a full window of the requested size fits under the vistos cap', () => {
    expect(LIMITE_PEDIDOS_LI * MAX_PAGINAS_POLL).toBeLessThanOrEqual(LIMITE_VISTOS);
  });
});

describe('lerLookbackHorasLi — fails closed, never defaults an invalid value', () => {
  it('unset and the template blank line are the default 72', () => {
    expect(lerLookbackHorasLi(undefined)).toBe(72);
    expect(lerLookbackHorasLi('')).toBe(72);
  });

  it('MATCH: a plain decimal from 1 to 2160', () => {
    expect(lerLookbackHorasLi('1')).toBe(1);
    expect(lerLookbackHorasLi('72')).toBe(72);
    expect(lerLookbackHorasLi('2160')).toBe(2_160);
  });

  it('DISTINCT: 2161, 0, a leading zero, whitespace, a sign, a fraction, an exponent → invalid', () => {
    for (const ruim of [
      '2161',
      '9999',
      '10000',
      '0',
      '00',
      '01',
      '072',
      ' ',
      ' 72',
      '72 ',
      '+72',
      '-1',
      '72.0',
      '1e2',
      '0x10',
      'setenta',
    ]) {
      expect(lerLookbackHorasLi(ruim), JSON.stringify(ruim)).toBeNull();
    }
  });
});

describe('the window bounds', () => {
  it('the bootstrap bound is now − look-back in SÃO PAULO time, to the second', () => {
    expect(limiteDeBootstrapLi(AGORA_MS, 72)).toBe('2026-10-10T09:00:00');
    // In UTC it would read 12:00 — a 3 h NARROWER window if the platform reads São Paulo.
    expect(limiteDeBootstrapLi(AGORA_MS, 72)).not.toBe('2026-10-10T12:00:00');
    expect(limiteDeBootstrapLi(AGORA_MS, 2_160)).toBe('2026-07-15T09:00:00');
    expect(limiteDeBootstrapLi(Date.UTC(2026, 0, 1, 2, 0, 0), 1)).toBe('2025-12-31T22:00:00');
  });

  it('since = cursor − overlap, on the naive fields', () => {
    expect(sinceDaJanelaLi('2026-10-13T08:15:58')).toBe('2026-10-13T04:13:58');
    expect(sinceDaJanelaLi('2026-01-01T01:00:00')).toBe('2025-12-31T20:58:00');
  });

  it('the tolerance bound = since − 4 h 10 min', () => {
    expect(limiteDeToleranciaLi('2026-10-13T04:13:58')).toBe('2026-10-13T00:03:58');
    expect(limiteDeToleranciaLi('2026-10-13T12:00:00')).toBe('2026-10-13T07:50:00');
  });

  it('the ceiling is now + 10 min in UTC, floored to the second', () => {
    expect(tetoDoCursorLi(AGORA_MS)).toBe('2026-10-13T12:10:00');
    expect(tetoDoCursorLi(Date.UTC(2026, 9, 13, 23, 55, 0, 999))).toBe('2026-10-14T00:05:00');
  });

  it('the first query: since_atualizado then limit=50, `:` sent percent-encoded', () => {
    const q = queryDaJanelaLi('2026-10-13T04:13:58');
    expect(q).toEqual({ since_atualizado: '2026-10-13T04:13:58', limit: 50 });
    expect(Object.keys(q)).toEqual(['since_atualizado', 'limit']);
    const qs = new URLSearchParams(
      Object.entries(q).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    expect(qs).toBe('since_atualizado=2026-10-13T04%3A13%3A58&limit=50');
  });
});

describe('the cursor', () => {
  const armazenado = '2026-10-13T08:00:00';

  it('advances to the max stamp, FLOORED to its second', () => {
    expect(
      proximoCursorLi({
        armazenado,
        maiorCarimbo: c('2026-10-13T08:15:58.999999'),
        agoraMs: AGORA_MS,
      }),
    ).toEqual({ cursor: '2026-10-13T08:15:58', noFuturo: false });
  });

  it('an empty window keeps the cursor', () => {
    expect(proximoCursorLi({ armazenado, maiorCarimbo: null, agoraMs: AGORA_MS })).toEqual({
      cursor: armazenado,
      noFuturo: false,
    });
  });

  it('never moves backwards', () => {
    expect(
      proximoCursorLi({
        armazenado,
        maiorCarimbo: c('2026-10-13T07:59:59.999999'),
        agoraMs: AGORA_MS,
      }).cursor,
    ).toBe(armazenado);
    expect(maiorCursorLi('2026-10-13T08:00:01', '2026-10-13T08:00:00')).toBe('2026-10-13T08:00:01');
    expect(maiorCursorLi(null, '2026-10-13T08:00:00')).toBe('2026-10-13T08:00:00');
  });

  it('a stamp exactly at the ceiling is not clamped; one second past it is (carimbo-no-futuro)', () => {
    expect(
      proximoCursorLi({
        armazenado,
        maiorCarimbo: c('2026-10-13T12:10:00.999999'),
        agoraMs: AGORA_MS,
      }),
    ).toEqual({ cursor: '2026-10-13T12:10:00', noFuturo: false });
    expect(
      proximoCursorLi({ armazenado, maiorCarimbo: c('2026-10-13T12:10:01'), agoraMs: AGORA_MS }),
    ).toEqual({ cursor: '2026-10-13T12:10:00', noFuturo: true });
  });

  it('the clamp never moves a stored cursor back either', () => {
    expect(
      proximoCursorLi({
        armazenado: '2026-10-13T13:00:00',
        maiorCarimbo: c('2026-10-14T00:00:00'),
        agoraMs: AGORA_MS,
      }),
    ).toEqual({ cursor: '2026-10-13T13:00:00', noFuturo: true });
  });

  it('zona-suspeita: a stamp later than now in São Paulo time', () => {
    expect(zonaSuspeitaLi(c('2026-10-13T09:00:00.5'), AGORA_MS)).toBe(false);
    expect(zonaSuspeitaLi(c('2026-10-13T09:00:00.500001'), AGORA_MS)).toBe(true);
    // A stamp written in UTC a minute ago reads as 3 h in São Paulo's future.
    expect(zonaSuspeitaLi(c('2026-10-13T11:59:00'), AGORA_MS)).toBe(true);
    expect(zonaSuspeitaLi(c('2026-10-13T08:59:59.999999'), AGORA_MS)).toBe(false);
  });
});

describe('vistos — what is enqueued', () => {
  const visto = c('2026-10-13T08:15:58.000000');

  it('MATCH: an equal stamp is the same change, skipped (strict >)', () => {
    expect(deveEnfileirarLi(visto, c('2026-10-13T08:15:58'))).toBe(false);
  });

  it('DISTINCT: one microsecond newer is a new change, enqueued', () => {
    expect(deveEnfileirarLi(visto, c('2026-10-13T08:15:58.000001'))).toBe(true);
  });

  it('an older stamp is skipped; a numero never seen is enqueued', () => {
    expect(deveEnfileirarLi(visto, c('2026-10-13T08:15:57.999999'))).toBe(false);
    expect(deveEnfileirarLi(undefined, visto)).toBe(true);
  });

  it('an unreadable stamp is enqueued ONCE: the marker records it', () => {
    expect(deveEnfileirarLi(undefined, null)).toBe(true);
    expect(vistoDaLinhaLi(null)).toBe(MARCA_DATA_ILEGIVEL_LI);
    expect(deveEnfileirarLi(MARCA_DATA_ILEGIVEL_LI, null)).toBe(false);
    // A row that turned unreadable after a readable version is a change.
    expect(deveEnfileirarLi(visto, null)).toBe(true);
  });

  it('a readable stamp after the marker is enqueued (the marker is never compared as text)', () => {
    // As text, '?' sorts AFTER every digit — a string compare would skip this row forever.
    expect(MARCA_DATA_ILEGIVEL_LI > visto).toBe(true);
    expect(deveEnfileirarLi(MARCA_DATA_ILEGIVEL_LI, visto)).toBe(true);
    expect(vistoDaLinhaLi(visto)).toBe(visto);
  });
});

describe('vistos — merge', () => {
  const antigo = c('2026-10-13T08:00:00');
  const novo = c('2026-10-13T09:00:00');

  it("is the union, and this run's entries win where they are newer", () => {
    expect(mesclarVistosLi({ '1': antigo, '2': antigo }, { '2': novo, '3': novo })).toEqual({
      '1': antigo,
      '2': novo,
      '3': novo,
    });
  });

  it('a fresher stored stamp is never moved back by a re-derive', () => {
    expect(mesclarVistosLi({ '2': novo }, { '2': antigo })).toEqual({ '2': novo });
  });

  it('the marker this run recorded replaces a stamp, and a stamp this run read replaces the marker', () => {
    expect(mesclarVistosLi({ '2': novo }, { '2': MARCA_DATA_ILEGIVEL_LI })).toEqual({
      '2': MARCA_DATA_ILEGIVEL_LI,
    });
    expect(mesclarVistosLi({ '2': MARCA_DATA_ILEGIVEL_LI }, { '2': antigo })).toEqual({
      '2': antigo,
    });
  });

  it('returns a new object and leaves both inputs alone', () => {
    const base = { '1': antigo };
    const novos = { '2': novo };
    const saida = mesclarVistosLi(base, novos);
    expect(saida).not.toBe(base);
    expect(base).toEqual({ '1': antigo });
    expect(novos).toEqual({ '2': novo });
  });
});

describe('vistos — prune and cap', () => {
  const since = '2026-10-13T12:00:00';
  const limite = limiteDeToleranciaLi(since); // 07:50:00

  it('MATCH: a row 3 h below since (a zone mismatch) is KEPT', () => {
    expect(podarVistosLi({ '1': c('2026-10-13T09:00:00') }, limite)).toEqual({
      '1': c('2026-10-13T09:00:00'),
    });
  });

  it('DISTINCT: a row below since − 4 h 10 min is PRUNED', () => {
    expect(podarVistosLi({ '1': c('2026-10-13T07:49:59') }, limite)).toEqual({});
  });

  it('the edge: a row exactly at the tolerance bound stays; one microsecond below goes', () => {
    expect(
      podarVistosLi(
        { '1': c('2026-10-13T07:50:00'), '2': c('2026-10-13T07:49:59.999999') },
        limite,
      ),
    ).toEqual({ '1': c('2026-10-13T07:50:00') });
  });

  it('the unreadable marker is never pruned by the bound', () => {
    expect(podarVistosLi({ '1': MARCA_DATA_ILEGIVEL_LI }, limite)).toEqual({
      '1': MARCA_DATA_ILEGIVEL_LI,
    });
  });

  /** `n` entries, one second apart from 08:00:00, numeros 1…n. */
  function muitos(n: number): Record<string, string> {
    const base = Date.UTC(2026, 9, 13, 8, 0, 0);
    const saida: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const d = new Date(base + i * 1000);
      const texto = d.toISOString().slice(0, 19);
      saida[String(i + 1)] = c(texto);
    }
    return saida;
  }

  it('MATCH: 5 000 entries are kept whole', () => {
    const v = muitos(LIMITE_VISTOS);
    expect(Object.keys(podarVistosLi(v, limite))).toHaveLength(LIMITE_VISTOS);
  });

  it('DISTINCT: 5 001 entries lose exactly the oldest one', () => {
    const v = muitos(LIMITE_VISTOS + 1);
    const podado = podarVistosLi(v, limite);
    expect(Object.keys(podado)).toHaveLength(LIMITE_VISTOS);
    expect(Object.hasOwn(podado, '1')).toBe(false);
    expect(Object.hasOwn(podado, '2')).toBe(true);
    expect(Object.hasOwn(podado, String(LIMITE_VISTOS + 1))).toBe(true);
  }, 30_000);

  it('past the cap, stamps go before the marker, and a tie goes by the lower numero', () => {
    const v = muitos(LIMITE_VISTOS - 1);
    v['900000'] = MARCA_DATA_ILEGIVEL_LI;
    // Two entries sharing the OLDEST stamp (numero 1's): the lower numero goes first.
    v['800000'] = v['1'] ?? '';
    const podado = podarVistosLi(v, limite);
    expect(Object.keys(podado)).toHaveLength(LIMITE_VISTOS);
    expect(podado['900000']).toBe(MARCA_DATA_ILEGIVEL_LI);
    expect(Object.hasOwn(podado, '1')).toBe(false);
    expect(Object.hasOwn(podado, '800000')).toBe(true);
  }, 30_000);
});

describe('the advance checks', () => {
  const limite = '2026-10-13T07:50:00';

  it('filtro-ignorado — MATCH: a row exactly at the bound is legitimate', () => {
    expect(filtroIgnoradoLi(c('2026-10-13T07:50:00'), limite)).toBe(false);
    expect(filtroIgnoradoLi(c('2026-10-13T12:00:00'), limite)).toBe(false);
  });

  it('filtro-ignorado — DISTINCT: one second (or one microsecond) below it', () => {
    expect(filtroIgnoradoLi(c('2026-10-13T07:49:59'), limite)).toBe(true);
    expect(filtroIgnoradoLi(c('2026-10-13T07:49:59.999999'), limite)).toBe(true);
  });

  it('janela-grande-demais — MATCH: total == limit × 20 still drains', () => {
    expect(janelaGrandeDemaisLi({ limit: 50, total_count: 50 * MAX_PAGINAS_POLL })).toBe(false);
    expect(janelaGrandeDemaisLi({ limit: 15, total_count: 300 })).toBe(false);
  });

  it('janela-grande-demais — DISTINCT: +1 is refused; the limit READ BACK sizes it', () => {
    expect(janelaGrandeDemaisLi({ limit: 50, total_count: 50 * MAX_PAGINAS_POLL + 1 })).toBe(true);
    // The platform answered 15 although 50 was asked: 301 rows need 21 pages.
    expect(janelaGrandeDemaisLi({ limit: 15, total_count: 301 })).toBe(true);
  });

  it('janela-grande-demais cannot be decided without a total_count', () => {
    expect(janelaGrandeDemaisLi({ limit: 50 })).toBe(false);
    expect(janelaGrandeDemaisLi({ limit: 50, total_count: null })).toBe(false);
  });

  it('janela-instavel: fewer distinct rows than the LARGEST total announced', () => {
    expect(consistenciaDaJanelaLi([2], 2)).toBe('consistente');
    expect(consistenciaDaJanelaLi([2], 1)).toBe('instavel');
    expect(consistenciaDaJanelaLi([10, undefined, 12], 11)).toBe('instavel');
    expect(consistenciaDaJanelaLi([10, null, 12], 12)).toBe('consistente');
    // More rows than announced (one was added while paging) is not a loss.
    expect(consistenciaDaJanelaLi([2], 3)).toBe('consistente');
    expect(consistenciaDaJanelaLi([0], 0)).toBe('consistente');
  });

  it('janela-instavel is skipped when no page carried a total_count', () => {
    expect(consistenciaDaJanelaLi([], 0)).toBe('sem-total');
    expect(consistenciaDaJanelaLi([undefined, null], 5)).toBe('sem-total');
  });
});
