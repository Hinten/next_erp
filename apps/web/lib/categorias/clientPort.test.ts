import { describe, expect, it } from 'vitest';
import { impostoCategoriaSchema } from '@delfrance/schemas';
import { categoriaImpostoCarriesInfo } from './clientPort';

// Regression coverage for the review finding on #467's PR: `carriesInfo`
// keys emptiness off `typeof v === 'string'` for the Dados Gerais fields.
// Any field in that list whose type stops being a string (an earlier
// version of `impostoCategoriaSchema` retyped `NVE`/`indEscala` to
// array/boolean) makes an entry that carries ONLY that field silently
// unrepresentable — `buildCategoriaImpostoTransactionWrites` reads it as
// empty and DELETES the stored doc instead of writing it. These tests pin
// every Dados Gerais field currently modeled as a lenient string.
describe('categoriaImpostoCarriesInfo', () => {
  const empty = () => impostoCategoriaSchema.parse({});

  it('reads a pristine (all-null) entry as carrying no info', () => {
    expect(categoriaImpostoCarriesInfo(empty())).toBe(false);
  });

  it.each([
    'origem',
    'cfop',
    'cfopInterestadual',
    'NCM',
    'NVE',
    'CEST',
    'indEscala',
    'CNPJFab',
    'cBenef',
    'extipi',
    'unidade',
  ] as const)('reads an entry whose only content is %s as carrying info', (field) => {
    const imp = impostoCategoriaSchema.parse({ [field]: 'x' });
    expect(categoriaImpostoCarriesInfo(imp)).toBe(true);
  });

  it('treats a whitespace-only string field as empty', () => {
    const imp = impostoCategoriaSchema.parse({ NVE: '   ' });
    expect(categoriaImpostoCarriesInfo(imp)).toBe(false);
  });

  it('reads an explicit compoeValorTotalDaNFe=false as carrying info', () => {
    const imp = impostoCategoriaSchema.parse({ compoeValorTotalDaNFe: false });
    expect(categoriaImpostoCarriesInfo(imp)).toBe(true);
  });

  it('reads an entry whose only content is a typed tax config as carrying info', () => {
    const imp = impostoCategoriaSchema.parse({ configuracaoICMS: { crt: '1', csosn: '102' } });
    expect(categoriaImpostoCarriesInfo(imp)).toBe(true);
  });

  it('treats an all-null nested configuracaoIBSCBS as empty', () => {
    const imp = impostoCategoriaSchema.parse({ configuracaoIBSCBS: { CST: null } });
    expect(categoriaImpostoCarriesInfo(imp)).toBe(false);
  });

  it('reads a non-null leaf inside configuracaoIBSCBS as carrying info', () => {
    const imp = impostoCategoriaSchema.parse({ configuracaoIBSCBS: { CST: '000' } });
    expect(categoriaImpostoCarriesInfo(imp)).toBe(true);
  });
});
