import { dataModificacaoLiSchema } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { coerceToMicros } from '@delfrance/core/datetime';

import {
  FUSO_DATAS_LI,
  canonicaDoCursorLi,
  cursorDaDataLi,
  dataLiParaMicros,
  deslocarDataLi,
  lerDataLi,
  microsDeMillisLi,
  millisDeMicrosLi,
  msIngenuoDeDataLi,
  renderizarDataLi,
} from './dataLi';

describe('lerDataLi — the canonical stamp', () => {
  it("the document's stamps are already canonical and come back unchanged", () => {
    for (const s of ['2022-10-31T12:17:58.949670', '2022-10-31T12:28:12.653648']) {
      expect(lerDataLi(s)).toBe(s);
    }
  });

  it('MATCH: a missing fraction, and a short one, equal their zero-padded forms', () => {
    expect(lerDataLi('2026-10-13T08:15:58')).toBe('2026-10-13T08:15:58.000000');
    expect(lerDataLi('2026-10-13T08:15:58')).toBe(lerDataLi('2026-10-13T08:15:58.000000'));
    expect(lerDataLi('2026-10-13T08:15:58.1')).toBe('2026-10-13T08:15:58.100000');
    expect(lerDataLi('2026-10-13T08:15:58.1')).toBe(lerDataLi('2026-10-13T08:15:58.100000'));
    expect(lerDataLi('2026-10-13T08:15:58.12345')).toBe('2026-10-13T08:15:58.123450');
  });

  it('DISTINCT: one microsecond apart, .1 vs .01, one second apart', () => {
    const pares: [string, string][] = [
      ['2026-10-13T08:15:58', '2026-10-13T08:15:58.000001'],
      ['2026-10-13T08:15:58.1', '2026-10-13T08:15:58.01'],
      ['2026-10-13T08:15:58', '2026-10-13T08:15:59'],
    ];
    for (const [a, b] of pares) {
      const ca = lerDataLi(a);
      const cb = lerDataLi(b);
      expect(ca, a).not.toBeNull();
      expect(cb, b).not.toBeNull();
      expect(ca, `${a} vs ${b}`).not.toBe(cb);
      // …and string order is time order: the earlier text sorts first.
      expect((ca ?? '') < (cb ?? ''), `${a} < ${b}`).toBe(a < b);
    }
  });

  it('string order of canonical stamps is time order where the raw texts disagree', () => {
    // Raw, `…:58.9` sorts AFTER `…:58.10`; canonical, `.900000` is later than `.100000`
    // and `.1` is EARLIER than `.10001`, as the instants are.
    const a = lerDataLi('2026-10-13T08:15:58.9') ?? '';
    const b = lerDataLi('2026-10-13T08:15:58.10') ?? '';
    expect(a > b).toBe(true);
    expect(
      (lerDataLi('2026-10-13T08:15:58.1') ?? '') < (lerDataLi('2026-10-13T08:15:58.10001') ?? ''),
    ).toBe(true);
  });

  it('REFUSED (formato-de-data): a space for the T, an offset or Z, and every other near-miss', () => {
    for (const ruim of [
      '2026-10-13 08:15:58.000000',
      '2026-10-13 08:15:58',
      '2026-10-13T08:15:58Z',
      '2026-10-13T08:15:58.000000Z',
      '2026-10-13T08:15:58+00:00',
      '2026-10-13T08:15:58.000000-03:00',
      '2026-10-13T08:15:58.0000000',
      '2026-10-13T08:15:58.',
      '2026-10-13t08:15:58',
      ' 2026-10-13T08:15:58',
      '2026-10-13T08:15:58 ',
      '2026-10-13T08:15',
      '2026-10-13',
      '2026-13-13T08:15:58',
      '2026-10-32T08:15:58',
      '2026-02-30T08:15:58',
      '2026-02-29T08:15:58',
      '2026-10-13T24:00:00',
      '2026-10-13T08:60:58',
      '2026-10-13T08:15:60',
      '0050-10-13T08:15:58',
      '',
    ]) {
      expect(lerDataLi(ruim), ruim).toBeNull();
    }
    for (const ruim of [1_667_218_678, null, undefined, {}, new Date(0), ['2026-10-13T08:15:58']]) {
      expect(lerDataLi(ruim), String(ruim)).toBeNull();
    }
  });

  it('a leap day is accepted in a leap year', () => {
    expect(lerDataLi('2028-02-29T23:59:59.5')).toBe('2028-02-29T23:59:59.500000');
  });

  it("every accepted stamp satisfies the task payload's dataModificacaoLi grammar", () => {
    for (const ok of [
      '2026-10-13T08:15:58',
      '2026-10-13T08:15:58.1',
      '2022-10-31T12:17:58.949670',
      '2028-02-29T00:00:00.000001',
      '0100-01-01T00:00:00',
    ]) {
      const canonica = lerDataLi(ok);
      expect(canonica, ok).not.toBeNull();
      expect(dataModificacaoLiSchema.safeParse(canonica).success, ok).toBe(true);
      expect(canonica?.length).toBe(26);
    }
  });
});

describe('the naive arithmetic', () => {
  it('reads the naive fields as if UTC; a cursor and its canonical stamp are the same second', () => {
    const esperado = Date.UTC(2026, 9, 13, 8, 15, 58);
    expect(msIngenuoDeDataLi('2026-10-13T08:15:58')).toBe(esperado);
    expect(msIngenuoDeDataLi('2026-10-13T08:15:58.000000')).toBe(esperado);
    // The fraction is ignored: whole seconds only.
    expect(msIngenuoDeDataLi('2026-10-13T08:15:58.999999')).toBe(esperado);
  });

  it('refuses anything that is neither a cursor nor a canonical stamp, or no real day', () => {
    for (const ruim of [
      '2026-10-13T08:15:58.1',
      '2026-10-13 08:15:58',
      '2026-02-30T00:00:00',
      '2026-04-31T00:00:00.000000',
      '0099-12-31T23:59:59',
      '',
    ]) {
      expect(msIngenuoDeDataLi(ruim), ruim).toBeNull();
    }
  });

  it('renders naive seconds, FLOORED, zero-padded', () => {
    expect(renderizarDataLi(Date.UTC(2026, 0, 2, 3, 4, 5, 999))).toBe('2026-01-02T03:04:05');
    expect(renderizarDataLi(Date.UTC(999, 11, 31, 23, 59, 59))).toBe('0999-12-31T23:59:59');
  });

  it('refuses to render outside the four-digit years it can write', () => {
    // `Date.UTC(100, …)` is the earliest year it does not remap into the 1900s.
    for (const ruim of [
      Number.NaN,
      Infinity,
      Date.UTC(10_000, 0, 1),
      Date.UTC(100, 0, 1) - 1_000,
    ]) {
      expect(() => renderizarDataLi(ruim), String(ruim)).toThrow(RangeError);
    }
  });

  it('render and read are inverse on every valid cursor', () => {
    for (const cursor of ['2026-10-13T08:15:58', '2028-02-29T00:00:00', '1999-12-31T23:59:59']) {
      expect(renderizarDataLi(msIngenuoDeDataLi(cursor) ?? Number.NaN)).toBe(cursor);
    }
  });

  it('a stamp FLOORS to its second for the cursor, and a cursor lifts to .000000', () => {
    expect(cursorDaDataLi('2026-10-13T08:15:58.999999')).toBe('2026-10-13T08:15:58');
    expect(canonicaDoCursorLi('2026-10-13T08:15:58')).toBe('2026-10-13T08:15:58.000000');
    expect(canonicaDoCursorLi(cursorDaDataLi('2026-10-13T08:15:58.000000'))).toBe(
      '2026-10-13T08:15:58.000000',
    );
  });

  it('shifts across a day, a month, a year and a leap day, on the naive fields', () => {
    expect(deslocarDataLi('2026-10-13T02:00:00', -14_520)).toBe('2026-10-12T21:58:00');
    expect(deslocarDataLi('2026-11-01T01:00:00.123456', -7_200)).toBe('2026-10-31T23:00:00');
    expect(deslocarDataLi('2026-01-01T01:00:00', -14_520)).toBe('2025-12-31T20:58:00');
    expect(deslocarDataLi('2028-03-01T02:00:00', -14_520)).toBe('2028-02-29T21:58:00');
    expect(deslocarDataLi('2026-10-13T23:55:00', 600)).toBe('2026-10-14T00:05:00');
  });

  it('a shift of an invalid text throws instead of inventing a bound', () => {
    expect(() => deslocarDataLi('2026-02-30T00:00:00', -1)).toThrow(RangeError);
    expect(() => deslocarDataLi('ontem', -1)).toThrow(RangeError);
  });
});

describe('dataLiParaMicros — the order import’s one conversion to an instant', () => {
  /** µs of a UTC wall time. */
  const us = (ano: number, mes: number, dia: number, h: number, m = 0, s = 0) =>
    Date.UTC(ano, mes, dia, h, m, s) * 1000;

  it('reads the naive stamp in America/Sao_Paulo (the inferred zone): 10:00 there is 13:00 UTC', () => {
    expect(FUSO_DATAS_LI).toBe('America/Sao_Paulo');
    expect(dataLiParaMicros('2026-10-14T10:00:00')).toBe(us(2026, 9, 14, 13));
    expect(dataLiParaMicros('2026-10-14T10:00:00.123456')).toBe(us(2026, 9, 14, 13) + 123_456);
  });

  it('⚠️ NEAR-MISS: never the UTC reading `coerceToMicros` gives an offset-less text (3 h apart)', () => {
    // The mutant "coerceToMicros on the incoming stamp" answers the UTC wall time.
    const utc = coerceToMicros('2026-10-14T10:00:00');
    expect(utc).toBe(us(2026, 9, 14, 10));
    expect(dataLiParaMicros('2026-10-14T10:00:00')).not.toBe(utc);
    expect((dataLiParaMicros('2026-10-14T10:00:00') ?? 0) - (utc ?? 0)).toBe(3 * 3600 * 1_000_000);
  });

  it('EQUAL pair: X ≡ X.000000 and .1 ≡ .100000 — the lerDataLi fold, nothing wider', () => {
    expect(dataLiParaMicros('2026-10-14T10:00:00')).toBe(
      dataLiParaMicros('2026-10-14T10:00:00.000000'),
    );
    expect(dataLiParaMicros('2026-10-14T10:00:00.1')).toBe(
      dataLiParaMicros('2026-10-14T10:00:00.100000'),
    );
  });

  it('⚠️ NEAR-MISS: one microsecond apart stays one microsecond apart', () => {
    const a = dataLiParaMicros('2026-10-14T10:00:00.000000');
    const b = dataLiParaMicros('2026-10-14T10:00:00.000001');
    expect(a).not.toBeNull();
    expect((b ?? 0) - (a ?? 0)).toBe(1);
  });

  it('refuses (null) whatever lerDataLi refuses: an offset, a Z, a space, a non-string', () => {
    for (const ruim of [
      '2026-10-14T10:00:00Z',
      '2026-10-14T10:00:00-03:00',
      '2026-10-14 10:00:00',
      '2026-02-30T10:00:00',
      '',
      null,
      1_760_000_000,
    ]) {
      expect(dataLiParaMicros(ruim), String(ruim)).toBeNull();
    }
  });
});

describe('the ms ↔ µs pair the dispatch deadline crosses', () => {
  it('EQUAL pair: a whole-ms instant survives µs → ms → µs', () => {
    const us = 1_772_550_000_123_000;
    expect(microsDeMillisLi(millisDeMicrosLi(us))).toBe(us);
  });

  it('⚠️ NEAR-MISS: the sub-ms part is dropped (floor), never rounded up; ms ≠ µs', () => {
    expect(millisDeMicrosLi(1_772_550_000_123_999)).toBe(1_772_550_000_123);
    expect(millisDeMicrosLi(1_772_550_000_123_000)).not.toBe(1_772_550_000_123_000);
    expect(microsDeMillisLi(1_772_550_000_123)).toBe(1_772_550_000_123_000);
  });
});
