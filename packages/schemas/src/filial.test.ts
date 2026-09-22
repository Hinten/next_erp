import { describe, expect, it } from 'vitest';
import { filialFormSchema, filialMeta, filialSchema } from './filial';

const VALID_ENDERECO = {
  logradouro: 'Av. Paulista',
  numero: '1000',
  cep: '01310100',
  cidade: 'São Paulo',
  estado: 'SP' as const,
};

const MINIMAL_FILIAL = {
  razaoSocial: 'Empresa Exemplo LTDA',
  fantasia: null,
  cnae: null,
  cnpj: '12345678000190',
  ie: '123456789',
  iest: null,
  imun: null,
  sede: VALID_ENDERECO,
};

describe('filialSchema', () => {
  it('accepts a minimal valid filial', () => {
    const out = filialSchema.parse(MINIMAL_FILIAL);
    expect(out.razaoSocial).toBe('Empresa Exemplo LTDA');
    expect(out.cnpj).toBe('12345678000190');
    expect(out.sede.cidade).toBe('São Paulo');
  });

  it('rejects empty razaoSocial', () => {
    expect(filialSchema.safeParse({ ...MINIMAL_FILIAL, razaoSocial: '' }).success).toBe(false);
  });

  it('rejects razaoSocial > 1000 chars', () => {
    expect(
      filialSchema.safeParse({
        ...MINIMAL_FILIAL,
        razaoSocial: 'x'.repeat(1001),
      }).success,
    ).toBe(false);
  });

  it('rejects fantasia > 1000 chars', () => {
    expect(
      filialSchema.safeParse({
        ...MINIMAL_FILIAL,
        fantasia: 'x'.repeat(1001),
      }).success,
    ).toBe(false);
  });

  it('rejects cnpj > 18 chars', () => {
    expect(
      filialSchema.safeParse({
        ...MINIMAL_FILIAL,
        cnpj: '1'.repeat(19),
      }).success,
    ).toBe(false);
  });

  it('rejects punctuation in cnpj, and letters in ie', () => {
    expect(filialSchema.safeParse({ ...MINIMAL_FILIAL, cnpj: '12.345.678' }).success).toBe(false);
    // ⚠️ `ie` stays digits-only on purpose — Inscrição Estadual is a STATE
    // register and is untouched by RFB IN 2.229/2024. Only `cnpj` widened.
    expect(filialSchema.safeParse({ ...MINIMAL_FILIAL, ie: 'ABCD' }).success).toBe(false);
  });

  /**
   * CNPJ alfanumérico on our own emitente (RFB IN 2.229/2024 · #1619).
   *
   * ⚠️ The shape is `[0-9A-Z]{12}[0-9]{2}`, never `[0-9A-Z]{14}` — the two
   * check digits stay numeric — and never the wider `^[0-9A-Z]*$` that
   * `cliente.cpf_cnpj` uses, which only works there because a
   * `validateCpfCnpj` refine sits behind it.
   */
  describe('cnpj alfanumérico', () => {
    const comCnpj = (cnpj: string) => filialSchema.safeParse({ ...MINIMAL_FILIAL, cnpj }).success;

    it('accepts an alphanumeric CNPJ, and still accepts a numeric one', () => {
      expect(comCnpj('12ABC34501DE35')).toBe(true);
      expect(comCnpj('PC3D315K000193')).toBe(true);
      expect(comCnpj('12345678000190')).toBe(true);
    });

    /**
     * ⚠️ The near-miss that matters most. This regex IS the canonical-form
     * guarantee, not just input validation: `inutilizar.ts` compares
     * `chave.slice(6, 20) === filial.cnpj` as an OWNERSHIP check and
     * `filial-cert.ts` runs `where('cnpj', '==', …)`, both byte-exact against a
     * value the XSD facet guarantees is uppercase. A lowercase row answers
     * "not ours" / resolves no certificate, and neither failure names the case
     * mismatch as its cause.
     */
    it('rejects lowercase — the stored form must be canonical', () => {
      expect(comCnpj('12abc34501de35')).toBe(false);
      expect(comCnpj('12ABC34501de35')).toBe(false);
    });

    it('rejects a letter in either check-digit position', () => {
      expect(comCnpj('12ABC34501DEF5')).toBe(false);
      expect(comCnpj('12ABC34501DE3F')).toBe(false);
    });

    it('rejects a punctuated alphanumeric CNPJ', () => {
      expect(comCnpj('12.ABC.345/01DE-35')).toBe(false);
    });

    it('accepts a bad check digit — the CHECKSUM lives on filialFormSchema', () => {
      // Read-tolerance (root CLAUDE.md rule 8): `filialSchema` is also the read
      // schema, and the old `CnpjInput` truncated pasted alfa values, so a
      // short/invalid row may already be stored. It must still parse.
      expect(comCnpj('12ABC34501DE99')).toBe(true);
      expect(comCnpj('123450135')).toBe(true);
    });
  });

  describe('filialFormSchema — the write-side checksum', () => {
    const salva = (cnpj: string) => filialFormSchema.safeParse({ ...MINIMAL_FILIAL, cnpj }).success;

    // ⚠️ `MINIMAL_FILIAL.cnpj` ('12345678000190') is itself checksum-INVALID,
    // so every case here overrides it. That is not an oversight in the fixture
    // — it is exactly the read-tolerant population this refine is kept off the
    // base schema for.
    it('accepts a checksum-valid CNPJ, numeric or alphanumeric', () => {
      expect(salva('11222333000181')).toBe(true);
      expect(salva('12ABC34501DE35')).toBe(true);
      expect(salva('PC3D315K000193')).toBe(true);
    });

    it('rejects the fixture CNPJ, which has never been checksum-valid', () => {
      expect(salva('12345678000190')).toBe(false);
    });

    it('rejects a bad check digit', () => {
      expect(salva('12ABC34501DE99')).toBe(false);
      expect(salva('PC3D315K000194')).toBe(false);
    });

    it('rejects the truncation the old input produced', () => {
      // `replace(/\D/g, '')` over `12ABC34501DE35` left exactly this.
      expect(salva('123450135')).toBe(false);
    });

    it('rejects an EMPTY cnpj', () => {
      // `^(\d*|…)$` accepts '', so without this a filial saves with no CNPJ and
      // the only complaint arrives from the generator at emission time.
      expect(salva('')).toBe(false);
    });
  });

  // Regression: Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc.
  it('rejects missing fantasia (must be string | null, not undefined)', () => {
    const { fantasia, ...without } = MINIMAL_FILIAL;
    void fantasia;
    expect(filialSchema.safeParse(without).success).toBe(false);
  });

  it('requires a valid sede (rejects missing endereco)', () => {
    const { sede, ...without } = MINIMAL_FILIAL;
    void sede;
    expect(filialSchema.safeParse(without).success).toBe(false);
  });
});

describe('filialMeta', () => {
  it('targets the filiais collection', () => {
    expect(filialMeta.collectionPath).toBe('filiais');
  });

  it('reuses the configuracoes BigInt permission bits', () => {
    expect(filialMeta.permissions.read).toBe(1n << 40n);
    expect(filialMeta.permissions.write).toBe(1n << 41n);
    expect(filialMeta.permissions.delete).toBe(1n << 41n);
  });
});
