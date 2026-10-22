import { describe, expect, it } from 'vitest';

import {
  LOOKBACK_POLL_ENV_AMAZON,
  LOOKBACK_POLL_H_MAXIMO,
  LOOKBACK_POLL_H_PADRAO,
  ancoraDoBootstrapMs,
  deveEnfileirar,
  isoSegundosZ,
  lerInstanteAmazon,
  lerLinhaPollAmazon,
  lerLookbackHorasAmazon,
  limiteInferior,
  mesclarVistos,
  pendenteRetomavel,
  podarVistos,
  proximoCursorMs,
} from './janelaPoll';
import { CAP_INICIO_MS, JANELA_VISTOS_MS, MAX_VISTOS, VIDA_TOKEN_MS } from './orcamentoPoll';

const T10 = Date.UTC(2027, 0, 15, 10, 0, 0);
const PEDIDO = '171-2345678-9012345';

describe('isoSegundosZ / limiteInferior', () => {
  it('floors to the whole second, UTC, Z', () => {
    expect(isoSegundosZ(T10)).toBe('2027-01-15T10:00:00Z');
    expect(isoSegundosZ(T10 + 999)).toBe('2027-01-15T10:00:00Z');
    expect(isoSegundosZ(T10 + 1000)).toBe('2027-01-15T10:00:01Z');
    expect(isoSegundosZ(T10 - 1)).toBe('2027-01-15T09:59:59Z');
  });

  it('a fresh window starts ten minutes before the cursor', () => {
    expect(limiteInferior(T10)).toBe('2027-01-15T09:50:00Z');
    expect(limiteInferior(T10 + 59_999)).toBe('2027-01-15T09:50:59Z');
  });

  it('refuses what is not a non-negative safe integer — a null cursor never becomes 1969', () => {
    for (const ruim of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, null as unknown]) {
      expect(() => isoSegundosZ(ruim as number), String(ruim)).toThrow(TypeError);
    }
    // In JS, null − 600 000 is −600 000: the window algebra refuses it too.
    expect(() => limiteInferior(null as unknown as number)).toThrow(TypeError);
  });
});

describe('lerInstanteAmazon — the fold SCOPE: equal instants fold, a later one does not', () => {
  it('Z, .000Z and -03:00 are the same instant; .001Z is not (never a string compare)', () => {
    const a = lerInstanteAmazon('2027-01-15T10:00:00Z');
    const b = lerInstanteAmazon('2027-01-15T10:00:00.000Z');
    const c = lerInstanteAmazon('2027-01-15T07:00:00-03:00');
    const d = lerInstanteAmazon('2027-01-15T10:00:00.001Z');
    expect(a).toEqual({ us: T10 * 1000, ms: T10 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d?.us).toBe(T10 * 1000 + 1000);
    expect(d?.us).not.toBe(a?.us);
  });

  it('keeps sub-millisecond digits in µs: two changes in one millisecond stay distinct', () => {
    const x = lerInstanteAmazon('2027-01-15T10:00:00.000001Z');
    const y = lerInstanteAmazon('2027-01-15T10:00:00.000002Z');
    expect(x?.ms).toBe(y?.ms);
    expect(x?.us).not.toBe(y?.us);
    expect(deveEnfileirar(x?.us, y?.us ?? 0)).toBe(true);
  });

  it('an offset-less, a date-only or a garbled stamp is refused (null)', () => {
    for (const ruim of [
      '2027-01-15T10:00:00',
      '2027-01-15T10:00:00.000',
      '2027-01-15',
      '2027-01-15T10:00Z',
      '15/01/2027 10:00:00',
      '2027-01-15T10:00:00 Z',
      '',
      '1969-12-31T23:59:59Z',
    ]) {
      expect(lerInstanteAmazon(ruim), ruim).toBeNull();
    }
    // Near-misses that ARE accepted: a compact offset, a lowercase z.
    expect(lerInstanteAmazon('2027-01-15T07:00:00-0300')?.ms).toBe(T10);
    expect(lerInstanteAmazon('2027-01-15T10:00:00z')?.ms).toBe(T10);
  });
});

describe('lerLinhaPollAmazon', () => {
  it('reads orderId and lastUpdatedTime, in both units, and nothing else', () => {
    expect(
      lerLinhaPollAmazon({
        orderId: PEDIDO,
        lastUpdatedTime: '2027-01-15T10:00:00.5Z',
        buyer: { buyerName: 'x' },
      }),
    ).toEqual({ orderId: PEDIDO, lastUpdatedUs: T10 * 1000 + 500_000, lastUpdatedMs: T10 + 500 });
  });

  it('an invalid row is null: no orderId, a bad orderId, an offset-less stamp, not an object', () => {
    for (const ruim of [
      null,
      'x',
      [PEDIDO],
      { lastUpdatedTime: '2027-01-15T10:00:00Z' },
      { orderId: '171-2345678-901234', lastUpdatedTime: '2027-01-15T10:00:00Z' },
      { orderId: PEDIDO },
      { orderId: PEDIDO, lastUpdatedTime: '2027-01-15T10:00:00' },
      { orderId: PEDIDO, lastUpdatedTime: 1_800_000_000_000 },
    ]) {
      expect(lerLinhaPollAmazon(ruim), JSON.stringify(ruim)).toBeNull();
    }
  });

  it('a getter is never invoked', () => {
    let lido = false;
    const linha = Object.defineProperty({ lastUpdatedTime: '2027-01-15T10:00:00Z' }, 'orderId', {
      get: () => {
        lido = true;
        return PEDIDO;
      },
      enumerable: true,
    });
    expect(lerLinhaPollAmazon(linha)).toBeNull();
    expect(lido).toBe(false);
  });
});

describe('proximoCursorMs — forward only, capped at the drain start − 5 min', () => {
  const inicio = T10 + 3_600_000;

  it('an empty window keeps the stored cursor', () => {
    expect(
      proximoCursorMs({ armazenadoMs: T10, maiorLinhaMs: null, inicioDrenagemMs: inicio }),
    ).toBe(T10);
  });

  it('advances to the max row when it is before the cap', () => {
    expect(
      proximoCursorMs({ armazenadoMs: T10, maiorLinhaMs: T10 + 60_000, inicioDrenagemMs: inicio }),
    ).toBe(T10 + 60_000);
  });

  it('never passes the drain start − 5 min, even when the max row is later', () => {
    expect(
      proximoCursorMs({ armazenadoMs: T10, maiorLinhaMs: inicio + 1, inicioDrenagemMs: inicio }),
    ).toBe(inicio - CAP_INICIO_MS);
  });

  it('never moves back', () => {
    expect(
      proximoCursorMs({ armazenadoMs: T10, maiorLinhaMs: T10 - 1, inicioDrenagemMs: inicio }),
    ).toBe(T10);
  });
});

describe('pendenteRetomavel — the token lives 23 h', () => {
  const pendente = {
    paginationToken: 't',
    lastUpdatedAfter: '2027-01-15T09:50:00Z',
    marketplaceIds: 'A2Q3Y263D00KWC',
    inicioDrenagemMs: T10,
    tokenEmMs: T10,
    paginas: 5,
    linhaInvalida: false,
    maiorLinhaMs: null,
  };

  it('kept 1 ms before 23 h, discarded at 23 h and at 23 h + 1 ms', () => {
    expect(pendenteRetomavel(pendente, T10 + VIDA_TOKEN_MS - 1)).toBe(true);
    expect(pendenteRetomavel(pendente, T10 + VIDA_TOKEN_MS)).toBe(false);
    expect(pendenteRetomavel(pendente, T10 + VIDA_TOKEN_MS + 1)).toBe(false);
  });

  it('a null token (page 1 of the stored window) is always resumable', () => {
    expect(pendenteRetomavel({ ...pendente, paginationToken: null }, T10 + 30 * 86_400_000)).toBe(
      true,
    );
  });
});

describe('vistos', () => {
  it('deveEnfileirar: only a NEWER stamp; the same one is the same change', () => {
    expect(deveEnfileirar(undefined, 5)).toBe(true);
    expect(deveEnfileirar(5, 6)).toBe(true);
    expect(deveEnfileirar(5, 5)).toBe(false);
    expect(deveEnfileirar(5, 4)).toBe(false);
  });

  it('mesclarVistos: the newer stamp wins per order, the base untouched', () => {
    const base = { a: 10, b: 20 };
    expect(mesclarVistos(base, { b: 15, c: 30, a: 11 })).toEqual({ a: 11, b: 20, c: 30 });
    expect(base).toEqual({ a: 10, b: 20 });
  });

  it('podarVistos: drops rows older than cursor − 25 min, keeps the boundary', () => {
    const cursor = T10;
    const limite = cursor - JANELA_VISTOS_MS;
    const podado = podarVistos(
      {
        '111-1111111-1111111': limite * 1000,
        '222-2222222-2222222': limite * 1000 - 1000,
        '333-3333333-3333333': limite * 1000 + 999,
      },
      cursor,
    );
    expect(Object.keys(podado).sort()).toEqual(['111-1111111-1111111', '333-3333333-3333333']);
  });

  it('podarVistos: at most MAX_VISTOS, the OLDEST dropped first', () => {
    const vistos: Record<string, number> = {};
    for (let i = 0; i < MAX_VISTOS + 3; i += 1) {
      vistos[`100-0000000-${String(i).padStart(7, '0')}`] = T10 * 1000 + i;
    }
    const podado = podarVistos(vistos, T10);
    expect(Object.keys(podado)).toHaveLength(MAX_VISTOS);
    for (const i of [0, 1, 2]) {
      expect(podado[`100-0000000-${String(i).padStart(7, '0')}`], String(i)).toBeUndefined();
    }
    expect(podado[`100-0000000-${String(MAX_VISTOS + 2).padStart(7, '0')}`]).toBeDefined();
  });
});

describe('the look-back — fails closed, never defaults an invalid value', () => {
  it('names the variable and the planned bounds', () => {
    expect(LOOKBACK_POLL_ENV_AMAZON).toBe('AMAZON_POLL_LOOKBACK_H');
    expect(LOOKBACK_POLL_H_PADRAO).toBe(24);
    expect(LOOKBACK_POLL_H_MAXIMO).toBe(720);
  });

  it('unset or empty is the default', () => {
    expect(lerLookbackHorasAmazon(undefined)).toBe(24);
    expect(lerLookbackHorasAmazon('')).toBe(24);
  });

  it('accepts 1 to 720 plain hours', () => {
    expect(lerLookbackHorasAmazon('1')).toBe(1);
    expect(lerLookbackHorasAmazon('72')).toBe(72);
    expect(lerLookbackHorasAmazon('720')).toBe(720);
  });

  it.each([
    ['0'],
    ['721'],
    ['9999'],
    ['10000'],
    ['024'],
    [' 24'],
    ['24 '],
    ['   '],
    ['-24'],
    ['+24'],
    ['24h'],
    ['2.5'],
    ['1e2'],
    ['0x18'],
  ])('%j is INVALID (null), never the default', (ruim) => {
    expect(lerLookbackHorasAmazon(ruim)).toBeNull();
  });

  it('the bootstrap anchor is agora − horas', () => {
    expect(ancoraDoBootstrapMs(T10, 24)).toBe(T10 - 24 * 3_600_000);
  });
});
