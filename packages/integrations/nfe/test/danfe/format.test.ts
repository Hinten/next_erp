import { describe, expect, it } from 'vitest';

import {
  cmToPt,
  cutString,
  formatCep,
  formatChaveAcesso,
  formatCpfCnpj,
  formatDate,
  formatMoney,
  formatNNF,
  formatQty,
  formatSerie,
  formatTelefone,
  formatTime,
  formatTimeSeconds,
  freteLabel,
  NFeDanfeFormatError,
  onlyDigits,
} from '../../src/danfe/format';
import { CHAVE } from './fixtures';

describe('danfe/format', () => {
  it('groups the 44-digit chave into eleven blocks of four', () => {
    const grouped = formatChaveAcesso(CHAVE);
    expect(grouped).toBe('3526 0514 2001 6600 0187 5500 1000 0000 0710 0000 0018');
    expect(grouped.split(' ')).toHaveLength(11);
    expect(onlyDigits(grouped)).toBe(CHAVE);
  });

  it('masks CPF (11) and CNPJ (14); falls back to raw otherwise', () => {
    expect(formatCpfCnpj('12345678909')).toBe('123.456.789-09');
    expect(formatCpfCnpj('14200166000187')).toBe('14.200.166/0001-87');
    expect(formatCpfCnpj('123')).toBe('123');
  });

  it('formats CEP and phone numbers', () => {
    expect(formatCep('01001000')).toBe('01001-000');
    expect(formatCep('123')).toBe('123');
    expect(formatTelefone('1133224455')).toBe('(11) 3322-4455');
    expect(formatTelefone('11933224455')).toBe('(11) 93322-4455');
  });

  it('NEVER strips a country code from a phone — a DANFE shows the signed value', () => {
    // The ERP's own display formatter (`@delfrance/core/phone`'s
    // `formatTelefone`) DOES strip `55`, because that is how a cliente's
    // telefone is stored. `fone` here comes from a signed XML in SEFAZ's shape
    // (6-14 digits, no country code), so it must pass through untouched — and
    // DDD 55 (Santa Maria/RS) means a 12-digit `55…` is not impossible.
    expect(formatTelefone('5511933224455')).toBe('5511933224455');
    expect(formatTelefone('551133224455')).toBe('551133224455');
  });

  it('formats money pt-BR with two decimals and no symbol', () => {
    expect(formatMoney('1234.56')).toBe('1.234,56');
    expect(formatMoney('0')).toBe('0,00');
    expect(formatMoney(1000000)).toBe('1.000.000,00');
    expect(formatMoney('')).toBe('');
    expect(formatMoney('abc')).toBe('abc');
  });

  it('formats quantity, número and série', () => {
    expect(formatQty('2.5')).toBe('2,5');
    expect(formatNNF('7')).toBe('000.000.007');
    expect(formatNNF('123456789')).toBe('123.456.789');
    expect(formatSerie('1')).toBe('001');
  });

  it('renders dates/times exactly as stamped in the lexical (SP offset)', () => {
    expect(formatDate('2026-05-26T15:25:00-03:00')).toBe('26/05/2026');
    expect(formatTimeSeconds('2026-05-26T15:30:12-03:00')).toBe('15:30:12');
    expect(formatTime('2026-05-26T15:30:12-03:00')).toBe('15:30');
  });

  it("renders a -04:00 issuer's own wall-clock, not São Paulo time (#418)", () => {
    // An AM/MT filial emitting 23:30 local: the old SP-pinned Intl rendered
    // this instant as 00:30 on 01/07 — a visible XML↔DANFE mismatch across a
    // calendar date. The document must say what the XML says.
    expect(formatDate('2026-06-30T23:30:00-04:00')).toBe('30/06/2026');
    expect(formatTime('2026-06-30T23:30:00-04:00')).toBe('23:30');
    expect(formatTimeSeconds('2026-06-30T23:30:00-04:00')).toBe('23:30:00');
  });

  it('renders a date-only dVenc as the wire date (#418 — was one day EARLY)', () => {
    // JS parses date-only ISO as UTC midnight; the old SP-pinned Intl shifted
    // it -3h → every DANFE duplicata due date printed a day early ('14/08').
    expect(formatDate('2026-08-15')).toBe('15/08/2026');
  });

  it('zero-pads day/month (fiscal-document form, matches the wire)', () => {
    expect(formatDate('2026-03-05T08:00:00-03:00')).toBe('05/03/2026');
  });

  it('throws a named error on a non-SEFAZ lexical or a missing time part', () => {
    expect(() => formatDate('26/05/2026')).toThrow(NFeDanfeFormatError);
    expect(() => formatDate('garbage')).toThrow(/garbage/);
    expect(() => formatTime('2026-08-15')).toThrow(NFeDanfeFormatError);
    expect(() => formatTimeSeconds('2026-08-15')).toThrow(/no time part/);
  });

  it('fails LOUD on impossible dates and junk suffixes (never prints nonsense)', () => {
    // The old Intl path threw on these too — a fiscal document must fail to
    // render rather than print a garbage month/day from a corrupted doc.
    expect(() => formatDate('2026-13-45')).toThrow(NFeDanfeFormatError);
    expect(() => formatDate('2026-00-10')).toThrow(NFeDanfeFormatError);
    expect(() => formatDate('2026-08-15junk')).toThrow(NFeDanfeFormatError);
    expect(() => formatDate('2026-08-15T15:30:12.000Z')).toThrow(NFeDanfeFormatError);
    expect(() => formatTime('2026-08-15T25:00:00-03:00')).toThrow(NFeDanfeFormatError);
  });

  it('stays lenient where harmless: +00:00 legacy stamps and offset-less datetimes render', () => {
    // Pre-#415 UTC deploys stamped dhEmi with +00:00 — render that wall-clock
    // as written. An offset-less datetime never legally occurs on the wire,
    // but slicing it is unambiguous, so it renders rather than throwing.
    expect(formatDate('2026-05-20T10:30:00+00:00')).toBe('20/05/2026');
    expect(formatTimeSeconds('2026-05-20T10:30:00+00:00')).toBe('10:30:00');
    expect(formatTime('2026-05-26T15:25:00')).toBe('15:25');
  });

  it('labels modalidade do frete and truncates strings', () => {
    expect(freteLabel('0')).toBe('0 - REM. (CIF)');
    expect(freteLabel('9')).toBe('9 - SEM FRETE');
    expect(freteLabel('x')).toBe('');
    expect(cutString('abcdef', 3)).toBe('abc');
    expect(cutString('ab', 3)).toBe('ab');
  });

  it('converts centimetres to points', () => {
    expect(cmToPt(1)).toBeCloseTo(28.3465, 3);
    expect(cmToPt(10)).toBeCloseTo(283.465, 2);
  });
});
