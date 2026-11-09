/**
 * The product import's evidence pass (`evidencias.ts`), on the fake Firestore: which matched
 * variations give a claim (exact SKU only), what the claim says (the ERP child's variante of the
 * right grupo), how claims of several families gather in ONE document per store option, and the
 * phase's cursor.
 *
 * Nothing reaches the network (D17): the pass makes no Loja Integrada call, and the GLOBAL `fetch`
 * is stubbed to throw for the whole file — every test also asserts it was never called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type EvidenciaOpcaoLi,
  type GrupoComLinksLi,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  evidenciaOpcaoLiSchema,
  importacaoLojaIntegradaMeta,
  varianteFakePath,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { filhoLi, linhaProdutoLi, paiLi, uriOpcaoLi, vistaLi } from '../testing/produtosLi';
import {
  type AlegacaoDaFamiliaLi,
  type DepsEvidenciasLi,
  UNIDADE_DAS_EVIDENCIAS_LI,
  eixoUnicoDaFamiliaLi,
  executarUnidadeDasEvidenciasLi,
  fundirAlegacoesLi,
  lerEvidenciasDoJobLi,
  proximaFamiliaDasEvidenciasLi,
} from './evidencias';
import { type FamiliaLi, type MontagemLi, ORIGEM_DO_FILHO_LI } from './familias';
import { UNIDADE_IMPORTACAO_LI } from './orcamento';
import { type ConflitoDeSkuNaLojaLi, projetarProdutoErpLi } from './resolucao';

const CONTA = 'conta-li-evidencias';
const JOB = 'job-evidencias';
const TAM = 8946;
const COR = 7001;

let fetchFalso: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchFalso = vi.fn(() => Promise.reject(new Error('evidencias.test: nenhuma chamada de rede')));
  vi.stubGlobal('fetch', fetchFalso);
});
afterEach(() => {
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/* ------------------------------- fixtures --------------------------------- */

function deps(db: FakeDb): DepsEvidenciasLi {
  return { db: asDb(db), contaId: CONTA, jobId: JOB };
}

function familia(raiz: DocData, filhos: readonly DocData[] = []): FamiliaLi {
  return {
    raiz: vistaLi(raiz),
    detalheDaRaiz: null,
    filhos: filhos.map((f) => ({
      linha: vistaLi(f),
      detalhe: null,
      origem: ORIGEM_DO_FILHO_LI.filhos,
    })),
    semDetalhe: [],
    pendencias: [],
  };
}

function montagem(familias: readonly FamiliaLi[]): MontagemLi {
  return {
    familias,
    avulsos: [],
    contagens: { reivindicacoesIgnoradas: 0, reivindicacoesDisputadas: 0, filhosIlegiveis: 0 },
  };
}

function seedProduto(db: FakeDb, id: string, campos: DocData = {}): void {
  db.seed(`produtos/${id}`, { nome: `P ${id}`, sku: null, paiId: null, ...campos });
}

/** An ERP variation carrying these `(grupo, variante)` pairs. */
function taxonomia(...pares: readonly (readonly [string, string])[]): DocData {
  return {
    variacoesUid: pares.map(([g, v]) => varianteFakePath(g, v)),
    grupoDeVariacoesUid: [...new Set(pares.map(([g]) => g))],
  };
}

/** A grupo whose links for THIS conta are `grade → { option → variantes }`. */
function grupo(
  id: string,
  variantes: readonly string[],
  links: Record<number, Record<number, readonly string[]>> = {},
): GrupoComLinksLi {
  return {
    id,
    variantesIds: variantes,
    linksVariacoesli: Object.entries(links).map(([grade, opcoes]) => ({
      name: null,
      grade_id: Number(grade),
      integracaoLiId: CONTA,
      variationOptions: Object.entries(opcoes).map(([opcao, ids]) => ({
        li_option_id: Number(opcao),
        li_option_name: null,
        arakene_variation_id: [...ids],
      })),
    })),
  };
}

/** A store variation with these `(grade, option)` pairs. */
function variacao(
  id: number,
  sku: string | null,
  ...opcoes: readonly (readonly [number, number])[]
) {
  return filhoLi(id, { sku: sku ?? '', variacoes: opcoes.map(([g, v]) => uriOpcaoLi(g, v)) });
}

function caminhoEvidencia(id: string): string {
  return `${importacaoLojaIntegradaMeta.collectionPath}/${JOB}/evidencias/${id}`;
}

function evidenciaGravada(db: FakeDb, id: string): EvidenciaOpcaoLi | undefined {
  const raw = db.ler(caminhoEvidencia(id));
  return raw === undefined ? undefined : evidenciaOpcaoLiSchema.parse(raw);
}

/** ERP family `pai` (SKU `CAM`) with a P and an M of grupo `tam`. */
function familiaErpDeTamanho(db: FakeDb, skus: { p?: string; m?: string } = {}): void {
  seedProduto(db, 'pai', { sku: 'CAM' });
  seedProduto(db, 'p', { sku: skus.p ?? 'CAM-P', paiId: 'pai', ...taxonomia(['tam', 'v-p']) });
  seedProduto(db, 'm', { sku: skus.m ?? 'CAM-M', paiId: 'pai', ...taxonomia(['tam', 'v-m']) });
}

const SEM_CONFLITO: ReadonlyMap<string, ConflitoDeSkuNaLojaLi> = new Map();

async function umaUnidade(
  db: FakeDb,
  familias: readonly FamiliaLi[],
  grupos: readonly GrupoComLinksLi[],
  cursorPaiId: number | null = null,
  skusEmConflito: ReadonlyMap<string, ConflitoDeSkuNaLojaLi> = SEM_CONFLITO,
) {
  return executarUnidadeDasEvidenciasLi(
    deps(db),
    { montagem: montagem(familias), grupos, skusEmConflito },
    { cursorPaiId, filhosLidos: [] },
  );
}

/* --------------------------------- claims --------------------------------- */

describe('the claims of a matched family', () => {
  it('EQUAL: a variation matched by EXACT SKU, its option unlinked in a linked grade ⇒ the ERP child’s variante of THAT grupo', async () => {
    const db = new FakeDb();
    familiaErpDeTamanho(db);
    const grupos = [grupo('tam', ['v-p', 'v-m'], { [TAM]: { 2: ['v-m'] } })];
    const f = familia(paiLi(500, [501, 502], { sku: 'CAM' }), [
      variacao(501, 'CAM-P', [TAM, 1]),
      variacao(502, 'CAM-M', [TAM, 2]), // already resolved: no claim
    ]);
    const passo = await umaUnidade(db, [f], grupos);
    expect(passo).toMatchObject({ tipo: 'familia', liId: 500, alegacoes: 1, documentos: 1 });
    expect(evidenciaGravada(db, `${String(TAM)}_1`)).toEqual({
      gradeId: TAM,
      opcaoId: 1,
      alegacoes: [
        {
          grupoId: 'tam',
          varianteId: 'v-p',
          ocorrencias: 1,
          todasDeEixoUnico: true,
          exemploLiFilhoId: 501,
          exemploErpFilhoId: 'p',
        },
      ],
      nomeGrade: null,
      nomeOpcao: null,
    });
    expect(db.idsEm(`${importacaoLojaIntegradaMeta.collectionPath}/${JOB}/evidencias`)).toEqual([
      `${String(TAM)}_1`,
    ]);
  });

  it('a grade linked NOWHERE, on a family of ONE axis both sides ⇒ a single-axis claim per option', async () => {
    const db = new FakeDb();
    familiaErpDeTamanho(db);
    const grupos = [grupo('tam', ['v-p', 'v-m'])];
    const f = familia(paiLi(500, [501, 502], { sku: 'CAM' }), [
      variacao(501, 'CAM-P', [TAM, 1]),
      variacao(502, 'CAM-M', [TAM, 2]),
    ]);
    await umaUnidade(db, [f], grupos);
    expect(evidenciaGravada(db, `${String(TAM)}_1`)?.alegacoes).toEqual([
      expect.objectContaining({ grupoId: 'tam', varianteId: 'v-p', todasDeEixoUnico: true }),
    ]);
    expect(evidenciaGravada(db, `${String(TAM)}_2`)?.alegacoes).toEqual([
      expect.objectContaining({ grupoId: 'tam', varianteId: 'v-m', todasDeEixoUnico: true }),
    ]);
  });

  it('several axes: the ONE unlinked grade is placed by elimination, flagged multi-axis', async () => {
    const db = new FakeDb();
    seedProduto(db, 'pai', { sku: 'CAM', filhoUnicoId: 'az-p' });
    seedProduto(db, 'az-p', {
      sku: 'CAM-AZ-P',
      paiId: 'pai',
      ...taxonomia(['cor', 'v-az'], ['tam', 'v-p']),
    });
    const grupos = [grupo('cor', ['v-az'], { [COR]: { 31: ['v-az'] } }), grupo('tam', ['v-p'])];
    const f = familia(paiLi(500, [501], { sku: 'CAM' }), [
      variacao(501, 'CAM-AZ-P', [COR, 31], [TAM, 1]),
    ]);
    await umaUnidade(db, [f], grupos);
    expect(evidenciaGravada(db, `${String(TAM)}_1`)?.alegacoes).toEqual([
      expect.objectContaining({ grupoId: 'tam', varianteId: 'v-p', todasDeEixoUnico: false }),
    ]);
    expect(evidenciaGravada(db, `${String(COR)}_31`)).toBeUndefined();
  });

  it('⚠️ NEAR-MISS: TWO unlinked grades on one variation ⇒ no claim (nothing says which axis is which)', async () => {
    const db = new FakeDb();
    seedProduto(db, 'pai', { sku: 'CAM', filhoUnicoId: 'az-p' });
    seedProduto(db, 'az-p', {
      sku: 'CAM-AZ-P',
      paiId: 'pai',
      ...taxonomia(['cor', 'v-az'], ['tam', 'v-p']),
    });
    const f = familia(paiLi(500, [501], { sku: 'CAM' }), [
      variacao(501, 'CAM-AZ-P', [COR, 31], [TAM, 1]),
    ]);
    const passo = await umaUnidade(db, [f], [grupo('cor', ['v-az']), grupo('tam', ['v-p'])]);
    // Anti-vacuity: the family DID match, so "no claim" is the elimination refusing.
    expect(passo).toMatchObject({
      raiz: { tipo: SITUACAO_ERP_ITEM_LI.encontrado, erpId: 'pai' },
      alegacoes: 0,
      documentos: 0,
    });
    expect(db.escritas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: two unlinked grades and ONE spare ERP axis ⇒ no claim — never both options onto one grupo', async () => {
    const db = new FakeDb();
    seedProduto(db, 'pai', { sku: 'CAM', filhoUnicoId: 'az-p' });
    seedProduto(db, 'az-p', {
      sku: 'CAM-AZ-P',
      paiId: 'pai',
      ...taxonomia(['cor', 'v-az'], ['tam', 'v-p']),
    });
    const grupos = [grupo('cor', ['v-az'], { [COR]: { 31: ['v-az'] } }), grupo('tam', ['v-p'])];
    const GOLA = 5555;
    const f = familia(paiLi(500, [501], { sku: 'CAM' }), [
      variacao(501, 'CAM-AZ-P', [COR, 31], [TAM, 1], [GOLA, 9]),
    ]);
    const passo = await umaUnidade(db, [f], grupos);
    expect(passo).toMatchObject({ raiz: { tipo: SITUACAO_ERP_ITEM_LI.encontrado }, alegacoes: 0 });
    expect(db.escritas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: an ERP child holding TWO variantes of the option’s grupo ⇒ no claim (never the first one)', async () => {
    const db = new FakeDb();
    seedProduto(db, 'pai', { sku: 'CAM', filhoUnicoId: 'pm' });
    seedProduto(db, 'pm', {
      sku: 'CAM-PM',
      paiId: 'pai',
      ...taxonomia(['tam', 'v-p'], ['tam', 'v-m']),
    });
    const f = familia(paiLi(500, [501], { sku: 'CAM' }), [variacao(501, 'CAM-PM', [TAM, 1])]);
    const linkada = [grupo('tam', ['v-p', 'v-m'], { [TAM]: {} })];
    expect(await umaUnidade(db, [f], linkada)).toMatchObject({
      raiz: { tipo: SITUACAO_ERP_ITEM_LI.encontrado },
      alegacoes: 0,
    });
    // …and the same through the unlinked-grade path.
    expect(await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'])])).toMatchObject({
      alegacoes: 0,
    });
    expect(db.escritas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: a variation linked to its ERP child but with ANOTHER SKU gives no claim (not exact-SKU evidence)', async () => {
    const db = new FakeDb();
    familiaErpDeTamanho(db, { p: 'ERP-P' });
    db.seed('produtos/p/produtolojaintegrada/501', {
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 501,
      sku: 'LOJA-P',
    });
    const f = familia(paiLi(500, [501], { sku: 'CAM' }), [variacao(501, 'LOJA-P', [TAM, 1])]);
    const passo = await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'], { [TAM]: {} })]);
    expect(passo).toMatchObject({
      raiz: { tipo: SITUACAO_ERP_ITEM_LI.encontrado, erpId: 'pai' },
      alegacoes: 0,
    });
    expect(db.escritas).toEqual([]);

    // EQUAL: the same link with the SAME SKU on both sides is exact-SKU evidence.
    const db2 = new FakeDb();
    familiaErpDeTamanho(db2, { p: 'LOJA-P' });
    db2.seed('produtos/p/produtolojaintegrada/501', {
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 501,
      sku: 'LOJA-P',
    });
    expect(await umaUnidade(db2, [f], [grupo('tam', ['v-p', 'v-m'], { [TAM]: {} })])).toMatchObject(
      { alegacoes: 1 },
    );
  });

  it('⚠️ NEAR-MISS: a SKU differing only in case or an edge space is no match, so no claim', async () => {
    for (const sku of ['cam-p', 'CAM-P ', ' CAM-P']) {
      const db = new FakeDb();
      familiaErpDeTamanho(db);
      const f = familia(paiLi(500, [501], { sku: 'CAM' }), [variacao(501, sku, [TAM, 1])]);
      expect(await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'])])).toMatchObject({
        raiz: { tipo: SITUACAO_ERP_ITEM_LI.encontrado },
        alegacoes: 0,
      });
    }
  });

  it('a SKU the store repeats gives no claim', async () => {
    const db = new FakeDb();
    familiaErpDeTamanho(db);
    const f = familia(paiLi(500, [501], { sku: 'CAM' }), [variacao(501, 'CAM-P', [TAM, 1])]);
    const repetido = new Map([['CAM-P', PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja] as const]);
    const parecido = new Map([['CAM-P', PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja] as const]);
    expect(await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'])], null, repetido)).toMatchObject(
      {
        raiz: { tipo: SITUACAO_ERP_ITEM_LI.encontrado },
        alegacoes: 0,
      },
    );
    // A near duplicate is no exact-SKU evidence either.
    expect(await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'])], null, parecido)).toMatchObject(
      {
        alegacoes: 0,
      },
    );
    // …even matched through its OWN link to a child with that same SKU.
    db.seed('produtos/p/produtolojaintegrada/501', {
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 501,
      sku: 'CAM-P',
    });
    expect(await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'])], null, repetido)).toMatchObject(
      {
        alegacoes: 0,
      },
    );
    // EQUAL: the same link with the SKU not repeated is exact-SKU evidence.
    expect(await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'])])).toMatchObject({
      alegacoes: 1,
    });
  });

  it('an option already standing for TWO variantes, or a grade linked in two grupos, gives no claim', async () => {
    const db = new FakeDb();
    familiaErpDeTamanho(db);
    const f = familia(paiLi(500, [501], { sku: 'CAM' }), [variacao(501, 'CAM-P', [TAM, 1])]);
    const ambigua = [grupo('tam', ['v-p', 'v-m'], { [TAM]: { 1: ['v-p', 'v-m'] } })];
    const casou = { raiz: { tipo: SITUACAO_ERP_ITEM_LI.encontrado }, alegacoes: 0 };
    expect(await umaUnidade(db, [f], ambigua)).toMatchObject(casou);
    const emDois = [
      grupo('tam', ['v-p', 'v-m'], { [TAM]: {} }),
      grupo('tam2', ['x'], { [TAM]: {} }),
    ];
    expect(await umaUnidade(db, [f], emDois)).toMatchObject(casou);
    // EQUAL: the same variation over a grade linked once, option unlinked ⇒ one claim.
    expect(await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'], { [TAM]: {} })])).toMatchObject({
      alegacoes: 1,
    });
  });

  it('a family matched to no ERP family (absent, or in conflict) gives nothing and writes nothing', async () => {
    const db = new FakeDb();
    seedProduto(db, 'a', { sku: 'DUP' });
    seedProduto(db, 'b', { sku: 'DUP' });
    const ausente = familia(paiLi(500, [501], { sku: 'NOVA' }), [variacao(501, 'N-1', [TAM, 1])]);
    const emConflito = familia(paiLi(600, [601], { sku: 'DUP' }), [variacao(601, 'D-1', [TAM, 1])]);
    expect(await umaUnidade(db, [ausente], [])).toMatchObject({
      tipo: 'familia',
      raiz: { tipo: SITUACAO_ERP_ITEM_LI.ausente },
      alegacoes: 0,
    });
    expect(await umaUnidade(db, [emConflito], [])).toMatchObject({
      raiz: { tipo: SITUACAO_ERP_ITEM_LI.conflito },
      alegacoes: 0,
    });
    expect(db.escritas).toEqual([]);
  });
});

/* ----------------------------- claim documents ---------------------------- */

describe('claims gather in ONE document per store option', () => {
  it('two families claiming the same pair ⇒ one pair, two occurrences; another variante ⇒ a second pair (the divergence kept)', async () => {
    const db = new FakeDb();
    familiaErpDeTamanho(db);
    seedProduto(db, 'pai2', { sku: 'BLU', filhoUnicoId: 'p2' });
    seedProduto(db, 'p2', { sku: 'BLU-P', paiId: 'pai2', ...taxonomia(['tam', 'v-p']) });
    seedProduto(db, 'pai3', { sku: 'CAL', filhoUnicoId: 'g3' });
    seedProduto(db, 'g3', { sku: 'CAL-G', paiId: 'pai3', ...taxonomia(['tam', 'v-g']) });
    const grupos = [grupo('tam', ['v-p', 'v-m', 'v-g'], { [TAM]: {} })];
    const familias = [
      familia(paiLi(500, [501], { sku: 'CAM' }), [variacao(501, 'CAM-P', [TAM, 1])]),
      familia(paiLi(600, [601], { sku: 'BLU' }), [variacao(601, 'BLU-P', [TAM, 1])]),
      familia(paiLi(700, [701], { sku: 'CAL' }), [variacao(701, 'CAL-G', [TAM, 1])]),
    ];
    let cursor: number | null = null;
    for (let i = 0; i < 3; i += 1) {
      const passo = await umaUnidade(db, familias, grupos, cursor);
      if (passo.tipo !== 'familia') throw new Error('esperava uma família');
      cursor = passo.familias.cursorPaiId;
    }
    expect(evidenciaGravada(db, `${String(TAM)}_1`)?.alegacoes).toEqual([
      expect.objectContaining({ grupoId: 'tam', varianteId: 'v-p', ocorrencias: 2 }),
      expect.objectContaining({ grupoId: 'tam', varianteId: 'v-g', ocorrencias: 1 }),
    ]);
  });

  it('fundirAlegacoesLi — EQUAL: the same (grupo, variante) is one pair; the single-axis flag is an AND', () => {
    const a = (over: Partial<AlegacaoDaFamiliaLi> = {}): AlegacaoDaFamiliaLi => ({
      gradeId: TAM,
      opcaoId: 1,
      grupoId: 'tam',
      varianteId: 'v-p',
      eixoUnico: true,
      liFilhoId: 501,
      erpFilhoId: 'p',
      ...over,
    });
    const uma = fundirAlegacoesLi(TAM, 1, null, [a()]);
    const duas = fundirAlegacoesLi(TAM, 1, uma, [a({ eixoUnico: false, liFilhoId: 601 })]);
    expect(duas.alegacoes).toEqual([
      {
        grupoId: 'tam',
        varianteId: 'v-p',
        ocorrencias: 2,
        todasDeEixoUnico: false,
        exemploLiFilhoId: 501,
        exemploErpFilhoId: 'p',
      },
    ]);
    // The stored value is never mutated.
    expect(uma.alegacoes[0]).toMatchObject({ ocorrencias: 1, todasDeEixoUnico: true });
  });

  it('⚠️ NEAR-MISS: variante `v-p` vs `V-P`, or another grupo, is ANOTHER pair (exact keys); another option is ignored', () => {
    const base = {
      gradeId: TAM,
      opcaoId: 1,
      eixoUnico: true,
      liFilhoId: 501,
      erpFilhoId: 'p',
    };
    const r = fundirAlegacoesLi(TAM, 1, null, [
      { ...base, grupoId: 'tam', varianteId: 'v-p' },
      { ...base, grupoId: 'tam', varianteId: 'V-P' },
      { ...base, grupoId: 'tam2', varianteId: 'v-p' },
      { ...base, opcaoId: 2, grupoId: 'tam', varianteId: 'v-p' },
    ]);
    expect(r.alegacoes.map((x) => [x.grupoId, x.varianteId, x.ocorrencias])).toEqual([
      ['tam', 'v-p', 1],
      ['tam', 'V-P', 1],
      ['tam2', 'v-p', 1],
    ]);
  });

  it('a unit retried after its writes merges the same pairs again: only the occurrence count moves', async () => {
    const db = new FakeDb();
    familiaErpDeTamanho(db);
    const grupos = [grupo('tam', ['v-p', 'v-m'], { [TAM]: {} })];
    const f = familia(paiLi(500, [501], { sku: 'CAM' }), [variacao(501, 'CAM-P', [TAM, 1])]);
    await umaUnidade(db, [f], grupos);
    await umaUnidade(db, [f], grupos); // the same cursor: a retry
    expect(evidenciaGravada(db, `${String(TAM)}_1`)?.alegacoes).toEqual([
      expect.objectContaining({ varianteId: 'v-p', ocorrencias: 2, todasDeEixoUnico: true }),
    ]);
  });

  it('lerEvidenciasDoJobLi: the job’s documents in key order, parsed strictly (corruption is a ZodError)', async () => {
    const db = new FakeDb();
    const ev = (g: number, o: number) =>
      evidenciaOpcaoLiSchema.parse({ gradeId: g, opcaoId: o }) as unknown as DocData;
    db.seed(caminhoEvidencia('9_1'), ev(9, 1));
    db.seed(caminhoEvidencia('10_2'), ev(10, 2));
    expect((await lerEvidenciasDoJobLi(asDb(db), JOB)).map((e) => e.id)).toEqual(['10_2', '9_1']);
    db.seed(caminhoEvidencia('11_1'), { gradeId: 'x' });
    await expect(lerEvidenciasDoJobLi(asDb(db), JOB)).rejects.toThrow();
  });
});

/* --------------------------------- axes ----------------------------------- */

describe('eixoUnicoDaFamiliaLi — one axis on BOTH sides', () => {
  const erp = (id: string, ...pares: readonly (readonly [string, string])[]) =>
    projetarProdutoErpLi(id, taxonomia(...pares));

  it('EQUAL: one option per variation, one grade; one variante per ERP child, one grupo', () => {
    const f = familia(paiLi(500, [501, 502]), [
      variacao(501, 'A', [TAM, 1]),
      variacao(502, 'B', [TAM, 2]),
    ]);
    expect(eixoUnicoDaFamiliaLi(f, [erp('p', ['tam', 'v-p']), erp('m', ['tam', 'v-m'])])).toBe(
      true,
    );
  });

  it('⚠️ NEAR-MISS: two grades in the store, two grupos in the ERP, a two-variante child, or a child with no taxonomy ⇒ not single-axis', () => {
    const umEixo = familia(paiLi(500, [501]), [variacao(501, 'A', [TAM, 1])]);
    const doisEixos = familia(paiLi(500, [501, 502]), [
      variacao(501, 'A', [TAM, 1]),
      variacao(502, 'B', [COR, 2]),
    ]);
    const p = erp('p', ['tam', 'v-p']);
    expect(eixoUnicoDaFamiliaLi(doisEixos, [p])).toBe(false);
    expect(eixoUnicoDaFamiliaLi(umEixo, [p, erp('az', ['cor', 'v-az'])])).toBe(false);
    expect(eixoUnicoDaFamiliaLi(umEixo, [erp('az-p', ['cor', 'v-az'], ['tam', 'v-p'])])).toBe(
      false,
    );
    expect(eixoUnicoDaFamiliaLi(umEixo, [p, projetarProdutoErpLi('legado', {})])).toBe(false);
  });
});

/* -------------------------------- the phase ------------------------------- */

describe('the evidencias phase — one family per unit, no call', () => {
  it('every unit is a no-call unit', () => {
    expect(UNIDADE_DAS_EVIDENCIAS_LI).toBe(UNIDADE_IMPORTACAO_LI.familia);
  });

  it('visits store parents with variations in ascending id above the cursor; simple products and empty families are skipped; then concluido', async () => {
    const db = new FakeDb();
    const familias = [
      familia(paiLi(900, [901]), [variacao(901, 'Z', [TAM, 1])]),
      familia(linhaProdutoLi(100)),
      familia(paiLi(300, [])),
      familia(paiLi(200, [201]), [variacao(201, 'Y', [TAM, 1])]),
    ];
    const m = montagem(familias);
    expect(proximaFamiliaDasEvidenciasLi(m, { cursorPaiId: null, filhosLidos: [] })?.raiz.id).toBe(
      200,
    );
    expect(proximaFamiliaDasEvidenciasLi(m, { cursorPaiId: 200, filhosLidos: [] })?.raiz.id).toBe(
      900,
    );
    expect(proximaFamiliaDasEvidenciasLi(m, { cursorPaiId: 900, filhosLidos: [] })).toBeNull();

    const passo = await umaUnidade(db, familias, [], 200);
    expect(passo).toMatchObject({
      tipo: 'familia',
      liId: 900,
      familias: { cursorPaiId: 900, filhosLidos: [] },
    });
    expect(await umaUnidade(db, familias, [], 900)).toEqual({ tipo: 'concluido' });
  });

  it('writes ONLY the job’s claim documents — never a produto, a link or a grupo', async () => {
    const db = new FakeDb();
    familiaErpDeTamanho(db);
    const antes = JSON.stringify([
      db.ler('produtos/pai'),
      db.ler('produtos/p'),
      db.ler('produtos/m'),
    ]);
    const f = familia(paiLi(500, [501, 502], { sku: 'CAM' }), [
      variacao(501, 'CAM-P', [TAM, 1]),
      variacao(502, 'CAM-M', [TAM, 2]),
    ]);
    await umaUnidade(db, [f], [grupo('tam', ['v-p', 'v-m'])]);
    expect(db.escritas.length).toBeGreaterThan(0);
    for (const e of db.escritas) {
      expect(e.caminho.startsWith(caminhoEvidencia(''))).toBe(true);
      expect(e.sobrescrita).toBe(true);
    }
    expect(
      JSON.stringify([db.ler('produtos/pai'), db.ler('produtos/p'), db.ler('produtos/m')]),
    ).toBe(antes);
  });
});
