import { describe, expect, it } from 'vitest';

import {
  CLASSE,
  CLASSES_DO_GATE,
  censar,
  contagemPorConta,
  gatePassa,
  linhaDeRecusa,
  linhaDoGate,
  produtoDoCaminhoLi,
  produtosDosVinculosLi,
  recusaSemContasLi,
  type Achado,
  type ContaLida,
  type EntradaDoCenso,
  type ProdutoLido,
  type ResultadoDoCenso,
  type VinculoLido,
  type VinculosDeOutrosCanais,
} from './transform';

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                   */
/* -------------------------------------------------------------------------- */

/** Loja Integrada contas A and B, a Mercado Livre M, a Shopee S, and Z of another tipo. */
const CONTAS: ContaLida[] = [
  { id: 'A', tipo: 3 },
  { id: 'B', tipo: 3 },
  { id: 'M', tipo: 1 },
  { id: 'S', tipo: 5 },
  { id: 'Z', tipo: 8 },
];
const TIPO_POR_CONTA = new Map(CONTAS.map((c) => [c.id, c.tipo] as const));

/** The public example store product id. */
const ID_LI = 182904918;

/** A counting link of conta A under `produtos/<produtoId>`. */
function vinculoLi(
  produtoId: string,
  docId: string,
  over: Record<string, unknown> = {},
): VinculoLido {
  return {
    caminho: `produtos/${produtoId}/produtolojaintegrada/${docId}`,
    dados: { contaLojaIntegrada: 'documents/integracao/A', id: ID_LI, removido: false, ...over },
  };
}

const produto = (over: Partial<ProdutoLido> = {}): ProdutoLido => ({
  existe: true,
  integracoesComProduto: [],
  paiId: null,
  ...over,
});

const SEM_OUTROS: VinculosDeOutrosCanais = {
  produtoMercadoLivre: [],
  variacaoMercadoLivre: [],
  prodshopee: [],
};

/**
 * One corpus. `produtos` names every produto the links point at; every existing one gets
 * {@link SEM_OUTROS} unless `outros` says otherwise. A produto left out of `produtos` reads as
 * absent, the way a `getAll` miss does.
 */
function entrada(over: {
  contas?: ContaLida[];
  vinculosLi?: VinculoLido[];
  produtos?: Record<string, ProdutoLido>;
  outros?: Record<string, Partial<VinculosDeOutrosCanais>>;
}): EntradaDoCenso {
  const vinculosLi = over.vinculosLi ?? [];
  const produtos = new Map<string, ProdutoLido>();
  for (const id of produtosDosVinculosLi(vinculosLi)) {
    produtos.set(id, over.produtos?.[id] ?? produto({ existe: false }));
  }
  const outrosCanais = new Map<string, VinculosDeOutrosCanais>();
  for (const [id, p] of produtos) {
    if (p.existe) outrosCanais.set(id, { ...SEM_OUTROS, ...(over.outros?.[id] ?? {}) });
  }
  return { contas: over.contas ?? CONTAS, vinculosLi, produtos, outrosCanais };
}

/**
 * A healthy witness produto: a counting link of A, and A already in the array. It keeps the gate
 * evaluated (contas and counting links above 0) and reports nothing itself.
 */
const TESTEMUNHA = {
  vinculo: vinculoLi('testemunha', '1', { id: 1 }),
  produto: produto({ integracoesComProduto: ['A'] }),
};

/** The census over the witness plus `vinculos` and `produtos`. */
function censoCom(
  vinculos: VinculoLido[],
  produtos: Record<string, ProdutoLido>,
  outros: Record<string, Partial<VinculosDeOutrosCanais>> = {},
): ResultadoDoCenso {
  return censar(
    entrada({
      vinculosLi: [TESTEMUNHA.vinculo, ...vinculos],
      produtos: { testemunha: TESTEMUNHA.produto, ...produtos },
      outros,
    }),
  );
}

const classes = (r: ResultadoDoCenso) => r.achados.map((a) => [a.classe, a.caminho, a.contaId]);
const daClasse = (r: ResultadoDoCenso, classe: string): Achado[] =>
  r.achados.filter((a) => a.classe === classe);

/* -------------------------------------------------------------------------- */

describe('equal pairs: every stored shape of one gap reports li-ausente', () => {
  const casos: Array<[string, Record<string, unknown>, Partial<ProdutoLido>]> = [
    ['the canonical ref', { contaLojaIntegrada: 'documents/integracao/A' }, {}],
    ['the bare ref', { contaLojaIntegrada: 'integracao/A' }, {}],
    ['a ref with a leading slash', { contaLojaIntegrada: '/documents/integracao/A' }, {}],
    ['an id stored as its decimal text', { id: String(ID_LI) }, {}],
    ['a hidden link (ativo: false)', { ativo: false }, {}],
    ['a blocked link (bloqueado: true)', { bloqueado: true }, {}],
    ['the anchor field absent', {}, { integracoesComProduto: undefined }],
    ['the anchor field null', {}, { integracoesComProduto: null }],
    ['an array holding only other contas', {}, { integracoesComProduto: ['B', 'M', 'S'] }],
  ];

  it.each(casos)('%s ⇒ li-ausente, and A in the add plan', (_nome, link, prod) => {
    const r = censoCom([vinculoLi('p', '9', link)], { p: produto(prod) });
    expect(classes(r).filter(([c]) => c !== CLASSE.liIdTexto)).toEqual([
      [CLASSE.liAusente, 'produtos/p', 'A'],
    ]);
    expect(r.plano).toEqual([{ produtoId: 'p', contaId: 'A' }]);
    expect(r.gate.ausente).toBe(1);
  });

  it('the li-ausente row carries the stored value it was judged against', () => {
    const r = censoCom([vinculoLi('p', '9')], { p: produto({ integracoesComProduto: ['B'] }) });
    expect(daClasse(r, CLASSE.liAusente)[0]).toMatchObject({
      campo: 'integracoesComProduto',
      valor: ['B'],
    });
  });

  it('two counting links of A on one produto are ONE gap', () => {
    const r = censoCom([vinculoLi('p', '9'), vinculoLi('p', '10', { id: 7 })], { p: produto() });
    expect(r.plano).toEqual([{ produtoId: 'p', contaId: 'A' }]);
    expect(r.gate.ausente).toBe(1);
    // Both links counted, the witness's too.
    expect(r.gate.vinculosQueContam).toBe(3);
  });

  it('a produto missing two contas is two gaps, sorted by conta', () => {
    const r = censoCom(
      [vinculoLi('p', '9', { contaLojaIntegrada: 'documents/integracao/B' }), vinculoLi('p', '8')],
      { p: produto() },
    );
    expect(r.plano).toEqual([
      { produtoId: 'p', contaId: 'A' },
      { produtoId: 'p', contaId: 'B' },
    ]);
  });
});

describe('Loja Integrada near misses', () => {
  it.each([
    ['in the trash (removido: true)', { removido: true }],
    ["an id that is not canonical ('07')", { id: '07' }],
    ['no store product id (id: null)', { id: null }],
    ['an id of 0', { id: 0 }],
  ])('a link %s does not count ⇒ no finding at all', (_nome, link) => {
    const r = censoCom([vinculoLi('p', '9', link)], { p: produto() });
    expect(r.achados).toEqual([]);
    expect(r.plano).toEqual([]);
  });

  it('an array already holding A ⇒ no finding', () => {
    const r = censoCom([vinculoLi('p', '9')], {
      p: produto({ integracoesComProduto: ['B', 'A'] }),
    });
    expect(r.achados).toEqual([]);
  });

  it('⚠️ NEAR-MISS: a ref to another collection is li-conta-ilegivel, never li-ausente', () => {
    const r = censoCom([vinculoLi('p', '9', { contaLojaIntegrada: 'documents/categorias/A' })], {
      p: produto(),
    });
    expect(classes(r)).toEqual([
      [CLASSE.liContaIlegivel, 'produtos/p/produtolojaintegrada/9', null],
    ]);
    expect(r.plano).toEqual([]);
  });

  it.each([
    ['absent', undefined],
    ['a number', 42],
    ['inside an array', ['documents/integracao/A']],
    ['a bare id (not a ref)', 'A'],
    ['another channel field only', undefined, { contaOuterRef: 'documents/integracao/A' }],
  ])(
    'a counting link whose conta ref is %s ⇒ li-conta-ilegivel, never a silent drop',
    (_nome, ref, extra: Record<string, unknown> = {}) => {
      const r = censoCom([vinculoLi('p', '9', { contaLojaIntegrada: ref, ...extra })], {
        p: produto(),
      });
      expect(classes(r)).toEqual([
        [CLASSE.liContaIlegivel, 'produtos/p/produtolojaintegrada/9', null],
      ]);
      expect(r.plano).toEqual([]);
    },
  );

  it("⚠️ NEAR-MISS: an array holding 'integracao/A' does not hold A ⇒ li-ausente AND entrada-em-forma-de-caminho", () => {
    const r = censoCom([vinculoLi('p', '9')], {
      p: produto({ integracoesComProduto: ['integracao/A'] }),
    });
    expect(classes(r)).toEqual([
      [CLASSE.entradaEmFormaDeCaminho, 'produtos/p', 'A'],
      [CLASSE.liAusente, 'produtos/p', 'A'],
    ]);
    expect(daClasse(r, CLASSE.entradaEmFormaDeCaminho)[0]!.valor).toBe('integracao/A');
    expect(r.plano).toEqual([{ produtoId: 'p', contaId: 'A' }]);
  });

  it("the canonical path form 'documents/integracao/A' is a path-shaped entry too", () => {
    const r = censoCom([vinculoLi('p', '9')], {
      p: produto({ integracoesComProduto: ['documents/integracao/A'] }),
    });
    expect(daClasse(r, CLASSE.entradaEmFormaDeCaminho)).toHaveLength(1);
    expect(daClasse(r, CLASSE.liAusente)).toHaveLength(1);
  });

  it.each([[' A'], ['A '], ['a']])(
    '⚠️ NEAR-MISS: an array holding %j does not hold A (no fold on the stored side) ⇒ li-ausente',
    (armazenado) => {
      const r = censoCom([vinculoLi('p', '9')], {
        p: produto({ integracoesComProduto: [armazenado] }),
      });
      expect(classes(r)).toEqual([[CLASSE.liAusente, 'produtos/p', 'A']]);
    },
  );

  it('a link of a conta whose doc is gone ⇒ li-conta-inexistente, never li-ausente', () => {
    const r = censoCom([vinculoLi('p', '9', { contaLojaIntegrada: 'documents/integracao/X' })], {
      p: produto(),
    });
    expect(classes(r)).toEqual([
      [CLASSE.liContaInexistente, 'produtos/p/produtolojaintegrada/9', 'X'],
    ]);
    expect(r.plano).toEqual([]);
    expect(r.gate.contaInexistente).toBe(1);
  });

  it.each([['M'], ['S'], ['Z']])(
    'a Loja Integrada link naming conta %s (another tipo) ⇒ li-conta-de-outro-tipo',
    (conta) => {
      const r = censoCom(
        [vinculoLi('p', '9', { contaLojaIntegrada: `documents/integracao/${conta}` })],
        { p: produto() },
      );
      expect(classes(r)).toEqual([
        [CLASSE.liContaDeOutroTipo, 'produtos/p/produtolojaintegrada/9', conta],
      ]);
      expect(daClasse(r, CLASSE.liContaDeOutroTipo)[0]!.valor).toMatchObject({
        tipoDaConta: TIPO_POR_CONTA.get(conta),
      });
      expect(r.plano).toEqual([]);
    },
  );

  it("a conta whose tipo is stored as the TEXT '3' is not a Loja Integrada conta", () => {
    const r = censar(
      entrada({
        contas: [...CONTAS, { id: 'T', tipo: '3' }],
        vinculosLi: [
          TESTEMUNHA.vinculo,
          vinculoLi('p', '9', { contaLojaIntegrada: 'documents/integracao/T' }),
        ],
        produtos: { testemunha: TESTEMUNHA.produto, p: produto() },
      }),
    );
    expect(classes(r)).toEqual([
      [CLASSE.liContaDeOutroTipo, 'produtos/p/produtolojaintegrada/9', 'T'],
    ]);
  });

  it.each([
    ['a map', { A: true }],
    ['a string', 'A'],
    ['a number', 3],
    ['a boolean', true],
  ])('the anchor field stored as %s ⇒ li-campo-invalido, never in the add plan', (_n, valor) => {
    const r = censoCom([vinculoLi('p', '9')], { p: produto({ integracoesComProduto: valor }) });
    expect(classes(r)).toEqual([[CLASSE.liCampoInvalido, 'produtos/p', 'A']]);
    expect(daClasse(r, CLASSE.liCampoInvalido)[0]!.valor).toEqual(valor);
    expect(r.plano).toEqual([]);
    expect(r.gate).toMatchObject({ ausente: 0, campoInvalido: 1 });
    expect(gatePassa(r.gate)).toBe(false);
  });

  it('an orphan link (its produto doc is gone) ⇒ li-produto-ausente, nothing else', () => {
    const r = censar(
      entrada({
        vinculosLi: [TESTEMUNHA.vinculo, vinculoLi('sumiu', '9')],
        produtos: { testemunha: TESTEMUNHA.produto },
      }),
    );
    expect(classes(r)).toEqual([
      [CLASSE.liProdutoAusente, 'produtos/sumiu/produtolojaintegrada/9', 'A'],
    ]);
    expect(r.plano).toEqual([]);
    expect(r.gate.produtos).toBe(1);
    expect(r.gate.vinculosQueContam).toBe(1);
  });
});

describe('the safety rule: the add plan only ever holds Loja Integrada contas', () => {
  it('ML, Shopee and other-tipo findings never reach the plan', () => {
    const r = censoCom(
      [
        vinculoLi('p', '1'),
        vinculoLi('p', '2', { contaLojaIntegrada: 'documents/integracao/M' }),
        vinculoLi('p', '3', { contaLojaIntegrada: 'documents/integracao/Z' }),
        vinculoLi('p', '4', { contaLojaIntegrada: 'documents/integracao/S' }),
        vinculoLi('q', '5', { contaLojaIntegrada: 'documents/integracao/B' }),
      ],
      { p: produto(), q: produto({ integracoesComProduto: null }) },
      {
        p: {
          produtoMercadoLivre: [
            {
              caminho: 'produtos/p/produtoMercadoLivre/x',
              dados: { contaOuterRef: 'documents/integracao/M', id: 'MLB1', estado: 'a' },
            },
          ],
          prodshopee: [
            {
              caminho: 'produtos/p/prodshopee/y',
              dados: { contaProdutoShopeeOuterRef: 'documents/integracao/S', item_id: 12 },
            },
          ],
        },
      },
    );
    expect(daClasse(r, CLASSE.mlAusente)).toHaveLength(1);
    expect(daClasse(r, CLASSE.shopeeAusente)).toHaveLength(1);
    expect(r.plano).toEqual([
      { produtoId: 'p', contaId: 'A' },
      { produtoId: 'q', contaId: 'B' },
    ]);
    for (const { contaId } of r.plano) expect(TIPO_POR_CONTA.get(contaId)).toBe(3);
  });

  it('only the two gate classes are gated', () => {
    expect([...CLASSES_DO_GATE].sort()).toEqual([CLASSE.liAusente, CLASSE.liCampoInvalido]);
  });
});

describe('Mercado Livre (report only)', () => {
  const pml = (dados: Record<string, unknown>) => ({
    caminho: 'produtos/p/produtoMercadoLivre/x',
    dados: { contaOuterRef: 'documents/integracao/M', id: 'MLB1', estado: 'a', ...dados },
  });
  const vml = (dados: Record<string, unknown>) => ({
    caminho: 'produtos/p/variacaoMercadoLivre/v',
    dados: { contaOuterRef: 'documents/integracao/M', id: 77, ...dados },
  });
  const comMl = (outros: Partial<VinculosDeOutrosCanais>) =>
    censoCom(
      [vinculoLi('p', '9')],
      { p: produto({ integracoesComProduto: ['A'] }) },
      { p: outros },
    );

  it('a live parent link of M missing from the array ⇒ ml-ausente', () => {
    const r = comMl({ produtoMercadoLivre: [pml({})] });
    expect(classes(r)).toEqual([[CLASSE.mlAusente, 'produtos/p', 'M']]);
    expect(r.plano).toEqual([]);
  });

  it('M already in the array ⇒ nothing', () => {
    const r = censoCom(
      [vinculoLi('p', '9')],
      { p: produto({ integracoesComProduto: ['A', 'M'] }) },
      { p: { produtoMercadoLivre: [pml({})] } },
    );
    expect(r.achados).toEqual([]);
  });

  it.each([
    ["estado 'rm'", { estado: 'rm' }],
    ["estado 'c'", { estado: 'c' }],
    ['a numeric id', { id: 123 }],
    ['an empty id', { id: '' }],
  ])('⚠️ NEAR-MISS: a parent link with %s does not count ⇒ no finding', (_n, dados) => {
    expect(comMl({ produtoMercadoLivre: [pml(dados)] }).achados).toEqual([]);
  });

  it('a variation link with its own conta ⇒ ml-variacao-ausente', () => {
    const r = comMl({ variacaoMercadoLivre: [vml({})] });
    expect(classes(r)).toEqual([[CLASSE.mlVariacaoAusente, 'produtos/p', 'M']]);
  });

  it('⚠️ a variation link with a null contaOuterRef ⇒ ml-variacao-sem-conta, never ml-variacao-ausente (no parent hop)', () => {
    const r = comMl({
      variacaoMercadoLivre: [vml({ contaOuterRef: null })],
      produtoMercadoLivre: [],
    });
    expect(classes(r)).toEqual([
      [CLASSE.mlVariacaoSemConta, 'produtos/p/variacaoMercadoLivre/v', null],
    ]);
  });

  it('ML conta classes: unreadable, gone, another tipo', () => {
    const r = comMl({
      produtoMercadoLivre: [
        {
          ...pml({ contaOuterRef: 'documents/categorias/M' }),
          caminho: 'produtos/p/produtoMercadoLivre/1',
        },
        {
          ...pml({ contaOuterRef: 'documents/integracao/X' }),
          caminho: 'produtos/p/produtoMercadoLivre/2',
        },
        {
          ...pml({ contaOuterRef: 'documents/integracao/A' }),
          caminho: 'produtos/p/produtoMercadoLivre/3',
        },
      ],
    });
    expect(classes(r)).toEqual([
      [CLASSE.mlContaIlegivel, 'produtos/p/produtoMercadoLivre/1', null],
      [CLASSE.mlContaInexistente, 'produtos/p/produtoMercadoLivre/2', 'X'],
      [CLASSE.mlContaDeOutroTipo, 'produtos/p/produtoMercadoLivre/3', 'A'],
    ]);
  });
});

describe('Shopee (report only)', () => {
  const ps = (dados: Record<string, unknown>) => ({
    caminho: 'produtos/p/prodshopee/y',
    dados: { contaProdutoShopeeOuterRef: 'documents/integracao/S', item_id: 12, ...dados },
  });
  const comShopee = (dados: Record<string, unknown>) =>
    censoCom(
      [vinculoLi('p', '9')],
      { p: produto({ integracoesComProduto: ['A'] }) },
      { p: { prodshopee: [ps(dados)] } },
    );

  it('a live listing of S missing from the array ⇒ shopee-ausente', () => {
    expect(classes(comShopee({}))).toEqual([[CLASSE.shopeeAusente, 'produtos/p', 'S']]);
  });

  it('an absent estadoAnuncio still reads as live', () => {
    expect(classes(comShopee({ estadoAnuncio: null }))).toEqual([
      [CLASSE.shopeeAusente, 'produtos/p', 'S'],
    ]);
  });

  it.each([
    ['a string item_id', { item_id: '12' }],
    ["estadoAnuncio 'removido'", { estadoAnuncio: 'removido' }],
    ['no item_id (a draft)', { item_id: null }],
  ])('⚠️ NEAR-MISS: %s does not count ⇒ no finding', (_n, dados) => {
    expect(comShopee(dados).achados).toEqual([]);
  });

  it('the Mercado Livre conta field on a Shopee link reads no conta ⇒ shopee-conta-ilegivel', () => {
    const r = comShopee({
      contaProdutoShopeeOuterRef: undefined,
      contaOuterRef: 'documents/integracao/S',
    });
    expect(classes(r)).toEqual([[CLASSE.shopeeContaIlegivel, 'produtos/p/prodshopee/y', null]]);
  });
});

describe('li-raiz-sem-vinculo', () => {
  it('a child whose root holds only a TRASHED link of A ⇒ reported on the child', () => {
    const r = censoCom(
      [vinculoLi('filho', '9'), vinculoLi('raiz', '8', { id: 5, removido: true })],
      {
        filho: produto({ paiId: 'raiz', integracoesComProduto: ['A'] }),
        raiz: produto({ integracoesComProduto: ['A'] }),
      },
    );
    expect(classes(r)).toEqual([[CLASSE.liRaizSemVinculo, 'produtos/filho', 'A']]);
    expect(daClasse(r, CLASSE.liRaizSemVinculo)[0]!.valor).toEqual({ raiz: 'raiz' });
  });

  it('a root holding a counting link of A ⇒ not reported', () => {
    const r = censoCom([vinculoLi('filho', '9'), vinculoLi('raiz', '8', { id: 5 })], {
      filho: produto({ paiId: 'raiz', integracoesComProduto: ['A'] }),
      raiz: produto({ integracoesComProduto: ['A'] }),
    });
    expect(r.achados).toEqual([]);
  });

  it('a root holding a counting link of ANOTHER conta only ⇒ reported for A', () => {
    const r = censoCom(
      [
        vinculoLi('filho', '9'),
        vinculoLi('raiz', '8', { contaLojaIntegrada: 'documents/integracao/B' }),
      ],
      {
        filho: produto({ paiId: 'raiz', integracoesComProduto: ['A'] }),
        raiz: produto({ integracoesComProduto: ['B'] }),
      },
    );
    expect(classes(r)).toEqual([[CLASSE.liRaizSemVinculo, 'produtos/filho', 'A']]);
  });

  it('a root with no Loja Integrada link at all (never point-read) ⇒ reported', () => {
    const r = censoCom([vinculoLi('filho', '9')], {
      filho: produto({ paiId: 'raiz', integracoesComProduto: ['A'] }),
    });
    expect(classes(r)).toEqual([[CLASSE.liRaizSemVinculo, 'produtos/filho', 'A']]);
  });

  it.each([[null], [undefined], [''], [7], ['filho']])(
    'paiId %j names no parent ⇒ not reported',
    (paiId) => {
      const r = censoCom([vinculoLi('filho', '9')], {
        filho: produto({ paiId, integracoesComProduto: ['A'] }),
      });
      expect(r.achados).toEqual([]);
    },
  );
});

describe('the path parser', () => {
  it('produtos/X/produtolojaintegrada/Y reads as X', () => {
    expect(produtoDoCaminhoLi('produtos/X/produtolojaintegrada/Y')).toBe('X');
  });

  it.each([
    ['a nested leaf', 'produtos/X/variacoes/V/produtolojaintegrada/Y'],
    ['a foreign root', 'clientes/X/produtolojaintegrada/Y'],
    ['another leaf', 'produtos/X/produtoMercadoLivre/Y'],
    ['a short path', 'produtos/X'],
    ['an empty id', 'produtos//produtolojaintegrada/Y'],
  ])('%s reads as no produto', (_n, caminho) => {
    expect(produtoDoCaminhoLi(caminho)).toBeNull();
  });

  it('an unexpected path ⇒ li-caminho-inesperado, and its produto is never point-read', () => {
    const torto: VinculoLido = {
      caminho: 'produtos/X/variacoes/V/produtolojaintegrada/Y',
      dados: { contaLojaIntegrada: 'documents/integracao/A', id: ID_LI },
    };
    expect(produtosDosVinculosLi([torto, TESTEMUNHA.vinculo])).toEqual(['testemunha']);
    const r = censoCom([torto], {});
    expect(classes(r)).toEqual([[CLASSE.liCaminhoInesperado, torto.caminho, 'A']]);
  });
});

describe('the refusals: NAO-AVALIADO, never 0 0', () => {
  it('zero Loja Integrada contas ⇒ sem-contas-li', () => {
    const contas = CONTAS.filter((c) => c.tipo !== 3);
    expect(recusaSemContasLi(contas)).toBe('sem-contas-li');
    const r = censar(
      entrada({ contas, vinculosLi: [vinculoLi('p', '9')], produtos: { p: produto() } }),
    );
    expect(r.gate.recusa).toBe('sem-contas-li');
    expect(gatePassa(r.gate)).toBe(false);
    expect(linhaDoGate(r.gate)).toBe(
      'GATE li: NAO-AVALIADO sem-contas-li contas-li=0 vinculos-que-contam=0',
    );
    expect(linhaDoGate(r.gate)).not.toContain('ausente=');
  });

  it("a conta of tipo '3' (text) alone is still zero Loja Integrada contas", () => {
    expect(recusaSemContasLi([{ id: 'T', tipo: '3' }])).toBe('sem-contas-li');
    expect(recusaSemContasLi(CONTAS)).toBeNull();
  });

  it.each([
    ['no link at all', [], {}],
    ['only trashed links', [vinculoLi('p', '9', { removido: true })], { p: produto() }],
    ['only orphan links', [vinculoLi('p', '9')], {}],
    [
      'only links of a gone conta',
      [vinculoLi('p', '9', { contaLojaIntegrada: 'documents/integracao/X' })],
      { p: produto() },
    ],
  ])(
    'Loja Integrada contas but %s ⇒ sem-vinculos-que-contam',
    (_n, vinculosLi: VinculoLido[], produtos: Record<string, ProdutoLido>) => {
      const r = censar(entrada({ vinculosLi, produtos }));
      expect(r.gate).toMatchObject({ recusa: 'sem-vinculos-que-contam', vinculosQueContam: 0 });
      expect(gatePassa(r.gate)).toBe(false);
      expect(linhaDoGate(r.gate)).toBe(
        'GATE li: NAO-AVALIADO sem-vinculos-que-contam contas-li=2 vinculos-que-contam=0',
      );
    },
  );

  it('the refusal before the walk prints no link count', () => {
    expect(linhaDeRecusa('sem-contas-li', 0, null)).toBe(
      'GATE li: NAO-AVALIADO sem-contas-li contas-li=0',
    );
  });

  it('an evaluated 0 0 ⇒ PASSA; a gap ⇒ BLOQUEIA', () => {
    const limpo = censoCom([], {});
    expect(limpo.gate.recusa).toBeNull();
    expect(linhaDoGate(limpo.gate)).toBe(
      'GATE li: ausente=0 campo-invalido=0 contas-li=2 vinculos-que-contam=1 produtos=1 => PASSA',
    );
    const comLacuna = censoCom([vinculoLi('p', '9')], { p: produto() });
    expect(linhaDoGate(comLacuna.gate)).toBe(
      'GATE li: ausente=1 campo-invalido=0 contas-li=2 vinculos-que-contam=2 produtos=2 => BLOQUEIA',
    );
  });
});

describe('li-id-texto and li-dono-duplicado (report only)', () => {
  it('a counting link with a TEXT id ⇒ li-id-texto', () => {
    const r = censoCom([vinculoLi('p', '9', { id: String(ID_LI) })], {
      p: produto({ integracoesComProduto: ['A'] }),
    });
    expect(classes(r)).toEqual([[CLASSE.liIdTexto, 'produtos/p/produtolojaintegrada/9', 'A']]);
  });

  it.each([
    ['a NUMBER id', { id: ID_LI }],
    ["a text id that does not count ('07')", { id: '07' }],
    ['a text id in the trash', { id: String(ID_LI), removido: true }],
  ])('⚠️ NEAR-MISS: %s ⇒ no li-id-texto', (_n, link) => {
    const r = censoCom([vinculoLi('p', '9', link)], {
      p: produto({ integracoesComProduto: ['A'] }),
    });
    expect(daClasse(r, CLASSE.liIdTexto)).toEqual([]);
  });

  it('two produtos holding (A, the same NUMBER id) ⇒ ONE li-dono-duplicado naming both', () => {
    const r = censoCom([vinculoLi('q', '9'), vinculoLi('p', '9')], {
      p: produto({ integracoesComProduto: ['A'] }),
      q: produto({ integracoesComProduto: ['A'] }),
    });
    expect(classes(r)).toEqual([[CLASSE.liDonoDuplicado, 'produtos/p', 'A']]);
    expect(daClasse(r, CLASSE.liDonoDuplicado)[0]!.valor).toEqual({
      id: ID_LI,
      produtos: ['p', 'q'],
    });
  });

  it('a trashed link is still an owner (the order import reads no removido)', () => {
    const r = censoCom([vinculoLi('p', '9'), vinculoLi('q', '9', { removido: true })], {
      p: produto({ integracoesComProduto: ['A'] }),
      q: produto({ integracoesComProduto: ['A'] }),
    });
    expect(classes(r)).toEqual([[CLASSE.liDonoDuplicado, 'produtos/p', 'A']]);
  });

  it.each([
    ['two links under ONE produto', [vinculoLi('p', '9'), vinculoLi('p', '10')], ['p']],
    [
      'the same id under two contas',
      [vinculoLi('p', '9'), vinculoLi('q', '9', { contaLojaIntegrada: 'documents/integracao/B' })],
      ['p', 'q'],
    ],
    [
      'one TEXT id and one number id',
      [vinculoLi('p', '9'), vinculoLi('q', '9', { id: String(ID_LI) })],
      ['p', 'q'],
    ],
    [
      'two different ids',
      [vinculoLi('p', '9'), vinculoLi('q', '9', { id: ID_LI + 1 })],
      ['p', 'q'],
    ],
  ])('⚠️ NEAR-MISS: %s ⇒ no li-dono-duplicado', (_n, vinculos: VinculoLido[], ids: string[]) => {
    const produtos = Object.fromEntries(
      ids.map((id) => [id, produto({ integracoesComProduto: ['A', 'B'] })]),
    );
    expect(daClasse(censoCom(vinculos, produtos), CLASSE.liDonoDuplicado)).toEqual([]);
  });

  it('⚠️ NEAR-MISS: an owner whose produto doc is gone counts for nothing', () => {
    const r = censoCom([vinculoLi('p', '9'), vinculoLi('sumiu', '9')], {
      p: produto({ integracoesComProduto: ['A'] }),
    });
    expect(daClasse(r, CLASSE.liDonoDuplicado)).toEqual([]);
  });
});

describe('idempotence and determinism', () => {
  /** A corpus with gaps of every applied kind, plus report-only noise. */
  function corpus(): EntradaDoCenso {
    return entrada({
      vinculosLi: [
        TESTEMUNHA.vinculo,
        vinculoLi('p1', '1'),
        vinculoLi('p1', '2', { contaLojaIntegrada: 'integracao/B', id: 11 }),
        vinculoLi('p2', '3', { contaLojaIntegrada: '/documents/integracao/A', id: '12' }),
        vinculoLi('p3', '4', { id: 13 }),
        vinculoLi('p4', '5', { removido: true }),
        vinculoLi('p5', '6', { contaLojaIntegrada: 'documents/integracao/M', id: 14 }),
        vinculoLi('filho', '7', { id: 15 }),
        vinculoLi('orfao', '8', { id: 16 }),
      ],
      produtos: {
        testemunha: TESTEMUNHA.produto,
        p1: produto({ integracoesComProduto: undefined }),
        p2: produto({ integracoesComProduto: null }),
        p3: produto({ integracoesComProduto: ['integracao/A', 'M'] }),
        p4: produto(),
        p5: produto(),
        filho: produto({ paiId: 'p4' }),
      },
      outros: {
        p1: {
          produtoMercadoLivre: [
            {
              caminho: 'produtos/p1/produtoMercadoLivre/x',
              dados: { contaOuterRef: 'documents/integracao/M', id: 'MLB1' },
            },
          ],
        },
      },
    });
  }

  /** The produtos as an apply would leave them: the stored array ∪ the planned contas. */
  function aplicarPlano(e: EntradaDoCenso, r: ResultadoDoCenso): EntradaDoCenso {
    const produtos = new Map(e.produtos);
    for (const { produtoId, contaId } of r.plano) {
      const p = produtos.get(produtoId)!;
      const atual = Array.isArray(p.integracoesComProduto)
        ? (p.integracoesComProduto as unknown[])
        : [];
      if (!atual.includes(contaId)) {
        produtos.set(produtoId, { ...p, integracoesComProduto: [...atual, contaId] });
      }
    }
    return { ...e, produtos };
  }

  it('the transform over its own output reports zero gated rows', () => {
    const primeira = censar(corpus());
    expect(primeira.plano.length).toBeGreaterThan(0);
    const segunda = censar(aplicarPlano(corpus(), primeira));
    expect(segunda.plano).toEqual([]);
    expect(segunda.achados.filter((a) => CLASSES_DO_GATE.has(a.classe))).toEqual([]);
    expect(gatePassa(segunda.gate)).toBe(true);
    // The judged population did not shrink: the same contas, the same counting links.
    expect(segunda.gate.contasLi).toBe(primeira.gate.contasLi);
    expect(segunda.gate.vinculosQueContam).toBe(primeira.gate.vinculosQueContam);
    // Report-only findings are not the apply's to fix.
    expect(daClasse(segunda, CLASSE.mlAusente)).toHaveLength(1);
    expect(daClasse(segunda, CLASSE.entradaEmFormaDeCaminho)).toHaveLength(1);
  });

  it('shuffled input gives byte-identical output', () => {
    const base = corpus();
    const embaralhar = <T>(xs: readonly T[]): T[] => {
      const out = [...xs].reverse();
      return [...out.slice(3), ...out.slice(0, 3)];
    };
    const embaralhado: EntradaDoCenso = {
      contas: embaralhar(base.contas),
      vinculosLi: embaralhar(base.vinculosLi),
      produtos: new Map(embaralhar([...base.produtos.entries()])),
      outrosCanais: new Map(embaralhar([...base.outrosCanais.entries()])),
    };
    expect(JSON.stringify(censar(embaralhado))).toBe(JSON.stringify(censar(base)));
  });

  it('findings come sorted by path, then conta, then class', () => {
    const r = censar(corpus());
    const chaves = r.achados.map((a) => [a.caminho, a.contaId ?? '', a.classe] as const);
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    expect(chaves).toEqual(
      [...chaves].sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]) || cmp(a[2], b[2])),
    );
    // A produto's own rows come before its links' rows.
    const p2 = chaves.filter(([c]) => c.startsWith('produtos/p2')).map(([c]) => c);
    expect(p2).toEqual(['produtos/p2', 'produtos/p2/produtolojaintegrada/3']);
  });
});

describe('the summary', () => {
  it('every Loja Integrada conta is listed with its counting links, zero included', () => {
    const r = censoCom([vinculoLi('p', '9')], { p: produto() });
    expect(r.vinculosPorConta).toEqual([
      ['A', 2],
      ['B', 0],
    ]);
  });

  it('counts per (channel, conta, class)', () => {
    const r = censoCom(
      [vinculoLi('p', '9'), vinculoLi('q', '9', { id: 2 }), vinculoLi('q', '8', { id: 'x' })],
      { p: produto(), q: produto({ integracoesComProduto: { invalido: true } }) },
    );
    expect(contagemPorConta(r.achados)).toEqual([
      { canal: 'li', contaId: 'A', classe: CLASSE.liAusente, n: 1 },
      { canal: 'li', contaId: 'A', classe: CLASSE.liCampoInvalido, n: 1 },
    ]);
  });
});
