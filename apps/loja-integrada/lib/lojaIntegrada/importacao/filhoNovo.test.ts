/**
 * The product import's add-child (`filhoNovo.ts`) on the fake Firestore: a store variation missing
 * from a matched ERP family is added with the parent's `filhoUnicoId` re-derived over the FULL
 * child set in ONE batch under the parent's precondition; a sibling deleted between the read and
 * the commit fails it and the re-plan derives the right pointer; the post-commit re-derive repairs a
 * pointer a writer moved without touching the parent; only grupos the family already uses; the
 * create probe; our own landed batch; Simular.
 *
 * Every sameness decision is pinned as a PAIR (the equal case and the near-miss). Every query is
 * checked against `firestore.indexes.json`. Nothing reaches the network (D17): the GLOBAL `fetch` is
 * stubbed to throw for the whole file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  type GrupoComLinksLi,
  type MarcaCatalogoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  type ResolucaoOpcaoLi,
  TIPO_RESOLUCAO_OPCAO_LI,
  fundirLinksVariacoesLi,
  varianteFakePath,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import {
  detalheLi,
  filhoLi,
  paiLi,
  uriOpcaoLi,
  vistaDetalhadaLi,
  vistaLi,
} from '../testing/produtosLi';
import { idProdutoCriadoLi } from './familiaNova';
import { type FamiliaLi, ORIGEM_DO_FILHO_LI } from './familias';
import {
  DESFECHO_DO_PONTEIRO_LI,
  type EntradaDoFilhoNovoLi,
  MAX_TENTATIVAS_FILHO_NOVO_LI,
  type ResultadoDoFilhoNovoLi,
  adicionarFilhosLi,
  gruposDaFamiliaErpLi,
  rederivarFilhoUnicoLi,
} from './filhoNovo';
import { type ResolucaoDosFilhosLi, SITUACAO_DO_FILHO_LI, resolverFilhosLi } from './resolucao';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('filhoNovo.test: nenhuma chamada de rede'))),
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

const CONTA = 'conta-li-filho-novo';
const OUTRA = 'conta-li-filho-novo-2';
const GRADE = 8946;
const GRADE_TAMANHO = 7000;
const COR = 'grupo-cor-filho-novo';
const TAMANHO = 'grupo-tamanho-filho-novo';
const CATEGORIA = 'cat-filho-novo';
const REF_CATEGORIA = `documents/categorias/${CATEGORIA}`;
const MARCAS: readonly MarcaCatalogoLi[] = [{ id: 5001, nome: 'Marca Neutra', ativo: true }];
const PAI = 'erp-pai-filho-novo';
const AZUL_ERP = 'erp-azul-filho-novo';

const fake = (grupo: string, variante: string) => varianteFakePath(grupo, variante);
const vinculoEm = (produtoId: string, liId: number) =>
  `produtos/${produtoId}/produtolojaintegrada/${String(liId)}`;
const VERDE_ID = idProdutoCriadoLi('CAM-VD');
const ROXO_ID = idProdutoCriadoLi('CAM-RX');

/** The ERP grupos "Cor" and "Tamanho", as stored. */
function seedGrupos(db: FakeDb): void {
  db.seed(`grupoDeVariacoes/${COR}`, {
    nome: 'Cor',
    ordem: 1,
    variacoes: [
      { id: 'v-azul', nome: 'Azul' },
      { id: 'v-verde', nome: 'Verde' },
      { id: 'v-roxo', nome: 'Roxo' },
    ],
  });
  db.seed(`grupoDeVariacoes/${TAMANHO}`, {
    nome: 'Tamanho',
    ordem: 2,
    variacoes: [{ id: 'v-p', nome: 'P' }],
  });
}

/** The memo's grupo with `conta`'s link of `grade`: option id → variante ids. */
function grupoLi(
  id: string,
  grade: number,
  variantes: readonly string[],
  opcoes: Record<number, readonly string[]>,
  conta = CONTA,
): GrupoComLinksLi {
  return {
    id,
    variantesIds: [...variantes],
    // Built by the shared never-drop merge, exactly as a learning would write it.
    linksVariacoesli: linksDe(conta, grade, opcoes),
  };
}

const MEMO: readonly GrupoComLinksLi[] = [
  grupoLi(COR, GRADE, ['v-azul', 'v-verde', 'v-roxo'], {
    1: ['v-azul'],
    2: ['v-verde'],
    4: ['v-roxo'],
  }),
  grupoLi(TAMANHO, GRADE_TAMANHO, ['v-p'], { 5: ['v-p'] }),
];

/**
 * The ERP family "Camiseta": ONE child, Azul (a one-variation family, so `filhoUnicoId` names it),
 * `ordem` 0, the parent's selection over the grupo "Cor".
 */
function seedFamiliaErp(db: FakeDb, filhos: Record<string, DocData> = {}): void {
  db.seed(`produtos/${PAI}`, {
    nome: 'Camiseta',
    sku: 'CAM',
    paiId: null,
    filhoUnicoId: AZUL_ERP,
    grupoDeVariacoesUid: [COR],
    variacoesUid: [fake(COR, 'v-azul')],
  });
  db.seed(`produtos/${AZUL_ERP}`, {
    nome: 'Camiseta Azul',
    sku: 'CAM-AZ',
    paiId: PAI,
    ordem: 0,
    variacoesUid: [fake(COR, 'v-azul')],
    grupoDeVariacoesUid: [COR],
  });
  for (const [id, dados] of Object.entries(filhos)) db.seed(`produtos/${id}`, dados);
}

interface Variacao {
  readonly id: number;
  readonly sku: string;
  readonly opcoes: readonly (readonly [number, number])[];
  readonly linha?: DocData;
  readonly detalhe?: DocData;
}

const AZUL: Variacao = { id: 801, sku: 'CAM-AZ', opcoes: [[GRADE, 1]] };
const VERDE: Variacao = {
  id: 802,
  sku: 'CAM-VD',
  opcoes: [[GRADE, 2]],
  detalhe: { altura: 11, largura: 12, profundidade: 13 },
};
const ROXO: Variacao = { id: 803, sku: 'CAM-RX', opcoes: [[GRADE, 4]] };

/** The store family "Camiseta" (store id 800) with its variations and their details. */
function familia(variacoes: readonly Variacao[]): FamiliaLi {
  const row = paiLi(
    800,
    variacoes.map((v) => v.id),
    { sku: 'CAM', nome: 'Camiseta' },
  );
  return {
    raiz: vistaLi(row),
    detalheDaRaiz: vistaDetalhadaLi(
      detalheLi(row, null, {
        marca: '/api/v1/marca/5001',
        peso: '0.900',
        altura: 30,
        largura: 40,
        profundidade: 50,
      }),
    ),
    filhos: variacoes.map((v) => {
      const filho = filhoLi(v.id, {
        sku: v.sku,
        variacoes: v.opcoes.map(([g, o]) => uriOpcaoLi(g, o)),
        ...v.linha,
      });
      return {
        linha: vistaLi(filho),
        detalhe: vistaDetalhadaLi(detalheLi(filho, 800, { peso: '0.250', ...v.detalhe })),
        origem: ORIGEM_DO_FILHO_LI.filhos,
      };
    }),
    semDetalhe: [],
    pendencias: [],
  };
}

/** The cascade's verdict on `f`'s variations under the ERP parent, as the family unit runs it. */
async function cascata(db: FakeDb, f: FamiliaLi): Promise<ResolucaoDosFilhosLi> {
  return resolverFilhosLi({ db: asDb(db), contaId: CONTA }, f, PAI, {
    grupos: MEMO,
    skusRepetidos: new Set(),
  });
}

/** A hand-built `ausente` verdict whose options all resolved to `(grupo, variante)`. */
function ausente(liId: number, opcoes: readonly (readonly [number, number, string, string])[]) {
  return {
    liId,
    situacao: SITUACAO_DO_FILHO_LI.ausente,
    erp: null,
    via: null,
    opcoes: opcoes.map(
      ([gradeId, opcaoId, grupo, variante]): ResolucaoOpcaoLi => ({
        tipo: TIPO_RESOLUCAO_OPCAO_LI.resolvida,
        gradeId,
        opcaoId,
        grupoIds: [grupo],
        varianteIds: [variante],
      }),
    ),
    pendencias: [],
  };
}

interface Opcoes {
  readonly modo?: ModoImportacaoLi;
  readonly conta?: string;
  readonly antesDoCommit?: () => Promise<void> | void;
}

function adicionar(
  db: FakeDb,
  entrada: Omit<EntradaDoFilhoNovoLi, 'erpPaiId' | 'categoriaErpId' | 'marcas' | 'skusRepetidos'> &
    Partial<Pick<EntradaDoFilhoNovoLi, 'skusRepetidos'>>,
  o: Opcoes = {},
): Promise<ResultadoDoFilhoNovoLi> {
  return adicionarFilhosLi(
    {
      db: asDb(db),
      contaId: o.conta ?? CONTA,
      modo: o.modo ?? MODO_IMPORTACAO_LI.aplicar,
      agoraMs: () => AGORA_MS,
      ...(o.antesDoCommit === undefined ? {} : { antesDoCommit: o.antesDoCommit }),
    },
    {
      erpPaiId: PAI,
      categoriaErpId: CATEGORIA,
      marcas: MARCAS,
      skusRepetidos: new Set(),
      ...entrada,
    },
  );
}

/** A produto's ref through the collection handle (a concurrent writer's). */
function produto(db: FakeDb, id: string) {
  return produtoCollection.docRef(asDb(db), {}, id);
}

/** A one-shot seam: `fn` runs before the FIRST commit only. */
function umaVez(fn: () => Promise<void> | void): () => Promise<void> {
  let feito = false;
  return async () => {
    if (feito) return;
    feito = true;
    await fn();
  };
}

/* ------------------------------- the add ---------------------------------- */

describe('a missing variation is added to the matched family, in ONE batch under the parent', () => {
  it('the child, its extraData and link, and the parent’s pointer re-derived over the FULL set', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const paiAntes = db.carimboDe(`produtos/${PAI}`);
    const f = familia([AZUL, VERDE]);
    const r = await adicionar(db, { familia: f, filhos: await cascata(db, f) });
    expect(r).toMatchObject({
      adicionados: [{ liId: 802, produtoId: VERDE_ID, retomado: false }],
      existentes: [],
      pendencias: [],
      gravado: true,
      ponteiro: DESFECHO_DO_PONTEIRO_LI.igual,
    });
    expect(db.ler(`produtos/${VERDE_ID}`)).toMatchObject({
      nome: 'Camiseta Verde',
      sku: 'CAM-VD',
      paiId: PAI,
      ordem: 1,
      variacoesUid: [fake(COR, 'v-verde')],
      grupoDeVariacoesUid: [COR],
      categoriaProdutoOuterRef: REF_CATEGORIA,
      pesoLiquidoKg: 0.25,
      alturaCm: 11,
      timestamp: AGORA_MS,
    });
    expect(db.ler(vinculoEm(VERDE_ID, 802))).toMatchObject({
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 802,
      paiProdutoIntegradaId: 800,
    });
    // One child of one becomes two: the pointer goes from Azul to none.
    expect(db.ler(`produtos/${PAI}`)).toMatchObject({
      filhoUnicoId: null,
      ultimaModificacao: AGORA_MS,
      // The selection is not extended (a value is never written over).
      variacoesUid: [fake(COR, 'v-azul')],
    });
    const lote = db.escritas.filter((e) => e.lote === 1);
    expect(lote.map((e) => [e.verbo, e.caminho])).toEqual([
      ['create', `produtos/${VERDE_ID}`],
      ['create', `produtos/${VERDE_ID}/extraData/singleton`],
      ['create', vinculoEm(VERDE_ID, 802)],
      ['update', `produtos/${PAI}`],
    ]);
    expect(db.escritas).toHaveLength(lote.length);
    expect(paiAntes).toBeDefined();
  });

  it('⚠️ NEAR-MISS: the pointer comes from the FULL set — one child added to a family with none names it', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    db.seed(`produtos/${PAI}`, {
      nome: 'Camiseta',
      sku: 'CAM',
      paiId: null,
      grupoDeVariacoesUid: [COR],
    });
    await adicionar(db, {
      familia: familia([VERDE]),
      filhos: { filhos: [ausente(802, [[GRADE, 2, COR, 'v-verde']])] },
    });
    expect(db.ler(`produtos/${PAI}`)?.filhoUnicoId).toBe(VERDE_ID);
    expect(db.ler(`produtos/${VERDE_ID}`)?.ordem).toBe(0);
  });

  it('a sibling deleted between the child-set read and the commit fails the batch; the re-plan derives the right pointer', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const f = familia([AZUL, VERDE]);
    const filhos = await cascata(db, f);
    const r = await adicionar(
      db,
      { familia: f, filhos },
      {
        // An ERP writer removes Azul and moves the pointer, in the parent too.
        antesDoCommit: umaVez(async () => {
          await produto(db, AZUL_ERP).delete();
          await produto(db, PAI).update({ filhoUnicoId: null });
        }),
      },
    );
    expect(r).toMatchObject({ adicionados: [{ liId: 802, produtoId: VERDE_ID }], gravado: true });
    // The stale set {Azul, Verde} would say "none"; the live one is Verde alone.
    expect(db.ler(`produtos/${PAI}`)?.filhoUnicoId).toBe(VERDE_ID);
    // The first batch landed nothing; the second, everything — and it was the RE-PLAN that derived
    // the pointer, in the batch itself: the post-commit re-derive had nothing left to repair.
    expect(db.escritas.filter((e) => e.lote !== undefined).map((e) => e.lote)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(
      db.escritas.find((e) => e.lote === 1 && e.caminho === `produtos/${PAI}`)?.dados,
    ).toMatchObject({ filhoUnicoId: VERDE_ID });
    expect(r.ponteiro).toBe(DESFECHO_DO_PONTEIRO_LI.igual);
  });

  it('the post-commit re-derive repairs a pointer a writer changed WITHOUT touching the parent', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const f = familia([AZUL, VERDE]);
    const filhos = await cascata(db, f);
    const r = await adicionar(
      db,
      { familia: f, filhos },
      // Azul removed alone: the parent's stamp does not move, so the batch lands on {Azul, Verde}.
      {
        antesDoCommit: umaVez(async () => {
          await produto(db, AZUL_ERP).delete();
        }),
      },
    );
    expect(r.ponteiro).toBe(DESFECHO_DO_PONTEIRO_LI.corrigido);
    expect(db.ler(`produtos/${PAI}`)?.filhoUnicoId).toBe(VERDE_ID);
  });

  it(`a lost precondition on every attempt ⇒ conflito-de-escrita after ${String(MAX_TENTATIVAS_FILHO_NOVO_LI)}, nothing of ours lands`, async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const f = familia([AZUL, VERDE]);
    const filhos = await cascata(db, f);
    let toques = 0;
    const r = await adicionar(
      db,
      { familia: f, filhos },
      {
        antesDoCommit: async () => {
          toques += 1;
          await produto(db, PAI).update({ nome: `Camiseta ${String(toques)}` });
        },
      },
    );
    expect(toques).toBe(MAX_TENTATIVAS_FILHO_NOVO_LI);
    expect(r).toMatchObject({
      adicionados: [],
      gravado: false,
      pendencias: [
        { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId: 802, referencias: [PAI] },
      ],
    });
    expect(db.ler(`produtos/${VERDE_ID}`)).toBeUndefined();
  });

  it('the parent gone ⇒ conflito-de-escrita, nothing written', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    const r = await adicionar(db, {
      familia: familia([VERDE]),
      filhos: { filhos: [ausente(802, [[GRADE, 2, COR, 'v-verde']])] },
    });
    expect(r.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId: null, referencias: [PAI] },
    ]);
    expect(db.escritas).toEqual([]);
  });
});

/* ------------------------------ which variations ---------------------------- */

describe('which variations are added', () => {
  it('EQUAL: an option of a grupo the family uses ⇒ added; NEAR-MISS: a grupo it does not use ⇒ variacao-sem-vinculo, naming it', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const r = await adicionar(db, {
      familia: familia([
        VERDE,
        {
          ...ROXO,
          opcoes: [
            [GRADE, 4],
            [GRADE_TAMANHO, 5],
          ],
        },
      ]),
      filhos: {
        filhos: [
          ausente(802, [[GRADE, 2, COR, 'v-verde']]),
          ausente(803, [
            [GRADE, 4, COR, 'v-roxo'],
            [GRADE_TAMANHO, 5, TAMANHO, 'v-p'],
          ]),
        ],
      },
    });
    expect(r.adicionados.map((a) => a.liId)).toEqual([802]);
    expect(r.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo, liId: 803, referencias: ['7000/5'] },
    ]);
    expect(db.ler(`produtos/${ROXO_ID}`)).toBeUndefined();
  });

  it('gruposDaFamiliaErpLi reads the parent’s and the children’s grupos in every stored ref form', () => {
    expect(
      [
        ...gruposDaFamiliaErpLi({ grupoDeVariacoesUid: ['documents/grupoDeVariacoes/g1'] }, [
          { grupoDeVariacoesUid: ['g2'] },
          { variacoesUid: ['grupoDeVariacoes/g3/variacoes/v'] },
          { variacoesUid: [7], grupoDeVariacoesUid: null },
        ]),
      ].sort(),
    ).toEqual(['g1', 'g2', 'g3']);
  });

  it('a combination an existing child already holds ⇒ variacao-ambigua naming it; two added on one combination ⇒ both refused', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db, {
      'erp-verde-antigo': {
        nome: 'Camiseta Verde',
        sku: 'CAM-VERDE',
        paiId: PAI,
        variacoesUid: [`grupoDeVariacoes/${COR}/variacoes/v-verde`],
      },
    });
    const r = await adicionar(db, {
      familia: familia([VERDE, ROXO, { id: 804, sku: 'CAM-RX2', opcoes: [[GRADE, 4]] }]),
      filhos: {
        filhos: [
          ausente(802, [[GRADE, 2, COR, 'v-verde']]),
          ausente(803, [[GRADE, 4, COR, 'v-roxo']]),
          ausente(804, [[GRADE, 4, COR, 'v-roxo']]),
        ],
      },
    });
    expect(r.adicionados).toEqual([]);
    expect(r.pendencias).toEqual([
      {
        codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua,
        liId: 802,
        referencias: ['erp-verde-antigo'],
      },
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, liId: 803, referencias: [] },
      { codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua, liId: 804, referencias: [] },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it('a hidden variation is not added (oculto-nao-criado), with zero reads; a matched one is no candidate', async () => {
    const db = new FakeDb();
    seedFamiliaErp(db);
    const r = await adicionar(db, {
      familia: familia([AZUL, { ...VERDE, linha: { ativo: false } }]),
      filhos: {
        filhos: [
          { ...ausente(801, [[GRADE, 1, COR, 'v-azul']]), situacao: SITUACAO_DO_FILHO_LI.casado },
          ausente(802, [[GRADE, 2, COR, 'v-verde']]),
        ],
      },
    });
    expect(r.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId: 802, referencias: [] },
    ]);
    expect(r.adicionados).toEqual([]);
    expect(db.leituras).toEqual([]);
  });

  it('a SKU the store repeats, or an option the cascade left unresolved, is skipped silently (the cascade reported it)', async () => {
    const db = new FakeDb();
    seedFamiliaErp(db);
    const r = await adicionar(db, {
      familia: familia([VERDE, ROXO]),
      skusRepetidos: new Set(['CAM-VD']),
      filhos: {
        filhos: [
          ausente(802, [[GRADE, 2, COR, 'v-verde']]),
          {
            ...ausente(803, []),
            opcoes: [
              {
                tipo: TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo,
                gradeId: GRADE,
                opcaoId: 4,
                grupoIds: [],
                varianteIds: [],
              },
            ],
          },
        ],
      },
    });
    expect(r).toMatchObject({ adicionados: [], pendencias: [] });
    expect(db.leituras).toEqual([]);
  });
});

/* -------------------------------- the probe -------------------------------- */

describe('the create probe — per variation, the others still added', () => {
  it("an exact hit ⇒ sku-ja-existe (that one left out); a 'parecido' hit alone ⇒ sku-parecido", async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db, {
      'erp-solto': { nome: 'Solto', sku: 'CAM-VD', paiId: null },
      'erp-minusculo': { nome: 'Minúsculo', sku: 'cam-rx', paiId: null },
    });
    const r = await adicionar(db, {
      familia: familia([VERDE, ROXO, { id: 805, sku: 'CAM-AM', opcoes: [[GRADE, 1]] }]),
      filhos: {
        filhos: [
          ausente(802, [[GRADE, 2, COR, 'v-verde']]),
          ausente(803, [[GRADE, 4, COR, 'v-roxo']]),
          // Azul's combination is the ERP child's: refused before the probe.
          ausente(805, [[GRADE, 1, COR, 'v-azul']]),
        ],
      },
    });
    expect(r.adicionados).toEqual([]);
    expect(r.pendencias).toEqual(
      expect.arrayContaining([
        { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: 802, referencias: ['erp-solto'] },
        { codigo: PENDENCIA_IMPORTACAO_LI.skuParecido, liId: 803, referencias: ['erp-minusculo'] },
      ]),
    );
    expect(db.escritas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: one refused, the other added in the batch — the pointer over the set that landed', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db, { 'erp-solto': { nome: 'Solto', sku: 'CAM-VD', paiId: null } });
    const r = await adicionar(db, {
      familia: familia([VERDE, ROXO]),
      filhos: {
        filhos: [
          ausente(802, [[GRADE, 2, COR, 'v-verde']]),
          ausente(803, [[GRADE, 4, COR, 'v-roxo']]),
        ],
      },
    });
    expect(r.adicionados.map((a) => a.liId)).toEqual([803]);
    expect(db.ler(`produtos/${ROXO_ID}`)).toMatchObject({ nome: 'Camiseta Roxo', ordem: 1 });
    expect(db.ler(`produtos/${VERDE_ID}`)).toBeUndefined();
    expect(db.ler(`produtos/${PAI}`)?.filhoUnicoId).toBeNull();
  });
});

/* --------------------------- the planned ids ------------------------------ */

describe('a variation already at its id', () => {
  it("this conta's own batch, landed with its reply lost ⇒ added (retomado), nothing written again", async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const f = familia([AZUL, VERDE]);
    const filhos = await cascata(db, f);
    await adicionar(db, { familia: f, filhos });
    const escritas = db.escritas.length;
    const r = await adicionar(db, { familia: f, filhos });
    expect(r).toMatchObject({
      adicionados: [{ liId: 802, produtoId: VERDE_ID, retomado: true }],
      existentes: [],
      vinculos: [],
      gravado: true,
    });
    expect(db.escritas).toHaveLength(escritas);
  });

  it("⚠️ NEAR-MISS: another conta's add of the same variation ⇒ existentes (fill and link), never counted as added", async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const f = familia([AZUL, VERDE]);
    const filhos = await cascata(db, f);
    await adicionar(db, { familia: f, filhos }, { conta: OUTRA });
    const escritas = db.escritas.length;
    const r = await adicionar(db, { familia: f, filhos });
    expect(r).toMatchObject({
      adicionados: [],
      existentes: [{ liId: 802, produtoId: VERDE_ID }],
      gravado: false,
    });
    expect(db.escritas).toHaveLength(escritas);
  });

  it('the SKU at its id under ANOTHER parent ⇒ sku-ja-existe', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db, { [VERDE_ID]: { nome: 'Outra', sku: 'CAM-VD', paiId: 'outro-pai' } });
    const r = await adicionar(db, {
      familia: familia([VERDE]),
      filhos: { filhos: [ausente(802, [[GRADE, 2, COR, 'v-verde']])] },
    });
    expect(r.pendencias).toEqual([
      { codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId: 802, referencias: [VERDE_ID] },
    ]);
    expect(db.escritas).toEqual([]);
  });
});

/* -------------------------------- Simular --------------------------------- */

describe('Simular — the same reads and verdicts, nothing written', () => {
  it('the add a run would make, and no write — aplicar then adds exactly it', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const f = familia([AZUL, VERDE]);
    const filhos = await cascata(db, f);
    const simulado = await adicionar(
      db,
      { familia: f, filhos },
      { modo: MODO_IMPORTACAO_LI.simular },
    );
    expect(simulado).toMatchObject({ gravado: false, ponteiro: null });
    expect(db.escritas).toEqual([]);
    const aplicado = await adicionar(db, { familia: f, filhos });
    expect(aplicado.adicionados).toEqual(simulado.adicionados);
    expect(aplicado.vinculos).toEqual(simulado.vinculos);
  });
});

/* ------------------------------ the re-derive ------------------------------ */

describe('rederivarFilhoUnicoLi', () => {
  it('EQUAL: the stored pointer is the live one ⇒ no write; NEAR-MISS: it is not ⇒ written on the parent’s read', async () => {
    const db = new FakeDb();
    seedFamiliaErp(db);
    expect(await rederivarFilhoUnicoLi(asDb(db), PAI, AGORA_MS)).toBe(
      DESFECHO_DO_PONTEIRO_LI.igual,
    );
    expect(db.escritas).toEqual([]);
    db.seed(`produtos/${PAI}`, { ...db.ler(`produtos/${PAI}`), filhoUnicoId: 'antigo' });
    expect(await rederivarFilhoUnicoLi(asDb(db), PAI, AGORA_MS)).toBe(
      DESFECHO_DO_PONTEIRO_LI.corrigido,
    );
    expect(db.ler(`produtos/${PAI}`)).toMatchObject({
      filhoUnicoId: AZUL_ERP,
      ultimaModificacao: AGORA_MS,
    });
  });

  it('a lost precondition re-runs the DERIVATION once, then gives up', async () => {
    const db = new FakeDb();
    seedFamiliaErp(db);
    db.seed(`produtos/${PAI}`, { ...db.ler(`produtos/${PAI}`), filhoUnicoId: null });
    // A sibling appears and the parent moves before our write: the re-run sees two children.
    db.antesDaProximaEscrita(`produtos/${PAI}`, () => {
      db.seed('produtos/irmao', { nome: 'Irmão', sku: 'CAM-IR', paiId: PAI });
      db.seed(`produtos/${PAI}`, { ...db.ler(`produtos/${PAI}`), nome: 'Camiseta!' });
    });
    expect(await rederivarFilhoUnicoLi(asDb(db), PAI, AGORA_MS)).toBe(
      DESFECHO_DO_PONTEIRO_LI.igual,
    );
    expect(db.ler(`produtos/${PAI}`)?.filhoUnicoId).toBeNull();

    const outra = new FakeDb();
    seedFamiliaErp(outra);
    outra.seed(`produtos/${PAI}`, { ...outra.ler(`produtos/${PAI}`), filhoUnicoId: null });
    // Seeds, not writes: a write inside a hook would itself consume the next hook.
    for (let i = 0; i < 2; i += 1) {
      outra.antesDaProximaEscrita(`produtos/${PAI}`, () => {
        outra.seed(`produtos/${PAI}`, { ...outra.ler(`produtos/${PAI}`), nome: `C ${String(i)}` });
      });
    }
    expect(await rederivarFilhoUnicoLi(asDb(outra), PAI, AGORA_MS)).toBe(
      DESFECHO_DO_PONTEIRO_LI.perdeu,
    );
  });

  it('the parent gone ⇒ pai-ausente, nothing read beyond it', async () => {
    const db = new FakeDb();
    expect(await rederivarFilhoUnicoLi(asDb(db), PAI, AGORA_MS)).toBe(
      DESFECHO_DO_PONTEIRO_LI.paiAusente,
    );
    expect(db.consultas).toEqual([]);
  });
});

/* ------------------------------- the indexes ------------------------------- */

describe('every query rides a declared index (root rule 1)', () => {
  it('the child set and the re-derive on `produtos (paiId, nome)`’s prefix; the probe on `produtos (sku)`', async () => {
    const db = new FakeDb();
    seedGrupos(db);
    seedFamiliaErp(db);
    const f = familia([AZUL, VERDE]);
    const filhos = await cascata(db, f);
    const antes = db.consultas.length;
    await adicionar(db, { familia: f, filhos });
    const consultas = db.consultas.slice(antes);
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) dir = dirname(dir);
    const declarados = (
      JSON.parse(readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8')) as {
        indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string }[] }[];
      }
    ).indexes;
    // Anti-vacuity: the child set, the probe, the re-derive (limit 2).
    expect(
      consultas.map((c) => [c.filtros.map(([campo, op]) => `${campo} ${op}`), c.limite]),
    ).toEqual([
      [['paiId =='], null],
      [['sku in'], null],
      [['paiId =='], 2],
    ]);
    for (const c of consultas) {
      expect(c.ordens).toEqual([]);
      const campos = c.filtros.map(([campo]) => campo).sort();
      const servida = declarados.some(
        (i) =>
          i.collectionGroup === c.colecao &&
          i.queryScope === 'COLLECTION' &&
          JSON.stringify(
            i.fields
              .slice(0, campos.length)
              .map((x) => x.fieldPath)
              .sort(),
          ) === JSON.stringify(campos),
      );
      expect(servida, JSON.stringify(c)).toBe(true);
    }
  });
});
