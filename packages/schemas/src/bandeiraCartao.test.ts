import { describe, expect, it } from 'vitest';
import {
  BANDEIRA,
  BANDEIRA_LABELS,
  bandeiraCartaoMeta,
  bandeiraCartaoSchema,
  bandeiraSchema,
} from './bandeiraCartao';

const MINIMAL = {
  ehCredito: true,
  nome: 'Visa Crédito',
  cnpj_instituicao: null,
  bandeira: null,
};

describe('bandeiraCartaoSchema', () => {
  it('accepts a minimal valid bandeira and applies numeric defaults', () => {
    const out = bandeiraCartaoSchema.parse(MINIMAL);
    expect(out).toMatchObject({
      ehCredito: true,
      nome: 'Visa Crédito',
      tarifa: 0,
      tarifaFixa: 0,
      maxParcelas: 1,
      prazoRecebimento: 0,
    });
  });

  it('rejects empty nome', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, nome: '' }).success).toBe(false);
  });

  it('rejects nome > 255 chars', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, nome: 'x'.repeat(256) }).success).toBe(
      false,
    );
  });

  it('rejects cnpj_instituicao > 14 chars', () => {
    expect(
      bandeiraCartaoSchema.safeParse({
        ...MINIMAL,
        cnpj_instituicao: '1'.repeat(15),
      }).success,
    ).toBe(false);
  });

  it('rejects a PUNCTUATED cnpj_instituicao — the stored form is unpunctuated', () => {
    expect(
      bandeiraCartaoSchema.safeParse({
        ...MINIMAL,
        cnpj_instituicao: '12.345.678/0001-90',
      }).success,
    ).toBe(false);
  });

  it('accepts an ALPHANUMERIC cnpj_instituicao (RFB IN 2.229/2024)', () => {
    // `<card><CNPJ>` is the credenciadora — a COUNTERPARTY, which is exactly who
    // the Receita issues alphanumeric CNPJs to. Under the old `^\d*$` a new
    // acquirer could not be registered at all.
    expect(
      bandeiraCartaoSchema.safeParse({ ...MINIMAL, cnpj_instituicao: '12ABC34501DE35' }).success,
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS: lowercase is refused — the canonical stored form is uppercase', () => {
    expect(
      bandeiraCartaoSchema.safeParse({ ...MINIMAL, cnpj_instituicao: '12abc34501de35' }).success,
    ).toBe(false);
  });

  it('⚠️ NEAR-MISS: letters ONLY in the alfa CNPJ shape, and never in the DVs', () => {
    // No `validateCpfCnpj` refine backs this field, so the regex is the whole
    // guard — and `generator-input.ts` copies the value into `<card><CNPJ>`
    // verbatim, so anything it accepts reaches the signed XML unre-checked.
    for (const bad of ['ABCDEFGHIJKLMN', '12ABC34501DEFG', 'ABCDEFGHIJK', 'A']) {
      expect(
        bandeiraCartaoSchema.safeParse({ ...MINIMAL, cnpj_instituicao: bad }).success,
        bad,
      ).toBe(false);
    }
    // Every purely numeric value the old `\d*` took is still taken.
    for (const ok of ['', '1122233300018', '11222333000181']) {
      expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, cnpj_instituicao: ok }).success, ok).toBe(
        true,
      );
    }
  });

  it('rejects tarifa < 0', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, tarifa: -1 }).success).toBe(false);
  });

  it('rejects maxParcelas < 1', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, maxParcelas: 0 }).success).toBe(false);
  });

  it('accepts a known bandeira code', () => {
    const out = bandeiraCartaoSchema.parse({
      ...MINIMAL,
      bandeira: BANDEIRA.visa,
    });
    expect(out.bandeira).toBe('01');
  });

  it('rejects an unknown bandeira code', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, bandeira: '00' }).success).toBe(false);
  });

  // Regression: Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc.
  it('rejects missing cnpj_instituicao (must be present, even if null)', () => {
    const { cnpj_instituicao, ...without } = MINIMAL;
    void cnpj_instituicao;
    expect(bandeiraCartaoSchema.safeParse(without).success).toBe(false);
  });
});

describe('bandeira enum + labels', () => {
  it('has labels for every bandeira value', () => {
    for (const value of Object.values(BANDEIRA)) {
      expect(BANDEIRA_LABELS[value]).toBeDefined();
      expect(bandeiraSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe('bandeiraCartaoMeta', () => {
  it('targets the bandeirasCartao collection', () => {
    expect(bandeiraCartaoMeta.collectionPath).toBe('bandeirasCartao');
  });

  it('reuses the pagamento BigInt permission bits', () => {
    expect(bandeiraCartaoMeta.permissions.read).toBe(1n << 24n);
    expect(bandeiraCartaoMeta.permissions.write).toBe(1n << 25n);
    expect(bandeiraCartaoMeta.permissions.delete).toBe(1n << 26n);
  });
});
