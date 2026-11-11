import { describe, expect, it } from 'vitest';
import {
  ESTADO_PUBLICACAO_LI,
  RELACAO_VINCULO_LI,
  contaDoLinkLi,
  estadoPublicacaoLiSchema,
  produtoLojaIntegradaLinkSchema,
  vinculoLiConta,
  vinculoLiDaContaEId,
} from './lojaIntegradaLink';
import { contaIdFromRef } from '../../shared/outerRef';

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

describe('contaIdFromRef — the conta a stored ref names (the one reader the LI link shares)', () => {
  it.each([['documents/integracao/C1'], ['integracao/C1']])('EQUAL: %s ⇒ C1', (ref) => {
    expect(contaIdFromRef(ref)).toBe('C1');
  });

  it.each([
    ['another conta', 'documents/integracao/C2', 'C2'],
    ['another collection', 'documents/categorias/C1', null],
    ['a bare id (not a ref)', 'C1', null],
    ['an empty string', '', null],
    ['null', null, null],
    ['a number', 1, null],
  ])('⚠️ NEAR-MISS: %s ⇒ %j', (_r, ref, esperado) => {
    expect(contaIdFromRef(ref)).toBe(esperado);
  });

  it('⚠️ NEAR-MISS: the id is not folded — another case is another conta', () => {
    expect(contaIdFromRef('documents/integracao/c1')).toBe('c1');
    expect(contaIdFromRef('documents/integracao/c1')).not.toBe('C1');
  });
});

describe('contaDoLinkLi — the anchor’s conta reader (contaLojaIntegrada, nothing else)', () => {
  /** A store product id, so every body below would count: only the conta field varies. */
  const ID_LI = 182904918;

  it.each([
    ['the canonical form', 'documents/integracao/C1'],
    ['the bare form', 'integracao/C1'],
    ['a leading slash', '/documents/integracao/C1'],
  ])('EQUAL: %s reads as the same conta, C1', (_r, ref) => {
    expect(contaDoLinkLi({ contaLojaIntegrada: ref, id: ID_LI })).toBe('C1');
  });

  it('⚠️ NEAR-MISS: another conta’s ref reads as THAT conta — never C1, and never case-folded', () => {
    expect(contaDoLinkLi({ contaLojaIntegrada: 'documents/integracao/C2', id: ID_LI })).toBe('C2');
    expect(contaDoLinkLi({ contaLojaIntegrada: 'documents/integracao/c1', id: ID_LI })).toBe('c1');
  });

  it.each([
    ['another collection’s ref', 'documents/categorias/C1'],
    ['a bare id (not a ref)', 'C1'],
    ['the collection alone', 'integracao'],
    ['an empty string', ''],
    ['null', null],
    ['a number', 42],
    // A reader that stringified before it parsed would read this as C1: `String([ref])` is the ref.
    ['the ref inside an array', ['documents/integracao/C1']],
    ['the ref inside a map', { caminho: 'integracao/C1' }],
  ])('⚠️ NEAR-MISS: %s reads null — never C1', (_r, ref) => {
    expect(contaDoLinkLi({ contaLojaIntegrada: ref, id: ID_LI })).toBeNull();
  });

  it.each([['contaOuterRef'], ['contaProdutoShopeeOuterRef'], ['contaAmazonOuterRef']])(
    '⚠️ NEAR-MISS: a doc carrying ONLY %s (another channel’s conta field) reads null',
    (campo) => {
      // The copy-paste trap: one identifier apart, it compiles, and the trigger goes silent.
      expect(contaDoLinkLi({ [campo]: 'documents/integracao/C1', id: ID_LI })).toBeNull();
      // ÂNCORA: the same body under the right field does read C1.
      expect(contaDoLinkLi({ contaLojaIntegrada: 'documents/integracao/C1', id: ID_LI })).toBe(
        'C1',
      );
    },
  );

  it('reads the conta whatever the link’s counting state — counting is vinculoLiConta’s', () => {
    expect(
      contaDoLinkLi({ contaLojaIntegrada: 'documents/integracao/C1', id: null, removido: true }),
    ).toBe('C1');
  });

  it('⛔ a raw document never makes it throw', () => {
    for (const bruto of [
      {},
      { contaLojaIntegrada: undefined },
      { contaLojaIntegrada: { caminho: 'integracao/C1' } },
      { contaLojaIntegrada: ['integracao/C1'] },
      { contaLojaIntegrada: 'documents/integracao/C1', id: { valor: 1 } },
    ]) {
      expect(() => contaDoLinkLi(bruto)).not.toThrow();
    }
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

  it.each([
    ['a text removido', { id: 182904918, removido: 'true' }],
    ['a numeric removido', { id: 182904918, removido: 1 }],
  ])(
    'only removido === true is the trash: %s still counts (over-including is the safe side)',
    (_r, link) => {
      expect(vinculoLiConta(link)).toBe(true);
    },
  );
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

  it('⚠️ NEAR-MISS: the conta id is not case-folded — c1 is another conta than C1', () => {
    expect(
      vinculoLiDaContaEId(
        { id: 182904918, contaLojaIntegrada: 'documents/integracao/c1' },
        'C1',
        182904918,
      ),
    ).toBe(RELACAO_VINCULO_LI.outraConta);
  });

  it('⚠️ the conta is decided FIRST: another conta’s link with a text id ⇒ outra-conta, never id-ilegivel', () => {
    expect(
      vinculoLiDaContaEId(
        { id: '182904918', contaLojaIntegrada: 'documents/integracao/C2' },
        'C1',
        182904918,
      ),
    ).toBe(RELACAO_VINCULO_LI.outraConta);
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
