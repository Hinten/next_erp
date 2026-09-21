import { describe, expect, it } from 'vitest';
import {
  CHAVE_NFE_REGEX,
  ESTADO_NFE,
  ESTADO_NFE_LABELS,
  estadoNFeSchema,
  nfeMeta,
  nfeSchema,
} from './nfe';
import { pedidoMeta } from './pedido';

const MINIMAL = {
  numeracao: 1,
  serie: 1,
  chave: null,
  idLote: null,
  infNFe: null,
  xml_nfe_proc: null,
  xml_epec_proc: null,
  xml_assinado: null,
  nRec: null,
  retries: null,
  cStat: null,
  xMotivo: null,
  justificativaContingencia: null,
  error: null,
};

describe('nfeSchema', () => {
  it('accepts a minimal valid NF-e and applies defaults', () => {
    const out = nfeSchema.parse(MINIMAL);
    expect(out).toMatchObject({
      numeracao: 1,
      serie: 1,
      tpEmis: 1,
      estado: '0',
    });
  });

  it('rejects empty chave when provided (must be null or non-empty)', () => {
    expect(nfeSchema.safeParse({ ...MINIMAL, chave: '' }).success).toBe(false);
  });

  it('rejects justificativaContingencia shorter than 15 chars', () => {
    expect(
      nfeSchema.safeParse({
        ...MINIMAL,
        justificativaContingencia: 'curto',
      }).success,
    ).toBe(false);
  });

  it('rejects justificativaContingencia > 255 chars', () => {
    expect(
      nfeSchema.safeParse({
        ...MINIMAL,
        justificativaContingencia: 'x'.repeat(256),
      }).success,
    ).toBe(false);
  });

  it('accepts a valid justificativa', () => {
    const out = nfeSchema.parse({
      ...MINIMAL,
      justificativaContingencia: 'Sefaz indisponível por falha geral.',
    });
    expect(out.justificativaContingencia).toBeTruthy();
  });

  it('rejects unknown estado value', () => {
    expect(nfeSchema.safeParse({ ...MINIMAL, estado: 'z' }).success).toBe(false);
  });

  it('rejects non-integer numeracao / serie', () => {
    expect(nfeSchema.safeParse({ ...MINIMAL, numeracao: 1.5 }).success).toBe(false);
    expect(nfeSchema.safeParse({ ...MINIMAL, serie: 1.5 }).success).toBe(false);
  });

  // Regression: Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc.
  it('rejects missing chave (must be present, even if null)', () => {
    const { chave, ...without } = MINIMAL;
    void chave;
    expect(nfeSchema.safeParse(without).success).toBe(false);
  });

  it('accepts nRec, xml_assinado and retries (the recovery fields)', () => {
    const out = nfeSchema.parse({
      ...MINIMAL,
      nRec: '351000000000000',
      xml_assinado: '<NFe>...</NFe>',
      retries: 2,
    });
    expect(out.nRec).toBe('351000000000000');
    expect(out.xml_assinado).toBe('<NFe>...</NFe>');
    expect(out.retries).toBe(2);
  });

  it('rejects negative retries', () => {
    expect(nfeSchema.safeParse({ ...MINIMAL, retries: -1 }).success).toBe(false);
  });

  it('rejects non-integer retries', () => {
    expect(nfeSchema.safeParse({ ...MINIMAL, retries: 1.5 }).success).toBe(false);
  });

  it('rejects empty xml_assinado / nRec (must be null or non-empty)', () => {
    expect(nfeSchema.safeParse({ ...MINIMAL, xml_assinado: '' }).success).toBe(false);
    expect(nfeSchema.safeParse({ ...MINIMAL, nRec: '' }).success).toBe(false);
  });
});

describe('CHAVE_NFE_REGEX', () => {
  it('matches a 44-character chave and nothing else', () => {
    expect(CHAVE_NFE_REGEX.test('1'.repeat(44))).toBe(true);
    expect(CHAVE_NFE_REGEX.test('35260514200166000187550010000000071000000018')).toBe(true);
    expect(CHAVE_NFE_REGEX.test('1'.repeat(43))).toBe(false);
    expect(CHAVE_NFE_REGEX.test('1'.repeat(45))).toBe(false);
    expect(CHAVE_NFE_REGEX.test('')).toBe(false);
  });

  // NT 2026.004 / RFB IN 2.229-2024. The alphanumeric window is the emitente
  // CNPJ's 12-character body — positions 6–17 — and nothing else.
  it('accepts letters in the CNPJ body (positions 6–17)', () => {
    const alfa = `432601PC3D315K0001${'9'.repeat(26)}`;
    expect(alfa).toHaveLength(44);
    expect(CHAVE_NFE_REGEX.test(alfa)).toBe(true);
  });

  it('rejects letters OUTSIDE that window — where SEFAZ still forbids them', () => {
    // cUF/AAMM prefix (0–5)
    expect(CHAVE_NFE_REGEX.test(`43260A${'1'.repeat(38)}`)).toBe(false);
    // the CNPJ's two check digits (18–19) and everything after
    expect(CHAVE_NFE_REGEX.test(`432601PC3D315K0001A${'9'.repeat(25)}`)).toBe(false);
    expect(CHAVE_NFE_REGEX.test(`${'1'.repeat(43)}A`)).toBe(false);
    // lowercase is never accepted
    expect(CHAVE_NFE_REGEX.test(`432601pc3d315k0001${'9'.repeat(26)}`)).toBe(false);
  });

  it('mirrors the TChNFe XSD facet byte for byte', () => {
    // ⚠️ This constant is a copy of a SEFAZ facet, so the anchor is the SCHEMA,
    // not our history: `TChNFe` in tiposBasico_v4.00.xsd. If the two ever
    // disagree we accept chaves SEFAZ rejects, or reject ones it accepts.
    expect(CHAVE_NFE_REGEX.source).toBe('^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$');
    expect(CHAVE_NFE_REGEX.flags).toBe('');
  });
});

describe('estado labels', () => {
  it('has a label for every estado', () => {
    for (const value of Object.values(ESTADO_NFE)) {
      expect(ESTADO_NFE_LABELS[value]).toBeDefined();
      expect(estadoNFeSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe('nfeMeta', () => {
  it('targets the nfev4 subcollection of pedidos', () => {
    expect(nfeMeta.collectionPath).toBe('pedidos/{pedidoId}/nfev4');
  });

  it('uses the existing nfe BigInt permission bits', () => {
    expect(nfeMeta.permissions.read).toBe(1n << 32n);
    expect(nfeMeta.permissions.write).toBe(1n << 33n);
    expect(nfeMeta.permissions.delete).toBe(1n << 34n);
  });

  it('is registered as a cascade child of pedido (deletes on parent delete)', () => {
    const entry = pedidoMeta.cascade?.find((c) => c.path === nfeMeta.collectionPath);
    expect(entry).toBeDefined();
    expect(entry?.onDelete).toBe('cascade');
  });
});
