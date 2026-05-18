import { describe, expect, it } from 'vitest';
import { filialMeta, filialSchema } from './filial';

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
    expect(
      filialSchema.safeParse({ ...MINIMAL_FILIAL, razaoSocial: '' }).success,
    ).toBe(false);
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

  it('rejects non-digit cnpj/ie/iest/imun', () => {
    expect(
      filialSchema.safeParse({ ...MINIMAL_FILIAL, cnpj: '12.345.678' }).success,
    ).toBe(false);
    expect(
      filialSchema.safeParse({ ...MINIMAL_FILIAL, ie: 'ABCD' }).success,
    ).toBe(false);
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
