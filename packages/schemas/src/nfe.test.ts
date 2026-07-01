import { describe, expect, it } from 'vitest';
import {
  ESTADO_NFE,
  ESTADO_NFE_LABELS,
  estadoNFeSchema,
  nfeFiscalEncerrada,
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

describe('estado labels', () => {
  it('has a label for every estado', () => {
    for (const value of Object.values(ESTADO_NFE)) {
      expect(ESTADO_NFE_LABELS[value]).toBeDefined();
      expect(estadoNFeSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe('nfeFiscalEncerrada', () => {
  it('flags cancelada and numeração-inutilizada', () => {
    expect(nfeFiscalEncerrada(ESTADO_NFE.cancelada)).toBe(true);
    expect(nfeFiscalEncerrada(ESTADO_NFE.numeracaoInutilizada)).toBe(true);
  });

  it('does not flag aprovada or any in-flight / rejected estado', () => {
    for (const value of Object.values(ESTADO_NFE)) {
      if (value === ESTADO_NFE.cancelada || value === ESTADO_NFE.numeracaoInutilizada) continue;
      expect(nfeFiscalEncerrada(value)).toBe(false);
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
