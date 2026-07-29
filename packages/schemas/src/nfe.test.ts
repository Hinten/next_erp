import { describe, expect, it } from 'vitest';
import {
  CHAVE_NFE_REGEX,
  ESTADO_NFE,
  ESTADO_NFE_LABELS,
  estadoNFeSchema,
  ML_ENVIO_ESTADO,
  mlEnvioEstadoSchema,
  mlEnvioSchema,
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

describe('mlEnvio (Step 12 ML invoice-upload marker, #739)', () => {
  const FULL_ML_ENVIO = {
    estado: ML_ENVIO_ESTADO.enviado,
    tentativas: 3,
    shipmentId: '44123456789',
    motivo: null,
    ultimoErro: 'HTTP 500 from ML',
    ultimoErroCodigo: '500',
    atualizadoEm: 1_753_000_000_000,
  };

  it('parses a pre-Step-12 doc with mlEnvio absent (read-tolerance)', () => {
    const out = nfeSchema.parse(MINIMAL);
    expect(out.mlEnvio).toBeUndefined();
  });

  it('accepts mlEnvio: null', () => {
    const out = nfeSchema.parse({ ...MINIMAL, mlEnvio: null });
    expect(out.mlEnvio).toBeNull();
  });

  it('roundtrips a full mlEnvio block on the NF-e doc', () => {
    const out = nfeSchema.parse({ ...MINIMAL, mlEnvio: FULL_ML_ENVIO });
    expect(out.mlEnvio).toEqual(FULL_ML_ENVIO);
  });

  it('applies defaults on a minimal mlEnvio block (estado only)', () => {
    const out = mlEnvioSchema.parse({ estado: ML_ENVIO_ESTADO.pendente });
    expect(out).toEqual({
      estado: ML_ENVIO_ESTADO.pendente,
      tentativas: 0,
      shipmentId: null,
      motivo: null,
      ultimoErro: null,
      ultimoErroCodigo: null,
      atualizadoEm: null,
    });
  });

  it('rejects an unknown estado, negative/non-integer tentativas, empty shipmentId', () => {
    const base = { estado: ML_ENVIO_ESTADO.pendente };
    expect(mlEnvioSchema.safeParse({ estado: 'ok' }).success).toBe(false);
    expect(mlEnvioSchema.safeParse({ ...base, tentativas: -1 }).success).toBe(false);
    expect(mlEnvioSchema.safeParse({ ...base, tentativas: 1.5 }).success).toBe(false);
    expect(mlEnvioSchema.safeParse({ ...base, shipmentId: '' }).success).toBe(false);
  });

  it('ML_ENVIO_ESTADO members match the enum exactly (both directions)', () => {
    expect(Object.values(ML_ENVIO_ESTADO).sort()).toEqual([...mlEnvioEstadoSchema.options].sort());
    for (const value of Object.values(ML_ENVIO_ESTADO)) {
      expect(mlEnvioEstadoSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe('CHAVE_NFE_REGEX', () => {
  it('matches exactly 44 digits and nothing else', () => {
    expect(CHAVE_NFE_REGEX.test('1'.repeat(44))).toBe(true);
    expect(CHAVE_NFE_REGEX.test('35260514200166000187550010000000071000000018')).toBe(true);
    expect(CHAVE_NFE_REGEX.test('1'.repeat(43))).toBe(false);
    expect(CHAVE_NFE_REGEX.test('1'.repeat(45))).toBe(false);
    expect(CHAVE_NFE_REGEX.test(`${'1'.repeat(43)}A`)).toBe(false);
    expect(CHAVE_NFE_REGEX.test('')).toBe(false);
  });

  it('stays byte-identical to the historical inline pattern', () => {
    // Several call sites (pedido pageModel, UI inputs) replaced an inline
    // /^\d{44}$/ with this constant — keep the source stable so behavior
    // (and any future rules-gen consumption) never drifts.
    expect(CHAVE_NFE_REGEX.source).toBe('^\\d{44}$');
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
