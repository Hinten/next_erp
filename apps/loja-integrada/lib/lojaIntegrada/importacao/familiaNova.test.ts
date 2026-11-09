/**
 * The product import's whole-family create (`familiaNova.ts`) on the fake Firestore: the ids keyed
 * by the SKU, the ERP family builder's shapes (a família de um for a simple product; a parent and
 * one child per kept variation, named by the ERP family rule), the create probe, the ONE batch and
 * its all-or-nothing, the `ALREADY_EXISTS` judgement (our own landed batch, another conta's create,
 * another SKU at the id), and Simular's parity.
 *
 * Every sameness decision is pinned as a PAIR (the equal case and the near-miss). Every query is
 * checked against `firestore.indexes.json`. Nothing reaches the network (D17): the GLOBAL `fetch` is
 * stubbed to throw for the whole file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Timestamp } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  FORMA_RAIZ_ERP,
  type GrupoComLinksLi,
  type MarcaCatalogoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  fundirLinksVariacoesLi,
  skuDoMembroUnico,
  varianteFakePath,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { seedJobLi } from '../testing/importacaoLi';
import {
  detalheLi,
  filhoLi,
  linhaProdutoLi,
  paiLi,
  uriOpcaoLi,
  vistaDetalhadaLi,
  vistaLi,
} from '../testing/produtosLi';
import {
  ESTADO_DO_ID_PLANEJADO_LI,
  MAX_TENTATIVAS_FAMILIA_NOVA_LI,
  PAPEL_DO_PRODUTO_CRIADO_LI,
  PREFIXO_ID_PRODUTO_CRIADO_LI,
  type ResultadoDaFamiliaNovaLi,
  TIPO_RESULTADO_FAMILIA_NOVA_LI,
  criarFamiliaLi,
  estadoDoIdPlanejadoLi,
  idMembroCriadoLi,
  idProdutoCriadoLi,
  nomesIguaisPeloCorteLi,
  recusasAntesDosDetalhesLi,
} from './familiaNova';
import { type FamiliaLi, ORIGEM_DO_FILHO_LI } from './familias';
import { planejarFamiliaLi } from './plano';
import { resolverRaizLi } from './resolucao';
import { vincularFamiliaLi } from './vinculos';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('familiaNova.test: nenhuma chamada de rede'))),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------- fixtures --------------------------------- */

/** `conta`'s link of grade `grade` in a grupo: option id → variante ids. */
function linksDe(
  conta: string,
  grade: number,
  opcoes: Record<number, readonly string[]>,
): unknown[] {
  const fusao = fundirLinksVariacoesLi(
    null,
    Object.entries(opcoes).flatMap(([opcao, ids]) =>
      ids.map((varianteId) => ({
        integracaoLiId: conta,
        gradeId: grade,
        opcaoId: Number(opcao),
        varianteId,
      })),
    ),
  );
  if (!fusao.ok) throw new Error('linksDe: a fusão recusou a lista vazia');
  return fusao.array;
}

const CONTA = 'conta-li-familia-nova';
const OUTRA = 'conta-li-familia-nova-2';
const GRADE = 8946;
const GRUPO = 'grupo-cor-familia-nova';
const CATEGORIA = 'cat-familia-nova';
const REF_CATEGORIA = `documents/categorias/${CATEGORIA}`;
const MARCA = 5001;
const MARCAS: readonly MarcaCatalogoLi[] = [{ id: MARCA, nome: 'Marca Neutra', ativo: true }];
const DESCRICAO = '<p>Uma descrição neutra.</p>';

const sha = (texto: string) => createHash('sha256').update(texto, 'utf8').digest('hex');
const vinculoEm = (produtoId: string, liId: number) =>
  `produtos/${produtoId}/produtolojaintegrada/${String(liId)}`;
const extraEm = (produtoId: string) => `produtos/${produtoId}/extraData/singleton`;

/** The ERP grupo "Cor" with its two variantes, as stored. */
function seedGrupo(db: FakeDb, id = GRUPO): void {
  db.seed(`grupoDeVariacoes/${id}`, {
    nome: 'Cor',
    ordem: 1,
    variacoesIds: ['v-azul', 'v-verde', 'v-roxo'],
    variacoes: [
      { id: 'v-azul', nome: 'Azul' },
      { id: 'v-verde', nome: 'Verde' },
      { id: 'v-roxo', nome: 'Roxo' },
    ],
  });
}

/** The memo's grupo with this conta's link of grade `GRADE`: option id → variante ids. */
function grupoLi(
  opcoes: Record<number, readonly string[]> = { 1: ['v-azul'], 2: ['v-verde'], 4: ['v-roxo'] },
  id = GRUPO,
  conta = CONTA,
): GrupoComLinksLi {
  return {
    id,
    variantesIds: ['v-azul', 'v-verde', 'v-roxo'],
    // Built by the shared never-drop merge, exactly as a learning would write it.
    linksVariacoesli: linksDe(conta, GRADE, opcoes),
  };
}

/** A store simple product with its detail (the default measures, a brand, a description). */
function simples(liId: number, sku: string, linha: DocData = {}, detalhe: DocData = {}): FamiliaLi {
  const row = linhaProdutoLi(liId, { sku, gtin: '7890000000017', ...linha });
  return {
    raiz: vistaLi(row),
    detalheDaRaiz: vistaDetalhadaLi(
      detalheLi(row, null, {
        marca: `/api/v1/marca/${String(MARCA)}`,
        descricao_completa: DESCRICAO,
        ...detalhe,
      }),
    ),
    filhos: [],
    semDetalhe: [],
    pendencias: [],
  };
}

interface Variacao {
  readonly id: number;
  readonly sku: string;
  readonly opcao: number;
  readonly linha?: DocData;
  readonly detalhe?: DocData;
}

/** A store family "Camiseta" (its detail's box 30×40×50, 0.9 kg) with its variations. */
function familia(
  liId: number,
  sku: string,
  variacoes: readonly Variacao[],
  linha: DocData = {},
): FamiliaLi {
  const row = paiLi(
    liId,
    variacoes.map((v) => v.id),
    { sku, nome: 'Camiseta', ...linha },
  );
  return {
    raiz: vistaLi(row),
    detalheDaRaiz: vistaDetalhadaLi(
      detalheLi(row, null, {
        marca: `/api/v1/marca/${String(MARCA)}`,
        descricao_completa: DESCRICAO,
        peso: '0.900',
        altura: 30,
        largura: 40,
        profundidade: 50,
      }),
    ),
    filhos: variacoes.map((v) => {
      const filho = filhoLi(v.id, {
        sku: v.sku,
        variacoes: [uriOpcaoLi(GRADE, v.opcao)],
        ...v.linha,
      });
      return {
        linha: vistaLi(filho),
        detalhe: vistaDetalhadaLi(detalheLi(filho, liId, { peso: '0.250', ...v.detalhe })),
        origem: ORIGEM_DO_FILHO_LI.filhos,
      };
    }),
    semDetalhe: [],
    pendencias: [],
  };
}

const AZUL: Variacao = {
  id: 801,
  sku: 'CAM-AZ',
  opcao: 1,
  detalhe: { altura: null, largura: null, profundidade: null },
};
const VERDE: Variacao = {
  id: 802,
  sku: 'CAM-VD',
  opcao: 2,
  detalhe: { altura: 11, largura: 12, profundidade: 13 },
};

interface Opcoes {
  readonly modo?: ModoImportacaoLi;
  readonly conta?: string;
  readonly grupos?: readonly GrupoComLinksLi[];
  readonly antesDoCommit?: () => Promise<void> | void;
}

/** The create, from `plano.ts`'s own classification of an `ausente` family under "complete". */
function criar(db: FakeDb, f: FamiliaLi, o: Opcoes = {}): Promise<ResultadoDaFamiliaNovaLi> {
  const conta = o.conta ?? CONTA;
  const modo = o.modo ?? MODO_IMPORTACAO_LI.aplicar;
  const plano = planejarFamiliaLi({
    job: {
      integracaoId: conta,
      modo,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.completar,
      selecionados: [],
    },
    familia: f,
    raiz: { tipo: SITUACAO_ERP_ITEM_LI.ausente },
    filhos: null,
    skusEmConflito: new Map(),
    recusasDoAprendizado: new Map(),
  });
  if (plano.criacao === null)
    throw new Error('familiaNova.test: o plano não classificou a criação');
  return criarFamiliaLi(
    {
      db: asDb(db),
      contaId: conta,
      modo,
      agoraMs: () => AGORA_MS,
      ...(o.antesDoCommit === undefined ? {} : { antesDoCommit: o.antesDoCommit }),
    },
    {
      familia: f,
      criacao: plano.criacao,
      grupos: o.grupos ?? [grupoLi(undefined, GRUPO, conta)],
      categoriaErpId: CATEGORIA,
      marcas: MARCAS,
    },
  );
}

function seedProduto(db: FakeDb, id: string, campos: DocData): void {
  db.seed(`produtos/${id}`, { nome: `P ${id}`, sku: null, paiId: null, ...campos });
}

const recusa = (r: ResultadoDaFamiliaNovaLi) =>
  r.tipo === TIPO_RESULTADO_FAMILIA_NOVA_LI.recusada ? r.pendencias : null;

/* -------------------------------- the ids ---------------------------------- */

describe('ids keyed by the SKU', () => {
  it('EQUAL: one SKU, one id — `li-sku-<sha256 of the UTF-8 SKU>`, the sole member `-un` after it', () => {
    expect(idProdutoCriadoLi('X')).toBe(`${PREFIXO_ID_PRODUTO_CRIADO_LI}${sha('X')}`);
    expect(idProdutoCriadoLi('X')).toBe(idProdutoCriadoLi('X'));
    expect(idProdutoCriadoLi('CAMISA-Ç')).toBe(`li-sku-${sha('CAMISA-Ç')}`);
    expect(idMembroCriadoLi('X')).toBe(`li-sku-${sha('X')}-un`);
  });

  it("⚠️ NEAR-MISS: exact bytes — 'x', 'X ', ' X' and the member's own SKU are other ids", () => {
    const ids = ['X', 'x', 'X ', ' X', 'X-UN'].map(idProdutoCriadoLi);
    expect(new Set(ids).size).toBe(5);
    // The member's id is the ROOT SKU's, never its own derived SKU's.
    expect(idMembroCriadoLi('X')).not.toBe(idProdutoCriadoLi('X-UN'));
  });

  it('an empty SKU identifies nothing: it throws', () => {
    expect(() => idProdutoCriadoLi('')).toThrow(RangeError);
  });
});

/* ------------------------------ the shapes -------------------------------- */

describe('a simple store product ⇒ an ERP família de um, in ONE batch', () => {
  it('the root carries the store SKU and names its sole member; the member mirrors it with the derived SKU', async () => {
    const db = new FakeDb();
    const r = await criar(db, simples(500, 'X'));
    const raizId = idProdutoCriadoLi('X');
    const membroId = idMembroCriadoLi('X');
    expect(r).toMatchObject({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
      raizId,
      produtos: [
        { produtoId: raizId, papel: PAPEL_DO_PRODUTO_CRIADO_LI.raiz, liId: 500 },
        { produtoId: membroId, papel: PAPEL_DO_PRODUTO_CRIADO_LI.membro, liId: 500 },
      ],
      gravado: true,
      retomada: false,
      pendencias: [],
    });
    expect(db.ler(`produtos/${raizId}`)).toMatchObject({
      nome: 'Produto 500',
      sku: 'X',
      paiId: null,
      filhoUnicoId: membroId,
      gtin: '7890000000017',
      pesoLiquidoKg: 0.2,
      pesoBrutoKg: 0.2,
      alturaCm: 10,
      larguraCm: 12,
      profundidadeCm: 14,
      categoriaProdutoOuterRef: REF_CATEGORIA,
      variacoesUid: null,
      grupoDeVariacoesUid: null,
      timestamp: AGORA_MS,
      ultimaModificacao: AGORA_MS,
    });
    expect(db.ler(`produtos/${membroId}`)).toMatchObject({
      nome: 'Produto 500',
      sku: skuDoMembroUnico('X'),
      paiId: raizId,
      gtin: '7890000000017',
      categoriaProdutoOuterRef: REF_CATEGORIA,
      pesoLiquidoKg: 0.2,
      alturaCm: 10,
      variacoesUid: null,
      grupoDeVariacoesUid: null,
    });
    expect(db.ler(extraEm(raizId))).toEqual({ descricao: DESCRICAO, marca: 'Marca Neutra' });
    // The link sits on the ROOT, never on the sole member, which gets no extraData either.
    expect(db.ler(vinculoEm(raizId, 500))).toMatchObject({
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 500,
      sku: 'X',
    });
    expect(db.idsEm(`produtos/${membroId}/produtolojaintegrada`)).toEqual([]);
    expect(db.ler(extraEm(membroId))).toBeUndefined();
    // ONE commit: every write a create, all under batch 1.
    expect(db.escritas.map((e) => [e.verbo, e.lote])).toEqual([
      ['create', 1],
      ['create', 1],
      ['create', 1],
      ['create', 1],
    ]);
  });

  it('the SKU rungs answer it as they answer a hand-made família de um', async () => {
    const db = new FakeDb();
    await criar(db, simples(500, 'X'));
    const outra = await resolverRaizLi(
      { db: asDb(db), contaId: OUTRA },
      simples(900, 'X'),
      new Map(),
    );
    expect(outra).toMatchObject({
      tipo: SITUACAO_ERP_ITEM_LI.encontrado,
      erpId: idProdutoCriadoLi('X'),
      forma: FORMA_RAIZ_ERP.familiaDeUm,
    });
  });

  it('never written: price, cost, kit, publication and the anchor hold the schema defaults', async () => {
    const db = new FakeDb();
    await criar(db, simples(500, 'X'));
    expect(db.ler(`produtos/${idProdutoCriadoLi('X')}`)).toMatchObject({
      precos: null,
      custo: null,
      ehKit: false,
      ehKitVirtual: false,
      componentesKit: null,
      publicado: false,
      codPai: null,
      integracoesComProduto: [],
      fotos: null,
      fotosArquivosIds: null,
    });
  });
});

describe('a store family ⇒ an ERP parent and one child per kept variation', () => {
  it('names each child by the ERP family rule, takes the resolution, the parent’s category and — with none of its own — its box', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const r = await criar(db, familia(800, 'CAM', [AZUL, VERDE]));
    const raizId = idProdutoCriadoLi('CAM');
    const azul = idProdutoCriadoLi('CAM-AZ');
    const verde = idProdutoCriadoLi('CAM-VD');
    expect(r).toMatchObject({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
      produtos: [
        { produtoId: raizId, papel: PAPEL_DO_PRODUTO_CRIADO_LI.raiz, liId: 800 },
        { produtoId: azul, papel: PAPEL_DO_PRODUTO_CRIADO_LI.filho, liId: 801 },
        { produtoId: verde, papel: PAPEL_DO_PRODUTO_CRIADO_LI.filho, liId: 802 },
      ],
    });
    const fakeAzul = varianteFakePath(GRUPO, 'v-azul');
    const fakeVerde = varianteFakePath(GRUPO, 'v-verde');
    expect(db.ler(`produtos/${raizId}`)).toMatchObject({
      nome: 'Camiseta',
      sku: 'CAM',
      paiId: null,
      // A family of many names no child.
      filhoUnicoId: null,
      variacoesUid: [fakeAzul, fakeVerde],
      grupoDeVariacoesUid: [GRUPO],
      categoriaProdutoOuterRef: REF_CATEGORIA,
      alturaCm: 30,
    });
    expect(db.ler(`produtos/${azul}`)).toMatchObject({
      nome: 'Camiseta Azul',
      sku: 'CAM-AZ',
      paiId: raizId,
      ordem: 0,
      variacoesUid: [fakeAzul],
      grupoDeVariacoesUid: [GRUPO],
      categoriaProdutoOuterRef: REF_CATEGORIA,
      // Its own weight; its read detail has no dimension, so the parent's box.
      pesoLiquidoKg: 0.25,
      alturaCm: 30,
      larguraCm: 40,
      profundidadeCm: 50,
    });
    // NEAR-MISS: a variation with dimensions of its own keeps them, never mixed with the parent's.
    expect(db.ler(`produtos/${verde}`)).toMatchObject({
      nome: 'Camiseta Verde',
      ordem: 1,
      alturaCm: 11,
      larguraCm: 12,
      profundidadeCm: 13,
    });
    // A link on the parent and on every child (the child's names its parent's store id).
    expect(db.ler(vinculoEm(raizId, 800))).toMatchObject({ id: 800, sku: 'CAM' });
    expect(db.ler(vinculoEm(azul, 801))).toMatchObject({
      id: 801,
      sku: 'CAM-AZ',
      paiProdutoIntegradaId: 800,
    });
    expect(db.ler(vinculoEm(verde, 802))).toMatchObject({ id: 802, paiProdutoIntegradaId: 800 });
    // A child's brand is its parent's (its extraData is the fill of an empty one).
    expect(db.ler(extraEm(azul))).toEqual({ marca: 'Marca Neutra' });
    // Every write in ONE batch.
    expect(new Set(db.escritas.map((e) => e.lote))).toEqual(new Set([1]));
    expect(db.escritas.every((e) => e.verbo === 'create')).toBe(true);
  });

  it("⚠️ NEAR-MISS: a child's name is never the store variation's own `nome`", async () => {
    const db = new FakeDb();
    seedGrupo(db);
    await criar(db, familia(800, 'CAM', [{ ...AZUL, linha: { nome: 'Nome Da Loja' } }, VERDE]));
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM-AZ')}`)?.nome).toBe('Camiseta Azul');
  });

  it('a ONE-child family names its child in filhoUnicoId (derived over the full set)', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    await criar(db, familia(800, 'CAM', [AZUL]));
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM')}`)?.filhoUnicoId).toBe(
      idProdutoCriadoLi('CAM-AZ'),
    );
  });

  it('a hidden variation is not created: the family is created without it', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const r = await criar(db, familia(800, 'CAM', [AZUL, { ...VERDE, linha: { ativo: false } }]));
    expect(r.tipo).toBe(TIPO_RESULTADO_FAMILIA_NOVA_LI.criada);
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM-VD')}`)).toBeUndefined();
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM')}`)?.filhoUnicoId).toBe(
      idProdutoCriadoLi('CAM-AZ'),
    );
  });

  it('a variation whose option resolves to no variante refuses the WHOLE family, naming the option — nothing read or written', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const r = await criar(db, familia(800, 'CAM', [AZUL, { ...VERDE, opcao: 3 }]));
    expect(recusa(r)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo, liId: 802, referencias: ['8946/3'] },
    ]);
    expect(db.escritas).toEqual([]);
    expect(db.consultas).toEqual([]);
  });

  it('two variations on one combination refuse it (variacao-ambigua on both)', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    // Two store options linked to one ERP variante.
    const r = await criar(db, familia(800, 'CAM', [AZUL, { ...VERDE, opcao: 2 }]), {
      grupos: [grupoLi({ 1: ['v-azul'], 2: ['v-azul'] })],
    });
    expect(recusa(r)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, liId: 801, referencias: ['802'] },
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, liId: 802, referencias: ['801'] },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it('a grupo gone since the memo was read ⇒ variacao-sem-vinculo; one that does not parse ⇒ dado-invalido', async () => {
    const semGrupo = new FakeDb();
    expect(recusa(await criar(semGrupo, familia(800, 'CAM', [AZUL])))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo, liId: 801, referencias: ['8946/1'] },
    ]);
    const quebrado = new FakeDb();
    quebrado.seed(`grupoDeVariacoes/${GRUPO}`, { nome: '', variacoes: [] });
    expect(recusa(await criar(quebrado, familia(800, 'CAM', [AZUL])))).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
        liId: 801,
        referencias: ['grupoDeVariacoes.nome'],
      },
    ]);
    expect([...semGrupo.escritas, ...quebrado.escritas]).toEqual([]);
  });
});

/* ------------------------------ the documents ------------------------------ */

describe('every planned document parses — only a name is ever cut', () => {
  it('a brand name over 255 refuses the create (dado-invalido, its field), nothing written', async () => {
    const db = new FakeDb();
    const longa = 'M'.repeat(256);
    const f = simples(500, 'X');
    const r = await criarFamiliaLi(
      { db: asDb(db), contaId: CONTA, modo: MODO_IMPORTACAO_LI.aplicar, agoraMs: () => AGORA_MS },
      {
        familia: f,
        criacao: { viavel: true, nome: 'Produto 500', nomeCortado: false, filhos: [], ocultos: [] },
        grupos: [],
        categoriaErpId: CATEGORIA,
        marcas: [{ id: MARCA, nome: longa, ativo: true }],
      },
    );
    expect(recusa(r)).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
        liId: null,
        referencias: ['extraData.marca'],
      },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it('a description over 3,000 characters: created WITHOUT it, reported with its length', async () => {
    const db = new FakeDb();
    const r = await criar(db, simples(500, 'X', {}, { descricao_completa: 'd'.repeat(3001) }));
    expect(r).toMatchObject({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.descricaoLonga, liId: null, referencias: ['3001'] },
      ],
    });
    expect(db.ler(extraEm(idProdutoCriadoLi('X')))).toEqual({ marca: 'Marca Neutra' });
  });

  it('a name over 100 is cut at 100 and reported — the root’s and a child’s', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const longo = 'N'.repeat(98);
    const r = await criar(db, familia(800, 'CAM', [AZUL], { nome: longo }));
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM')}`)?.nome).toBe(longo);
    // NEAR-MISS: the root's 98 fit; its child's 98 + ' Azul' do not.
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM-AZ')}`)?.nome).toBe(`${longo} A`);
    expect(r).toMatchObject({
      pendencias: [{ codigo: PENDENCIA_IMPORTACAO_LI.nomeCortado, liId: 801, referencias: [] }],
    });
    const outra = new FakeDb();
    const r2 = await criar(outra, simples(500, 'X', { nome: 'P'.repeat(120) }));
    expect(outra.ler(`produtos/${idProdutoCriadoLi('X')}`)?.nome).toBe('P'.repeat(100));
    expect(r2).toMatchObject({
      pendencias: [{ codigo: PENDENCIA_IMPORTACAO_LI.nomeCortado, liId: null, referencias: [] }],
    });
  });

  it('NEAR-MISS: a refused create reports no cut name: nothing was created to carry it', async () => {
    const db = new FakeDb();
    db.seed('produtos/a-mao', { nome: 'A mão', sku: 'X', paiId: null, filhoUnicoId: null });
    const r = await criar(db, simples(500, 'X', { nome: 'P'.repeat(120) }));
    expect(r).toEqual({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.recusada,
      pendencias: [
        expect.objectContaining({ codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: null }),
      ],
    });
  });
});

/* ------------------------------- the details ------------------------------- */

describe('the details — the store’s fresher view decides too', () => {
  const semDetalheDaRaiz = (f: FamiliaLi): FamiliaLi => ({ ...f, detalheDaRaiz: null });

  it('the ROOT’s detail never read (the store answered 404: deleted since the listing) ⇒ dado-invalido(detalhe), nothing created; NEAR-MISS: read ⇒ created', async () => {
    const db = new FakeDb();
    expect(recusa(await criar(db, semDetalheDaRaiz(simples(500, 'X'))))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: null, referencias: ['detalhe'] },
    ]);
    expect(db.escritas).toEqual([]);
    expect((await criar(db, simples(500, 'X'))).tipo).toBe(TIPO_RESULTADO_FAMILIA_NOVA_LI.criada);
  });

  it('a kept VARIATION’s detail never read ⇒ dado-invalido(detalhe) on it, the whole family refused', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const f = familia(800, 'CAM', [AZUL, VERDE]);
    const r = await criar(db, {
      ...f,
      filhos: f.filhos.map((x) => (x.linha.id === 802 ? { ...x, detalhe: null } : x)),
    });
    expect(recusa(r)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: 802, referencias: ['detalhe'] },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it('a missing detail is judged only AFTER the probe: with a probe hit, the family reports the probe’s verdict', async () => {
    const db = new FakeDb();
    seedProduto(db, 'a-mao', { sku: 'X' });
    expect(recusa(await criar(db, semDetalheDaRaiz(simples(500, 'X'))))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: null, referencias: ['a-mao'] },
    ]);
  });

  it('the ROOT hidden, blocked or TRASHED in its detail ⇒ oculto-nao-criado; another SKU in it ⇒ dado-invalido(sku) — nothing read or written', async () => {
    for (const [detalhe, esperado] of [
      [{ ativo: false }, { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, referencias: [] }],
      [{ bloqueado: true }, { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, referencias: [] }],
      [{ removido: true }, { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, referencias: [] }],
      [{ sku: 'X-NOVO' }, { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, referencias: ['sku'] }],
    ] as const) {
      const db = new FakeDb();
      expect(
        recusa(await criar(db, simples(500, 'X', {}, detalhe))),
        JSON.stringify(detalhe),
      ).toEqual([{ codigo: esperado.codigo, liId: null, referencias: [...esperado.referencias] }]);
      expect(db.escritas).toEqual([]);
      expect(db.consultas).toEqual([]);
    }
  });

  it('a VARIATION hidden or trashed in its detail is left out (oculto-nao-criado); every one left out ⇒ not created', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const r = await criar(
      db,
      familia(800, 'CAM', [AZUL, { ...VERDE, detalhe: { ...VERDE.detalhe, removido: true } }]),
    );
    expect(r).toMatchObject({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
      pendencias: [{ codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId: 802, referencias: [] }],
    });
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM-VD')}`)).toBeUndefined();
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM')}`)?.filhoUnicoId).toBe(
      idProdutoCriadoLi('CAM-AZ'),
    );

    const nenhum = new FakeDb();
    seedGrupo(nenhum);
    const todos = await criar(
      nenhum,
      familia(800, 'CAM', [{ ...AZUL, detalhe: { ativo: false } }]),
    );
    expect(recusa(todos)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId: 801, referencias: [] },
    ]);
    expect(nenhum.escritas).toEqual([]);
  });

  it('a variation whose detail carries ANOTHER SKU refuses the family (dado-invalido(sku)): its id would be keyed on a stale SKU', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const r = await criar(
      db,
      familia(800, 'CAM', [AZUL, { ...VERDE, detalhe: { ...VERDE.detalhe, sku: 'CAM-VERDE' } }]),
    );
    expect(recusa(r)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: 802, referencias: ['sku'] },
    ]);
    expect(db.escritas).toEqual([]);
  });
});

describe('recusasAntesDosDetalhesLi — what refuses a create with no detail read', () => {
  const plano = (f: FamiliaLi) => {
    const p = planejarFamiliaLi({
      job: {
        integracaoId: CONTA,
        modo: MODO_IMPORTACAO_LI.aplicar,
        alvo: ALVO_IMPORTACAO_LI.todos,
        acao: ACAO_IMPORTACAO_LI.completar,
        selecionados: [],
      },
      familia: f,
      raiz: { tipo: SITUACAO_ERP_ITEM_LI.ausente },
      filhos: null,
      skusEmConflito: new Map(),
      recusasDoAprendizado: new Map(),
    });
    if (p.criacao === null) throw new Error('sem criação');
    return p.criacao;
  };
  const semDetalhes = (f: FamiliaLi): FamiliaLi => ({
    ...f,
    detalheDaRaiz: null,
    filhos: f.filhos.map((x) => ({ ...x, detalhe: null })),
  });
  const antes = (db: FakeDb, f: FamiliaLi) =>
    recusasAntesDosDetalhesLi(
      { db: asDb(db), contaId: CONTA },
      { familia: f, criacao: plano(f), grupos: [grupoLi()] },
    );

  it('PAIR: every option resolved and no SKU in the ERP ⇒ nothing refuses yet ⟷ NEAR-MISS an option with no link ⇒ variacao-sem-vinculo, no query', async () => {
    const db = new FakeDb();
    expect(await antes(db, semDetalhes(familia(800, 'CAM', [AZUL, VERDE])))).toEqual([]);
    const semVinculo = new FakeDb();
    expect(
      await antes(semVinculo, semDetalhes(familia(800, 'CAM', [AZUL, { ...VERDE, opcao: 3 }]))),
    ).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo, liId: 802, referencias: ['8946/3'] },
    ]);
    expect(semVinculo.consultas).toEqual([]);
  });

  it('the probe over the rows’ SKUs — a variation’s, the sole member’s DERIVED one — answers with no detail; a hit on a PLANNED id is left to the commit', async () => {
    const db = new FakeDb();
    seedProduto(db, 'erp-raiz', { sku: 'CAM-VD' });
    expect(await antes(db, semDetalhes(familia(800, 'CAM', [AZUL, VERDE])))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: 802, referencias: ['erp-raiz'] },
    ]);
    const membro = new FakeDb();
    seedProduto(membro, 'a-mao', { sku: 'X-UN' });
    expect(await antes(membro, semDetalhes(simples(500, 'X')))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: null, referencias: ['a-mao'] },
    ]);
    const planejado = new FakeDb();
    seedProduto(planejado, idProdutoCriadoLi('X'), { sku: 'X' });
    expect(await antes(planejado, semDetalhes(simples(500, 'X')))).toEqual([]);
  });
});

describe('antesDoLote — what must precede the batch', () => {
  it('runs after the probe and every check, right BEFORE the commit, with every produto of the batch (the sole member too); NEAR-MISS Simular never runs it', async () => {
    const db = new FakeDb();
    const vistos: unknown[] = [];
    const deps = {
      db: asDb(db),
      contaId: CONTA,
      agoraMs: () => AGORA_MS,
      antesDoLote: async (produtos: readonly unknown[]) => {
        vistos.push({ produtos: [...produtos], escritas: db.escritas.length });
        return null;
      },
    };
    const f = simples(500, 'X');
    const criacao = {
      viavel: true,
      nome: 'Produto 500',
      nomeCortado: false,
      filhos: [],
      ocultos: [],
    };
    const entrada = { familia: f, criacao, grupos: [], categoriaErpId: CATEGORIA, marcas: MARCAS };
    await criarFamiliaLi({ ...deps, modo: MODO_IMPORTACAO_LI.simular }, entrada);
    expect(vistos).toEqual([]);
    const r = await criarFamiliaLi({ ...deps, modo: MODO_IMPORTACAO_LI.aplicar }, entrada);
    expect(r.tipo).toBe(TIPO_RESULTADO_FAMILIA_NOVA_LI.criada);
    expect(vistos).toEqual([
      {
        produtos: [
          { produtoId: idProdutoCriadoLi('X'), papel: PAPEL_DO_PRODUTO_CRIADO_LI.raiz, liId: 500 },
          { produtoId: idMembroCriadoLi('X'), papel: PAPEL_DO_PRODUTO_CRIADO_LI.membro, liId: 500 },
        ],
        escritas: 0,
      },
    ]);
  });

  it('its pendências refuse the create: nothing of the batch is written', async () => {
    const db = new FakeDb();
    const recusada = {
      codigo: PENDENCIA_IMPORTACAO_LI.categoriaAmbigua,
      liId: null,
      referencias: ['900'],
    };
    const r = await criarFamiliaLi(
      {
        db: asDb(db),
        contaId: CONTA,
        modo: MODO_IMPORTACAO_LI.aplicar,
        agoraMs: () => AGORA_MS,
        antesDoLote: () => Promise.resolve([recusada]),
      },
      {
        familia: simples(500, 'X'),
        criacao: { viavel: true, nome: 'Produto 500', nomeCortado: false, filhos: [], ocultos: [] },
        grupos: [],
        categoriaErpId: CATEGORIA,
        marcas: MARCAS,
      },
    );
    expect(recusa(r)).toEqual([recusada]);
    expect(db.escritas).toEqual([]);
  });
});

describe('a name the cut made', () => {
  it('two variations whose CUT names come out equal ⇒ dado-invalido(nome) on both, nothing created', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    // The parent's name fills the field: "<100> Azul" and "<100> Verde" both cut back to it.
    const r = await criar(db, familia(800, 'CAM', [AZUL, VERDE], { nome: 'N'.repeat(100) }));
    expect(recusa(r)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: 801, referencias: ['nome'] },
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: 802, referencias: ['nome'] },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it('nomesIguaisPeloCorteLi — EQUAL by the cut ⇒ both named; NEAR-MISS: equal with NO cut (the builder’s own), or cut and distinct ⇒ none', () => {
    expect(
      nomesIguaisPeloCorteLi([
        { liId: 2, nome: 'A', cortado: false },
        { liId: 1, nome: 'A', cortado: true },
      ]),
    ).toEqual([1, 2]);
    expect(
      nomesIguaisPeloCorteLi([
        { liId: 1, nome: 'A', cortado: false },
        { liId: 2, nome: 'A', cortado: false },
      ]),
    ).toEqual([]);
    expect(
      nomesIguaisPeloCorteLi([
        { liId: 1, nome: 'A', cortado: true },
        { liId: 2, nome: 'a', cortado: true },
      ]),
    ).toEqual([]);
  });
});

/* -------------------------------- the probe -------------------------------- */

describe('the create probe — every SKU the batch would write, across the whole catalogue', () => {
  it("EQUAL: a variation's SKU equal to an ERP ROOT's refuses the WHOLE family, naming the ERP id", async () => {
    const db = new FakeDb();
    seedGrupo(db);
    seedProduto(db, 'erp-raiz', { sku: 'CAM-AZ' });
    const r = await criar(db, familia(800, 'CAM', [AZUL, VERDE]));
    expect(recusa(r)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: 801, referencias: ['erp-raiz'] },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it("EQUAL: equal to ANOTHER family's child refuses it too (no paiId filter)", async () => {
    const db = new FakeDb();
    seedGrupo(db);
    seedProduto(db, 'outro-filho', { sku: 'CAM-VD', paiId: 'outro-pai' });
    expect(recusa(await criar(db, familia(800, 'CAM', [AZUL, VERDE])))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: 802, referencias: ['outro-filho'] },
    ]);
  });

  it("EQUAL: the sole member's DERIVED SKU equal to an existing produto refuses the simple product", async () => {
    const db = new FakeDb();
    seedProduto(db, 'a-mao', { sku: 'X-UN' });
    expect(recusa(await criar(db, simples(500, 'X')))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: null, referencias: ['a-mao'] },
    ]);
  });

  it("a 'parecido' hit alone ⇒ sku-parecido, nothing created", async () => {
    const db = new FakeDb();
    seedProduto(db, 'maiusculo', { sku: 'ABC-1' });
    expect(recusa(await criar(db, simples(500, 'abc-1')))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuParecido, liId: null, referencias: ['maiusculo'] },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it("⚠️ NEAR-MISS: 'CAM-AZ' against an ERP 'CAM-AZUL' is no hit — created", async () => {
    const db = new FakeDb();
    seedGrupo(db);
    seedProduto(db, 'erp-azul', { sku: 'CAM-AZUL' });
    const r = await criar(db, familia(800, 'CAM', [AZUL, VERDE]));
    expect(r.tipo).toBe(TIPO_RESULTADO_FAMILIA_NOVA_LI.criada);
  });

  it('runs AFTER the plan, right before the commit: a produto made by hand in between is caught', async () => {
    const db = new FakeDb();
    db.antesDaProximaConsulta('produtos', () => seedProduto(db, 'a-mao', { sku: 'X' }));
    expect(recusa(await criar(db, simples(500, 'X')))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: null, referencias: ['a-mao'] },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it("⚠️ NEAR-MISS: a hit on one of the PLANNED ids (another conta's create, landed just before the probe) is left to the commit — adopted, never refused", async () => {
    const db = new FakeDb();
    db.antesDaProximaConsulta('produtos', async () => {
      await criar(db, simples(900, 'X'), { conta: OUTRA });
    });
    expect(await criar(db, simples(500, 'X'))).toEqual({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.existente,
      raizId: idProdutoCriadoLi('X'),
    });
  });
});

/* ---------------------------- ALREADY_EXISTS ------------------------------ */

describe('the planned ids and ALREADY_EXISTS', () => {
  it("two contas' creates of SKU 'X' ⇒ ONE produto, TWO link docs (the second adopts, then links)", async () => {
    const db = new FakeDb();
    const raizId = idProdutoCriadoLi('X');
    // The other conta's job creates the same store product between this one's probe and commit.
    const r = await criar(db, simples(500, 'X'), {
      antesDoCommit: async () => {
        const daOutra = await criar(db, simples(900, 'X'), { conta: OUTRA });
        expect(daOutra.tipo).toBe(TIPO_RESULTADO_FAMILIA_NOVA_LI.criada);
      },
    });
    expect(r).toEqual({ tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.existente, raizId });
    // This conta's batch was rejected whole: only the other conta's link is there.
    expect(db.idsEm(`produtos/${raizId}/produtolojaintegrada`)).toEqual(['900']);
    expect(new Set(db.escritas.map((e) => e.lote))).toEqual(new Set([1]));

    // The existing-product path: the cascade now finds the root by its SKU, the link is written.
    const contexto = { db: asDb(db), contaId: CONTA };
    const raiz = await resolverRaizLi(contexto, simples(500, 'X'), new Map());
    expect(raiz).toMatchObject({ tipo: SITUACAO_ERP_ITEM_LI.encontrado, erpId: raizId });
    const plano = planejarFamiliaLi({
      job: {
        integracaoId: CONTA,
        modo: MODO_IMPORTACAO_LI.aplicar,
        alvo: ALVO_IMPORTACAO_LI.todos,
        acao: ACAO_IMPORTACAO_LI.completar,
        selecionados: [],
      },
      familia: simples(500, 'X'),
      raiz,
      filhos: null,
      skusEmConflito: new Map(),
      recusasDoAprendizado: new Map(),
    });
    const criacaoDoJob = seedJobLi(db, 'job-familia-nova', CONTA) as unknown as Timestamp;
    await vincularFamiliaLi({ ...contexto, modo: MODO_IMPORTACAO_LI.aplicar, criacaoDoJob }, plano);
    expect(db.idsEm(`produtos/${raizId}/produtolojaintegrada`).sort()).toEqual(['500', '900']);
    expect(
      db.idsEm('produtos').filter((id) => id.startsWith(PREFIXO_ID_PRODUTO_CRIADO_LI)),
    ).toEqual([raizId, idMembroCriadoLi('X')]);
  });

  it("this conta's OWN batch, landed with its reply lost ⇒ criada (retomada), nothing written again", async () => {
    const db = new FakeDb();
    const r = await criar(db, simples(500, 'X'), {
      // The first commit of this very call landed; the SDK's retry met it as ALREADY_EXISTS.
      antesDoCommit: async () => {
        await criar(db, simples(500, 'X'));
      },
    });
    expect(r).toMatchObject({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
      gravado: true,
      retomada: true,
    });
    expect(new Set(db.escritas.map((e) => e.lote))).toEqual(new Set([1]));
  });

  it('⚠️ NEAR-MISS: the root and this conta’s link from TWO commits are not one batch ⇒ existente', async () => {
    const db = new FakeDb();
    const raizId = idProdutoCriadoLi('X');
    seedProduto(db, raizId, { sku: 'X' });
    db.seed(vinculoEm(raizId, 500), {
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 500,
      sku: 'X',
    });
    expect(await criar(db, simples(500, 'X'))).toEqual({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.existente,
      raizId,
    });
    expect(db.escritas).toEqual([]);
  });

  it('a doc at the id with ANOTHER SKU ⇒ sku-ja-existe, never adopted — read before, or met by the commit', async () => {
    const antes = new FakeDb();
    const raizId = idProdutoCriadoLi('X');
    seedProduto(antes, raizId, { sku: 'x' });
    expect(recusa(await criar(antes, simples(500, 'X')))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: null, referencias: [raizId] },
    ]);
    expect(antes.escritas).toEqual([]);

    const noCommit = new FakeDb();
    const r = await criar(noCommit, simples(500, 'X'), {
      antesDoCommit: () => seedProduto(noCommit, raizId, { sku: 'X ' }),
    });
    expect(recusa(r)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: null, referencias: [raizId] },
    ]);
    expect(noCommit.escritas).toEqual([]);
  });

  it('the family batch is ONE commit: a child id taken before it fails ALL of it — nothing of it lands', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const raizId = idProdutoCriadoLi('CAM');
    const verde = idProdutoCriadoLi('CAM-VD');
    const r = await criar(db, familia(800, 'CAM', [AZUL, VERDE]), {
      antesDoCommit: () => seedProduto(db, verde, { sku: 'CAM-VD', paiId: raizId }),
    });
    // The root is absent, so that child is a SKU the ERP holds outside the family.
    expect(recusa(r)).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: 802, referencias: [verde] },
    ]);
    expect(db.escritas).toEqual([]);
    expect(db.ler(`produtos/${raizId}`)).toBeUndefined();
    expect(db.ler(`produtos/${idProdutoCriadoLi('CAM-AZ')}`)).toBeUndefined();
    expect(db.ler(vinculoEm(raizId, 800))).toBeUndefined();
  });

  it('a stray document under a planned id that no read explains ⇒ conflito-de-escrita after the attempts', async () => {
    const db = new FakeDb();
    const raizId = idProdutoCriadoLi('X');
    db.seed(vinculoEm(raizId, 500), { sobra: true });
    expect(recusa(await criar(db, simples(500, 'X')))).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId: null, referencias: [raizId] },
    ]);
    expect(db.escritas).toEqual([]);
    // One probe per attempt.
    expect(db.consultas.filter((c) => c.colecao === 'produtos')).toHaveLength(
      MAX_TENTATIVAS_FAMILIA_NOVA_LI,
    );
  });

  it('estadoDoIdPlanejadoLi — EQUAL: the SKU byte for byte under the planned parent; NEAR-MISS: anything else', () => {
    const snap = (data: DocData | undefined) => ({ exists: data !== undefined, data: () => data });
    const raiz = { sku: 'X', paiId: null };
    expect(estadoDoIdPlanejadoLi(snap(undefined), raiz)).toBe(ESTADO_DO_ID_PLANEJADO_LI.livre);
    expect(estadoDoIdPlanejadoLi(snap({ sku: 'X', paiId: null }), raiz)).toBe(
      ESTADO_DO_ID_PLANEJADO_LI.nosso,
    );
    expect(estadoDoIdPlanejadoLi(snap({ sku: 'X' }), raiz)).toBe(ESTADO_DO_ID_PLANEJADO_LI.nosso);
    for (const outro of [
      { sku: 'x', paiId: null },
      { sku: 'X ', paiId: null },
      { sku: 'X', paiId: 'p' },
      { sku: null },
    ]) {
      expect(estadoDoIdPlanejadoLi(snap(outro), raiz)).toBe(ESTADO_DO_ID_PLANEJADO_LI.outro);
    }
    expect(
      estadoDoIdPlanejadoLi(snap({ sku: 'X-AZ', paiId: 'r' }), { sku: 'X-AZ', paiId: 'r' }),
    ).toBe(ESTADO_DO_ID_PLANEJADO_LI.nosso);
    expect(
      estadoDoIdPlanejadoLi(snap({ sku: 'X-AZ', paiId: 'q' }), { sku: 'X-AZ', paiId: 'r' }),
    ).toBe(ESTADO_DO_ID_PLANEJADO_LI.outro);
  });
});

/* -------------------------------- Simular --------------------------------- */

describe('Simular — the same reads and verdicts, nothing written', () => {
  it('a creatable family: criada, nothing written — and aplicar then creates exactly those produtos', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    const simulada = await criar(db, familia(800, 'CAM', [AZUL, VERDE]), {
      modo: MODO_IMPORTACAO_LI.simular,
    });
    expect(simulada).toMatchObject({ tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada, gravado: false });
    expect(db.escritas).toEqual([]);
    const aplicada = await criar(db, familia(800, 'CAM', [AZUL, VERDE]));
    expect(aplicada).toMatchObject({ gravado: true });
    expect(aplicada.tipo === 'criada' && aplicada.produtos).toEqual(
      simulada.tipo === 'criada' && simulada.produtos,
    );
  });

  it('a refusal and an adoption read the same under both modes', async () => {
    for (const modo of [MODO_IMPORTACAO_LI.simular, MODO_IMPORTACAO_LI.aplicar]) {
      const recusada = new FakeDb();
      seedProduto(recusada, 'a-mao', { sku: 'X-UN' });
      expect(recusa(await criar(recusada, simples(500, 'X'), { modo }))).toEqual([
        { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: null, referencias: ['a-mao'] },
      ]);
      const adotada = new FakeDb();
      seedProduto(adotada, idProdutoCriadoLi('X'), { sku: 'X' });
      expect((await criar(adotada, simples(500, 'X'), { modo })).tipo).toBe(
        TIPO_RESULTADO_FAMILIA_NOVA_LI.existente,
      );
      expect([...recusada.escritas, ...adotada.escritas]).toEqual([]);
    }
  });
});

/* ------------------------------- the indexes ------------------------------- */

describe('every query rides a declared index (root rule 1)', () => {
  it('the probe: `sku in`, on `produtos (sku ASC)`; everything else is read by id', async () => {
    const db = new FakeDb();
    seedGrupo(db);
    await criar(db, familia(800, 'CAM', [AZUL, VERDE]));
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
    const declarados = (
      JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
        indexes: {
          collectionGroup: string;
          queryScope: string;
          fields: { fieldPath: string }[];
        }[];
      }
    ).indexes;
    expect(db.consultas.map((c) => c.filtros.map(([campo, op]) => `${campo} ${op}`))).toEqual([
      ['sku in'],
    ]);
    for (const c of db.consultas) {
      const campos = c.filtros.map(([campo]) => campo).sort();
      const servida = declarados.some(
        (i) =>
          i.collectionGroup === c.colecao &&
          i.queryScope === 'COLLECTION' &&
          JSON.stringify(
            i.fields
              .slice(0, campos.length)
              .map((f) => f.fieldPath)
              .sort(),
          ) === JSON.stringify(campos),
      );
      expect(servida, JSON.stringify(c)).toBe(true);
    }
  });
});
