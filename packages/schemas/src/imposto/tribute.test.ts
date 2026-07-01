import { describe, expect, it } from 'vitest';
import {
  CSOSN_LABELS,
  CST_ICMS_LABELS,
  CST_PIS_COFINS_LABELS,
  configuracaoIBSCBSSchema,
  configuracaoICMSSchema,
  impostoSchema,
  taxConfigFields,
} from './tribute';

describe('configuracaoICMSSchema — Simples Nacional', () => {
  it('round-trips a CSOSN 101 config (com crédito)', () => {
    const cfg = { crt: '1', csosn: '101', csosn101: { pCredSN: 1.5, vCredICMSSN: 2 } };
    expect(configuracaoICMSSchema.parse(cfg)).toEqual(cfg);
  });

  it('round-trips a bare CSOSN 102 (no sub-config)', () => {
    const cfg = { crt: '1', csosn: '102' };
    expect(configuracaoICMSSchema.parse(cfg)).toEqual(cfg);
  });

  it('rejects an invalid CRT', () => {
    expect(configuracaoICMSSchema.safeParse({ crt: '9', csosn: '102' }).success).toBe(false);
  });
});

describe('configuracaoICMSSchema — Regime Normal (lossless storage, #312 deferred)', () => {
  it('round-trips a CST 00 config (icms00)', () => {
    const cfg = {
      crt: '3',
      csosn: null,
      cst: '00',
      icms00: { modBC: '3', vBC: 100, pICMS: 18, vICMS: 18 },
    };
    expect(configuracaoICMSSchema.parse(cfg)).toEqual(cfg);
  });

  it('round-trips a CST 20 config with redução + desoneração (motDesICMS as int)', () => {
    const cfg = {
      crt: '3',
      csosn: null,
      cst: '20',
      icms20: {
        modBC: '0',
        pRedBC: 30,
        vBC: 70,
        pICMS: 18,
        vICMS: 12.6,
        vICMSDeson: 5,
        motDesICMS: 9,
      },
    };
    expect(configuracaoICMSSchema.parse(cfg)).toEqual(cfg);
  });
});

describe('impostoSchema — per-item Imposto', () => {
  it('parses origem + ICMS + PIS + COFINS', () => {
    const imp = {
      origem: '0',
      cfop: '5102',
      configuracaoICMS: { crt: '1', csosn: '102' },
      configuracaoPIS: { CST: '01', pPIS: 1.65 },
      configuracaoCOFINS: { CST: '01', pCOFINS: 7.6 },
    };
    const parsed = impostoSchema.parse(imp);
    expect(parsed.origem).toBe('0');
    expect(parsed.configuracaoPIS?.pPIS).toBe(1.65);
  });

  it('holds configuracaoIBSCBS leniently (a PARTIAL RTC blob parses verbatim)', () => {
    const imp = { origem: '0', configuracaoIBSCBS: { CST: '000' } };
    const parsed = impostoSchema.parse(imp);
    // z.unknown — the half-filled blob survives, the strict check is at emit.
    expect(parsed.configuracaoIBSCBS).toEqual({ CST: '000' });
  });

  it('rejects a non-4-digit CFOP', () => {
    expect(impostoSchema.safeParse({ origem: '0', cfop: '510' }).success).toBe(false);
  });
});

describe('configuracaoIBSCBSSchema — Reforma Tributária', () => {
  it('validates a complete IBS/CBS group', () => {
    const rtc = { CST: '000', cClassTrib: '000000', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 };
    expect(configuracaoIBSCBSSchema.parse(rtc)).toMatchObject(rtc);
  });

  it('rejects an IS group with neither ad-valorem nor per-unit rate', () => {
    const rtc = {
      CST: '000',
      cClassTrib: '000000',
      pIBSUF: 0.1,
      pIBSMun: 0,
      pCBS: 0.9,
      is: { CSTIS: '000', cClassTribIS: '000000' },
    };
    expect(configuracaoIBSCBSSchema.safeParse(rtc).success).toBe(false);
  });

  // CST↔cClassTrib structural rule (#333)
  it('accepts the confirmed tributação-integral pair (000 / 000001)', () => {
    const rtc = { CST: '000', cClassTrib: '000001', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 };
    expect(configuracaoIBSCBSSchema.safeParse(rtc).success).toBe(true);
  });

  it('accepts a structurally valid code not in the vendored seed (lenient membership)', () => {
    // 200099 is structurally valid for CST 200 but isn't seeded — must NOT be
    // rejected (membership is a UI warning only, never an emit-time block).
    const rtc = { CST: '200', cClassTrib: '200099', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 };
    expect(configuracaoIBSCBSSchema.safeParse(rtc).success).toBe(true);
  });

  it('rejects when cClassTrib first 3 digits ≠ CST', () => {
    const rtc = { CST: '000', cClassTrib: '410001', pIBSUF: 0.1, pIBSMun: 0, pCBS: 0.9 };
    const res = configuracaoIBSCBSSchema.safeParse(rtc);
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) => i.path.join('.') === 'cClassTrib');
      expect(issue?.message).toMatch(/3 primeiros dígitos/);
    }
  });
});

describe('taxConfigFields — shared storage fragment', () => {
  it('every config field is optional (an Imposto-bearing doc may omit them all)', () => {
    // A z.object built only from taxConfigFields accepts {} (all configs absent).
    const result = configuracaoICMSSchema.safeParse;
    expect(typeof result).toBe('function');
    // The fragment itself: each entry parses `null` and `undefined`.
    for (const field of Object.values(taxConfigFields)) {
      expect(field.safeParse(null).success).toBe(true);
      expect(field.safeParse(undefined).success).toBe(true);
    }
  });
});

describe('UI label maps', () => {
  it('exposes CSOSN, Regime Normal CST and PIS/COFINS CST labels', () => {
    expect(CSOSN_LABELS['101']).toContain('101');
    expect(CST_ICMS_LABELS['00']).toContain('00');
    expect(CST_PIS_COFINS_LABELS['01']).toContain('01');
  });
});
