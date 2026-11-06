/**
 * The product import's "complete" writes (master plan step 9) on a REAL Firestore — the emulator
 * of `ci-loja-integrada.yml`, not the in-memory fake.
 *
 * `familiaNova.test.ts`, `filhoNovo.test.ts`, `completar.test.ts` and `fotos.test.ts` prove the
 * decisions against `testing/fakeDb.ts`, which MODELS how the server answers the three primitives
 * these writers rest on: a batch is all or nothing (a `create` over an existing document fails the
 * whole commit with 6), a stale `lastUpdateTime` fails a write with 9, and a batch commits under
 * ONE stamp. This file proves the server answers them that way, through the modules' own seams
 * (`antesDoCommit`, `antesDaEscrita`, the `guardarFotoLi` upload seam):
 *
 *  - the whole-family create is ONE commit: a child id taken between the reads and the commit fails
 *    ALL of it — no produto, `extraData` or link of the batch lands; and another conta's create of
 *    the same family landing there fails it too, and the re-read ADOPTS that family, which the
 *    existing-product path then links: one produto per SKU, one link per conta;
 *  - two contas' creates of one store SKU, one after the other, land on ONE produto;
 *  - this conta's OWN batch, landed with its reply lost, is recognised by the server's stamps (the
 *    root and its link share one `createTime`), and a root and link from two commits are not;
 *  - the add-child batch fails on the parent's precondition when a sibling is deleted between the
 *    child-set read and the commit, and the batch that lands carries the pointer the re-plan
 *    derived from the live set;
 *  - a fill losing to an operator's edit re-plans on the fresh read and writes nothing over it;
 *  - the photo write losing to an operator's upload — landing during ours, or between the read the
 *    write is guarded by and the write — keeps only the operator's; and another writer that adds no
 *    photo only costs a retry. The lane runs NO Storage emulator: the upload seam is the real
 *    shared uploader (`putArquivoAdmin`, its `arquivos` document on this Firestore) over the fake
 *    bucket.
 *
 * ⚠️ This file WRITES link documents (the creates' batches and the existing-product path), so the
 * ANCHOR trigger the functions emulator loads (`onProdutoLojaIntegradaLinkChanged`) fires on them
 * and writes each produto's `integracoesComProduto` (`testing/ancoraLi.ts`). So: its produtos are
 * seeded by no other suite (ids derived from SKUs no other suite uses, and `*-li-completar-fs`
 * ids); every step that creates a link awaits the anchor's write on THAT produto UNCONDITIONALLY
 * before it asserts on it or races a precondition on it — never "only if it fails"; and every case
 * ends ({@link limparProdutos}) by deleting its links and awaiting the anchor's last write (the conta
 * leaving the array) before its produtos go, so no anchor write of this file lands in the next case
 * or the next file. Every link written here COUNTS (a store id, not in the trash), which is what
 * makes "await the conta in the array" the right wait.
 *
 * It writes no `integracao` document (the conta trigger never runs for it: the contas below are
 * only refs), seeds its one job `executando` (the job-creation trigger ignores it with zero reads;
 * its `createTime` is the links' "created by this job" clock), and nothing reaches Loja Integrada:
 * the CDN is a scripted reader and the setup's fetch kill-switch stands behind it.
 */
import { env } from 'node:process';
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
  WriteResult,
} from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DesfechoImagemLi, LeitorCdnLi } from '@delfrance/integrations-loja-integrada';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  type Foto,
  type GrupoComLinksLi,
  type ImagemProdutoLi,
  type MarcaCatalogoLi,
  MODO_IMPORTACAO_LI,
  PENDENCIA_IMPORTACAO_LI,
  SITUACAO_ERP_ITEM_LI,
  buildFotoRefs,
  deriveFotosArquivosIds,
  fundirLinksVariacoesLi,
  productArquivoId,
  productOriginalPath,
  varianteFakePath,
} from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { aguardarAncoraLi, comConta, semConta } from '../testing/ancoraLi';
import { FakeBucket, asBucket } from '../testing/fakeBucket';
import { AGORA_MS } from '../testing/fixtures';
import { caminhoJobLi, jobLi } from '../testing/importacaoLi';
import {
  detalheLi,
  filhoLi,
  linhaProdutoLi,
  paiLi,
  uriOpcaoLi,
  vistaDetalhadaLi,
  vistaLi,
} from '../testing/produtosLi';
import { preencherProdutoLi, valoresDoLiLi } from './completar';
import {
  type ResultadoDaFamiliaNovaLi,
  TIPO_RESULTADO_FAMILIA_NOVA_LI,
  criarFamiliaLi,
  idMembroCriadoLi,
  idProdutoCriadoLi,
} from './familiaNova';
import { type FamiliaLi, ORIGEM_DO_FILHO_LI } from './familias';
import { DESFECHO_DO_PONTEIRO_LI, adicionarFilhosLi } from './filhoNovo';
import {
  type AlvoDeFotosLi,
  DESFECHO_FOTOS_DO_PRODUTO_LI,
  type DepsFotosLi,
  type GuardarFotoLi,
  type ResultadoFotosDaFamiliaLi,
  TIPO_PASSO_FOTOS_LI,
  type CursorFotosLi,
  criarGuardarFotoLi,
  executarUnidadeDeFotoLi,
  hashDaFotoLi,
} from './fotos';
import { PAPEL_DO_VINCULO_LI, planejarFamiliaLi } from './plano';
import { resolverFilhosLi, resolverRaizLi } from './resolucao';
import { DESFECHO_DO_VINCULO_LI, type ResultadoDosVinculosLi, vincularFamiliaLi } from './vinculos';

const EMULATED = Boolean(env.FIRESTORE_EMULATOR_HOST);

function db(): Firestore {
  return getAdminFirestore();
}

/* ------------------------------- fixtures --------------------------------- */

/** Obviously fake conta ids, seeded by no other suite (and never as `integracao` documents). */
const CONTA = 'conta-li-completar-fs';
const OUTRA = 'conta-li-completar-fs-2';
/** The job whose `createTime` is the links' clock: seeded `executando`, never `pendente`. */
const JOB = 'jobImportacaoFsCompletar01';
const GRADE = 8946;
const GRUPO = 'grupo-cor-li-completar-fs';
const CATEGORIA = 'cat-li-completar-fs';
const REF_CATEGORIA = `documents/categorias/${CATEGORIA}`;
const MARCA = 5001;
const MARCAS: readonly MarcaCatalogoLi[] = [{ id: MARCA, nome: 'Marca Neutra', ativo: true }];
const URI_MARCA = `/api/v1/marca/${String(MARCA)}`;
const DESCRICAO = '<p>Uma descrição neutra.</p>';

/** Store SKUs no other suite uses: the created produtos' ids derive from them. */
const SKU = {
  camiseta: 'LI-CFS-CAM',
  camisetaAzul: 'LI-CFS-CAM-AZ',
  camisetaVerde: 'LI-CFS-CAM-VD',
  simples: 'LI-CFS-SIMPLES',
  retomada: 'LI-CFS-RETOMADA',
  duasVezes: 'LI-CFS-DUAS-VEZES',
  camisa: 'LI-CFS-CMS',
  camisaAzul: 'LI-CFS-CMS-AZ',
  camisaVerde: 'LI-CFS-CMS-VD',
} as const;

/** Every produto this file may write: the cleanup's list. */
const ID = {
  camiseta: idProdutoCriadoLi(SKU.camiseta),
  camisetaAzul: idProdutoCriadoLi(SKU.camisetaAzul),
  camisetaVerde: idProdutoCriadoLi(SKU.camisetaVerde),
  simples: idProdutoCriadoLi(SKU.simples),
  simplesMembro: idMembroCriadoLi(SKU.simples),
  retomada: idProdutoCriadoLi(SKU.retomada),
  retomadaMembro: idMembroCriadoLi(SKU.retomada),
  duasVezes: idProdutoCriadoLi(SKU.duasVezes),
  duasVezesMembro: idMembroCriadoLi(SKU.duasVezes),
  camisa: 'erp-pai-li-completar-fs',
  camisaAzul: 'erp-azul-li-completar-fs',
  camisaVerde: idProdutoCriadoLi(SKU.camisaVerde),
  preencher: 'erp-preencher-li-completar-fs',
  fotos: 'erp-fotos-li-completar-fs',
} as const;

const produtoRef = (id: string): DocumentReference => db().collection('produtos').doc(id);
const vinculoRef = (produtoId: string, liId: number): DocumentReference =>
  produtoRef(produtoId).collection('produtolojaintegrada').doc(String(liId));
const extraDataRef = (produtoId: string): DocumentReference =>
  produtoRef(produtoId).collection('extraData').doc('singleton');

/** The link documents under a produto, by doc id (ascending). */
async function vinculosDe(produtoId: string): Promise<string[]> {
  const snap = await produtoRef(produtoId).collection('produtolojaintegrada').get();
  return snap.docs.map((d) => d.id).sort();
}

async function existe(ref: DocumentReference): Promise<boolean> {
  return (await ref.get()).exists;
}

/** Every produto of the catalogue carrying exactly `sku` (the `produtos (sku ASC)` index). */
async function idsComSku(sku: string): Promise<string[]> {
  const snap = await db().collection('produtos').where('sku', '==', sku).get();
  return snap.docs.map((d) => d.id).sort();
}

function stampDe(snap: DocumentSnapshot, campo: 'createTime' | 'updateTime'): Timestamp {
  const t = snap[campo];
  if (t === undefined) throw new Error(`completar.firestore.test: ${snap.ref.path} ausente`);
  return t;
}

/** The anchor's write on each produto: `conta` in its array (module header). */
async function aguardarAncora(conta: string, produtoIds: readonly string[]): Promise<void> {
  for (const id of produtoIds) {
    await aguardarAncoraLi(db(), id, comConta(conta), `com a conta ${conta} (${id})`);
  }
}

/** The ERP grupo "Cor" as stored: what a created child's name and selection are read from. */
const GRUPO_ARMAZENADO = {
  nome: 'Cor',
  ordem: 1,
  variacoesIds: ['v-azul', 'v-verde'],
  variacoes: [
    { id: 'v-azul', nome: 'Azul' },
    { id: 'v-verde', nome: 'Verde' },
  ],
};

/** The dispatch's memo of that grupo: options 1 ⇒ Azul and 2 ⇒ Verde, for BOTH contas. */
function memo(): GrupoComLinksLi[] {
  const fusao = fundirLinksVariacoesLi(
    null,
    [CONTA, OUTRA].flatMap((integracaoLiId) => [
      { integracaoLiId, gradeId: GRADE, opcaoId: 1, varianteId: 'v-azul' },
      { integracaoLiId, gradeId: GRADE, opcaoId: 2, varianteId: 'v-verde' },
    ]),
  );
  if (!fusao.ok) throw new Error('completar.firestore.test: a fusão recusou os vínculos');
  return [{ id: GRUPO, variantesIds: ['v-azul', 'v-verde'], linksVariacoesli: fusao.array }];
}

interface Variacao {
  readonly id: number;
  readonly sku: string;
  readonly opcao: number;
}

/** A store family (its detail's box 30×40×50, 0.9 kg) with its variations and their details. */
function familiaLi(liId: number, sku: string, nome: string, variacoes: readonly Variacao[]) {
  const row = paiLi(
    liId,
    variacoes.map((v) => v.id),
    { sku, nome },
  );
  const familia: FamiliaLi = {
    raiz: vistaLi(row),
    detalheDaRaiz: vistaDetalhadaLi(
      detalheLi(row, null, {
        marca: URI_MARCA,
        descricao_completa: DESCRICAO,
        peso: '0.900',
        altura: 30,
        largura: 40,
        profundidade: 50,
      }),
    ),
    filhos: variacoes.map((v) => {
      const filho = filhoLi(v.id, { sku: v.sku, variacoes: [uriOpcaoLi(GRADE, v.opcao)] });
      return {
        linha: vistaLi(filho),
        detalhe: vistaDetalhadaLi(detalheLi(filho, liId, { peso: '0.250' })),
        origem: ORIGEM_DO_FILHO_LI.filhos,
      };
    }),
    semDetalhe: [],
    pendencias: [],
  };
  return familia;
}

/** The store family "Camiseta" of `conta`'s store: parent `liId`, variations `liId + 1`, `+ 2`. */
function camiseta(liId: number): FamiliaLi {
  return familiaLi(liId, SKU.camiseta, 'Camiseta', [
    { id: liId + 1, sku: SKU.camisetaAzul, opcao: 1 },
    { id: liId + 2, sku: SKU.camisetaVerde, opcao: 2 },
  ]);
}

/** A store simple product with its detail (a brand, a description). */
function simplesLi(liId: number, sku: string): FamiliaLi {
  const row = linhaProdutoLi(liId, { sku, gtin: '7890000000017' });
  return {
    raiz: vistaLi(row),
    detalheDaRaiz: vistaDetalhadaLi(
      detalheLi(row, null, { marca: URI_MARCA, descricao_completa: DESCRICAO }),
    ),
    filhos: [],
    semDetalhe: [],
    pendencias: [],
  };
}

/** The job fields the plan reads, under "complete". */
function jobDoPlano(integracaoId: string) {
  return {
    integracaoId,
    modo: MODO_IMPORTACAO_LI.aplicar,
    alvo: ALVO_IMPORTACAO_LI.todos,
    acao: ACAO_IMPORTACAO_LI.completar,
    selecionados: [],
  };
}

/** The create, from `plano.ts`'s own classification of an `ausente` family under "complete". */
async function criar(
  f: FamiliaLi,
  o: { readonly conta?: string; readonly antesDoCommit?: () => Promise<void> } = {},
): Promise<ResultadoDaFamiliaNovaLi> {
  const conta = o.conta ?? CONTA;
  const plano = planejarFamiliaLi({
    job: jobDoPlano(conta),
    familia: f,
    raiz: { tipo: SITUACAO_ERP_ITEM_LI.ausente },
    filhos: null,
    skusRepetidos: new Set(),
    recusasDoAprendizado: new Map(),
  });
  if (plano.criacao === null) {
    throw new Error('completar.firestore.test: o plano não classificou a criação');
  }
  return criarFamiliaLi(
    {
      db: db(),
      contaId: conta,
      modo: MODO_IMPORTACAO_LI.aplicar,
      agoraMs: () => AGORA_MS,
      ...(o.antesDoCommit === undefined ? {} : { antesDoCommit: o.antesDoCommit }),
    },
    {
      familia: f,
      criacao: plano.criacao,
      grupos: memo(),
      categoriaErpId: CATEGORIA,
      marcas: MARCAS,
    },
  );
}

/** The job document's `createTime`, read in `beforeAll` (the links' "created by this job" clock). */
let criacaoDoJob: Timestamp | undefined;

/**
 * The existing-product path's links, as the family unit runs it after an adoption: the cascade
 * (rung 2 now finds the root by its SKU, the variations under it by theirs), the plan, the links.
 */
async function vincularOExistente(f: FamiliaLi, conta: string): Promise<ResultadoDosVinculosLi> {
  if (criacaoDoJob === undefined) throw new Error('completar.firestore.test: o job não foi lido');
  const contexto = { db: db(), contaId: conta };
  const raiz = await resolverRaizLi(contexto, f, new Set());
  if (raiz.tipo !== SITUACAO_ERP_ITEM_LI.encontrado) {
    throw new Error(`completar.firestore.test: a raiz não foi encontrada (${raiz.tipo})`);
  }
  const filhos =
    f.filhos.length === 0
      ? null
      : await resolverFilhosLi(contexto, f, raiz.erpId, {
          grupos: memo(),
          skusRepetidos: new Set(),
        });
  const plano = planejarFamiliaLi({
    job: jobDoPlano(conta),
    familia: f,
    raiz,
    filhos,
    skusRepetidos: new Set(),
    recusasDoAprendizado: new Map(),
  });
  return vincularFamiliaLi({ ...contexto, modo: MODO_IMPORTACAO_LI.aplicar, criacaoDoJob }, plano);
}

/** A one-shot seam: `fn` runs before the FIRST commit only. */
function umaVez(fn: () => Promise<void>): () => Promise<void> {
  let feito = false;
  return async () => {
    if (feito) return;
    feito = true;
    await fn();
  };
}

/* ------------------------------ photo fixtures ----------------------------- */

/** A PNG: its magic number, then `n`, so each picture has its own bytes (and its own hash). */
function png(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n + 1]);
}

function imagem(id: number): ImagemProdutoLi {
  return { id, caminho: `1000/produto/${String(id)}/foto.png`, principal: false, posicao: null };
}

/** A scripted CDN reader answering `bytes` for `img`'s original; anything else THROWS. */
function cdnDe(img: ImagemProdutoLi, bytes: Uint8Array): LeitorCdnLi {
  const resposta: DesfechoImagemLi = { resultado: 'ok', status: 200, tipo: 'image/png', bytes };
  return {
    baixarImagemLi: (caminho, { forma }) =>
      forma === 'original' && caminho === img.caminho
        ? Promise.resolve(resposta)
        : Promise.reject(
            new Error(`completar.firestore.test: imagem fora do roteiro (${forma} ${caminho})`),
          ),
  };
}

/** A photo already on the produto (the operator's), by a hash no picture here has. */
function fotoDoOperador(produtoId: string): Foto {
  return {
    ...buildFotoRefs(produtoId, 'f'.repeat(128)),
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  };
}

/** The operator's upload as it reaches the produto: its photo and its arquivo id. */
async function operadorEnviaFoto(produtoId: string): Promise<void> {
  const foto = fotoDoOperador(produtoId);
  await produtoRef(produtoId).update({
    fotos: [foto],
    fotosArquivosIds: [productArquivoId(produtoId, 'f'.repeat(128))],
  });
}

/** The arquivos this file's uploads write (content-addressed: derived from the bytes). */
const BYTES_DAS_FOTOS = [png(1), png(2), png(3)] as const;
const ARQUIVOS = BYTES_DAS_FOTOS.map((b) => productArquivoId(ID.fotos, hashDaFotoLi(b)));

/** The photo deps over `banco`, the upload seam `guardar`, no pacing wait. */
function depsDasFotos(banco: Firestore, cdn: LeitorCdnLi, guardar: GuardarFotoLi): DepsFotosLi {
  return {
    db: banco,
    cdn,
    guardar,
    esperar: () => Promise.resolve(),
    agoraMs: () => AGORA_MS,
    logger: { warn: vi.fn() },
  };
}

/** Run the family's photo units from the start until they conclude. */
async function rodarFotos(
  deps: DepsFotosLi,
  alvos: readonly AlvoDeFotosLi[],
): Promise<ResultadoFotosDaFamiliaLi> {
  let cursor: CursorFotosLi | null = null;
  for (let i = 0; i < 10; i += 1) {
    const passo = await executarUnidadeDeFotoLi(deps, alvos, cursor);
    if (passo.tipo === TIPO_PASSO_FOTOS_LI.concluido) return passo.resultado;
    if (passo.tipo !== TIPO_PASSO_FOTOS_LI.progresso) {
      throw new Error(`completar.firestore.test: passo inesperado ${passo.tipo}`);
    }
    cursor = passo.cursor;
  }
  throw new Error('completar.firestore.test: as fotos não terminaram');
}

/**
 * The real Firestore, except that the FIRST `update` on `produtos/<produtoId>` runs `antes` right
 * before it is sent — the window between the read a guarded write is guarded by and the write,
 * which `fotos.ts` exposes no seam for. Every other member is the real one, bound to it; `antes`
 * writes through the real handle, never this one.
 */
function comPrimeiraEscritaInterceptada(
  real: Firestore,
  produtoId: string,
  antes: () => Promise<void>,
): { readonly banco: Firestore; readonly updates: () => number } {
  let updates = 0;
  const ligado = (alvo: object, prop: string | symbol): unknown => {
    const valor: unknown = Reflect.get(alvo, prop, alvo);
    return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
  };
  const refInterceptada = (ref: DocumentReference): DocumentReference =>
    new Proxy(ref, {
      get(r, p) {
        if (p !== 'update') return ligado(r, p);
        return async (...args: unknown[]): Promise<WriteResult> => {
          updates += 1;
          if (updates === 1) await antes();
          const original = Reflect.get(r, 'update', r) as (...a: unknown[]) => Promise<WriteResult>;
          return original.apply(r, args);
        };
      },
    });
  const banco = new Proxy(real, {
    get(alvo, prop) {
      if (prop !== 'collection') return ligado(alvo, prop);
      return (caminho: string) => {
        const colecao = alvo.collection(caminho);
        if (caminho !== 'produtos') return colecao;
        return new Proxy(colecao, {
          get(c, p) {
            if (p !== 'doc') return ligado(c, p);
            return (id: string) => {
              const ref = c.doc(id);
              return id === produtoId ? refInterceptada(ref) : ref;
            };
          },
        });
      };
    },
  });
  return { banco, updates: () => updates };
}

/* -------------------------------- cleanup ---------------------------------- */

const CONTA_DO_VINCULO = /^(?:documents\/)?integracao\/([^/]+)$/;

/**
 * Every produto this file may have written, gone — the anchor's rules (module header): a produto's
 * links are deleted only once the anchor's write for each of their contas has landed (else a late
 * add could re-list a conta after its removal), then the conta leaving the array is awaited, and
 * only then the produto (with its `extraData` and anything left under it) is deleted.
 */
async function limparProdutos(): Promise<void> {
  for (const id of Object.values(ID)) {
    const ref = produtoRef(id);
    const [produto, vinculos] = await Promise.all([
      ref.get(),
      ref.collection('produtolojaintegrada').get(),
    ]);
    const contas = new Set<string>();
    for (const v of vinculos.docs) {
      const conta: unknown = v.get('contaLojaIntegrada');
      const m = typeof conta === 'string' ? CONTA_DO_VINCULO.exec(conta) : null;
      if (m?.[1] !== undefined) contas.add(m[1]);
    }
    if (produto.exists) {
      for (const conta of contas) {
        await aguardarAncoraLi(db(), id, comConta(conta), `com a conta ${conta} (${id})`);
      }
    }
    for (const v of vinculos.docs) await v.ref.delete();
    if (produto.exists) {
      for (const conta of contas) {
        await aguardarAncoraLi(db(), id, semConta(conta), `sem a conta ${conta} (${id})`);
      }
    }
    await db().recursiveDelete(ref);
  }
  for (const arquivo of ARQUIVOS) await db().collection('arquivos').doc(arquivo).delete();
}

/* --------------------------------- suite ----------------------------------- */

describe.skipIf(!EMULATED)('the product import’s "complete" writes on a real Firestore', () => {
  beforeAll(async () => {
    await limparProdutos();
    await db().collection('grupoDeVariacoes').doc(GRUPO).set(GRUPO_ARMAZENADO);
    const job = jobLi(CONTA);
    expect(job.status).toBe('executando');
    const jobRef = db().doc(caminhoJobLi(JOB));
    await jobRef.set(job);
    criacaoDoJob = stampDe(await jobRef.get(), 'createTime');
  }, 120_000);

  afterEach(async () => {
    await limparProdutos();
  }, 120_000);

  afterAll(async () => {
    await limparProdutos();
    await db().collection('grupoDeVariacoes').doc(GRUPO).delete();
    await db().recursiveDelete(db().doc(caminhoJobLi(JOB)));
  }, 120_000);

  describe('the whole-family create is ONE commit on the server', () => {
    it('a child id taken between the reads and the commit fails ALL of it: no produto, extraData or link of the batch lands', async () => {
      const verdeAvulso = { nome: 'Camiseta Verde', sku: SKU.camisetaVerde, paiId: ID.camiseta };
      let commits = 0;
      const r = await criar(camiseta(7100), {
        antesDoCommit: async () => {
          commits += 1;
          // Only the GREEN child's id — the root and the other child are still free.
          if (commits === 1) await produtoRef(ID.camisetaVerde).create(verdeAvulso);
        },
      });

      // The server refused the batch whole (6); the re-read then found that child alone, with no
      // root to adopt: a SKU the ERP holds outside this family.
      expect(commits).toBe(1);
      expect(r).toEqual({
        tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.recusada,
        pendencias: [
          {
            codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste,
            liId: 7102,
            referencias: [ID.camisetaVerde],
          },
        ],
      });
      for (const id of [ID.camiseta, ID.camisetaAzul]) {
        expect(await existe(produtoRef(id)), id).toBe(false);
      }
      for (const id of [ID.camiseta, ID.camisetaAzul, ID.camisetaVerde]) {
        expect(await existe(extraDataRef(id)), `${id}/extraData`).toBe(false);
        expect(await vinculosDe(id), `${id}/produtolojaintegrada`).toEqual([]);
      }
      expect((await produtoRef(ID.camisetaVerde).get()).data()).toEqual(verdeAvulso);
    }, 120_000);

    it('another conta’s create of the same family landing first fails this batch whole; the re-read ADOPTS it and the existing-product path links it — one produto per SKU, one link per conta', async () => {
      const familia = [ID.camiseta, ID.camisetaAzul, ID.camisetaVerde];
      let daOutra: ResultadoDaFamiliaNovaLi | undefined;
      const r = await criar(camiseta(7100), {
        antesDoCommit: umaVez(async () => {
          daOutra = await criar(camiseta(7200), { conta: OUTRA });
        }),
      });

      expect(daOutra).toMatchObject({
        tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
        raizId: ID.camiseta,
        gravado: true,
        retomada: false,
      });
      expect(r).toEqual({ tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.existente, raizId: ID.camiseta });
      // The other conta's batch wrote a link under each produto: its anchor writes land on them.
      await aguardarAncora(OUTRA, familia);
      // This conta's batch landed NOTHING: under each produto only the other conta's link.
      expect(await vinculosDe(ID.camiseta)).toEqual(['7200']);
      expect(await vinculosDe(ID.camisetaAzul)).toEqual(['7201']);
      expect(await vinculosDe(ID.camisetaVerde)).toEqual(['7202']);

      // The existing-product path: the cascade finds the adopted family by its SKUs, links it.
      const v = await vincularOExistente(camiseta(7100), CONTA);
      expect(v.raiz?.desfecho.tipo).toBe(DESFECHO_DO_VINCULO_LI.criado);
      expect(v.filhos.map((f) => f.desfecho.tipo)).toEqual([
        DESFECHO_DO_VINCULO_LI.criado,
        DESFECHO_DO_VINCULO_LI.criado,
      ]);
      await aguardarAncora(CONTA, familia);

      expect(await vinculosDe(ID.camiseta)).toEqual(['7100', '7200']);
      expect(await vinculosDe(ID.camisetaAzul)).toEqual(['7101', '7201']);
      expect(await vinculosDe(ID.camisetaVerde)).toEqual(['7102', '7202']);
      expect((await vinculoRef(ID.camiseta, 7100).get()).data()).toMatchObject({
        contaLojaIntegrada: `documents/integracao/${CONTA}`,
        id: 7100,
      });
      for (const [sku, id] of [
        [SKU.camiseta, ID.camiseta],
        [SKU.camisetaAzul, ID.camisetaAzul],
        [SKU.camisetaVerde, ID.camisetaVerde],
      ] as const) {
        expect(await idsComSku(sku), sku).toEqual([id]);
      }
    }, 120_000);
  });

  it('two contas’ creates of one store SKU, one after the other, land on ONE produto with one link per conta', async () => {
    const primeira = await criar(simplesLi(7300, SKU.simples));
    expect(primeira).toMatchObject({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
      raizId: ID.simples,
      produtos: [{ produtoId: ID.simples }, { produtoId: ID.simplesMembro }],
      gravado: true,
    });
    // A simple product's link sits on its ROOT, never on the sole member.
    await aguardarAncora(CONTA, [ID.simples]);

    const segunda = await criar(simplesLi(7400, SKU.simples), { conta: OUTRA });
    expect(segunda).toEqual({ tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.existente, raizId: ID.simples });
    const v = await vincularOExistente(simplesLi(7400, SKU.simples), OUTRA);
    expect(v.raiz?.desfecho.tipo).toBe(DESFECHO_DO_VINCULO_LI.criado);
    await aguardarAncora(OUTRA, [ID.simples]);

    expect(await idsComSku(SKU.simples)).toEqual([ID.simples]);
    expect(await vinculosDe(ID.simples)).toEqual(['7300', '7400']);
    expect(await vinculosDe(ID.simplesMembro)).toEqual([]);
    expect((await vinculoRef(ID.simples, 7400).get()).data()).toMatchObject({
      contaLojaIntegrada: `documents/integracao/${OUTRA}`,
      id: 7400,
    });
  }, 120_000);

  it('this conta’s OWN batch, landed with its reply lost, is recognised by ONE commit stamp (criada, retomada); a root and link from two commits are not (existente)', async () => {
    let interna: ResultadoDaFamiliaNovaLi | undefined;
    // The same conta's create lands between this call's reads and its commit — exactly what a
    // commit whose reply was lost leaves for the SDK's retry to meet.
    const r = await criar(simplesLi(7500, SKU.retomada), {
      antesDoCommit: umaVez(async () => {
        interna = await criar(simplesLi(7500, SKU.retomada));
      }),
    });
    expect(interna).toMatchObject({ tipo: 'criada', gravado: true, retomada: false });
    expect(r).toMatchObject({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
      raizId: ID.retomada,
      gravado: true,
      retomada: true,
    });
    await aguardarAncora(CONTA, [ID.retomada]);
    const raiz = await produtoRef(ID.retomada).get();
    const vinculo = await vinculoRef(ID.retomada, 7500).get();
    expect(stampDe(raiz, 'createTime').isEqual(stampDe(vinculo, 'createTime'))).toBe(true);

    // NEAR-MISS: the same root and this conta's link, written by TWO commits.
    await produtoRef(ID.duasVezes).create({
      nome: 'Produto 7600',
      sku: SKU.duasVezes,
      paiId: null,
    });
    await vinculoRef(ID.duasVezes, 7600).create({
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 7600,
      paiProdutoIntegradaId: null,
      sku: SKU.duasVezes,
      nome: 'Produto 7600',
      ativo: true,
      bloqueado: false,
      removido: false,
    });
    await aguardarAncora(CONTA, [ID.duasVezes]);
    const raizDuas = await produtoRef(ID.duasVezes).get();
    const vinculoDuas = await vinculoRef(ID.duasVezes, 7600).get();
    expect(stampDe(raizDuas, 'createTime').isEqual(stampDe(vinculoDuas, 'createTime'))).toBe(false);
    expect(await criar(simplesLi(7600, SKU.duasVezes))).toEqual({
      tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.existente,
      raizId: ID.duasVezes,
    });
    expect(await existe(produtoRef(ID.duasVezesMembro))).toBe(false);
  }, 120_000);

  it('add-child: a sibling deleted between the child-set read and the commit fails the batch on the parent’s precondition; the batch that lands carries the pointer derived from the LIVE set', async () => {
    const fake = (variante: string) => varianteFakePath(GRUPO, variante);
    // The ERP family "Camisa": ONE child, Azul, named by the parent's pointer.
    await produtoRef(ID.camisa).create({
      nome: 'Camisa',
      sku: SKU.camisa,
      paiId: null,
      filhoUnicoId: ID.camisaAzul,
      grupoDeVariacoesUid: [GRUPO],
      variacoesUid: [fake('v-azul')],
    });
    await produtoRef(ID.camisaAzul).create({
      nome: 'Camisa Azul',
      sku: SKU.camisaAzul,
      paiId: ID.camisa,
      ordem: 0,
      variacoesUid: [fake('v-azul')],
      grupoDeVariacoesUid: [GRUPO],
    });
    // This conta's link of the store parent: the add runs only beside a confirmed parent link.
    await vinculoRef(ID.camisa, 7700).create({
      contaLojaIntegrada: `documents/integracao/${CONTA}`,
      id: 7700,
      paiProdutoIntegradaId: null,
      sku: SKU.camisa,
      nome: 'Camisa',
      ativo: true,
      bloqueado: false,
      removido: false,
    });
    // The add's batch races a precondition on the PARENT: its anchor write lands first.
    await aguardarAncora(CONTA, [ID.camisa]);

    const f = familiaLi(7700, SKU.camisa, 'Camisa', [
      { id: 7701, sku: SKU.camisaAzul, opcao: 1 },
      { id: 7702, sku: SKU.camisaVerde, opcao: 2 },
    ]);
    const filhos = await resolverFilhosLi({ db: db(), contaId: CONTA }, f, ID.camisa, {
      grupos: memo(),
      skusRepetidos: new Set(),
    });
    let commits = 0;
    const r = await adicionarFilhosLi(
      {
        db: db(),
        contaId: CONTA,
        modo: MODO_IMPORTACAO_LI.aplicar,
        agoraMs: () => AGORA_MS,
        // An ERP writer removes Azul and moves the pointer IN THE PARENT, as every one does.
        antesDoCommit: async () => {
          commits += 1;
          if (commits > 1) return;
          await produtoRef(ID.camisaAzul).delete();
          await produtoRef(ID.camisa).update({ filhoUnicoId: null });
        },
      },
      {
        familia: f,
        erpPaiId: ID.camisa,
        filhos,
        skusRepetidos: new Set(),
        categoriaErpId: CATEGORIA,
        marcas: MARCAS,
      },
    );

    // The server refused the first batch (9 on the parent): a second attempt committed.
    expect(commits).toBe(2);
    expect(r).toMatchObject({
      adicionados: [{ liId: 7702, produtoId: ID.camisaVerde, retomado: false }],
      existentes: [],
      pendencias: [],
      gravado: true,
      ponteiro: DESFECHO_DO_PONTEIRO_LI.igual,
    });
    await aguardarAncora(CONTA, [ID.camisaVerde]);

    const pai = await produtoRef(ID.camisa).get();
    const verde = await produtoRef(ID.camisaVerde).get();
    // The stale set {Azul, Verde} would say "none"; the live one is Verde alone.
    expect(pai.get('filhoUnicoId')).toBe(ID.camisaVerde);
    // ...written by the batch that created Verde (one commit stamp), not by the post-commit
    // re-derive; and Verde's `ordem` counts the LIVE siblings (none), not the stale set's Azul.
    expect(stampDe(pai, 'updateTime').isEqual(stampDe(verde, 'createTime'))).toBe(true);
    expect(verde.data()).toMatchObject({
      sku: SKU.camisaVerde,
      paiId: ID.camisa,
      ordem: 0,
      variacoesUid: [fake('v-verde')],
      grupoDeVariacoesUid: [GRUPO],
      categoriaProdutoOuterRef: REF_CATEGORIA,
    });
    expect(await vinculosDe(ID.camisaVerde)).toEqual(['7702']);
  }, 120_000);

  it('fill-empty: an operator edit landing between the read and the guarded write fails it (9); the re-plan writes every other empty field and nothing over the edit', async () => {
    await produtoRef(ID.preencher).create({
      nome: 'Produto do ERP',
      sku: 'LI-CFS-PREENCHER',
      paiId: null,
      gtin: null,
      pesoLiquidoKg: null,
      pesoBrutoKg: null,
      alturaCm: null,
      larguraCm: null,
      profundidadeCm: null,
      categoriaProdutoOuterRef: null,
    });
    const linha = linhaProdutoLi(7800, { gtin: '7890000000017' });
    const valores = valoresDoLiLi({
      papel: PAPEL_DO_VINCULO_LI.raiz,
      linha: vistaLi(linha),
      detalhe: vistaDetalhadaLi(
        detalheLi(linha, null, { marca: URI_MARCA, descricao_completa: DESCRICAO }),
      ),
      detalheDoPai: null,
      categoriaErpId: CATEGORIA,
      marcas: MARCAS,
    });
    let janelas = 0;
    const r = await preencherProdutoLi(
      {
        db: db(),
        modo: MODO_IMPORTACAO_LI.aplicar,
        agoraMs: () => AGORA_MS,
        antesDaEscrita: async () => {
          janelas += 1;
          // The operator types a GTIN between our read and our write — once.
          if (janelas === 1) await produtoRef(ID.preencher).update({ gtin: 'DO-OPERADOR' });
        },
      },
      { produtoId: ID.preencher, liId: null, valores },
    );

    // Two windows: the server refused the first write, the re-plan's landed.
    expect(janelas).toBe(2);
    expect(r).toMatchObject({ tipo: 'preenchido', gravado: true, pendencias: [] });
    if (r.tipo !== 'preenchido') throw new Error('completar.firestore.test: o produto sumiu');
    expect(r.campos).not.toContain('gtin');
    expect(r.campos).toEqual(
      expect.arrayContaining([
        'pesoLiquidoKg',
        'pesoBrutoKg',
        'alturaCm',
        'larguraCm',
        'profundidadeCm',
        'categoriaProdutoOuterRef',
      ]),
    );
    expect((await produtoRef(ID.preencher).get()).data()).toMatchObject({
      gtin: 'DO-OPERADOR',
      pesoLiquidoKg: 0.2,
      pesoBrutoKg: 0.2,
      alturaCm: 10,
      larguraCm: 12,
      profundidadeCm: 14,
      categoriaProdutoOuterRef: REF_CATEGORIA,
      ultimaModificacao: AGORA_MS,
    });
    // The absent singleton is created with only the filled keys.
    expect((await extraDataRef(ID.preencher).get()).data()).toEqual({
      descricao: DESCRICAO,
      marca: 'Marca Neutra',
    });
  }, 120_000);

  describe('photos: the write losing to an operator upload keeps only the operator’s', () => {
    const IMAGEM = imagem(7901);
    const alvos: readonly AlvoDeFotosLi[] = [
      { produtoId: ID.fotos, liId: null, imagens: [IMAGEM] },
    ];

    async function semearProdutoSemFotos(): Promise<void> {
      await produtoRef(ID.fotos).create({ nome: 'Produto com foto', sku: 'LI-CFS-FOTOS' });
    }

    it('an upload of the operator landing DURING ours: the read taken after our upload sees it, and ours is written nowhere', async () => {
      await semearProdutoSemFotos();
      const bucket = new FakeBucket();
      const real = criarGuardarFotoLi({ db: db(), bucket: asBucket(bucket), contaId: CONTA });
      const bytes = BYTES_DAS_FOTOS[0];
      const guardar: GuardarFotoLi = async (foto) => {
        await real(foto);
        await operadorEnviaFoto(ID.fotos);
      };

      const resultado = await rodarFotos(depsDasFotos(db(), cdnDe(IMAGEM, bytes), guardar), alvos);

      expect(resultado.produtos).toEqual([
        {
          produtoId: ID.fotos,
          liId: null,
          desfecho: DESFECHO_FOTOS_DO_PRODUTO_LI.perdeu,
          fotos: 0,
        },
      ]);
      expect(resultado.gravadas).toBe(0);
      expect(resultado.pendencias).toEqual([]);
      expect((await produtoRef(ID.fotos).get()).get('fotos')).toEqual([fotoDoOperador(ID.fotos)]);
      // Ours went through the real uploader: its arquivo on this Firestore, its object in the
      // bucket — an UNREFERENCED arquivo, the orphan reconcile's to reclaim.
      const hash = hashDaFotoLi(bytes);
      expect(
        (await db().collection('arquivos').doc(productArquivoId(ID.fotos, hash)).get()).data(),
      ).toMatchObject({
        resizeState: 'pending',
        externalIds: [{ externalId: '7901', integracaoPath: `documents/integracao/${CONTA}` }],
        url: expect.stringContaining(
          encodeURIComponent(productOriginalPath(ID.fotos, hash, 'png')),
        ),
      });
      expect(bucket.caminhos).toEqual([productOriginalPath(ID.fotos, hash, 'png')]);
    }, 120_000);

    it('an upload of the operator landing between the read and the write: the server refuses ours (9) and the re-read keeps only the operator’s', async () => {
      await semearProdutoSemFotos();
      const bucket = new FakeBucket();
      const guardar = criarGuardarFotoLi({ db: db(), bucket: asBucket(bucket), contaId: CONTA });
      const { banco, updates } = comPrimeiraEscritaInterceptada(db(), ID.fotos, () =>
        operadorEnviaFoto(ID.fotos),
      );

      const resultado = await rodarFotos(
        depsDasFotos(banco, cdnDe(IMAGEM, BYTES_DAS_FOTOS[1]), guardar),
        alvos,
      );

      // ONE write sent, refused: had it landed, the stored photos would be ours.
      expect(updates()).toBe(1);
      expect(resultado.produtos[0]?.desfecho).toBe(DESFECHO_FOTOS_DO_PRODUTO_LI.perdeu);
      expect(resultado.gravadas).toBe(0);
      expect((await produtoRef(ID.fotos).get()).get('fotos')).toEqual([fotoDoOperador(ID.fotos)]);
    }, 120_000);

    it('⚠️ NEAR-MISS: another writer there that adds NO photo only costs a retry — ours lands on the fresh read', async () => {
      await semearProdutoSemFotos();
      const bucket = new FakeBucket();
      const guardar = criarGuardarFotoLi({ db: db(), bucket: asBucket(bucket), contaId: CONTA });
      const { banco, updates } = comPrimeiraEscritaInterceptada(db(), ID.fotos, async () => {
        await produtoRef(ID.fotos).update({ nome: 'Renomeado' });
      });
      const bytes = BYTES_DAS_FOTOS[2];

      const resultado = await rodarFotos(depsDasFotos(banco, cdnDe(IMAGEM, bytes), guardar), alvos);

      // The first write refused (9), the second, on the re-read, landed.
      expect(updates()).toBe(2);
      expect(resultado.produtos[0]).toMatchObject({
        desfecho: DESFECHO_FOTOS_DO_PRODUTO_LI.importadas,
        fotos: 1,
      });
      const hash = hashDaFotoLi(bytes);
      const fotos: Foto[] = [
        { ...buildFotoRefs(ID.fotos, hash), grupoDeVariacoesOuterRef: null, variantePath: null },
      ];
      expect((await produtoRef(ID.fotos).get()).data()).toMatchObject({
        nome: 'Renomeado',
        fotos,
        // The original's id and its derivatives' (the resize trigger's 200/400 documents).
        fotosArquivosIds: deriveFotosArquivosIds(fotos),
        ultimaModificacao: AGORA_MS,
      });
      expect(deriveFotosArquivosIds(fotos)).toContain(productArquivoId(ID.fotos, hash));
    }, 120_000);
  });
});
