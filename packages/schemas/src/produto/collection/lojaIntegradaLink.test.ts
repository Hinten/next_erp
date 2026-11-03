import { describe, expect, it } from 'vitest';
import {
  ESTADO_PUBLICACAO_LI,
  RELACAO_VINCULO_LI,
  contaDoRefLi,
  estadoPublicacaoLiSchema,
  produtoLojaIntegradaLinkSchema,
  vinculoLiConta,
  vinculoLiDaContaEId,
} from './lojaIntegradaLink';

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

  it('reads estadoPublicacao as one of the eight codes, exactly as stored', () => {
    for (const codigo of Object.values(ESTADO_PUBLICACAO_LI)) {
      expect(
        produtoLojaIntegradaLinkSchema.parse({
          contaLojaIntegrada: 'documents/integracao/int1',
          sku: 'X',
          estadoPublicacao: codigo,
        }).estadoPublicacao,
      ).toBe(codigo);
    }
    expect(estadoPublicacaoLiSchema.options).toEqual(['r', 'a', 'ep', 'v', 'p', 'pa', 'c', 'E']);
  });

  it.each([
    ['an unknown code', 'ativo'],
    ['a case-folded code', 'e'],
    ['a code with a space', 'p '],
    ['a legacy number', 2],
    ['null', null],
    ['an object', {}],
  ])(
    '⚠️ an unknown stored estadoPublicacao (%s) READS as r — never a refused document',
    (_r, valor) => {
      const lido = produtoLojaIntegradaLinkSchema.safeParse({
        contaLojaIntegrada: 'documents/integracao/int1',
        sku: 'X',
        estadoPublicacao: valor,
      });
      expect(lido.success).toBe(true);
      expect(lido.data?.estadoPublicacao).toBe(ESTADO_PUBLICACAO_LI.rascunho);
    },
  );

  it('an absent estadoPublicacao reads as r', () => {
    expect(
      produtoLojaIntegradaLinkSchema.parse({
        contaLojaIntegrada: 'documents/integracao/int1',
        sku: 'X',
      }).estadoPublicacao,
    ).toBe('r');
  });

  it('defaults ativo to true (legacy ctor default), bloqueado and removido to false', () => {
    const parsed = produtoLojaIntegradaLinkSchema.parse({
      contaLojaIntegrada: 'documents/integracao/int1',
      sku: 'X',
    });
    expect(parsed.ativo).toBe(true);
    expect(parsed.bloqueado).toBe(false);
    expect(parsed.removido).toBe(false);
  });

  it('⚠️ destaque and usado are detail-only: absent reads as null, never an invented false', () => {
    const parsed = produtoLojaIntegradaLinkSchema.parse({
      contaLojaIntegrada: 'documents/integracao/int1',
      sku: 'X',
    });
    expect(parsed.destaque).toBeNull();
    expect(parsed.usado).toBeNull();
    expect(parsed.destaque).not.toBe(false);
  });

  it('a stored boolean destaque/usado still parses as stored', () => {
    const parsed = produtoLojaIntegradaLinkSchema.parse({
      contaLojaIntegrada: 'documents/integracao/int1',
      sku: 'X',
      destaque: true,
      usado: false,
      bloqueado: true,
    });
    expect(parsed).toMatchObject({ destaque: true, usado: false, bloqueado: true });
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

describe('contaDoRefLi — the conta a stored ref names', () => {
  it.each([['documents/integracao/C1'], ['integracao/C1']])('EQUAL: %s ⇒ C1', (ref) => {
    expect(contaDoRefLi(ref)).toBe('C1');
  });

  it.each([
    ['another conta', 'documents/integracao/C2', 'C2'],
    ['another collection', 'documents/categorias/C1', null],
    ['a bare id (not a ref)', 'C1', null],
    ['an empty string', '', null],
    ['null', null, null],
    ['a number', 1, null],
  ])('⚠️ NEAR-MISS: %s ⇒ %j', (_r, ref, esperado) => {
    expect(contaDoRefLi(ref)).toBe(esperado);
  });

  it('⚠️ NEAR-MISS: the id is not folded — another case is another conta', () => {
    expect(contaDoRefLi('documents/integracao/c1')).toBe('c1');
    expect(contaDoRefLi('documents/integracao/c1')).not.toBe('C1');
  });
});

describe('vinculoLiConta — the anchor’s counts predicate', () => {
  it.each([
    ['a live link', { id: 182904918, removido: false }],
    ['a hidden link', { id: 182904918, ativo: false }],
    ['a blocked link', { id: 182904918, bloqueado: true }],
    ['a text id in canonical form', { id: '182904918' }],
    ['an absent removido', { id: 182904918 }],
  ])('EQUAL: %s counts', (_r, link) => {
    expect(vinculoLiConta(link)).toBe(true);
  });

  it.each([
    ['a trashed link', { id: 182904918, removido: true }],
    ['a null id', { id: null }],
    ['a zero id', { id: 0 }],
    ['a leading zero', { id: '07' }],
    ['a fractional id', { id: 1.5 }],
    ['no id at all', {}],
    ['null', null],
    ['an array', [{ id: 1 }]],
    ['a string', 'documents/integracao/C1'],
  ])('⚠️ NEAR-MISS: %s does not count', (_r, link) => {
    expect(vinculoLiConta(link)).toBe(false);
  });
});

describe('vinculoLiDaContaEId — is this stored link THE link of (conta, store product)?', () => {
  const C1 = 'documents/integracao/C1';

  it('EQUAL: a number id under this conta, in both stored ref forms ⇒ mesmo', () => {
    expect(vinculoLiDaContaEId({ id: 182904918, contaLojaIntegrada: C1 }, 'C1', 182904918)).toBe(
      RELACAO_VINCULO_LI.mesmo,
    );
    expect(
      vinculoLiDaContaEId({ id: 182904918, contaLojaIntegrada: 'integracao/C1' }, 'C1', 182904918),
    ).toBe(RELACAO_VINCULO_LI.mesmo);
  });

  it('⚠️ NEAR-MISS: another id under this conta ⇒ outro-id', () => {
    expect(vinculoLiDaContaEId({ id: 182904919, contaLojaIntegrada: C1 }, 'C1', 182904918)).toBe(
      RELACAO_VINCULO_LI.outroId,
    );
  });

  it('⚠️ NEAR-MISS: another conta ⇒ outra-conta, whatever the id', () => {
    expect(
      vinculoLiDaContaEId(
        { id: 182904918, contaLojaIntegrada: 'documents/integracao/C2' },
        'C1',
        182904918,
      ),
    ).toBe(RELACAO_VINCULO_LI.outraConta);
    expect(vinculoLiDaContaEId({ id: 182904918, contaLojaIntegrada: 'C1' }, 'C1', 182904918)).toBe(
      RELACAO_VINCULO_LI.outraConta,
    );
    expect(vinculoLiDaContaEId({ id: 182904918 }, 'C1', 182904918)).toBe(
      RELACAO_VINCULO_LI.outraConta,
    );
    expect(vinculoLiDaContaEId(null, 'C1', 182904918)).toBe(RELACAO_VINCULO_LI.outraConta);
  });

  it.each([
    ['a TEXT id equal to the number', '182904918'],
    ['a null id', null],
    ['a zero id', 0],
    ['a fractional id', 182904918.5],
  ])('⚠️ NEAR-MISS: %s under this conta ⇒ id-ilegivel, never mesmo', (_r, id) => {
    expect(vinculoLiDaContaEId({ id, contaLojaIntegrada: C1 }, 'C1', 182904918)).toBe(
      RELACAO_VINCULO_LI.idIlegivel,
    );
  });
});
