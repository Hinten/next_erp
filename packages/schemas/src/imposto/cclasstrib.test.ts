/**
 * RTC cClassTrib/CST seed + validator (#333). Pure unit tests — no XSD, no
 * crypto. Guards the structural rule, the soft "not in seed" signal, the
 * picker helpers, and seed integrity.
 */
import { describe, expect, it } from 'vitest';

import {
  CCLASSTRIB_SEED,
  CST_IBSCBS_CODES,
  CST_IBSCBS_LABELS,
  cClassTribCodesForCst,
  cClassTribDescricao,
  cClassTribEntriesForCst,
  cstClassTribStructurallyValid,
  validateCstClassTrib,
} from './cclasstrib';

describe('cstClassTribStructurallyValid', () => {
  it('accepts a well-formed pair whose cClassTrib starts with the CST', () => {
    expect(cstClassTribStructurallyValid('000', '000001')).toBe(true);
    expect(cstClassTribStructurallyValid('200', '200099')).toBe(true);
  });

  it('rejects a first-3-digit mismatch', () => {
    expect(cstClassTribStructurallyValid('000', '410001')).toBe(false);
  });

  it('rejects malformed codes', () => {
    expect(cstClassTribStructurallyValid('00', '000001')).toBe(false); // CST too short
    expect(cstClassTribStructurallyValid('000', '0001')).toBe(false); // cClassTrib too short
    expect(cstClassTribStructurallyValid('000', '00000a')).toBe(false); // non-digit
  });
});

describe('validateCstClassTrib', () => {
  it('ok for a seeded, structurally valid pair', () => {
    expect(validateCstClassTrib('000', '000001')).toEqual({ ok: true });
  });

  it('cst-mismatch for a structural violation', () => {
    expect(validateCstClassTrib('000', '410001')).toEqual({ ok: false, reason: 'cst-mismatch' });
  });

  it('not-in-table for a structurally valid code absent from the seed', () => {
    expect(validateCstClassTrib('200', '200099')).toEqual({ ok: false, reason: 'not-in-table' });
  });
});

describe('picker helpers', () => {
  it('lists every CST label code and keeps codes/labels in sync', () => {
    expect(CST_IBSCBS_CODES).toContain('000');
    expect(CST_IBSCBS_CODES).toEqual(Object.keys(CST_IBSCBS_LABELS));
    expect(CST_IBSCBS_LABELS['000']).toBe('Tributação integral');
  });

  it('suggests only the chosen CST family, and all seeds when CST is empty', () => {
    expect(cClassTribCodesForCst('000')).toContain('000001');
    expect(cClassTribCodesForCst('000').every((c) => c.startsWith('000'))).toBe(true);
    expect(cClassTribCodesForCst('410')).toEqual([]); // none seeded yet
    expect(cClassTribEntriesForCst(null)).toEqual(CCLASSTRIB_SEED);
  });

  it('resolves descriptions for seeded codes only', () => {
    expect(cClassTribDescricao('000001')).toMatch(/integralmente/);
    expect(cClassTribDescricao('999999')).toBeNull();
    expect(cClassTribDescricao(null)).toBeNull();
  });
});

describe('seed integrity', () => {
  it('every seed entry is structurally consistent (cst === cClassTrib[0:3])', () => {
    for (const e of CCLASSTRIB_SEED) {
      expect(/^\d{3}$/.test(e.cst)).toBe(true);
      expect(/^\d{6}$/.test(e.cClassTrib)).toBe(true);
      expect(e.cClassTrib.slice(0, 3)).toBe(e.cst);
      expect(e.descricao.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate cClassTrib codes', () => {
    const codes = CCLASSTRIB_SEED.map((e) => e.cClassTrib);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
