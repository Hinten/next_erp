import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that `src/index.ts` exports the module.
import {
  MAX_DESCRICAO_LI,
  MAX_IMAGENS_PRODUTO_LI,
  TIPO_PRODUTO_LI,
  lerDetalheProdutoLi,
  lerProdutoLi,
  medidaPositivaLi,
  mesmoSkuLi,
  produtoLiDetalhadoSchema,
  produtoLiLidoSchema,
  skuParecidoLi,
  type LinhaDetalheProdutoLi,
  type LinhaProdutoLi,
} from './index';

/** A parent row in the shape of the public document's list example (fake ids and names). */
const PAI: LinhaProdutoLi = {
  id: 1000001,
  tipo: 'atributo',
  sku: 'KX7',
  nome: 'Camiseta de teste',
  ativo: true,
  bloqueado: false,
  removido: false,
  filhos: ['/api/v1/produto/1000002', '/api/v1/produto/1000003'],
  categorias: ['/api/v1/categoria/2000001', '/api/v1/categoria/2000002/'],
  grades: ['/api/v1/grades/3000001'],
  variacoes: [],
  gtin: null,
};

const FILHO: LinhaProdutoLi = {
  id: 1000002,
  tipo: 'atributo_opcao',
  sku: 'KX7-AZ',
  nome: null,
  ativo: true,
  bloqueado: false,
  removido: false,
  filhos: [],
  categorias: [],
  grades: [],
  variacoes: ['/api/v1/grade/3000001/variacao/4000001', '/api/v1/grade/3000002/variacao/4000009'],
};

describe('lerProdutoLi — the ROW view', () => {
  it('reads a parent row into the view the import stores, and the view parses', () => {
    const lido = lerProdutoLi(PAI);
    expect(lido).toEqual({
      id: 1000001,
      tipo: TIPO_PRODUTO_LI.atributo,
      sku: 'KX7',
      nome: 'Camiseta de teste',
      ativo: true,
      bloqueado: false,
      removido: false,
      filhoIds: [1000002, 1000003],
      categoriaIds: [2000001, 2000002],
      opcoes: [],
      gtin: null,
      categorias: ['/api/v1/categoria/2000001', '/api/v1/categoria/2000002/'],
      grades: ['/api/v1/grades/3000001'],
      variacoes: [],
      ilegiveis: { filhos: 0, categorias: 0, opcoes: 0 },
    });
    expect(produtoLiLidoSchema.safeParse(lido).success).toBe(true);
  });

  it('reads a variation’s two-id option URIs', () => {
    expect(lerProdutoLi(FILHO)?.opcoes).toEqual([
      { gradeId: 3000001, opcaoId: 4000001 },
      { gradeId: 3000002, opcaoId: 4000009 },
    ]);
  });

  it('⚠️ an unreadable URI is COUNTED, never dropped silently and never read as none', () => {
    const lido = lerProdutoLi({
      ...PAI,
      filhos: ['/api/v1/produto/1000002', '/api/v1/produto/None', 7],
      categorias: ['/api/v1/categoria/2000001', 'https://loja.invalid/api/v1/categoria/2'],
      variacoes: ['/api/v1/grades/3000001/variacao/4000001'],
    });
    expect(lido?.filhoIds).toEqual([1000002]);
    expect(lido?.ilegiveis).toEqual({ filhos: 2, categorias: 1, opcoes: 1 });
  });

  it('a URI repeated in a list is read once', () => {
    const lido = lerProdutoLi({
      ...PAI,
      filhos: ['/api/v1/produto/1000002', '/v1/produto/1000002/'],
    });
    expect(lido?.filhoIds).toEqual([1000002]);
  });

  it('EQUAL: one option pair in two URI forms is ONE option; ⚠️ NEAR-MISS: one option id under two grades is TWO', () => {
    // Keyed by the pair: the second grade's entry is kept for the resolver to judge, never
    // dropped silently as a repeat of the first.
    const lido = lerProdutoLi({
      ...FILHO,
      variacoes: [
        '/api/v1/grade/3000001/variacao/4000001',
        '/v1/grade/3000001/variacao/4000001/',
        '/api/v1/grade/3000002/variacao/4000001',
      ],
    });
    expect(lido?.opcoes).toEqual([
      { gradeId: 3000001, opcaoId: 4000001 },
      { gradeId: 3000002, opcaoId: 4000001 },
    ]);
    expect(lido?.ilegiveis.opcoes).toBe(0);
  });

  it.each([
    ['normal', TIPO_PRODUTO_LI.normal],
    ['atributo', TIPO_PRODUTO_LI.atributo],
    ['atributo_opcao', TIPO_PRODUTO_LI.atributoOpcao],
  ])('EQUAL: tipo %s is read as itself', (tipo, esperado) => {
    expect(lerProdutoLi({ ...PAI, tipo })?.tipo).toBe(esperado);
  });

  it.each([['Normal'], ['kit'], [''], [null], [1], [undefined]])(
    '⚠️ NEAR-MISS: tipo %j is desconhecido — never treated as normal',
    (tipo) => {
      expect(lerProdutoLi({ ...PAI, tipo })?.tipo).toBe(TIPO_PRODUTO_LI.desconhecido);
    },
  );

  it('keeps sku, nome and gtin VERBATIM; only the exact empty string is nothing', () => {
    expect(lerProdutoLi({ ...PAI, sku: ' KX7 ' })?.sku).toBe(' KX7 ');
    expect(lerProdutoLi({ ...PAI, sku: '' })?.sku).toBeNull();
    expect(lerProdutoLi({ ...PAI, sku: null })?.sku).toBeNull();
    expect(lerProdutoLi({ ...PAI, sku: 123 })?.sku).toBeNull();
    expect(lerProdutoLi({ ...PAI, nome: '' })?.nome).toBeNull();
    expect(lerProdutoLi({ ...PAI, gtin: '7890000000001' })?.gtin).toBe('7890000000001');
  });

  it('a non-boolean state flag reads as null, never as a guess', () => {
    const lido = lerProdutoLi({ ...PAI, ativo: 'true', bloqueado: undefined, removido: 0 });
    expect(lido).toMatchObject({ ativo: null, bloqueado: null, removido: null });
  });

  it.each([[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]])(
    'a row whose id is %j is unreadable (null): no link could store it',
    (id) => {
      expect(lerProdutoLi({ ...PAI, id })).toBeNull();
    },
  );

  it('⚠️ the id comes from `id`, never from `resource_uri`', () => {
    const linha = { ...PAI, resource_uri: '/api/v1/produto/9999999' } as LinhaProdutoLi;
    expect(lerProdutoLi(linha)?.id).toBe(1000001);
  });

  it('the verbatim URI lists keep only strings, in order', () => {
    const lido = lerProdutoLi({ ...PAI, categorias: ['/api/v1/categoria/1', 5, null] });
    expect(lido?.categorias).toEqual(['/api/v1/categoria/1']);
  });
});

/** A child detail: its own weight (a STRING decimal) and integer dimensions, a `pai`, no images. */
const DETALHE_FILHO: LinhaDetalheProdutoLi = {
  ...FILHO,
  pai: '/api/v1/produto/1000001',
  peso: '0.200',
  altura: 10,
  largura: 20,
  profundidade: 5,
  destaque: false,
  usado: false,
  descricao_completa: null,
};

describe('lerDetalheProdutoLi — the DETAIL view', () => {
  it('reads a child detail: its own weight and dimensions, its parent, no images', () => {
    const lido = lerDetalheProdutoLi(DETALHE_FILHO);
    expect(lido).toMatchObject({
      id: 1000002,
      paiId: 1000001,
      paiIlegivel: false,
      pesoKg: 0.2,
      alturaCm: 10,
      larguraCm: 20,
      profundidadeCm: 5,
      destaque: false,
      usado: false,
      descricao: null,
      descricaoLonga: false,
      descricaoTamanho: 0,
      imagens: [],
      imagensDescartadas: 0,
    });
    expect(produtoLiDetalhadoSchema.safeParse(lido).success).toBe(true);
  });

  it.each([[null], [''], [undefined]])('an empty pai %j ⇒ no parent, not unreadable', (pai) => {
    expect(lerDetalheProdutoLi({ ...DETALHE_FILHO, pai })).toMatchObject({
      paiId: null,
      paiIlegivel: false,
    });
  });

  it.each([['/api/v1/produto/None'], ['/api/v1/categoria/1000001'], [{ id: 1 }], [1000001]])(
    '⚠️ NEAR-MISS: an unreadable pai %j is ilegivel — NEVER read as "no parent"',
    (pai) => {
      expect(lerDetalheProdutoLi({ ...DETALHE_FILHO, pai })).toMatchObject({
        paiId: null,
        paiIlegivel: true,
      });
    },
  );

  it('reads the brand from its URI', () => {
    expect(
      lerDetalheProdutoLi({ ...DETALHE_FILHO, marca: '/api/v1/marca/5000001/' })?.marcaId,
    ).toBe(5000001);
    expect(
      lerDetalheProdutoLi({ ...DETALHE_FILHO, marca: '/api/v1/marca/None' })?.marcaId,
    ).toBeNull();
  });

  it('keeps a description up to the ceiling verbatim, HTML included', () => {
    const descricao = `<p>${'a'.repeat(MAX_DESCRICAO_LI - 7)}</p>`;
    expect(descricao).toHaveLength(MAX_DESCRICAO_LI);
    const lido = lerDetalheProdutoLi({ ...DETALHE_FILHO, descricao_completa: descricao });
    expect(lido).toMatchObject({ descricao, descricaoLonga: false, descricaoTamanho: 3000 });
  });

  it('⚠️ a description past the ceiling is stored as its LENGTH only — never a cut text', () => {
    const longa = 'b'.repeat(50_000);
    const lido = lerDetalheProdutoLi({ ...DETALHE_FILHO, descricao_completa: longa });
    expect(lido).toMatchObject({ descricao: null, descricaoLonga: true, descricaoTamanho: 50_000 });
    expect(JSON.stringify(lido)).not.toContain('bbbb');
  });

  it('an empty description is nothing', () => {
    expect(lerDetalheProdutoLi({ ...DETALHE_FILHO, descricao_completa: '' })).toMatchObject({
      descricao: null,
      descricaoLonga: false,
      descricaoTamanho: 0,
    });
  });

  it('carries no price, stock, SEO or URL key, whatever the detail holds', () => {
    const lido = lerDetalheProdutoLi({
      ...DETALHE_FILHO,
      ...{
        preco_cheio: 100,
        estoque_quantidade: 3,
        seo: '/api/v1/seo/1',
        url: 'https://x.invalid',
      },
    } as LinhaDetalheProdutoLi);
    const chaves = Object.keys(lido ?? {});
    for (const proibida of ['preco_cheio', 'estoque_quantidade', 'seo', 'url']) {
      expect(chaves).not.toContain(proibida);
    }
  });
});

describe('medidaPositivaLi — weight and dimensions', () => {
  it.each([
    ['"0.200"', '0.200', 0.2],
    ['"0.500"', '0.500', 0.5],
    ['float noise', '0.450000000000000011102230246251565404236316680908203125', 0.45],
    ['an integer dimension', 12, 12],
    ['a text integer', '12', 12],
    ['a number weight', 0.75, 0.75],
  ])('EQUAL: %s ⇒ %j', (_r, valor, esperado) => {
    expect(medidaPositivaLi(valor)).toBe(esperado);
  });

  it.each([
    ['zero', '0.000'],
    ['a number zero', 0],
    ['a comma decimal', '0,5'],
    ['an exponent', '5e-1'],
    ['a sign', '-0.5'],
    ['a leading plus', '+1'],
    ['a bare leading point', '.5'],
    ['a bare trailing point', '5.'],
    ['a space', ' 0.5'],
    ['an empty string', ''],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('⚠️ NEAR-MISS: %s ⇒ null (nothing is written)', (_r, valor) => {
    expect(medidaPositivaLi(valor)).toBeNull();
  });
});

describe('the images of a detail', () => {
  const imagem = (id: number, posicao: string | number | null, principal = false) => ({
    id,
    caminho: `fake/${String(id)}.jpg`,
    posicao,
    principal,
    grande: `https://cdn.invalid/800x800/fake/${String(id)}.jpg`,
    mime: null,
  });

  it('the principal first, then by posicao (null last, in API order), de-duplicated by id', () => {
    const lido = lerDetalheProdutoLi({
      ...DETALHE_FILHO,
      imagem_principal: imagem(9, '3'),
      imagens: [imagem(1, null), imagem(2, '2'), imagem(9, '3'), imagem(3, 1), imagem(4, null)],
    });
    expect(lido?.imagens.map((i) => i.id)).toEqual([9, 3, 2, 1, 4]);
    expect(lido?.imagens[0]).toEqual({
      id: 9,
      caminho: 'fake/9.jpg',
      principal: true,
      posicao: '3',
    });
    // Only the path is stored, never the body's absolute URL.
    expect(JSON.stringify(lido?.imagens)).not.toContain('cdn.invalid');
  });

  it(`keeps at most ${String(MAX_IMAGENS_PRODUTO_LI)} and counts the rest and the unreadable`, () => {
    const imagens = Array.from({ length: 60 }, (_, i) => imagem(i + 1, i));
    const lido = lerDetalheProdutoLi({
      ...DETALHE_FILHO,
      imagens: [...imagens, { id: 0, caminho: 'x' }, { id: 99, caminho: '' }],
    });
    expect(lido?.imagens).toHaveLength(MAX_IMAGENS_PRODUTO_LI);
    expect(lido?.imagensDescartadas).toBe(12);
  });

  it('with no imagem_principal, an imagens[] entry’s own principal flag puts it first', () => {
    const lido = lerDetalheProdutoLi({
      ...DETALHE_FILHO,
      imagens: [imagem(1, '1'), imagem(2, '2', true)],
    });
    expect(lido?.imagens.map((i) => [i.id, i.principal])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('an id repeated in imagens[] is ONE image, principal when any of its copies says so', () => {
    const lido = lerDetalheProdutoLi({
      ...DETALHE_FILHO,
      imagens: [imagem(1, '1'), imagem(2, '2'), imagem(2, '2', true)],
    });
    expect(lido?.imagens.map((i) => [i.id, i.principal])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(lido?.imagensDescartadas).toBe(0);
  });

  it('EQUAL: an image id as canonical decimal text reads; ⚠️ NEAR-MISS: an edge space or a leading zero is discarded', () => {
    const lido = lerDetalheProdutoLi({
      ...DETALHE_FILHO,
      imagens: [
        { ...imagem(1, 1), id: '7' },
        { ...imagem(2, 2), id: ' 8' },
        { ...imagem(3, 3), id: '09' },
      ],
    });
    expect(lido?.imagens.map((i) => i.id)).toEqual([7]);
    expect(lido?.imagensDescartadas).toBe(2);
  });

  it('an image with no readable caminho is discarded and counted — never kept without an address', () => {
    const lido = lerDetalheProdutoLi({
      ...DETALHE_FILHO,
      imagens: [imagem(1, 1), { id: 2, caminho: '', posicao: 2 }, { id: 3, posicao: 3 }],
    });
    expect(lido?.imagens.map((i) => i.id)).toEqual([1]);
    expect(lido?.imagensDescartadas).toBe(2);
  });
});

describe('mesmoSkuLi — the SKU identity is exact bytes', () => {
  it('EQUAL: the same characters', () => {
    expect(mesmoSkuLi('KX7-AZ', 'KX7-AZ')).toBe(true);
    expect(mesmoSkuLi('123456789012345', '123456789012345')).toBe(true);
  });

  it.each([
    ['another case', 'kx7-az'],
    ['a trailing space', 'KX7-AZ '],
    ['a leading space', ' KX7-AZ'],
    ['a no-break space', 'KX7-AZ '],
    ['a child’s SKU', 'KX7-AZ-P'],
  ])('⚠️ NEAR-MISS: %s is another product', (_r, outro) => {
    expect(mesmoSkuLi('KX7-AZ', outro)).toBe(false);
  });

  it('⚠️ NEAR-MISS: a leading zero is another product', () => {
    expect(mesmoSkuLi('01', '1')).toBe(false);
  });

  it('⚠️ NEAR-MISS: a number is never the same SKU as its decimal text, on either side', () => {
    expect(mesmoSkuLi('123', 123)).toBe(false);
    expect(mesmoSkuLi(123, '123')).toBe(false);
  });

  it('an empty or non-string SKU is equal to nothing, not even itself', () => {
    expect(mesmoSkuLi('', '')).toBe(false);
    expect(mesmoSkuLi(null, null)).toBe(false);
    expect(mesmoSkuLi(1, 1)).toBe(false);
  });
});

describe('skuParecidoLi — the create guard’s probe forms', () => {
  it('lists the six forms in order, without repeats and never empty', () => {
    expect(skuParecidoLi(' Abc-1 ')).toEqual([
      ' Abc-1 ',
      'Abc-1',
      ' ABC-1 ',
      ' abc-1 ',
      'ABC-1',
      'abc-1',
    ]);
    expect(skuParecidoLi('ABC-1')).toEqual(['ABC-1', 'abc-1']);
    expect(skuParecidoLi('')).toEqual([]);
    expect(skuParecidoLi(null)).toEqual([]);
  });

  it.each([
    ['abc-1', 'ABC-1'],
    ['ABC-1 ', 'ABC-1'],
    [' Abc-1', 'ABC-1'],
    ['ABC-1', 'abc-1'],
  ])('EQUAL (parecido): store %j reaches ERP %j', (loja, erp) => {
    expect(skuParecidoLi(loja)).toContain(erp);
  });

  it.each([
    ['ABC-1', 'ABC-2'],
    ['ABC-1', 'ABC1'],
    ['ABC-1', 'ABC-1-UN'],
  ])('⚠️ NEAR-MISS: store %j does not reach ERP %j', (loja, erp) => {
    expect(skuParecidoLi(loja)).not.toContain(erp);
  });

  it.each([
    ['an ERP SKU in MIXED case', 'abc-1', 'Abc-1'],
    ['an ERP SKU with an end space', 'ABC-1', 'ABC-1 '],
  ])('⚠️ STATED LIMIT: %s is NOT reached (only the store side is folded)', (_r, loja, erp) => {
    expect(skuParecidoLi(loja)).not.toContain(erp);
  });
});
