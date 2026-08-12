import { describe, expect, it } from 'vitest';
import { produtoLojaIntegradaLinkSchema } from './lojaIntegradaLink';

describe('produtoLojaIntegradaLinkSchema', () => {
  it('parses a legacy-shaped ProdutoIntegrada fixture doc (parent)', () => {
    const fixture = {
      contaLojaIntegrada: 'documents/integracao/int1',
      id: 555111,
      paiProdutoIntegradaId: null,
      estadoPublicacao: 1,
      error: null,
      sku: 'SKU-001',
      nome: 'Camiseta Básica Azul',
      descricao_html: '<p>Camiseta 100% algodão.</p>',
      ativo: true,
      destaque: false,
      usado: false,
      grades: ['Cor', 'Tamanho'],
      variacoes: null,
      categorias: ['Vestuário'],
      marca: 'Marca X',
      removido: false,
    };
    const parsed = produtoLojaIntegradaLinkSchema.parse(fixture);
    expect(parsed).toMatchObject({
      id: 555111,
      sku: 'SKU-001',
      nome: 'Camiseta Básica Azul',
      ativo: true,
      grades: ['Cor', 'Tamanho'],
      categorias: ['Vestuário'],
    });
  });

  it('parses a legacy-shaped ProdutoIntegrada fixture doc (child variation)', () => {
    const fixture = {
      contaLojaIntegrada: 'documents/integracao/int1',
      id: 555112,
      paiProdutoIntegradaId: 555111,
      sku: 'SKU-001-AZUL-M',
      grades: null,
      variacoes: ['555113', '555114'],
      removido: false,
    };
    const parsed = produtoLojaIntegradaLinkSchema.parse(fixture);
    expect(parsed.paiProdutoIntegradaId).toBe(555111);
    expect(parsed.variacoes).toEqual(['555113', '555114']);
    expect(parsed.grades).toBeNull();
  });

  it('requires a non-empty sku', () => {
    expect(produtoLojaIntegradaLinkSchema.safeParse({}).success).toBe(false);
    expect(
      produtoLojaIntegradaLinkSchema.safeParse({
        contaLojaIntegrada: 'documents/integracao/int1',
        sku: '',
      }).success,
    ).toBe(false);
  });

  it('rejects when contaLojaIntegrada is missing', () => {
    expect(produtoLojaIntegradaLinkSchema.safeParse({ sku: 'X' }).success).toBe(false);
  });

  it('accepts estadoPublicacao as either a number or a string (loose, undocumented codes)', () => {
    expect(
      produtoLojaIntegradaLinkSchema.parse({
        contaLojaIntegrada: 'documents/integracao/int1',
        sku: 'X',
        estadoPublicacao: 2,
      }).estadoPublicacao,
    ).toBe(2);
    expect(
      produtoLojaIntegradaLinkSchema.parse({
        contaLojaIntegrada: 'documents/integracao/int1',
        sku: 'X',
        estadoPublicacao: 'ativo',
      }).estadoPublicacao,
    ).toBe('ativo');
    expect(
      produtoLojaIntegradaLinkSchema.safeParse({
        contaLojaIntegrada: 'documents/integracao/int1',
        sku: 'X',
        estadoPublicacao: {},
      }).success,
    ).toBe(false);
  });

  it('defaults ativo to true (legacy ctor default) and the other state booleans to false', () => {
    const parsed = produtoLojaIntegradaLinkSchema.parse({
      contaLojaIntegrada: 'documents/integracao/int1',
      sku: 'X',
    });
    expect(parsed.ativo).toBe(true);
    expect(parsed.destaque).toBe(false);
    expect(parsed.usado).toBe(false);
    expect(parsed.removido).toBe(false);
  });

  it('preserves unknown top-level fields (pass-through)', () => {
    const parsed = produtoLojaIntegradaLinkSchema.parse({
      contaLojaIntegrada: 'documents/integracao/int1',
      sku: 'X',
      _futureLojaIntegradaField: 'whatever',
    });
    expect((parsed as Record<string, unknown>)._futureLojaIntegradaField).toBe('whatever');
  });
});
