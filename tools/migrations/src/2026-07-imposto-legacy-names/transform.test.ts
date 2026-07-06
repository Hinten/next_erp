import { describe, expect, it } from 'vitest';
import { impostoCategoriaSchema, regraImpostoSchema } from '@delfrance/schemas';
import {
  normalizeOperacaoRef,
  trailingSegment,
  translateLegacyImpostoCategoria,
  translateLegacyRegra,
} from './transform';

describe('trailingSegment', () => {
  it.each([
    ['p1', 'p1'],
    ['produtos/p1', 'p1'],
    ['documents/produtos/p1', 'p1'],
    ['/documents/categorias/c9/', 'c9'],
    ['', null],
    ['///', null],
  ])('%j → %j', (input, expected) => {
    expect(trailingSegment(input)).toBe(expected);
  });
});

describe('normalizeOperacaoRef', () => {
  it.each([
    ['op-1', 'operacao/op-1'],
    ['operacao/op-1', 'operacao/op-1'],
    ['documents/operacao/op-1', 'operacao/op-1'],
    [null, null],
    [undefined, null],
    [42, null],
    ['', null],
  ])('%j → %j', (input, expected) => {
    expect(normalizeOperacaoRef(input)).toBe(expected);
  });
});

describe('translateLegacyImpostoCategoria', () => {
  // Wire shape verified against the legacy Dart ODM
  // (.old/packages/produtos/lib/src/models.odm.g.dart — collection 'imposto',
  // scope key 'impostoCategoriaOperacaoOuterRef', bare-uid string value).
  const legacyDoc = {
    impostoCategoriaOperacaoOuterRef: 'op-1',
    origem: '0',
    cfop: '5102',
    cfopInterestadual: '6102',
    NCM: '61091000',
    compoeValorTotalDaNFe: true,
  };

  it('renames the scope key and normalizes the ref to operacao/<id>', () => {
    const { doc, notes } = translateLegacyImpostoCategoria(legacyDoc);
    expect(doc.impostoOperacaoOuterRef).toBe('operacao/op-1');
    expect(doc).not.toHaveProperty('impostoCategoriaOperacaoOuterRef');
    expect(notes).toContainEqual({
      field: 'impostoOperacaoOuterRef',
      from: 'op-1',
      to: 'operacao/op-1',
    });
  });

  it('handles the documents/-prefixed legacy ref shape', () => {
    const { doc } = translateLegacyImpostoCategoria({
      ...legacyDoc,
      impostoCategoriaOperacaoOuterRef: 'documents/operacao/op-1',
    });
    expect(doc.impostoOperacaoOuterRef).toBe('operacao/op-1');
  });

  it('null legacy scope stays null (applies to every operação)', () => {
    const { doc } = translateLegacyImpostoCategoria({
      ...legacyDoc,
      impostoCategoriaOperacaoOuterRef: null,
    });
    expect(doc.impostoOperacaoOuterRef).toBeNull();
  });

  it('an existing new-key value wins over the legacy key', () => {
    const { doc } = translateLegacyImpostoCategoria({
      ...legacyDoc,
      impostoOperacaoOuterRef: 'operacao/op-2',
    });
    expect(doc.impostoOperacaoOuterRef).toBe('operacao/op-2');
  });

  it('is idempotent', () => {
    const once = translateLegacyImpostoCategoria(legacyDoc).doc;
    const twice = translateLegacyImpostoCategoria(once).doc;
    expect(twice).toEqual(once);
  });

  it('does not mutate the input', () => {
    const input = { ...legacyDoc };
    translateLegacyImpostoCategoria(input);
    expect(input).toEqual(legacyDoc);
  });

  it('translated output parses under impostoCategoriaSchema', () => {
    const { doc } = translateLegacyImpostoCategoria(legacyDoc);
    const parsed = impostoCategoriaSchema.safeParse({ id: 'doc-1', ...doc });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.impostoOperacaoOuterRef).toBe('operacao/op-1');
    }
  });

  it('the RAW legacy doc would NOT scope correctly under the new schema (the bug being fixed)', () => {
    const parsed = impostoCategoriaSchema.safeParse({ id: 'doc-1', ...legacyDoc });
    // The parse succeeds but the scope silently defaults to null — the
    // per-operação rule would become a global default (#398 mis-scope).
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.impostoOperacaoOuterRef).toBeNull();
  });
});

describe('translateLegacyRegra', () => {
  // Wire shape verified against the legacy Dart model (RegraImposto —
  // UPPERCASE CFOP, path-shaped produtos/categorias arrays, free-form NCMs).
  const legacyDoc = {
    nome: 'Regra ST camisetas',
    CFOP: '5405',
    cfopInterestadual: '6404',
    produtos: ['produtos/p1', 'documents/produtos/p2', 'p3'],
    categorias: ['documents/categorias/c1'],
    ncms: ['6109.10.00', '61091000'],
    origem: '0',
  };

  it('renames CFOP → cfop', () => {
    const { doc } = translateLegacyRegra(legacyDoc);
    expect(doc.cfop).toBe('5405');
    expect(doc).not.toHaveProperty('CFOP');
  });

  it('an existing lowercase cfop wins over the uppercase key', () => {
    const { doc } = translateLegacyRegra({ ...legacyDoc, cfop: '5102' });
    expect(doc.cfop).toBe('5102');
  });

  it('normalizes produtos/categorias entries to bare uids (deduped)', () => {
    const { doc } = translateLegacyRegra(legacyDoc);
    expect(doc.produtos).toEqual(['p1', 'p2', 'p3']);
    expect(doc.categorias).toEqual(['c1']);
  });

  it('normalizes NCMs digits-only and dedupes', () => {
    const { doc } = translateLegacyRegra(legacyDoc);
    expect(doc.ncms).toEqual(['61091000']);
  });

  it('drops (and reports) NCMs that do not land on 8 digits', () => {
    const { doc, drops } = translateLegacyRegra({ ...legacyDoc, ncms: ['61091000', '123', null] });
    expect(doc.ncms).toEqual(['61091000']);
    expect(drops).toHaveLength(2);
    expect(drops.map((d) => d.field)).toEqual(['ncms', 'ncms']);
  });

  it('is idempotent', () => {
    const once = translateLegacyRegra(legacyDoc).doc;
    const twice = translateLegacyRegra(once).doc;
    expect(twice).toEqual(once);
  });

  it('translated output parses under regraImpostoSchema', () => {
    const { doc } = translateLegacyRegra(legacyDoc);
    const parsed = regraImpostoSchema.safeParse({ id: 'r-1', ...doc });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cfop).toBe('5405');
      expect(parsed.data.produtos).toEqual(['p1', 'p2', 'p3']);
    }
  });

  it('the RAW legacy doc fails the new schema (formatted NCM) — the bug being fixed', () => {
    const parsed = regraImpostoSchema.safeParse({ id: 'r-1', ...legacyDoc });
    expect(parsed.success).toBe(false);
  });
});
