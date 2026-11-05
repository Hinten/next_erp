/**
 * The product import's fill-empty (`completar.ts`) on the fake Firestore: the one unit conversion,
 * "empty" on both sides, the field map (a variation's inherited category, dimensions and brand),
 * the kit root, the tier-1 writes re-planned after a lost race, our own write recognised after a
 * lost reply, the third loss, the extraData create, and every key outside the table untouched.
 *
 * Every decision is pinned as a PAIR (the equal case and the near-miss). Nothing reaches the network
 * (D17): the GLOBAL `fetch` is stubbed to throw for the whole file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  type MarcaCatalogoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import {
  detalheLi,
  filhoLi,
  linhaProdutoLi,
  paiLi,
  vistaDetalhadaLi,
  vistaLi,
} from '../testing/produtosLi';
import {
  CATEGORIA_NO_PREENCHIMENTO_LI,
  type DepsPreenchimentoLi,
  type FonteDoPreenchimentoLi,
  MAX_TENTATIVAS_PREENCHIMENTO_LI,
  type ResultadoDoPreenchimentoLi,
  TIPO_RESULTADO_PREENCHIMENTO_LI,
  type ValoresDoLiLi,
  medidasErpDoDetalheLi,
  planejarPreenchimentoExtraDataLi,
  planejarPreenchimentoProdutoLi,
  preencherProdutoLi,
  valoresDoLiLi,
  vazioNoErpLi,
} from './completar';
import { PAPEL_DO_VINCULO_LI } from './plano';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('completar.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------- fixtures --------------------------------- */

const PRODUTO = 'erp-completar-1';
const P = `produtos/${PRODUTO}`;
const X = `${P}/extraData/singleton`;
const CATEGORIA_ERP = 'cat-erp-completar';
const REF_CATEGORIA = `documents/categorias/${CATEGORIA_ERP}`;

const MARCA = 5001;
const MARCA_SEM_NOME = 5002;
const MARCAS: readonly MarcaCatalogoLi[] = [
  { id: MARCA, nome: 'Marca Neutra', ativo: true },
  { id: MARCA_SEM_NOME, nome: '', ativo: true },
];
const uriMarca = (id: number) => `/api/v1/marca/${String(id)}`;

const DESCRICAO = '<p>Uma descrição neutra.</p>';

/** A root detail view: GTIN, the default measures (`"0.200"`, 10/12/14), a brand, a description. */
function detalheRaiz(over: DocData = {}, linha: DocData = {}) {
  return vistaDetalhadaLi(
    detalheLi(linhaProdutoLi(9001, { gtin: '7890000000017', ...linha }), null, {
      marca: uriMarca(MARCA),
      descricao_completa: DESCRICAO,
      ...over,
    }),
  );
}

/** A root's source: its row, its detail, the ERP category it resolved to, the job's brands. */
function fonte(over: Partial<FonteDoPreenchimentoLi> = {}): FonteDoPreenchimentoLi {
  const detalhe = over.detalhe === undefined ? detalheRaiz() : over.detalhe;
  return {
    papel: PAPEL_DO_VINCULO_LI.raiz,
    linha: vistaLi(linhaProdutoLi(9001, { gtin: '7890000000017' })),
    detalhe,
    detalheDoPai: null,
    categoriaErpId: CATEGORIA_ERP,
    marcas: MARCAS,
    ...over,
  };
}

/** A variation's source under a parent whose detail carries `paiOver`. */
function fonteDoFilho(
  filhoOver: DocData | null,
  paiOver: DocData = {},
  over: Partial<FonteDoPreenchimentoLi> = {},
): FonteDoPreenchimentoLi {
  const linha = filhoLi(9101, { gtin: '7890000000024' });
  const detalheDoPai = vistaDetalhadaLi(
    detalheLi(paiLi(9100, [9101]), null, {
      marca: uriMarca(MARCA),
      peso: '0.900',
      altura: 30,
      largura: 40,
      profundidade: 50,
      ...paiOver,
    }),
  );
  return {
    papel: PAPEL_DO_VINCULO_LI.filho,
    linha: vistaLi(linha),
    detalhe:
      filhoOver === null
        ? null
        : vistaDetalhadaLi(detalheLi(linha, 9100, { marca: null, ...filhoOver })),
    detalheDoPai,
    categoriaErpId: CATEGORIA_ERP,
    marcas: MARCAS,
    ...over,
  };
}

/** Every table field EMPTY, and a value on every field the fill must never touch. */
function produtoErp(over: DocData = {}): DocData {
  return {
    nome: 'Produto do ERP',
    sku: 'SKU-ERP-1',
    codPai: 'PAI-1',
    paiId: null,
    filhoUnicoId: null,
    codFornecedor: 'FORN-1',
    ordem: 3,
    gtin: null,
    categoriaProdutoOuterRef: null,
    tabelaDeMedidasModaUid: null,
    pesoLiquidoKg: null,
    pesoBrutoKg: null,
    alturaCm: null,
    larguraCm: null,
    profundidadeCm: null,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    ofereceFreteGratis: false,
    permiteVendaSemEstoque: false,
    ehUsado: false,
    crossdocking: 2,
    precos: { lista1: { valor: 10.5 } },
    custo: 4.25,
    propagatePriceToChildren: true,
    grupoDeVariacoesUid: null,
    variacoesUid: null,
    componentesKitKeys: null,
    componentesKit: null,
    integracoesComProduto: ['documents/integracao/outra-conta'],
    fotos: null,
    videos: null,
    anexos: null,
    fotosArquivosIds: null,
    // Keys the schema no longer models, kept by the migrated corpus: never written, never dropped.
    marketplace: [{ legado: true }],
    marketplaceIds: ['ml-1'],
    statusProdutosMarketplace: { ml: 'ativo' },
    timestamp: AGORA_MS - 86_400_000,
    ultimaModificacao: AGORA_MS - 86_400_000,
    ...over,
  };
}

/** An extraData singleton with every field the fill must never touch set. */
function extraDataErp(over: DocData = {}): DocData {
  return {
    descricao: null,
    marca: null,
    metaDescricao: 'Meta da loja',
    keyWords: ['a', 'b'],
    youtube: 'https://video.invalid/v',
    condicao: 2,
    coteudoAdulto: false,
    itensNoKit: null,
    googleMerchantData: null,
    campoNaoModelado: 'fica',
    ...over,
  };
}

function deps(
  db: FakeDb,
  modo: ModoImportacaoLi = MODO_IMPORTACAO_LI.aplicar,
): DepsPreenchimentoLi {
  return { db: asDb(db), modo, agoraMs: () => AGORA_MS };
}

async function preencher(
  db: FakeDb,
  f: FonteDoPreenchimentoLi = fonte(),
  modo: ModoImportacaoLi = MODO_IMPORTACAO_LI.aplicar,
  liId: number | null = null,
): Promise<ResultadoDoPreenchimentoLi> {
  return preencherProdutoLi(deps(db, modo), {
    produtoId: PRODUTO,
    liId,
    valores: valoresDoLiLi(f),
  });
}

function preenchido(r: ResultadoDoPreenchimentoLi) {
  if (r.tipo !== TIPO_RESULTADO_PREENCHIMENTO_LI.preenchido) {
    throw new Error(`esperava um preenchimento, veio ${r.tipo}`);
  }
  return r;
}

const TODOS_OS_CAMPOS = [
  'gtin',
  'pesoLiquidoKg',
  'pesoBrutoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
  'categoriaProdutoOuterRef',
  'extraData.descricao',
  'extraData.marca',
];

/** The values a plan takes, in the ERP's units, overridable field by field. */
function valores(over: Partial<ValoresDoLiLi> = {}): ValoresDoLiLi {
  return {
    gtin: '7890000000017',
    medidas: { pesoKg: 0.2, alturaCm: 10, larguraCm: 12, profundidadeCm: 14 },
    categoriaErpId: CATEGORIA_ERP,
    descricao: DESCRICAO,
    descricaoLongaTamanho: null,
    marca: 'Marca Neutra',
    ...over,
  };
}

/* ------------------------------ the units ---------------------------------- */

describe('medidasErpDoDetalheLi — the ONE unit conversion', () => {
  const medidas = (peso: unknown, over: DocData = {}) =>
    medidasErpDoDetalheLi(detalheRaiz({ peso, ...over }));

  it('EQUAL PAIR: the decimal text and its float noise store the same weight — "0.500" ⇒ 0.5, "0.450000000000000011…" ⇒ 0.45', () => {
    expect(medidas('0.500').pesoKg).toBe(0.5);
    expect(medidas('0.450000000000000011102230246251565').pesoKg).toBe(0.45);
    expect(medidas('0.45').pesoKg).toBe(0.45);
    // Noise that a plain parse would keep, absorbed by the gram the ERP weighs in.
    expect(medidas('0.19999999999999998').pesoKg).toBe(0.2);
  });

  it('NEAR-MISS: one gram apart stays apart — "0.451" is not 0.45, "0.449" is not 0.45', () => {
    expect(medidas('0.451').pesoKg).toBe(0.451);
    expect(medidas('0.449').pesoKg).toBe(0.449);
  });

  it('a weight under half a gram is NOTHING, never a 0 that would fill the field for good', () => {
    expect(medidas('0.0004').pesoKg).toBeNull();
    expect(medidas('0.0005').pesoKg).toBe(0.001);
  });

  it('dimensions are kept as read (cm); no detail ⇒ no measure at all', () => {
    expect(medidas('0.200', { altura: 10, largura: 12.5, profundidade: 14 })).toEqual({
      pesoKg: 0.2,
      alturaCm: 10,
      larguraCm: 12.5,
      profundidadeCm: 14,
    });
    expect(medidasErpDoDetalheLi(null)).toEqual({
      pesoKg: null,
      alturaCm: null,
      larguraCm: null,
      profundidadeCm: null,
    });
  });
});

/* ------------------------------- "empty" ----------------------------------- */

describe('vazioNoErpLi — what the fill may write over', () => {
  it('EQUAL PAIR: absent, null and "" are all empty', () => {
    expect(vazioNoErpLi({}, 'gtin')).toBe(true);
    expect(vazioNoErpLi({ gtin: null }, 'gtin')).toBe(true);
    expect(vazioNoErpLi({ gtin: '' }, 'gtin')).toBe(true);
  });

  it('NEAR-MISS: "x", 0, false and a lone space are VALUES, never replaced', () => {
    expect(vazioNoErpLi({ gtin: 'x' }, 'gtin')).toBe(false);
    expect(vazioNoErpLi({ pesoLiquidoKg: 0 }, 'pesoLiquidoKg')).toBe(false);
    expect(vazioNoErpLi({ alturaCm: false }, 'alturaCm')).toBe(false);
    expect(vazioNoErpLi({ gtin: ' ' }, 'gtin')).toBe(false);
  });

  it('only an OWN key counts: an inherited one does not make the field a value', () => {
    const herdado = Object.create({ gtin: 'herdado' }) as Record<string, unknown>;
    expect(vazioNoErpLi(herdado, 'gtin')).toBe(true);
  });
});

/* ------------------------------ the field map ------------------------------ */

describe('valoresDoLiLi — what the store gives each produto', () => {
  it('a root: its own GTIN, measures, description, and its brand by id from the job list', () => {
    expect(valoresDoLiLi(fonte())).toEqual({
      gtin: '7890000000017',
      medidas: { pesoKg: 0.2, alturaCm: 10, larguraCm: 12, profundidadeCm: 14 },
      categoriaErpId: CATEGORIA_ERP,
      descricao: DESCRICAO,
      descricaoLongaTamanho: null,
      marca: 'Marca Neutra',
    });
  });

  it('a root with no detail read: only the row GTIN — no measure, no description, no brand', () => {
    expect(valoresDoLiLi(fonte({ detalhe: null }))).toEqual({
      gtin: '7890000000017',
      medidas: { pesoKg: null, alturaCm: null, larguraCm: null, profundidadeCm: null },
      categoriaErpId: CATEGORIA_ERP,
      descricao: null,
      descricaoLongaTamanho: null,
      marca: null,
    });
  });

  it('the store "" is nothing: an empty GTIN, description and brand name are never values', () => {
    const v = valoresDoLiLi(
      fonte({
        linha: vistaLi(linhaProdutoLi(9001, { gtin: '' })),
        detalhe: detalheRaiz(
          { descricao_completa: '', marca: uriMarca(MARCA_SEM_NOME), peso: '' },
          { gtin: '' },
        ),
      }),
    );
    expect(v.gtin).toBeNull();
    expect(v.descricao).toBeNull();
    expect(v.marca).toBeNull();
    expect(v.medidas.pesoKg).toBeNull();
  });

  it('the detail, when read, decides the GTIN: its nothing is not overruled by the row', () => {
    const linha = vistaLi(linhaProdutoLi(9001, { gtin: '7890000000017' }));
    expect(valoresDoLiLi(fonte({ linha, detalhe: detalheRaiz({}, { gtin: '' }) })).gtin).toBeNull();
    expect(valoresDoLiLi(fonte({ linha, detalhe: null })).gtin).toBe('7890000000017');
  });

  it('a brand id the job list does not hold is nothing; a detail with no brand is nothing', () => {
    expect(
      valoresDoLiLi(fonte({ detalhe: detalheRaiz({ marca: uriMarca(7777) }) })).marca,
    ).toBeNull();
    expect(valoresDoLiLi(fonte({ detalhe: detalheRaiz({ marca: null }) })).marca).toBeNull();
  });

  it('a description over 3,000 characters: no text, only its length', () => {
    const v = valoresDoLiLi(
      fonte({ detalhe: detalheRaiz({ descricao_completa: 'a'.repeat(3001) }) }),
    );
    expect(v.descricao).toBeNull();
    expect(v.descricaoLongaTamanho).toBe(3001);
    const noLimite = valoresDoLiLi(
      fonte({ detalhe: detalheRaiz({ descricao_completa: 'a'.repeat(3000) }) }),
    );
    expect(noLimite.descricao).toHaveLength(3000);
    expect(noLimite.descricaoLongaTamanho).toBeNull();
  });

  it('EQUAL PAIR: a variation whose detail has NONE of the three dimensions takes its parent box; its weight stays its own', () => {
    const v = valoresDoLiLi(
      fonteDoFilho({ peso: '0.300', altura: null, largura: null, profundidade: null }),
    );
    expect(v.medidas).toEqual({ pesoKg: 0.3, alturaCm: 30, larguraCm: 40, profundidadeCm: 50 });
    expect(v.gtin).toBe('7890000000024');
  });

  it('NEAR-MISS: a variation with ONE dimension of its own keeps its own box — never mixed with the parent', () => {
    const v = valoresDoLiLi(
      fonteDoFilho({ peso: '0.300', altura: 7, largura: null, profundidade: null }),
    );
    expect(v.medidas).toEqual({
      pesoKg: 0.3,
      alturaCm: 7,
      larguraCm: null,
      profundidadeCm: null,
    });
  });

  it('NEAR-MISS: a variation whose detail was never read inherits nothing (unknown is not none)', () => {
    const v = valoresDoLiLi(fonteDoFilho(null));
    expect(v.medidas).toEqual({
      pesoKg: null,
      alturaCm: null,
      larguraCm: null,
      profundidadeCm: null,
    });
    expect(v.gtin).toBe('7890000000024');
  });

  it('a variation never inherits its parent weight, even with no weight of its own', () => {
    const v = valoresDoLiLi(
      fonteDoFilho({ peso: null, altura: null, largura: null, profundidade: null }),
    );
    expect(v.medidas.pesoKg).toBeNull();
    expect(v.medidas.alturaCm).toBe(30);
  });

  it("a variation's brand is its PARENT's; a brand on its own detail is not read", () => {
    expect(valoresDoLiLi(fonteDoFilho({ marca: uriMarca(7777) })).marca).toBe('Marca Neutra');
    expect(
      valoresDoLiLi(fonteDoFilho({ marca: uriMarca(MARCA) }, { marca: null })).marca,
    ).toBeNull();
  });
});

/* ------------------------------- the plans --------------------------------- */

describe('planejarPreenchimentoProdutoLi — the produto plan (pure)', () => {
  it('EQUAL PAIR: an absent, a null and an "" field are each filled', () => {
    const plano = planejarPreenchimentoProdutoLi(
      { gtin: '', pesoLiquidoKg: null, categoriaProdutoOuterRef: null },
      valores(),
    );
    expect(plano.campos).toEqual([
      'gtin',
      'pesoLiquidoKg',
      'pesoBrutoKg',
      'alturaCm',
      'larguraCm',
      'profundidadeCm',
      'categoriaProdutoOuterRef',
    ]);
    expect(plano.patch).toEqual({
      gtin: '7890000000017',
      pesoLiquidoKg: 0.2,
      pesoBrutoKg: 0.2,
      alturaCm: 10,
      larguraCm: 12,
      profundidadeCm: 14,
      categoriaProdutoOuterRef: REF_CATEGORIA,
    });
    expect(plano.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.preenchida);
  });

  it("NEAR-MISS: 'x', 0 and false are never replaced, and each weight field is decided on its own", () => {
    const plano = planejarPreenchimentoProdutoLi(
      {
        gtin: 'x',
        pesoLiquidoKg: 0,
        pesoBrutoKg: null,
        alturaCm: false,
        larguraCm: 5,
        profundidadeCm: '',
        categoriaProdutoOuterRef: 'documents/categorias/do-operador',
      },
      valores(),
    );
    expect(plano.patch).toEqual({ pesoBrutoKg: 0.2, profundidadeCm: 14 });
    expect(plano.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.existente);
  });

  it('a store value of nothing is never written: an empty field with no store value stays out of the patch', () => {
    const plano = planejarPreenchimentoProdutoLi(
      {},
      valores({
        gtin: null,
        medidas: { pesoKg: null, alturaCm: null, larguraCm: null, profundidadeCm: null },
        categoriaErpId: null,
      }),
    );
    expect(plano.patch).toEqual({});
    expect(plano.campos).toEqual([]);
    expect(plano.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.vazia);
  });

  it("a KIT root: its rollup weight and box are never the store's; GTIN and category still fill", () => {
    const plano = planejarPreenchimentoProdutoLi({ ehKit: true }, valores());
    expect(plano.campos).toEqual(['gtin', 'categoriaProdutoOuterRef']);
    // Near-miss: the same document NOT a kit takes them.
    expect(planejarPreenchimentoProdutoLi({ ehKit: false }, valores()).campos).toContain(
      'pesoLiquidoKg',
    );
  });

  it('a GTIN over 255 is dado-invalido(gtin) and every other field still fills', () => {
    const plano = planejarPreenchimentoProdutoLi({}, valores({ gtin: '7'.repeat(256) }));
    expect(plano.invalidos).toEqual(['gtin']);
    expect(plano.campos).not.toContain('gtin');
    expect(plano.campos).toContain('pesoLiquidoKg');
    expect(
      planejarPreenchimentoProdutoLi({}, valores({ gtin: '7'.repeat(255) })).invalidos,
    ).toEqual([]);
  });

  it('a GTIN over 255 on a field that already has a value is not reported (nothing would be written)', () => {
    expect(
      planejarPreenchimentoProdutoLi({ gtin: 'x' }, valores({ gtin: '7'.repeat(256) })).invalidos,
    ).toEqual([]);
  });

  it('a category id no ref can be formed from is dado-invalido(categoriaProdutoOuterRef), never a throw', () => {
    const plano = planejarPreenchimentoProdutoLi({}, valores({ categoriaErpId: 'a/b' }));
    expect(plano.invalidos).toEqual(['categoriaProdutoOuterRef']);
    expect(plano.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.vazia);
  });
});

describe('planejarPreenchimentoExtraDataLi — the extraData plan (pure)', () => {
  it('an absent document: both fields; a document with a description: only the brand', () => {
    expect(planejarPreenchimentoExtraDataLi(null, valores()).patch).toEqual({
      descricao: DESCRICAO,
      marca: 'Marca Neutra',
    });
    const plano = planejarPreenchimentoExtraDataLi(
      { descricao: 'do operador', marca: '' },
      valores(),
    );
    expect(plano.patch).toEqual({ marca: 'Marca Neutra' });
    expect(plano.campos).toEqual(['extraData.marca']);
  });

  it('a brand name over 255 is dado-invalido(extraData.marca)', () => {
    const plano = planejarPreenchimentoExtraDataLi(null, valores({ marca: 'm'.repeat(256) }));
    expect(plano.invalidos).toEqual(['extraData.marca']);
    expect(plano.campos).toEqual(['extraData.descricao']);
  });

  it('EQUAL PAIR / NEAR-MISS: a long description is reported only while the field is empty', () => {
    const longa = valores({ descricao: null, descricaoLongaTamanho: 4210 });
    expect(planejarPreenchimentoExtraDataLi({ descricao: '' }, longa).descricaoLongaTamanho).toBe(
      4210,
    );
    expect(
      planejarPreenchimentoExtraDataLi({ descricao: 'do operador' }, longa).descricaoLongaTamanho,
    ).toBeNull();
  });
});

/* ------------------------------- the writes -------------------------------- */

describe('preencherProdutoLi — the tier-1 fill on the fake', () => {
  it('fills every EMPTY field: one guarded produto update stamped with the job clock (ms), one extraData create', async () => {
    const db = new FakeDb();
    const versao = db.seed(P, produtoErp());
    const r = preenchido(await preencher(db));

    expect(r.campos).toEqual(TODOS_OS_CAMPOS);
    expect(r.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.preenchida);
    expect(r.gravado).toBe(true);
    expect(r.pendencias).toEqual([]);

    const [escrita, ...resto] = db.escritasEm(P);
    expect(resto).toEqual([]);
    expect(escrita?.verbo).toBe('update');
    expect(escrita?.dados).toEqual({
      gtin: '7890000000017',
      pesoLiquidoKg: 0.2,
      pesoBrutoKg: 0.2,
      alturaCm: 10,
      larguraCm: 12,
      profundidadeCm: 14,
      categoriaProdutoOuterRef: REF_CATEGORIA,
      ultimaModificacao: AGORA_MS,
    });
    expect(versao).toBeDefined();
    expect(db.escritasEm(X).map((e) => [e.verbo, e.dados])).toEqual([
      ['create', { descricao: DESCRICAO, marca: 'Marca Neutra' }],
    ]);
  });

  it('every produto and extraData key outside the table is byte-identical after the fill', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.seed(X, extraDataErp());
    const antesP = db.ler(P) ?? {};
    const antesX = db.ler(X) ?? {};
    preenchido(await preencher(db));

    const foraDaTabela = (doc: DocData, tabela: readonly string[]) =>
      Object.fromEntries(Object.entries(doc).filter(([k]) => !tabela.includes(k)));
    const tabelaP = [
      'gtin',
      'pesoLiquidoKg',
      'pesoBrutoKg',
      'alturaCm',
      'larguraCm',
      'profundidadeCm',
      'categoriaProdutoOuterRef',
      'ultimaModificacao',
    ];
    expect(foraDaTabela(db.ler(P) ?? {}, tabelaP)).toEqual(foraDaTabela(antesP, tabelaP));
    expect(Object.keys(db.ler(P) ?? {}).sort()).toEqual(Object.keys(antesP).sort());
    expect(foraDaTabela(db.ler(X) ?? {}, ['descricao', 'marca'])).toEqual(
      foraDaTabela(antesX, ['descricao', 'marca']),
    );
    expect(db.ler(X)).toMatchObject({ descricao: DESCRICAO, marca: 'Marca Neutra' });
  });

  it("NEAR-MISS: the ERP 'x', 0 and false survive the write, and nothing is written when nothing is empty", async () => {
    const db = new FakeDb();
    db.seed(
      P,
      produtoErp({
        gtin: 'x',
        pesoLiquidoKg: 0,
        pesoBrutoKg: 0.75,
        alturaCm: false,
        larguraCm: 1,
        profundidadeCm: 2,
        categoriaProdutoOuterRef: 'documents/categorias/do-operador',
      }),
    );
    db.seed(X, extraDataErp({ descricao: 'do operador', marca: 'do operador' }));
    const r = preenchido(await preencher(db));
    expect(r.campos).toEqual([]);
    expect(r.gravado).toBe(false);
    expect(r.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.existente);
    expect(db.escritas).toEqual([]);
  });

  it('the two store weights: "0.450000000000000011…" is stored 0.45, "0.500" is stored 0.5', async () => {
    for (const [peso, esperado] of [
      ['0.450000000000000011102230246251565', 0.45],
      ['0.500', 0.5],
    ] as const) {
      const db = new FakeDb();
      db.seed(P, produtoErp());
      preenchido(await preencher(db, fonte({ detalhe: detalheRaiz({ peso }) })));
      expect(db.ler(P)).toMatchObject({ pesoLiquidoKg: esperado, pesoBrutoKg: esperado });
    }
  });

  it("an existing variation with an EMPTY category takes the parent's; one with a category keeps it", async () => {
    const vazio = new FakeDb();
    vazio.seed(P, produtoErp({ paiId: 'erp-pai' }));
    const r = preenchido(
      await preencher(vazio, fonteDoFilho({ altura: null, largura: null, profundidade: null })),
    );
    expect(vazio.ler(P)).toMatchObject({
      categoriaProdutoOuterRef: REF_CATEGORIA,
      alturaCm: 30,
      larguraCm: 40,
      profundidadeCm: 50,
      gtin: '7890000000024',
    });
    expect(r.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.preenchida);

    const cheio = new FakeDb();
    cheio.seed(
      P,
      produtoErp({ paiId: 'erp-pai', categoriaProdutoOuterRef: 'documents/categorias/propria' }),
    );
    const r2 = preenchido(await preencher(cheio, fonteDoFilho({})));
    expect(cheio.ler(P)?.categoriaProdutoOuterRef).toBe('documents/categorias/propria');
    expect(r2.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.existente);
    expect(r2.campos).not.toContain('categoriaProdutoOuterRef');
  });

  it('a KIT root keeps its rollup weight and box empty; its GTIN and category fill', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp({ ehKit: true }));
    const r = preenchido(await preencher(db));
    expect(r.campos).toEqual([
      'gtin',
      'categoriaProdutoOuterRef',
      'extraData.descricao',
      'extraData.marca',
    ]);
    expect(db.ler(P)).toMatchObject({ pesoLiquidoKg: null, alturaCm: null, ehKit: true });
  });

  it('Simular reads and plans the same, writes NOTHING, and names the fields a run would fill', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.seed(X, extraDataErp());
    const r = preenchido(await preencher(db, fonte(), MODO_IMPORTACAO_LI.simular));
    expect(r.campos).toEqual(TODOS_OS_CAMPOS);
    expect(r.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.preenchida);
    expect(r.gravado).toBe(false);
    expect(db.escritas).toEqual([]);
  });

  it('a fill LOSING to an operator edit re-plans from the fresh read and writes nothing over it', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    // The operator types a GTIN between our read and our write: our precondition fails.
    db.antesDaProximaEscrita(P, () => {
      db.seed(P, { ...(db.ler(P) ?? {}), gtin: 'DO-OPERADOR', ultimaModificacao: AGORA_MS - 5 });
    });
    const r = preenchido(await preencher(db));

    expect(db.ler(P)?.gtin).toBe('DO-OPERADOR');
    expect(r.campos).not.toContain('gtin');
    expect(r.campos).toContain('pesoLiquidoKg');
    expect(r.pendencias).toEqual([]);
    const escritas = db.escritasEm(P);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.dados).not.toHaveProperty('gtin');
  });

  it('EQUAL PAIR: OUR write that landed with its reply lost counts as written — one write, never redone', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.respostaPerdidaNaProximaEscrita(P);
    const r = preenchido(await preencher(db));
    expect(r.campos).toEqual(TODOS_OS_CAMPOS);
    expect(r.gravado).toBe(true);
    expect(r.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.preenchida);
    expect(db.escritasEm(P)).toHaveLength(1);
    expect(r.pendencias).toEqual([]);
  });

  it('NEAR-MISS: a lost write whose stored document differs in ONE field of the patch is not ours — re-planned', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    // Another writer stored every one of our values but a different stamp (one ms apart).
    db.antesDaProximaEscrita(P, () => {
      db.seed(P, {
        ...(db.ler(P) ?? {}),
        gtin: '7890000000017',
        pesoLiquidoKg: 0.2,
        pesoBrutoKg: 0.2,
        alturaCm: 10,
        larguraCm: 12,
        profundidadeCm: 14,
        categoriaProdutoOuterRef: REF_CATEGORIA,
        ultimaModificacao: AGORA_MS + 1,
      });
    });
    const r = preenchido(await preencher(db));
    // Re-planned: every produto field is now filled — by them — so nothing of the produto is ours.
    expect(r.campos).toEqual(['extraData.descricao', 'extraData.marca']);
    expect(r.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.existente);
    expect(db.escritasEm(P)).toEqual([]);
  });

  it(`a fourth plan that still has work after ${String(MAX_TENTATIVAS_PREENCHIMENTO_LI)} lost writes is conflito-de-escrita; nothing forced`, async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    // Three edits of an unrelated field, each landing right before one of our writes.
    for (let i = 1; i <= MAX_TENTATIVAS_PREENCHIMENTO_LI; i += 1) {
      db.antesDaProximaEscrita(P, () => {
        db.seed(P, { ...(db.ler(P) ?? {}), nome: `Editado ${String(i)}` });
      });
    }
    const r = preenchido(await preencher(db, fonte(), MODO_IMPORTACAO_LI.aplicar, 9001));
    expect(r.pendencias).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
        liId: 9001,
        referencias: [PRODUTO],
      },
    ]);
    expect(r.campos).toEqual(['extraData.descricao', 'extraData.marca']);
    expect(r.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.vazia);
    expect(db.escritasEm(P)).toEqual([]);
    expect(db.ler(P)).toMatchObject({
      gtin: null,
      nome: `Editado ${String(MAX_TENTATIVAS_PREENCHIMENTO_LI)}`,
    });
  });

  it('NEAR-MISS: two lost writes, then the third lands — no conflict', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    for (let i = 1; i < MAX_TENTATIVAS_PREENCHIMENTO_LI; i += 1) {
      db.antesDaProximaEscrita(P, () => {
        db.seed(P, { ...(db.ler(P) ?? {}), nome: `Editado ${String(i)}` });
      });
    }
    const r = preenchido(await preencher(db));
    expect(r.pendencias).toEqual([]);
    expect(r.campos).toEqual(TODOS_OS_CAMPOS);
    expect(db.escritasEm(P)).toHaveLength(1);
  });

  it('a race whose winner filled every empty field ends with nothing to write — no conflict', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.antesDaProximaEscrita(P, () => {
      db.seed(P, {
        ...(db.ler(P) ?? {}),
        gtin: 'A',
        pesoLiquidoKg: 1,
        pesoBrutoKg: 1,
        alturaCm: 1,
        larguraCm: 1,
        profundidadeCm: 1,
        categoriaProdutoOuterRef: 'documents/categorias/outra',
      });
    });
    const r = preenchido(await preencher(db));
    expect(r.pendencias).toEqual([]);
    expect(r.campos).toEqual(['extraData.descricao', 'extraData.marca']);
    expect(db.escritasEm(P)).toEqual([]);
  });

  it('a produto deleted between the read and the write ends `ausente`: conflito-de-escrita, its extraData untouched', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.antesDaProximaEscrita(P, async () => {
      await produtoCollection.docRef(asDb(db), {}, PRODUTO).delete();
    });
    const r = await preencher(db);
    expect(r).toEqual({
      tipo: TIPO_RESULTADO_PREENCHIMENTO_LI.ausente,
      produtoId: PRODUTO,
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId: null, referencias: [PRODUTO] },
      ],
    });
    expect(db.leituras).not.toContain(X);
    expect(db.escritasEm(X)).toEqual([]);
  });

  it('a produto that is gone at the first read writes nothing and reads no extraData', async () => {
    const db = new FakeDb();
    const r = await preencher(db);
    expect(r.tipo).toBe(TIPO_RESULTADO_PREENCHIMENTO_LI.ausente);
    expect(db.escritas).toEqual([]);
    expect(db.leituras).toEqual([P]);
  });

  it('a failure that is not a lost precondition propagates (the task retries)', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.falharEscrita(P, grpc(14, 'UNAVAILABLE'));
    await expect(preencher(db)).rejects.toMatchObject({ code: 14 });
  });

  it('no store value for the extraData costs no read of it', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    const r = preenchido(
      await preencher(db, fonte({ detalhe: detalheRaiz({ descricao_completa: '', marca: null }) })),
    );
    expect(db.leituras).toEqual([P]);
    expect(r.campos).not.toContain('extraData.descricao');
  });
});

describe('preencherProdutoLi — the extraData singleton', () => {
  it('present: one guarded update of its EMPTY fields only', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.seed(X, extraDataErp({ descricao: 'do operador' }));
    const r = preenchido(await preencher(db));
    expect(r.campos.filter((c) => c.startsWith('extraData.'))).toEqual(['extraData.marca']);
    expect(db.escritasEm(X).map((e) => [e.verbo, e.dados])).toEqual([
      ['update', { marca: 'Marca Neutra' }],
    ]);
    expect(db.ler(X)?.descricao).toBe('do operador');
  });

  it('absent, and created by another writer between our read and our create: the 6 re-reads and plans on THEIR document', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.antesDaProximaEscrita(X, () => {
      db.seed(X, { descricao: 'do operador' });
    });
    const r = preenchido(await preencher(db));
    expect(r.campos.filter((c) => c.startsWith('extraData.'))).toEqual(['extraData.marca']);
    expect(db.ler(X)).toEqual({ descricao: 'do operador', marca: 'Marca Neutra' });
    expect(db.escritasEm(X).map((e) => e.verbo)).toEqual(['update']);
  });

  it('EQUAL PAIR: our own create that landed with its reply lost (the retry meets a 6) counts as written', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    // The document our create would write is already there when the create is answered.
    db.antesDaProximaEscrita(X, () => {
      db.seed(X, { descricao: DESCRICAO, marca: 'Marca Neutra' });
    });
    const r = preenchido(await preencher(db));
    expect(r.campos).toEqual(TODOS_OS_CAMPOS);
    expect(db.escritasEm(X)).toEqual([]);
  });

  it('present, and our update lands with its reply lost: counted, never redone', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.seed(X, extraDataErp());
    db.respostaPerdidaNaProximaEscrita(X);
    const r = preenchido(await preencher(db));
    expect(r.campos).toEqual(TODOS_OS_CAMPOS);
    expect(db.escritasEm(X)).toHaveLength(1);
  });

  it(`${String(MAX_TENTATIVAS_PREENCHIMENTO_LI)} lost writes of the extraData: conflito-de-escrita on it; the produto fill stands`, async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    db.seed(X, extraDataErp());
    for (let i = 1; i <= MAX_TENTATIVAS_PREENCHIMENTO_LI; i += 1) {
      db.antesDaProximaEscrita(X, () => {
        db.seed(X, { ...(db.ler(X) ?? {}), youtube: `https://video.invalid/${String(i)}` });
      });
    }
    const r = preenchido(await preencher(db));
    expect(r.pendencias).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
        liId: null,
        referencias: [`${PRODUTO}/extraData`],
      },
    ]);
    expect(r.campos).not.toContain('extraData.descricao');
    expect(r.campos).toContain('gtin');
    expect(r.gravado).toBe(true);
  });
});

describe('preencherProdutoLi — what the item reports', () => {
  it('dado-invalido names every refused field of both documents, and the rest still fills', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    const nomeLongo = 'm'.repeat(256);
    const r = preenchido(
      await preencher(
        db,
        fonte({
          detalhe: detalheRaiz({}, { gtin: '7'.repeat(256) }),
          marcas: [{ id: MARCA, nome: nomeLongo, ativo: true }],
        }),
        MODO_IMPORTACAO_LI.aplicar,
        9001,
      ),
    );
    expect(r.pendencias).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
        liId: 9001,
        referencias: ['gtin', 'extraData.marca'],
      },
    ]);
    expect(r.campos).toEqual([
      'pesoLiquidoKg',
      'pesoBrutoKg',
      'alturaCm',
      'larguraCm',
      'profundidadeCm',
      'categoriaProdutoOuterRef',
      'extraData.descricao',
    ]);
    expect(db.ler(P)?.gtin).toBeNull();
  });

  it('a description over 3,000: the field stays empty, descricao-longa carries its length; a filled field reports nothing', async () => {
    const longa = fonte({ detalhe: detalheRaiz({ descricao_completa: 'a'.repeat(3500) }) });
    const vazio = new FakeDb();
    vazio.seed(P, produtoErp());
    const r = preenchido(await preencher(vazio, longa));
    expect(r.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.descricaoLonga, liId: null, referencias: ['3500'] },
    ]);
    expect(vazio.ler(X)).toEqual({ marca: 'Marca Neutra' });

    const cheio = new FakeDb();
    cheio.seed(P, produtoErp());
    cheio.seed(X, extraDataErp({ descricao: 'do operador' }));
    const r2 = preenchido(await preencher(cheio, longa));
    expect(r2.pendencias).toEqual([]);
  });

  it('the category stays EMPTY when the store gives none — the tax review input', async () => {
    const db = new FakeDb();
    db.seed(P, produtoErp());
    const r = preenchido(await preencher(db, fonte({ categoriaErpId: null })));
    expect(r.categoria).toBe(CATEGORIA_NO_PREENCHIMENTO_LI.vazia);
    expect(r.campos).not.toContain('categoriaProdutoOuterRef');
  });
});
