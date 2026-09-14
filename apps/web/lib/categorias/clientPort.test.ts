import { describe, expect, it } from 'vitest';
import { impostoCategoriaSchema } from '@delfrance/schemas';
import { categoriaImpostoCarriesInfo } from './clientPort';

// Regression coverage for the review finding on #467's PR: `carriesInfo` used
// to key emptiness off `typeof v === 'string'` across a field list that
// included `NVE`/`indEscala`. Once those two carry their real wire types
// (#466), a typed value can never satisfy a string check — so an entry whose
// ONLY content is one of them reads as empty and
// `buildCategoriaImpostoTransactionWrites` DELETES the stored doc instead of
// writing it. That is what forced the revert on #1279; these tests pin every
// Dados Gerais field in the shape it is actually stored in.
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
    'CEST',
    'CNPJFab',
    'cBenef',
    'extipi',
    'unidade',
  ] as const)('reads an entry whose only content is %s as carrying info', (field) => {
    const imp = impostoCategoriaSchema.parse({ [field]: 'x' });
    expect(categoriaImpostoCarriesInfo(imp)).toBe(true);
  });

  // The two non-scalar fields, in their stored shapes. Each of these four
  // assertions is the exact silent-delete case from #1279.
  it('reads an entry whose only content is a populated NVE list as carrying info', () => {
    expect(categoriaImpostoCarriesInfo(impostoCategoriaSchema.parse({ NVE: ['AB1234'] }))).toBe(
      true,
    );
  });

  it.each([true, false])(
    'reads an entry whose only content is indEscala=%s as carrying info',
    (v) => {
      expect(categoriaImpostoCarriesInfo(impostoCategoriaSchema.parse({ indEscala: v }))).toBe(
        true,
      );
    },
  );

  // ⚠️ The twin of the produto-side case in
  // `packages/data/src/produto/usecases.test.ts`. Every other case here parses
  // first; `parseSoftRead` hands back a RAW doc on any unrelated mismatch, and
  // this decision runs BEFORE `impostoCategoriaSchema.parse`. Found in review
  // on #1507.
  it('reads a RAW (unparsed) entry whose only content is a legacy scalar NVE as carrying info', () => {
    const raw = {
      ...empty(),
      NVE: 'AB1234' as unknown as string[],
    };
    expect(categoriaImpostoCarriesInfo(raw)).toBe(true);
  });

  it('still reads a RAW entry whose legacy scalar NVE is blank as empty', () => {
    const raw = { ...empty(), NVE: '   ' as unknown as string[] };
    expect(categoriaImpostoCarriesInfo(raw)).toBe(false);
  });

  it('treats an empty or whitespace-only NVE as empty', () => {
    // `[]` and `['   ']` both mean "the operator cleared it" — the doc must be
    // deleted, not written with a meaningless list.
    expect(categoriaImpostoCarriesInfo(impostoCategoriaSchema.parse({ NVE: '   ' }))).toBe(false);
    expect(categoriaImpostoCarriesInfo(impostoCategoriaSchema.parse({ NVE: [] }))).toBe(false);
    expect(categoriaImpostoCarriesInfo(impostoCategoriaSchema.parse({ NVE: ['  '] }))).toBe(false);
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
