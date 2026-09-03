/**
 * Brazil timezone helpers (#395) — every case uses explicit instants and
 * explicit offsets, so the suite proves TZ-independence on ANY runner
 * (CI runs UTC; dev machines run BRT — results must be identical).
 */
import { describe, expect, it } from 'vitest';

import {
  datePartsInOffset,
  formatSefazDateTime,
  NFeTzError,
  offsetForCUF,
  offsetForUF,
  UF_UTC_OFFSET_MINUTES,
} from '../../src/generator/tz';
import { UF_SIGLA } from '@delfrance/schemas';

const SP = -180;

describe('offsetForUF / UF_UTC_OFFSET_MINUTES', () => {
  it('SP/DF/RJ are -03:00, Amazonas group -04:00, Acre -05:00', () => {
    expect(offsetForUF(UF_SIGLA.SP)).toBe(-180);
    expect(offsetForUF(UF_SIGLA.DF)).toBe(-180);
    expect(offsetForUF(UF_SIGLA.RJ)).toBe(-180);
    for (const uf of ['AM', 'MT', 'MS', 'RO', 'RR'] as const) {
      expect(offsetForUF(uf)).toBe(-240);
    }
    expect(offsetForUF(UF_SIGLA.AC)).toBe(-300);
  });

  it('covers every UF in the map (no undefined offsets)', () => {
    for (const offset of Object.values(UF_UTC_OFFSET_MINUTES)) {
      expect([-180, -240, -300]).toContain(offset);
    }
  });
});

describe('offsetForCUF', () => {
  it('resolves the chave cUF prefix (35 = SP → -03:00, 13 = AM → -04:00, 12 = AC → -05:00)', () => {
    expect(offsetForCUF('35')).toBe(-180);
    expect(offsetForCUF('13')).toBe(-240);
    expect(offsetForCUF('12')).toBe(-300);
  });

  it('throws a named error on an unknown IBGE code', () => {
    expect(() => offsetForCUF('00')).toThrow(NFeTzError);
  });
});

describe('formatSefazDateTime', () => {
  it('formats an instant in the given fixed offset (never the process TZ)', () => {
    expect(formatSefazDateTime(new Date('2026-05-20T13:30:00Z'), SP)).toBe(
      '2026-05-20T10:30:00-03:00',
    );
    expect(formatSefazDateTime(new Date('2026-05-20T13:30:00Z'), -240)).toBe(
      '2026-05-20T09:30:00-04:00',
    );
  });

  it('crosses the day boundary backwards: 01:30Z is 22:30 of the previous day in SP', () => {
    expect(formatSefazDateTime(new Date('2026-07-01T01:30:00Z'), SP)).toBe(
      '2026-06-30T22:30:00-03:00',
    );
  });

  it('crosses the year boundary: Jan 1 00:30Z is still Dec 31 in Brazil', () => {
    expect(formatSefazDateTime(new Date('2026-01-01T00:30:00Z'), SP)).toBe(
      '2025-12-31T21:30:00-03:00',
    );
  });

  it('zero-pads all components', () => {
    expect(formatSefazDateTime(new Date('2026-02-03T04:05:06Z'), SP)).toBe(
      '2026-02-03T01:05:06-03:00',
    );
  });
});

describe('datePartsInOffset ↔ formatSefazDateTime consistency (chave AAMM invariant)', () => {
  it('the AAMM derived parts always match the formatted dhEmi string', () => {
    // SEFAZ cross-checks chave AAMM against the dhEmi text — the two helpers
    // must agree for any instant/offset combination.
    const instants = [
      new Date('2026-01-01T00:30:00Z'), // year boundary
      new Date('2026-07-01T01:30:00Z'), // month boundary
      new Date('2026-05-20T13:30:00Z'), // mid-month
      new Date('2026-03-01T02:59:59Z'), // just before the -03:00 midnight
    ];
    for (const instant of instants) {
      for (const offset of [-180, -240, -300]) {
        const formatted = formatSefazDateTime(instant, offset);
        const parts = datePartsInOffset(instant, offset);
        expect(formatted.slice(0, 4)).toBe(String(parts.year));
        expect(formatted.slice(5, 7)).toBe(String(parts.month).padStart(2, '0'));
        expect(formatted.slice(8, 10)).toBe(String(parts.day).padStart(2, '0'));
      }
    }
  });
});
