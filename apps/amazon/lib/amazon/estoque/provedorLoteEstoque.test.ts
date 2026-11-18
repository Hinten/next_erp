/**
 * The stock feed provider (step 12, PR 12-f) against the counting fake
 * Firestore: the REAL context, the REAL shared evaluator, window reader, drift
 * blocks, family read, write-back, recovery delta and reconcile request, the
 * REAL stock and jobs producers over RECORDING queues (each refuses a task id
 * it already holds, as Cloud Tasks does), and a scripted `fetch` that models
 * Amazon — a listings catalogue (search and single read) and the feed calls —
 * and REFUSES anything unscripted. The end-to-end cases run the REAL send,
 * result and recovery handlers through the jobs dispatcher, with this
 * provider bound by the seam's own table.
 *
 * Clocks: our clock (`m.relogio`, ms) is the provider's `agora`; the fake's
 * commit clock moves one MICROSECOND per write from its own start. A case that
 * tests a commit filter takes its snapshot from the fake's commit clock (a
 * marker seeded first), exactly as the recovery delta's own suite does.
 *
 * ⚠️ D11: the global `fetch` refuses; the scripted one is the only network.
 * The read switch is `on` ONLY in the object literal handed to the context.
 * PLACEHOLDERS ONLY (public repository).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  AmazonHttpError,
  AmazonThrottleError,
  CAMINHO_LISTINGS,
  MARKETPLACE_ID_BR,
  type SpApiEscritaClient,
  URL_BASE_SP_API,
  URL_TOKEN_LWA,
  enviarDisponibilidadeAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  FLUXO_FEED_AMAZON,
  INTEGRACAO_TIPO,
  MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON,
  MOTIVO_CONTA_AMAZON,
  type MotivoContaAmazon,
  type VezFeedAmazon,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
  makeEstoqueUid,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_ESTOQUE_AMAZON,
  chaveContaPrecisaAtencao,
  sincronizarAvisoContaEstoqueAmazon,
} from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { loadAmazonContext } from '../core/contexto';
import { CANARIO_ENV_AMAZON, VALVULA_ENV_AMAZON } from '../core/valvulas';
import {
  type FilaLotesAmazon,
  MAX_ATRASO_LOTE_S,
  criarAgendadorLotesAmazon,
} from '../feeds/agendadorLotes';
import {
  DESTINO_LOTE_AMAZON,
  type RaizLoteAmazon,
  vincularDestinosLoteAmazon,
} from '../feeds/destinosLote';
import { type DepsProcessarLoteAmazon, processarLoteAmazon } from '../feeds/processarLote';
import {
  type ContextoLoteAmazon,
  type MontagemLoteAmazon,
  ORCAMENTO_MONTAGEM_LOTE_MS,
} from '../feeds/provedorLote';
import { MAX_PROBLEMAS_POR_SKU, type ProblemaSku } from '../feeds/relatorioFeed';
import {
  type TarefaEnviarFeedAmazon,
  type TarefaLoteAmazon,
  execucaoIdDaJanelaFeed,
  execucaoIdDaRecuperacaoFeed,
  loteJanelaFeedAmazonSchema,
  nomeEnvioFeed,
  tarefaEnviarFeedAmazonSchema,
} from '../feeds/tarefaLote';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  loggerEspiao,
  respostaJson,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import * as avaliacao from './avaliacaoLoteEstoque';
import { INTERVALO_GETS_ESTOQUE_AMAZON_MS, MAX_GETS_LOTE_JANELA } from './avaliacaoLoteEstoque';
import * as descoberta from './descobertaEstoque';
import {
  ESPACO_ENTRE_SNAPSHOTS_MS,
  MARGEM_COMMIT_MS,
  janelaDoTick as planejarJanelaDoTick,
} from './descobertaEstoque';
import {
  RETENCAO_DIVERGENCIA_ESTOQUE_AMAZON_DIAS,
  gravarBlocoDivergenciaEstoqueAmazon,
} from './divergenciasFirestore';
import { criarProdutorEstoqueAmazon } from './produtorEstoque';
import {
  type DadosLoteEstoqueAmazon,
  ORCAMENTO_RECUPERACAO_ESTOQUE_AMAZON_MS,
  ORIGEM_LOTE_RECUPERACAO_ESTOQUE_AMAZON,
  type ProvedorLoteEstoqueAmazon,
  criarProvedorLoteEstoqueAmazon,
  patchEstoqueAmazon,
} from './provedorLoteEstoque';
import {
  type DepsTickEstoqueAmazon,
  LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
  executarTickEstoqueAmazon,
} from './sincronizacaoEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  referenciaDaObservacao,
} from './tarefaEstoque';

/** The shared evaluator, real, behind a spy: the window build must call THIS module. */
vi.mock('./avaliacaoLoteEstoque', async (original) => {
  const real = await original<typeof import('./avaliacaoLoteEstoque')>();
  return { ...real, avaliarSkusEstoqueAmazon: vi.fn(real.avaliarSkusEstoqueAmazon) };
});

/**
 * The recovery's window planner, real behind a spy: one case hands the
 * recovery's feed a window shape no snapshot yields today (a commit filter
 * that does not force), to pin what keys the hand-off's wait.
 */
vi.mock('./descobertaEstoque', async (original) => {
  const real = await original<typeof import('./descobertaEstoque')>();
  return { ...real, janelaDaRecuperacao: vi.fn(real.janelaDaRecuperacao) };
});

/* ---------------------------------- constants ---------------------------------- */

const CONTA = 'conta-amz-provedor';
const REF_CONTA = `documents/integracao/${CONTA}`;
const DEP = 'dep-provedor-1';
const OUTRO_DEP = 'dep-provedor-2';
const CANONICA = `documents/depositos/${DEP}`;
const NUA = `depositos/${DEP}`;
const CAMINHO_BUSCA = `${CAMINHO_LISTINGS}/${SPID_A}`;
const MIN = 60_000;
const HORA = 60 * MIN;
const FEED = '50001234567';
const URL_UPLOAD = 'https://example-bucket.s3.amazonaws.com/entrada?X-Amz-Signature=0000sentinela';
const URL_RELATORIO =
  'https://example-bucket.s3.amazonaws.com/relatorio?X-Amz-Signature=0000relatorio';
const CAMINHO_DOCUMENTOS = '/feeds/2021-06-30/documents';
const CAMINHO_FEEDS = '/feeds/2021-06-30/feeds';
const VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const PEDIDO = `pedidoReconciliacaoEstoqueAmazon/${CONTA}`;
const RUN = `reconciliacaoEstoqueAmazon/${CONTA}`;
const aviso = (motivo: MotivoContaAmazon) => caminhoAviso(chaveContaPrecisaAtencao(CONTA, motivo));

/* ----------------------------------- the world ----------------------------------- */

interface ChamadaAmazon {
  readonly tipo: 'busca' | 'get';
  readonly skus: readonly string[];
  readonly emMs: number;
}

interface TarefaGravada<T> {
  readonly tarefa: T;
  readonly id: string | null;
  readonly atrasoS: number;
}

/** The feed side of the scripted Amazon (the end-to-end cases). */
interface RotasFeed {
  /** `getFeed`'s answer, by default `DONE` with a report. */
  feed: Record<string, unknown>;
  /** The processing report the download answers. */
  relatorio: Record<string, unknown>;
}

function mundo() {
  const fake = new FakeDb();
  fake.seed(caminhoConta(CONTA), {
    tipo: INTEGRACAO_TIPO.amazon,
    nome: 'Conta provedor',
    ativo: true,
    padrao: false,
    selling_partner_id: SPID_A,
    depositoOuterRef: CANONICA,
  });
  seedCredencial(fake, CONTA, { expirationDate: AGORA_MS + 30 * DIA_MS });
  const log = loggerEspiao();
  const idsEstoque = new Set<string>();
  const idsLote = new Set<string>();
  const m = {
    fake,
    log,
    relogio: AGORA_MS,
    esperas: [] as number[],
    /** Amazon's catalogue: SKU → listing. A SKU absent here GETs a 404. */
    amazon: new Map<string, Record<string, unknown>>(),
    /** SKUs a search page leaves out although Amazon lists them. */
    omitidos: new Set<string>(),
    /** An HTTP status EVERY search answers while set (429: Amazon throttling). */
    statusDaBusca: null as number | null,
    /** Runs right before every stock-queue enqueue. */
    aoEnfileirarEstoque: null as (() => void) | null,
    chamadas: [] as ChamadaAmazon[],
    feedChamadas: [] as string[],
    /** Every feed document uploaded, parsed. */
    documentos: [] as { messages: { sku: string; patches: unknown[] }[] }[],
    rotas: {
      feed: {
        feedId: FEED,
        feedType: 'JSON_LISTINGS_FEED',
        processingStatus: 'DONE',
        resultFeedDocumentId: 'doc-rel-1',
      },
      relatorio: {
        header: { sellerId: SPID_A, version: '2.0', feedId: FEED },
        issues: [],
        summary: {
          errors: 0,
          warnings: 0,
          messagesProcessed: 0,
          messagesAccepted: 0,
          messagesInvalid: 0,
        },
      },
    } as RotasFeed,
    tarefasEstoque: [] as TarefaGravada<TarefaEstoqueAmazon>[],
    tarefasLote: [] as TarefaGravada<TarefaLoteAmazon>[],
    /** Runs right before a query of `colecao` reads (`collectionGroup` queries only). */
    aoConsultar: null as ((colecao: string) => void) | null,
    /** Runs right before every `getAll`. */
    aoLerVarios: null as (() => void) | null,
    ambiente: {
      ...AMBIENTE_LIGADO,
      [VALVULA_ENV_AMAZON.estoque]: 'on',
      [CANARIO_ENV_AMAZON.estoque]: '*',
    } as Record<string, string | undefined>,
    db: null as unknown as Firestore,
    raiz: null as unknown as RaizLoteAmazon,
    provedor: null as unknown as ProvedorLoteEstoqueAmazon,
    agora: () => m.relogio,
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const metodo = init?.method ?? 'GET';
      if (url.href === URL_TOKEN_LWA) return tokenDeAcesso();
      if (url.origin === new URL(URL_UPLOAD).origin) {
        if (metodo === 'PUT') {
          m.feedChamadas.push('PUT upload');
          const corpo = new TextDecoder().decode(init?.body as Uint8Array);
          m.documentos.push(JSON.parse(corpo) as (typeof m.documentos)[number]);
          return new Response(null, { status: 200 });
        }
        m.feedChamadas.push('GET relatorio');
        return new Response(JSON.stringify(m.rotas.relatorio), { status: 200 });
      }
      if (url.origin === URL_BASE_SP_API) {
        if (metodo === 'GET' && url.pathname === CAMINHO_BUSCA) {
          const pedidos = (url.searchParams.get('identifiers') ?? '').split(',');
          m.chamadas.push({ tipo: 'busca', skus: pedidos, emMs: m.relogio });
          if (m.statusDaBusca !== null) {
            return respostaJson(m.statusDaBusca, {
              errors: [{ code: 'QuotaExceeded', message: 'x' }],
            });
          }
          const items = pedidos
            .filter((s) => m.amazon.has(s) && !m.omitidos.has(s))
            .map((s) => m.amazon.get(s));
          return respostaJson(200, { numberOfResults: items.length, items });
        }
        if (metodo === 'GET' && url.pathname.startsWith(`${CAMINHO_BUSCA}/`)) {
          const sku = decodeURIComponent(url.pathname.slice(CAMINHO_BUSCA.length + 1));
          m.chamadas.push({ tipo: 'get', skus: [sku], emMs: m.relogio });
          const corpo = m.amazon.get(sku);
          return corpo === undefined
            ? respostaJson(404, { errors: [{ code: 'NOT_FOUND', message: 'x' }] })
            : respostaJson(200, corpo);
        }
        if (metodo === 'POST' && url.pathname === CAMINHO_DOCUMENTOS) {
          m.feedChamadas.push('POST documento');
          return respostaJson(201, { feedDocumentId: 'doc-entrada-1', url: URL_UPLOAD });
        }
        if (metodo === 'POST' && url.pathname === CAMINHO_FEEDS) {
          m.feedChamadas.push('POST feed');
          return respostaJson(202, { feedId: FEED });
        }
        if (metodo === 'GET' && url.pathname.startsWith(`${CAMINHO_FEEDS}/`)) {
          m.feedChamadas.push('GET feed');
          return respostaJson(200, m.rotas.feed);
        }
        if (metodo === 'GET' && url.pathname.startsWith(`${CAMINHO_DOCUMENTOS}/`)) {
          m.feedChamadas.push('GET documento');
          return respostaJson(200, { feedDocumentId: 'doc-rel-1', url: URL_RELATORIO });
        }
      }
      throw new Error(`teste: requisição fora do roteiro (${metodo} ${url.pathname})`);
    }) as typeof globalThis.fetch,
    /** The provider's context, the way the send side builds it (`vez` = its E4 read). */
    async ctx(vez: VezFeedAmazon | null = null): Promise<ContextoLoteAmazon> {
      const contexto = await loadAmazonContext(m.db, CONTA, {
        ambiente: m.ambiente,
        agora: m.agora,
        logger: log.logger,
        fetch: m.fetch,
        gerarCorrelationId: () => 'corr-provedor-teste',
      });
      return {
        contexto,
        db: m.db,
        logger: log.logger,
        agora: m.agora,
        sellerId: SPID_A,
        relogioVez: null,
        vez,
      };
    },
    /** The jobs dispatcher's deps, the seam BOUND with this world's root. */
    deps(): DepsProcessarLoteAmazon {
      return {
        ambiente: m.ambiente,
        agora: m.agora,
        logger: log.logger,
        increment,
        agendador: m.raiz.agendadorLotes,
        provedores: vincularDestinosLoteAmazon(m.raiz, DESTINO_LOTE_AMAZON),
        registro: { tentativa: 0, idTarefa: 'tarefa-provedor-teste' },
        fetch: m.fetch,
        gerarCorrelationId: () => 'corr-provedor-teste',
        paginaReconciliacao: () => Promise.reject(new Error('teste: nenhuma página aqui')),
      };
    },
    despachar(t: TarefaLoteAmazon) {
      return processarLoteAmazon(m.db, t, m.deps());
    },
  };
  m.db = comGanchos(fake, m);
  m.raiz = {
    agendadorLotes: () =>
      criarAgendadorLotesAmazon({
        desligado: false,
        fila: (): FilaLotesAmazon => ({
          enqueue: (tarefa, opcoes) => {
            const id = opcoes?.id;
            if (id !== undefined && idsLote.has(id)) {
              return Promise.reject(falhaDeTarefaJaExistente(id));
            }
            if (id !== undefined) idsLote.add(id);
            m.tarefasLote.push({
              tarefa,
              id: id ?? null,
              atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
            });
            return Promise.resolve();
          },
        }),
      }),
    produtorEstoque: () =>
      criarProdutorEstoqueAmazon({
        desligado: false,
        fila: () => ({
          enqueue: (tarefa, extras) => {
            m.aoEnfileirarEstoque?.();
            const id = extras?.id;
            if (id !== undefined && idsEstoque.has(id)) {
              return Promise.reject(falhaDeTarefaJaExistente(id));
            }
            if (id !== undefined) idsEstoque.add(id);
            m.tarefasEstoque.push({
              tarefa,
              id: id ?? null,
              atrasoS: extras?.scheduleDelaySeconds ?? 0,
            });
            return Promise.resolve();
          },
        }),
      }),
    esperar: (ms) => {
      m.esperas.push(ms);
      m.relogio += ms;
      return Promise.resolve();
    },
    increment,
    gerarExecucaoId: () => `run-${String(m.tarefasLote.length + 1)}`,
    ambiente: () => m.ambiente,
  };
  m.provedor = criarProvedorLoteEstoqueAmazon(m.raiz);
  __setRelogioDoCacheParaTestes(() => m.relogio);
  return m;
}

type Mundo = ReturnType<typeof mundo>;

/**
 * The fake, with two hooks: right before a collection-group query reads, and
 * right before every `getAll` — the instants a clock spy reads.
 */
function comGanchos(
  fake: FakeDb,
  m: {
    readonly aoConsultar: ((colecao: string) => void) | null;
    readonly aoLerVarios: (() => void) | null;
  },
): Firestore {
  const base = asDb(fake) as unknown as Record<string | symbol, unknown>;
  const CONSTRUTORES = new Set(['where', 'orderBy', 'select', 'limit', 'startAfter']);
  const consulta = (alvo: object, colecao: string): object =>
    new Proxy(alvo, {
      get(t, prop) {
        const v: unknown = Reflect.get(t, prop, t);
        if (typeof v !== 'function') return v;
        const f = v as (...a: unknown[]) => unknown;
        if (prop === 'get') {
          return (...a: unknown[]) => {
            m.aoConsultar?.(colecao);
            return f.apply(t, a);
          };
        }
        if (typeof prop === 'string' && CONSTRUTORES.has(prop)) {
          return (...a: unknown[]) => consulta(f.apply(t, a) as object, colecao);
        }
        return f.bind(t);
      },
    });
  return new Proxy(base, {
    get(t, prop) {
      const v: unknown = Reflect.get(t, prop, t);
      if (typeof v !== 'function') return v;
      const f = v as (...a: unknown[]) => unknown;
      if (prop === 'collectionGroup') {
        return (id: string) => consulta(f.call(t, id) as object, id);
      }
      if (prop === 'getAll') {
        return (...a: unknown[]) => {
          m.aoLerVarios?.();
          return f.apply(t, a);
        };
      }
      return f.bind(t);
    },
  }) as unknown as Firestore;
}

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  vi.mocked(avaliacao.avaliarSkusEstoqueAmazon).mockClear();
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  expect(rede).toEqual([]);
  rede.length = 0;
});

/* ----------------------------------- the seeds ----------------------------------- */

/** A deterministic ASIN-shaped placeholder per SKU. */
function asinDe(sku: string): string {
  let h = 2166136261;
  for (const ch of sku) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  let letras = '';
  for (let i = 0; i < 8; i += 1) {
    letras += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + i * 7919;
  }
  return `B0${letras}`;
}

/** A listing as the model shapes it: BR summary, MFN availability at `quantidade`. */
function listing(sku: string, quantidade: number, extra: Record<string, unknown> = {}) {
  return {
    sku,
    summaries: [
      {
        marketplaceId: MARKETPLACE_ID_BR,
        asin: asinDe(sku),
        productType: 'PRODUCT',
        status: ['BUYABLE'],
      },
    ],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: quantidade }],
    relationships: [{ marketplaceId: MARKETPLACE_ID_BR, relationships: [] }],
    ...extra,
  };
}

/** An id for a SKU's produto: its SKU, made a document id. */
const idDe = (sku: string) => `p-${sku.replace(/[^A-Za-z0-9-]/g, '_')}`;

function produto(m: Mundo, id: string, dados: Record<string, unknown> = {}): void {
  m.fake.seed(`produtos/${id}`, { nome: `Produto ${id}`, ...dados });
}

function vinculo(m: Mundo, dono: string, linkId: string, sku: string): void {
  m.fake.seed(`produtos/${dono}/prodAmazon/${linkId}`, {
    contaAmazonOuterRef: REF_CONTA,
    sku,
    asin: asinDe(sku),
    productDataJson: { pesado: 'x'.repeat(32) },
  });
}

/** The unit's estoque row at the depósito, stamped `carimbo`. Returns its path. */
function linha(m: Mundo, produtoId: string, quantidade: number, carimbo: number): string {
  const caminho = `produtos/${produtoId}/estoques/${makeEstoqueUid(produtoId, DEP)}`;
  m.fake.seed(caminho, {
    depositoOuterRef: CANONICA,
    parentId: produtoId,
    quantidade,
    quantidadeReservada: 0,
    ultimaModificacao: carimbo,
  });
  return caminho;
}

/**
 * A simple produto linked to `sku`: ERP `erp` at the depósito (its row stamped
 * `carimbo`), listed on Amazon at `amazon` (or not listed). Returns the row's path.
 */
function simples(
  m: Mundo,
  sku: string,
  o: { erp: number; amazon?: number | null; carimbo: number },
): string {
  const id = idDe(sku);
  produto(m, id);
  vinculo(m, id, 'l1', sku);
  const caminho = linha(m, id, o.erp, o.carimbo);
  const amazon = o.amazon === undefined ? o.erp : o.amazon;
  if (amazon !== null) m.amazon.set(sku, listing(sku, amazon));
  return caminho;
}

/** Moves the fake's commit clock into the next millisecond. */
function avancarUmMs(m: Mundo): void {
  for (let i = 0; i < 1_000; i += 1) m.fake.seed('relogio/x', { i });
}

/** The fake's current commit millisecond (a marker seeded now). */
function commitAgora(m: Mundo): number {
  return m.fake.seed('relogio/marco', {}).toMillis();
}

/* --------------------------------- the payloads ---------------------------------- */

function enviar(
  lote: TarefaEnviarFeedAmazon['lote'],
  execucaoId = 'exec-provedor-1',
  origem = 'delta',
) {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: 'feed-enviar',
    fluxo: 'estoque',
    contaId: CONTA,
    execucaoId,
    origem,
    lote,
  }) as TarefaEnviarFeedAmazon & { readonly fluxo: 'estoque' };
}

/**
 * A window batch of the tick's class that keeps every row STAMPED in its range:
 * no commit filter, never forcing, no wait. The tick's own shape (its commit
 * filter, its stamp rule above its range start) is the tick end-to-end cases'.
 */
function janelaDoTick(desdeMs: number, ateMs: number, depositoId = DEP) {
  return enviar({
    tipo: 'janela',
    desdeMs,
    ateMs,
    manterDesdeMs: desdeMs,
    commitAposMs: null,
    forcarPorCommit: false,
    esperaAteMs: null,
    depositoId,
  });
}

/** A RECOVERY-born window batch: a commit filter that forces, and a bounded wait. */
function janelaDaRecuperacao(
  desdeMs: number,
  ateMs: number,
  commitAposMs: number,
  execucaoId = 'exec-rec-1',
) {
  return enviar(
    {
      tipo: 'janela',
      desdeMs,
      ateMs,
      manterDesdeMs: desdeMs,
      commitAposMs,
      forcarPorCommit: true,
      esperaAteMs: AGORA_MS + HORA,
      depositoId: DEP,
    },
    execucaoId,
    'recuperacao',
  );
}

function blocos(partes: number, execucaoId = 'run-x') {
  return enviar(
    { tipo: 'blocos', partes, esperaAteMs: AGORA_MS + 6 * HORA },
    execucaoId,
    'reconciliacao',
  );
}

/* ----------------------------------- readers ------------------------------------ */

const consultasDaJanela = (m: Mundo) => m.fake.consultas.filter((q) => q.colecao === 'estoques');
const buscas = (m: Mundo) => m.chamadas.filter((c) => c.tipo === 'busca');
const gets = (m: Mundo) => m.chamadas.filter((c) => c.tipo === 'get');
const skusEnviados = (r: MontagemLoteAmazon) => {
  if ('abortado' in r) throw new Error(`montagem abortada: ${r.abortado}`);
  return r.mensagens.map((x) => x.sku);
};
const quantidadeDe = (r: MontagemLoteAmazon, sku: string) => {
  if ('abortado' in r) throw new Error('montagem abortada');
  const msg = r.mensagens.find((x) => x.sku === sku);
  const valor = msg?.patches[0]?.value?.[0] as { quantity?: number } | undefined;
  return valor?.quantity;
};
function dadosDe(r: Awaited<ReturnType<ProvedorLoteEstoqueAmazon['membros']>>) {
  if ('abortado' in r) throw new Error(`membros abortados: ${r.abortado}`);
  return r;
}
const tarefasEstoque = (m: Mundo) =>
  m.tarefasEstoque
    .map((x) => [x.tarefa.sku, x.tarefa.origem, x.tarefa.referencia] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const doTipo = (m: Mundo, tipo: TarefaLoteAmazon['tipo']) =>
  m.tarefasLote.filter((x) => x.tarefa.tipo === tipo);

/* ======================================================================================= */

describe('the factory and its parity pins', () => {
  it('★ builds the stock provider: its fluxo, the REAL feed-failure motivo, and nothing of the root is called at build', () => {
    const m = mundo();
    const espias = {
      agendadorLotes: vi.fn(m.raiz.agendadorLotes),
      produtorEstoque: vi.fn(m.raiz.produtorEstoque),
      esperar: vi.fn(m.raiz.esperar),
      increment: vi.fn(m.raiz.increment),
      gerarExecucaoId: vi.fn(m.raiz.gerarExecucaoId),
      ambiente: vi.fn(m.raiz.ambiente),
    };
    const p = criarProvedorLoteEstoqueAmazon(espias);
    expect(p.fluxo).toBe('estoque');
    // NEAR-MISS: the core's own tests use another motivo as a stand-in.
    expect(p.motivoFalha).toBe(MOTIVO_CONTA_AMAZON.feedEstoqueFalhou);
    expect(p.motivoFalha).not.toBe(MOTIVO_CONTA_AMAZON.contaSemOperacao);
    for (const f of Object.values(espias)) expect(f).not.toHaveBeenCalled();
  });

  it('★ a feed message’s merge is EXACTLY the body the package’s own patchListingsItem helper sends', async () => {
    const patch = vi.fn((pedido: { corpo: string }) => {
      void pedido;
      return Promise.resolve({ dados: { status: 'ACCEPTED', submissionId: 's', sku: 'SKU-P' } });
    });
    await enviarDisponibilidadeAmazon({ patch } as unknown as SpApiEscritaClient, {
      sellerId: SPID_A,
      sku: 'SKU-P',
      quantidade: 7,
    });
    const corpo = JSON.parse(patch.mock.calls[0]?.[0].corpo ?? '{}') as { patches: unknown[] };
    expect(corpo.patches).toEqual([patchEstoqueAmazon(7)]);
    // NEAR-MISS: another quantity is another body.
    expect(corpo.patches).not.toEqual([patchEstoqueAmazon(8)]);
  });

  it('★ the report’s per-SKU problem cap equals the link outcome’s: a feed write-back never truncates twice', () => {
    expect(MAX_PROBLEMAS_POR_SKU).toBe(MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON);
    expect(MAX_PROBLEMAS_POR_SKU).toBe(10);
  });
});

/* ======================================================================================= */

describe('★ a WINDOW batch’s members: the window re-derived at the payload’s depósito', () => {
  it('one query per ref form with the payload’s bounds, then the mapping; a SKU re-stamped past ateMs is not a member', async () => {
    const m = mundo();
    const desde = AGORA_MS - 10 * MIN;
    const ate = AGORA_MS - 5 * MIN;
    simples(m, 'SKU-A', { erp: 3, carimbo: desde + 1 });
    simples(m, 'SKU-B', { erp: 4, carimbo: ate });
    // Re-stamped since the tick: its movement belongs to a later window.
    simples(m, 'SKU-TARDE', { erp: 5, carimbo: ate + 1 });

    const r = dadosDe(await m.provedor.membros(await m.ctx(), janelaDoTick(desde, ate)));

    expect(r.skus).toEqual(['SKU-A', 'SKU-B']);
    expect(consultasDaJanela(m).map((q) => q.filtros)).toEqual(
      [CANONICA, NUA].map((forma) => [
        ['depositoOuterRef', forma],
        ['ultimaModificacao >', desde],
        ['ultimaModificacao <=', ate],
      ]),
    );
    expect(r.dados.tipo).toBe('janela');
  });

  it('★ the snapshot is our clock BEFORE the first window query (a clock spy)', async () => {
    const m = mundo();
    simples(m, 'SKU-A', { erp: 3, carimbo: AGORA_MS - 6 * MIN });
    const instantes: number[] = [];
    m.aoConsultar = (colecao) => {
      if (colecao !== 'estoques') return;
      instantes.push(m.relogio);
      m.relogio += 30_000;
    };
    const antes = m.relogio;

    const r = dadosDe(
      await m.provedor.membros(await m.ctx(), janelaDoTick(AGORA_MS - 10 * MIN, AGORA_MS - MIN)),
    );

    if (r.dados.tipo !== 'janela') throw new Error('janela');
    expect(r.dados.snapshotEmMs).toBe(antes);
    expect(r.dados.snapshotEmMs).toBeLessThanOrEqual(instantes[0] ?? -1);
    // NEAR-MISS: a snapshot taken after the mapping would read a later clock.
    expect(m.relogio).toBeGreaterThan(r.dados.snapshotEmMs);
  });

  it('★ the conta’s depósito is no longer the payload’s ⇒ deposito-mudou, NO aviso, ZERO window queries', async () => {
    const m = mundo();
    simples(m, 'SKU-A', { erp: 3, carimbo: AGORA_MS - 6 * MIN });

    const r = await m.provedor.membros(
      await m.ctx(),
      janelaDoTick(AGORA_MS - 10 * MIN, AGORA_MS - MIN, OUTRO_DEP),
    );

    expect(r).toEqual({ abortado: 'deposito-mudou', aviso: null });
    expect(consultasDaJanela(m)).toEqual([]);
  });

  it(`★ ${String(3_001)} SKUs ⇒ ONE reconcile request (origem feed) and janela-grande; NEAR-MISS 3,000 ⇒ the members`, async () => {
    const m = mundo();
    const desde = AGORA_MS - 10 * MIN;
    produto(m, 'K');
    for (let i = 0; i < 3_000; i += 1)
      vinculo(m, 'K', `l${String(i)}`, `K-${String(i).padStart(4, '0')}`);
    linha(m, 'K', 2, desde + 1);

    const noTeto = dadosDe(await m.provedor.membros(await m.ctx(), janelaDoTick(desde, AGORA_MS)));
    expect(noTeto.skus).toHaveLength(3_000);
    expect(m.fake.ler(PEDIDO)).toBeUndefined();

    vinculo(m, 'K', 'l-extra', 'K-extra');
    const acima = await m.provedor.membros(await m.ctx(), janelaDoTick(desde, AGORA_MS));

    expect(acima).toEqual({ abortado: 'janela-grande', aviso: null });
    expect(m.fake.ler(PEDIDO)).toMatchObject({ pendente: false, pedidoEmMs: m.relogio });
    // The request started a run: page 0 on the jobs queue, named.
    expect(doTipo(m, 'reconciliacao')).toHaveLength(1);
    expect(m.fake.ler(PEDIDO)?.reexecucaoAutomaticaEmMs ?? null).toBeNull();
  });

  it('★ the deadline reached INSIDE membros ⇒ the guarded AUTOMATIC request instead (the member set is incomplete), snapshot-lento, no patch task', async () => {
    const m = mundo();
    const desde = AGORA_MS - 10 * MIN;
    simples(m, 'SKU-A', { erp: 3, carimbo: desde + 1 });
    m.aoConsultar = (colecao) => {
      if (colecao === 'estoques') m.relogio += ORCAMENTO_MONTAGEM_LOTE_MS + 1;
    };

    const r = await m.provedor.membros(await m.ctx(), janelaDoTick(desde, AGORA_MS));

    expect(r).toEqual({ abortado: 'snapshot-lento', aviso: MOTIVO_CONTA_AMAZON.feedEstoqueFalhou });
    expect(m.fake.ler(PEDIDO)).toMatchObject({ reexecucaoAutomaticaEmMs: expect.any(Number) });
    expect(m.tarefasEstoque).toEqual([]);
  });
});

/* ======================================================================================= */

describe('★ a WINDOW batch’s build: the SHARED evaluator, then the plan per SKU', () => {
  /** A recovery-born window over SKUs whose rows commit before, and one after, its filter. */
  async function cenarioMisto() {
    const m = mundo();
    const desde = AGORA_MS - 10 * MIN;
    const ate = AGORA_MS - MIN;
    simples(m, 'SKU-DIFERE', { erp: 7, amazon: 2, carimbo: desde + 1 });
    simples(m, 'SKU-IGUAL', { erp: 5, carimbo: desde + 2 });
    simples(m, 'SKU-AFN', { erp: 3, carimbo: desde + 3 });
    m.amazon.set(
      'SKU-AFN',
      listing('SKU-AFN', 1, {
        fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_NA', quantity: 1 }],
      }),
    );
    simples(m, 'SKU-PAI', { erp: 3, carimbo: desde + 4 });
    m.amazon.set(
      'SKU-PAI',
      listing('SKU-PAI', 1, {
        relationships: [
          {
            marketplaceId: MARKETPLACE_ID_BR,
            relationships: [{ type: 'VARIATION', childSkus: ['SKU-PAI-1'] }],
          },
        ],
      }),
    );
    // A SKU the PATCH path cannot carry, but a search reads and a feed carries.
    simples(m, 'SKU/BARRA', { erp: 9, amazon: 1, carimbo: desde + 5 });
    // The commit filter sits right after every row above.
    const filtro = commitAgora(m);
    avancarUmMs(m);
    // FORCED: its row committed after the filter; Amazon already shows its ERP value.
    simples(m, 'SKU-FORCADO', { erp: 4, carimbo: desde + 6 });
    const t = janelaDaRecuperacao(desde, ate, filtro);
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, t));
    return { m, t, ctx, membros };
  }

  it('★ calls the SHARED evaluator ONCE (the walk’s own module) with the window cap; sends the differing, a FORCED SKU Amazon already matches and a sem-caminho SKU; drops an unforced igual; refuses AFN and a parent', async () => {
    const { m, t, ctx, membros } = await cenarioMisto();
    expect(membros.skus).toEqual([
      'SKU-AFN',
      'SKU-DIFERE',
      'SKU-FORCADO',
      'SKU-IGUAL',
      'SKU-PAI',
      'SKU/BARRA',
    ]);

    const r = await m.provedor.montar(ctx, t, membros.skus, membros.dados);

    const espiao = vi.mocked(avaliacao.avaliarSkusEstoqueAmazon);
    expect(espiao).toHaveBeenCalledOnce();
    expect(espiao.mock.calls[0]?.[1]).toEqual(membros.skus);
    expect(espiao.mock.calls[0]?.[2]).toEqual({
      depositoId: DEP,
      prazoMs:
        (membros.dados as Extract<DadosLoteEstoqueAmazon, { tipo: 'janela' }>).snapshotEmMs +
        ORCAMENTO_MONTAGEM_LOTE_MS,
      maxGets: MAX_GETS_LOTE_JANELA,
    });
    expect(skusEnviados(r)).toEqual(['SKU-DIFERE', 'SKU-FORCADO', 'SKU/BARRA']);
    expect(quantidadeDe(r, 'SKU-DIFERE')).toBe(7);
    expect(quantidadeDe(r, 'SKU-FORCADO')).toBe(4);
    expect(quantidadeDe(r, 'SKU/BARRA')).toBe(9);
    if ('abortado' in r) throw new Error('abortada');
    expect(r.snapshotEmMs).toBe(
      (membros.dados as Extract<DadosLoteEstoqueAmazon, { tipo: 'janela' }>).snapshotEmMs,
    );
    expect(r.diff).toMatchObject({
      lote: 'janela',
      mensagens: 3,
      iguais: 1,
      forcados: 1,
      recusados: 2,
    });
    // The live read: ONE search for the six (the slash SKU is searchable).
    expect(buscas(m).map((b) => b.skus)).toEqual([membros.skus]);
  });

  it('the feed-recent rule reads the SEND side’s lease (ctx.vez): an equal read inside the lag after a feed ended is sent; NEAR-MISS no lease ⇒ not', async () => {
    const m = mundo();
    simples(m, 'SKU-IGUAL', { erp: 5, carimbo: AGORA_MS - 6 * MIN });
    const t = janelaDoTick(AGORA_MS - 10 * MIN, AGORA_MS - MIN);
    const sem = await m.ctx(null);
    const ms = dadosDe(await m.provedor.membros(sem, t));
    expect(skusEnviados(await m.provedor.montar(sem, t, ms.skus, ms.dados))).toEqual([]);

    const vez = { ultimoFeedConcluidoEmMs: AGORA_MS - 2 * MIN } as unknown as VezFeedAmazon;
    const com = await m.ctx(vez);
    expect(skusEnviados(await m.provedor.montar(com, t, ms.skus, ms.dados))).toEqual(['SKU-IGUAL']);
  });

  it('★ 61 search misses ⇒ 60 confirmation GETs (334 ms apart) and ONE nao-confirmado SKU, not sent; NEAR-MISS: the reconcile walk (no cap) confirms all 61', async () => {
    const m = mundo();
    const desde = AGORA_MS - 10 * MIN;
    produto(m, 'K');
    const skus = Array.from({ length: 61 }, (_v, i) => `K-${String(i).padStart(3, '0')}`);
    for (const [i, sku] of skus.entries()) {
      vinculo(m, 'K', `l${String(i)}`, sku);
      m.amazon.set(sku, listing(sku, 0));
      m.omitidos.add(sku);
    }
    linha(m, 'K', 2, desde + 1);
    const t = janelaDoTick(desde, AGORA_MS);
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, t));

    const r = await m.provedor.montar(ctx, t, membros.skus, membros.dados);

    expect(gets(m)).toHaveLength(MAX_GETS_LOTE_JANELA);
    const passos = gets(m).map((g, i, todas) =>
      i === 0 ? null : g.emMs - (todas[i - 1]?.emMs ?? 0),
    );
    for (const passo of passos.slice(1))
      expect(passo).toBeGreaterThanOrEqual(INTERVALO_GETS_ESTOQUE_AMAZON_MS);
    expect(skusEnviados(r)).toHaveLength(60);
    expect(skusEnviados(r)).not.toContain('K-060');
    if ('abortado' in r) throw new Error('abortada');
    expect(r.diff).toMatchObject({ naoConfirmados: 1, gets: 60 });

    // NEAR-MISS: the walk's evaluation of the same SKUs (no cap) confirms every miss.
    m.chamadas.length = 0;
    const walk = await avaliacao.avaliarSkusEstoqueAmazon(
      {
        contexto: ctx.contexto,
        db: m.db,
        logger: m.log.logger,
        agora: m.agora,
        sellerId: SPID_A,
        esperar: m.raiz.esperar,
      },
      skus,
      { depositoId: DEP, prazoMs: Number.MAX_SAFE_INTEGER, maxGets: null },
    );
    expect(gets(m)).toHaveLength(61);
    expect(walk.contagem.enviaveis).toBe(61);
  });

  it('★ the build past the shared 240 s ⇒ snapshot-lento with feed-estoque-falhou, NOTHING built, and the members handed to the per-SKU path FIRST', async () => {
    const { m, t, ctx, membros } = await cenarioMisto();
    m.relogio += ORCAMENTO_MONTAGEM_LOTE_MS + 1;

    const r = await m.provedor.montar(ctx, t, membros.skus, membros.dados);

    expect(r).toEqual({ abortado: 'snapshot-lento', aviso: MOTIVO_CONTA_AMAZON.feedEstoqueFalhou });
    expect(m.chamadas).toEqual([]);
    // Every member, once: the forced one a catch-up named by the BATCH, the rest by their observation.
    expect(tarefasEstoque(m).map(([sku, origem]) => [sku, origem])).toEqual([
      ['SKU-AFN', 'delta'],
      ['SKU-DIFERE', 'delta'],
      ['SKU-FORCADO', 'catch-up'],
      ['SKU-IGUAL', 'delta'],
      ['SKU-PAI', 'delta'],
      ['SKU/BARRA', 'delta'],
    ]);
    expect(m.tarefasEstoque.find((x) => x.tarefa.sku === 'SKU-FORCADO')?.tarefa.referencia).toBe(
      t.execucaoId,
    );
    expect(m.tarefasEstoque.every((x) => x.atrasoS === 0)).toBe(true);
  });
});

/* ======================================================================================= */

describe('★ a BLOCK batch: the run’s drift blocks, then the snapshot', () => {
  const RUN_X = 'run-x';

  async function bloco(
    m: Mundo,
    pagina: number,
    itens: {
      sku: string;
      unidadeId: string;
      quantidadeAmazon: number | null;
      quantidadeErp: number;
    }[],
    execucaoId = RUN_X,
    depositoId = DEP,
  ) {
    await gravarBlocoDivergenciaEstoqueAmazon(m.db, {
      contaId: CONTA,
      execucaoId,
      pagina,
      depositoId,
      itens,
      agoraMs: m.relogio,
    });
  }

  it('★ membros: ZERO queries — ONE getAll of exactly {run}-0…{run}-(partes−1), partes from the PAYLOAD; NEAR-MISS a prefix', async () => {
    const m = mundo();
    await bloco(m, 0, [{ sku: 'SKU-A', unidadeId: 'u-a', quantidadeAmazon: 1, quantidadeErp: 2 }]);
    await bloco(m, 2, [{ sku: 'SKU-C', unidadeId: 'u-c', quantidadeAmazon: 1, quantidadeErp: 2 }]);
    // The NEXT run already reclaimed the reconcile document: its page count is not this send's.
    m.fake.seed(RUN, { execucaoId: 'run-y', paginas: 9 });
    const ctx = await m.ctx();
    const leiturasAntes = m.fake.leituras.length;

    const r = dadosDe(await m.provedor.membros(ctx, blocos(3)));

    expect(r.skus).toEqual(['SKU-A', 'SKU-C']);
    expect(m.fake.consultas).toEqual([]);
    expect(m.fake.leituras.slice(leiturasAntes)).toEqual([
      `${RUN}/divergenciasEstoqueAmazon/${RUN_X}-0`,
      `${RUN}/divergenciasEstoqueAmazon/${RUN_X}-1`,
      `${RUN}/divergenciasEstoqueAmazon/${RUN_X}-2`,
    ]);
    // NEAR-MISS: one part fewer reads a prefix of the drift.
    expect(dadosDe(await m.provedor.membros(ctx, blocos(2))).skus).toEqual(['SKU-A']);
  });

  it('★ montar: the snapshot BEFORE the first ERP read; a converged SKU dropped, a GONE unit and a unit with VARIATIONS dropped and counted, a kit root’s own sole member kept; the quantity is the ERP’s NOW', async () => {
    const m = mundo();
    produto(m, 'u-difere');
    linha(m, 'u-difere', 9, 1);
    produto(m, 'u-convergiu');
    linha(m, 'u-convergiu', 4, 1);
    produto(m, 'u-pai');
    linha(m, 'u-pai', 3, 1);
    produto(m, 'u-pai-filho-1', { paiId: 'u-pai' });
    produto(m, 'u-kit', { ehKit: true, filhoUnicoId: 'u-kit-membro' });
    linha(m, 'u-kit', 6, 1);
    produto(m, 'u-kit-membro', { paiId: 'u-kit' });
    await bloco(m, 0, [
      { sku: 'SKU-DIFERE', unidadeId: 'u-difere', quantidadeAmazon: 2, quantidadeErp: 8 },
      { sku: 'SKU-CONVERGIU', unidadeId: 'u-convergiu', quantidadeAmazon: 4, quantidadeErp: 1 },
      { sku: 'SKU-SUMIU', unidadeId: 'u-sumiu', quantidadeAmazon: 2, quantidadeErp: 0 },
      { sku: 'SKU-PAI', unidadeId: 'u-pai', quantidadeAmazon: 1, quantidadeErp: 3 },
      { sku: 'SKU-KIT', unidadeId: 'u-kit', quantidadeAmazon: null, quantidadeErp: 6 },
    ]);
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, blocos(1)));
    let primeiraLeitura: number | null = null;
    m.aoLerVarios = () => {
      if (primeiraLeitura === null) {
        primeiraLeitura = m.relogio;
        m.relogio += 5_000;
      }
    };
    const antes = m.relogio;

    const r = await m.provedor.montar(ctx, blocos(1), membros.skus, membros.dados);

    if ('abortado' in r) throw new Error('abortada');
    expect(r.snapshotEmMs).toBe(antes);
    expect(r.snapshotEmMs).toBeLessThanOrEqual(primeiraLeitura ?? -1);
    expect(skusEnviados(r)).toEqual(['SKU-DIFERE', 'SKU-KIT']);
    // The ERP's quantity NOW, never the walk's.
    expect(quantidadeDe(r, 'SKU-DIFERE')).toBe(9);
    expect(r.diff).toMatchObject({
      lote: 'blocos',
      membros: 5,
      mensagens: 2,
      convergidos: 1,
      unidadesAusentes: 1,
      unidadesComVariacoes: 1,
    });
    // No link doc is re-read: the walk's verdict stands.
    expect(m.fake.consultas.filter((q) => q.colecao === 'prodAmazon')).toEqual([]);
    // The children seek, ids only, at most two.
    expect(m.fake.consultas.filter((q) => q.colecao === 'produtos').map((q) => q.limite)).toEqual([
      2, 2, 2, 2,
    ]);
  });

  it('★ the conta’s depósito is no longer the walk’s ⇒ deposito-mudou with estoque-deposito-sem-linhas, ZERO ERP reads', async () => {
    const m = mundo();
    await bloco(
      m,
      0,
      [{ sku: 'SKU-A', unidadeId: 'u-a', quantidadeAmazon: 1, quantidadeErp: 2 }],
      RUN_X,
      OUTRO_DEP,
    );
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, blocos(1)));
    const antes = m.fake.leituras.length;

    const r = await m.provedor.montar(ctx, blocos(1), membros.skus, membros.dados);

    expect(r).toEqual({
      abortado: 'deposito-mudou',
      aviso: MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas,
    });
    expect(m.fake.leituras.length).toBe(antes);
  });

  it('★ the snapshot past the shared 240 s ⇒ snapshot-lento with feed-estoque-falhou, and NOTHING handed over (the next daily run re-walks a block batch)', async () => {
    const m = mundo();
    produto(m, 'u-a');
    linha(m, 'u-a', 9, 1);
    await bloco(m, 0, [{ sku: 'SKU-A', unidadeId: 'u-a', quantidadeAmazon: 1, quantidadeErp: 2 }]);
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, blocos(1)));
    m.aoLerVarios = () => {
      m.relogio += ORCAMENTO_MONTAGEM_LOTE_MS + 1;
    };

    const r = await m.provedor.montar(ctx, blocos(1), membros.skus, membros.dados);

    expect(r).toEqual({ abortado: 'snapshot-lento', aviso: MOTIVO_CONTA_AMAZON.feedEstoqueFalhou });
    expect(m.tarefasEstoque).toEqual([]);
  });

  it('repassarParaPatches: one reconciliacao task per SKU, named by the RUN, carrying the WALK’s depósito (never the conta’s current one: the task refuses a moved depósito), no delay', async () => {
    const m = mundo();
    await bloco(
      m,
      0,
      [
        { sku: 'SKU-A', unidadeId: 'u-a', quantidadeAmazon: 1, quantidadeErp: 2 },
        { sku: 'SKU-B', unidadeId: 'u-b', quantidadeAmazon: 1, quantidadeErp: 2 },
      ],
      RUN_X,
      OUTRO_DEP,
    );
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, blocos(1)));

    expect(
      await m.provedor.repassarParaPatches(ctx, blocos(1), membros.skus, membros.dados),
    ).toEqual({ tarefas: 2 });
    expect(m.tarefasEstoque.map((x) => x.tarefa)).toEqual(
      ['SKU-A', 'SKU-B'].map((sku) => ({
        v: 1,
        contaId: CONTA,
        sku,
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao,
        referencia: RUN_X,
        depositoId: OUTRO_DEP,
      })),
    );
    expect(m.tarefasEstoque.every((x) => x.atrasoS === 0 && x.id !== null)).toBe(true);
    // The blocks keep 7 days, past every send of their run.
    expect(RETENCAO_DIVERGENCIA_ESTOQUE_AMAZON_DIAS).toBe(7);
  });
});

/* ======================================================================================= */

describe('★ gravarResultado: the report’s per-SKU write-back', () => {
  const erro: ProblemaSku = {
    code: '90220',
    message: 'texto-sentinela',
    severity: 'ERROR',
    attributeNames: null,
    categories: null,
  };
  const alerta: ProblemaSku = {
    code: '99001',
    message: 'x',
    severity: 'WARNING',
    attributeNames: null,
    categories: null,
  };

  it('★ an ERROR ⇒ recusado on EVERY link doc of the SKU (via feed, quantidade null, the feed’s emMs and id); a WARNING ⇒ aceito-com-avisos; an unlinked SKU skipped; estoque-recusado-pela-amazon raised ONCE; the feed aviso never touched', async () => {
    const m = mundo();
    produto(m, 'p1');
    vinculo(m, 'p1', 'l1', 'SKU-ERRO');
    vinculo(m, 'p1', 'l2', 'SKU-ERRO');
    produto(m, 'p2');
    vinculo(m, 'p2', 'l1', 'SKU-AVISO');
    produto(m, 'p3');
    vinculo(m, 'p3', 'l1', 'SKU-ERRO-2');
    const relogio = m.fake.seed('relogio/desfecho', {});
    const emMs = AGORA_MS - 2 * MIN;

    await m.provedor.gravarResultado(await m.ctx(), {
      problemas: new Map([
        ['SKU-ERRO', [erro]],
        ['SKU-ERRO-2', [erro, alerta]],
        ['SKU-AVISO', [alerta]],
        ['SKU-SEM-VINCULO', [erro]],
      ]),
      emMs,
      feedId: FEED,
      relogio,
    });

    for (const caminho of ['produtos/p1/prodAmazon/l1', 'produtos/p1/prodAmazon/l2']) {
      expect(m.fake.ler(caminho)?.envioEstoqueAmazon).toMatchObject({
        via: 'feed',
        emMs,
        quantidade: null,
        resultado: 'recusado',
        feedId: FEED,
      });
    }
    expect(m.fake.ler('produtos/p2/prodAmazon/l1')?.envioEstoqueAmazon).toMatchObject({
      resultado: 'aceito-com-avisos',
      quantidade: null,
    });
    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))).toMatchObject({
      resolvidoEm: null,
    });
    // Raised ONCE for the whole report, never once per refused SKU.
    expect(m.fake.escritasEm(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))).toHaveLength(1);
    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.feedEstoqueFalhou))).toBeUndefined();
  });

  it('NEAR-MISS: a stale recusado (every link already holds a NEWER outcome) writes nothing and raises nothing', async () => {
    const m = mundo();
    produto(m, 'p1');
    vinculo(m, 'p1', 'l1', 'SKU-ERRO');
    m.fake.seed('produtos/p1/prodAmazon/l1', {
      ...(m.fake.ler('produtos/p1/prodAmazon/l1') ?? {}),
      envioEstoqueAmazon: {
        via: 'patch',
        emMs: AGORA_MS,
        quantidade: 3,
        resultado: 'aceito',
        submissionId: 's1',
        feedId: null,
        problemas: [],
      },
    });

    await m.provedor.gravarResultado(await m.ctx(), {
      problemas: new Map([['SKU-ERRO', [erro]]]),
      emMs: AGORA_MS - HORA,
      feedId: FEED,
      relogio: m.fake.seed('relogio/desfecho', {}),
    });

    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))).toBeUndefined();
    expect(m.fake.ler('produtos/p1/prodAmazon/l1')?.envioEstoqueAmazon).toMatchObject({
      via: 'patch',
    });
  });
});

/* ======================================================================================= */

describe('★ recuperar: the recovery delta, and a failed feed’s OWN members', () => {
  /**
   * The world of a recovered feed with snapshot `S`: its member `M` (stamped
   * before the pending start `p`) committed before `S − 20 s`, `X` committed
   * after it (stamped after `S`), and `P` stamped after `p` (committed before
   * the margin).
   */
  function feedRecuperado() {
    const m = mundo();
    const s = commitAgora(m) + MARGEM_COMMIT_MS;
    const p = s - 2 * MIN;
    const linhaM = simples(m, 'SKU-M', { erp: 1, carimbo: s - 4 * MIN });
    const linhaP = simples(m, 'SKU-P', { erp: 1, carimbo: p + 1 });
    avancarUmMs(m);
    simples(m, 'SKU-X', { erp: 1, carimbo: s + 10_000 });
    m.relogio = AGORA_MS;
    // The failed window feed's own window: M and P's movement.
    const janela = {
      desdeMs: s - 5 * MIN,
      ateMs: s - MIN,
      manterDesdeMs: s - 5 * MIN,
      commitAposMs: null,
      forcarPorCommit: false,
      depositoId: DEP,
    };
    /** A SKU's observation: its row's commit, as a delta task names it. */
    const observacao = (linhaDe: string) => {
      const c = m.fake.carimboDe(linhaDe);
      if (c === undefined) throw new Error('fixture');
      return referenciaDaObservacao(c);
    };
    return { m, s, p, janela, refM: observacao(linhaM), refP: observacao(linhaP) };
  }

  it.each([
    ['concluido', 'a block batch', ', no request', false],
    ['falhou', 'a block batch', ' and ONE guarded request', true],
    ['abandonado', 'a block batch', ' and ONE guarded request', true],
    ['incerto', 'a block batch', ' and ONE guarded request', true],
  ] as const)(
    '★ %s, %s ⇒ the delta (X forced, named by the feed)%s',
    async (desfecho, _kind, _pedido, pede) => {
      const { m, s } = feedRecuperado();

      const r = await m.provedor.recuperar(await m.ctx(), {
        desfecho,
        snapshotEmMs: s,
        pendenteDesdeMs: null,
        referencia: FEED,
        janela: null,
      });

      expect(tarefasEstoque(m)).toEqual([['SKU-X', 'catch-up', FEED]]);
      if (pede) {
        expect(m.fake.ler(PEDIDO)).toMatchObject({ reexecucaoAutomaticaEmMs: AGORA_MS });
        expect(r).toEqual({ repassado: 'reconciliacao' });
      } else {
        expect(m.fake.ler(PEDIDO)).toBeUndefined();
        expect(r).toEqual({ tarefas: 1 });
      }
    },
  );

  it('★ a BLOCK batch’s cancelado ⇒ the guarded request and an UNFORCED delta over the pending start only (nothing of the feed applied)', async () => {
    const { m, s, p } = feedRecuperado();

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'cancelado',
      snapshotEmMs: s,
      pendenteDesdeMs: p,
      referencia: FEED,
      janela: null,
    });

    // P and X stamped after p, unforced (named by their observations); M never.
    expect(tarefasEstoque(m).map(([sku, origem]) => [sku, origem])).toEqual([
      ['SKU-P', 'delta'],
      ['SKU-X', 'delta'],
    ]);
    expect(m.fake.ler(PEDIDO)).toMatchObject({ reexecucaoAutomaticaEmMs: AGORA_MS });
    expect(r).toEqual({ repassado: 'reconciliacao' });
  });

  it.each(['falhou', 'cancelado', 'abandonado', 'incerto'] as const)(
    '★ a WINDOW batch’s %s ⇒ the delta PLUS its own window re-derived and handed to patches (each named by its observation, never forced), NO request',
    async (desfecho) => {
      const { m, s, janela, refM, refP } = feedRecuperado();

      const r = await m.provedor.recuperar(await m.ctx(), {
        desfecho,
        snapshotEmMs: s,
        pendenteDesdeMs: null,
        referencia: FEED,
        janela,
      });

      // The feed may have applied (every end but cancelado): X, committed after
      // its snapshot, is the delta's catch-up; M and P are the window's own.
      const proprios = [
        ['SKU-M', 'delta', refM],
        ['SKU-P', 'delta', refP],
      ];
      const esperado =
        desfecho === 'cancelado' ? proprios : [...proprios, ['SKU-X', 'catch-up', FEED]];
      expect(tarefasEstoque(m)).toEqual(esperado);
      expect(m.fake.ler(PEDIDO)).toBeUndefined();
      expect(r).toEqual({ tarefas: esperado.length });
    },
  );

  it('★ a WINDOW batch’s falhou whose own window’s re-derivation meets the recovery’s budget ⇒ the delta’s catch-up kept, then ONE guarded request and none of its own members (NEAR-MISS: inside the budget they go per SKU, above)', async () => {
    const { m, s, janela } = feedRecuperado();
    // The delta's one enqueue (X's catch-up) spends the whole budget.
    let primeira = true;
    m.aoEnfileirarEstoque = () => {
      if (!primeira) return;
      primeira = false;
      m.relogio += ORCAMENTO_RECUPERACAO_ESTOQUE_AMAZON_MS + 1;
    };

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'falhou',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela,
    });

    expect(tarefasEstoque(m)).toEqual([['SKU-X', 'catch-up', FEED]]);
    expect(r).toEqual({ repassado: 'reconciliacao' });
    expect(m.fake.ler(PEDIDO)).toMatchObject({ reexecucaoAutomaticaEmMs: m.relogio });
    expect(doTipo(m, 'reconciliacao')).toHaveLength(1);
  });

  it('★ NEAR-MISS: a SECOND window failure within 24 h still re-sends its own members (no request to be refused)', async () => {
    const { m, s, janela } = feedRecuperado();
    m.fake.seed(PEDIDO, {
      pendente: false,
      pedidoEmMs: AGORA_MS - HORA,
      reexecucaoAutomaticaEmMs: AGORA_MS - HORA,
    });

    await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'falhou',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela,
    });

    expect(tarefasEstoque(m).map(([sku]) => sku)).toEqual(
      expect.arrayContaining(['SKU-M', 'SKU-P']),
    );
    expect(m.fake.ler(PEDIDO)?.reexecucaoAutomaticaEmMs).toBe(AGORA_MS - HORA);
  });

  it('★ vez ⇒ the delta over (p, agora], nothing forced, NO request', async () => {
    const { m, p } = feedRecuperado();

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'vez',
      snapshotEmMs: null,
      pendenteDesdeMs: p,
      referencia: 'vez:exec-liberador',
      janela: null,
    });

    expect(tarefasEstoque(m).map(([sku, origem]) => [sku, origem])).toEqual([
      ['SKU-P', 'delta'],
      ['SKU-X', 'delta'],
    ]);
    expect(m.fake.ler(PEDIDO)).toBeUndefined();
    expect(r).toEqual({ tarefas: 2 });
  });

  it('★ a second AUTOMATIC request within 24 h ⇒ refused: nothing written on the request, feed-estoque-falhou raised', async () => {
    const { m, s } = feedRecuperado();
    const primeira = {
      desfecho: 'falhou',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    } as const;
    await m.provedor.recuperar(await m.ctx(), primeira);
    const pedido = m.fake.ler(PEDIDO);
    m.relogio += 23 * HORA;

    await m.provedor.recuperar(await m.ctx(), { ...primeira, referencia: '50009999999' });

    expect(m.fake.ler(PEDIDO)?.reexecucaoAutomaticaEmMs).toBe(pedido?.reexecucaoAutomaticaEmMs);
    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.feedEstoqueFalhou))).toMatchObject({
      resolvidoEm: null,
    });
  });

  it('★ a BLOCK failure whose delta ALSO truncates ⇒ still ONE request (the guarded one): never a second, refused one raising the feed aviso', async () => {
    const m = mundo();
    const s = commitAgora(m) + MARGEM_COMMIT_MS;
    avancarUmMs(m);
    for (let i = 0; i < 2_700; i += 1) linha(m, `T${String(i).padStart(5, '0')}`, 1, s - MIN);
    m.relogio = AGORA_MS;

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'falhou',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    expect(r).toEqual({ repassado: 'reconciliacao' });
    expect(m.fake.ler(PEDIDO)).toMatchObject({ reexecucaoAutomaticaEmMs: AGORA_MS });
    expect(m.fake.escritasEm(PEDIDO).length).toBeLessThanOrEqual(2);
    // NEAR-MISS: a second request in the same recovery would meet the 24-h guard.
    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.feedEstoqueFalhou))).toBeUndefined();
    expect(doTipo(m, 'reconciliacao')).toHaveLength(1);
  });

  it('★ a 12-h incerto recovery whose window TRUNCATES, after an automatic request earlier that day ⇒ NO request at all (NEAR-MISS: a recuperacao-origin hand-off would bypass the guard)', async () => {
    const m = mundo();
    const s = commitAgora(m) + MARGEM_COMMIT_MS;
    avancarUmMs(m);
    // 2,700 rows committed after the margin at ONE form: the window truncates.
    for (let i = 0; i < 2_700; i += 1) linha(m, `T${String(i).padStart(5, '0')}`, 1, s - MIN);
    m.relogio = AGORA_MS;
    m.fake.seed(PEDIDO, {
      pendente: false,
      pedidoEmMs: AGORA_MS - 2 * HORA,
      reexecucaoAutomaticaEmMs: AGORA_MS - 2 * HORA,
    });

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'incerto',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: 'exec-incerto',
      janela: {
        desdeMs: s - 10 * MIN,
        ateMs: s - 6 * MIN,
        manterDesdeMs: s - 10 * MIN,
        commitAposMs: null,
        forcarPorCommit: false,
        depositoId: DEP,
      },
    });

    expect(m.fake.ler(PEDIDO)).toMatchObject({
      pendente: false,
      pedidoEmMs: AGORA_MS - 2 * HORA,
      reexecucaoAutomaticaEmMs: AGORA_MS - 2 * HORA,
    });
    expect(doTipo(m, 'reconciliacao')).toEqual([]);
    expect(r).toEqual({ repassado: 'reconciliacao' });
  });

  it('★ the re-send set is EXACTLY the rows committed after S − 20 s among those stamped after S − 5 min, plus every SKU stamped after a folded start (unforced)', async () => {
    const { m, s, p } = feedRecuperado();
    // Committed after the margin but stamped BEFORE S − 5 min: outside the range.
    simples(m, 'SKU-FORA', { erp: 1, carimbo: s - 5 * MIN });

    await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: s,
      pendenteDesdeMs: p,
      referencia: FEED,
      janela: null,
    });

    // M (stamped before p, committed before the margin) and FORA (outside the range) never.
    expect(tarefasEstoque(m)).toEqual([
      ['SKU-P', 'delta', expect.any(String)],
      ['SKU-X', 'catch-up', FEED],
    ]);
  });

  it('★ chains END: a 40-SKU delta feed with no movement after its snapshot ⇒ nada, no second feed (NEAR-MISS: its 40 members stamped within S − 5 min would re-send under a stamp-only rule)', async () => {
    const m = mundo();
    const s = commitAgora(m) + MARGEM_COMMIT_MS;
    produto(m, 'K');
    for (let i = 0; i < 40; i += 1)
      vinculo(m, 'K', `l${String(i)}`, `K-${String(i).padStart(2, '0')}`);
    linha(m, 'K', 2, s - 2 * MIN);
    avancarUmMs(m);
    m.relogio = AGORA_MS;

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    expect(r).toEqual({ nada: true });
    expect(m.tarefasLote).toEqual([]);
    expect(m.tarefasEstoque).toEqual([]);
    // The NEAR-MISS, read off the rows: every member WAS stamped within the range.
    expect(s - 2 * MIN).toBeGreaterThan(s - 5 * MIN);
  });

  it('★ 35 rows committed in the 20 s before S1 ⇒ ONE window feed-enviar (recuperacao, commit filter, an hour’s wait), delayed so S2 ≥ S1 + 40 s, named by the RECOVERY; its own recovery is empty; a retried recovery meets ALREADY_EXISTS', async () => {
    const m = mundo();
    const s1 = commitAgora(m) + MARGEM_COMMIT_MS - 1;
    produto(m, 'K');
    for (let i = 0; i < 35; i += 1)
      vinculo(m, 'K', `l${String(i)}`, `K-${String(i).padStart(2, '0')}`);
    linha(m, 'K', 2, s1 - MIN);
    // The recovery runs 10 s after the snapshot (by our clock).
    m.relogio = s1 + 10_000;

    const entrada = {
      desfecho: 'concluido',
      snapshotEmMs: s1,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    } as const;
    const r = await m.provedor.recuperar(await m.ctx(), entrada);

    const execucaoId = execucaoIdDaRecuperacaoFeed(CONTA, FEED, null);
    expect(r).toEqual({ feed: execucaoId });
    const [envio] = doTipo(m, 'feed-enviar');
    expect(doTipo(m, 'feed-enviar')).toHaveLength(1);
    expect(envio?.id).toBe(nomeEnvioFeed(CONTA, execucaoId));
    // The producer label, spelled out: a recovery's batch, never the tick's `delta`.
    expect(ORIGEM_LOTE_RECUPERACAO_ESTOQUE_AMAZON).toBe('recuperacao');
    expect(envio?.tarefa).toMatchObject({
      origem: 'recuperacao',
      execucaoId,
      lote: {
        tipo: 'janela',
        commitAposMs: s1 - MARGEM_COMMIT_MS,
        // A snapshot: the window FORCES, so it waits (an hour) behind a held lease.
        forcarPorCommit: true,
        esperaAteMs: s1 + 10_000 + HORA,
        depositoId: DEP,
      },
    });
    // Its dispatch (and so its snapshot S2) is at least S1 + 40 s.
    expect(m.relogio + (envio?.atrasoS ?? 0) * 1000).toBeGreaterThanOrEqual(
      s1 + ESPACO_ENTRE_SNAPSHOTS_MS,
    );
    expect(m.tarefasEstoque).toEqual([]);

    // A retried recovery (a later clock) mints the SAME batch: Cloud Tasks holds it.
    m.relogio += 30_000;
    expect(await m.provedor.recuperar(await m.ctx(), entrada)).toEqual({ feed: execucaoId });
    expect(doTipo(m, 'feed-enviar')).toHaveLength(1);

    // The next link: F2's snapshot is at least S1 + 40 s, and nothing committed after it.
    m.relogio = s1 + ESPACO_ENTRE_SNAPSHOTS_MS + 60_000;
    expect(
      await m.provedor.recuperar(await m.ctx(), {
        ...entrada,
        snapshotEmMs: s1 + ESPACO_ENTRE_SNAPSHOTS_MS,
        referencia: '50002222222',
      }),
    ).toEqual({ nada: true });
  });

  it('★ a recovery’s FORCING window end to end: the hand-off carries forcarPorCommit true and its hour’s wait, and the send re-derives it with that flag — all 35 late-committed SKUs sent though Amazon already shows their ERP value (the paired NEAR-MISS is the tick’s LATE COMMIT end-to-end case, below: its non-forcing batch leaves the equal one out)', async () => {
    const m = mundo();
    const s1 = commitAgora(m) + MARGEM_COMMIT_MS - 1;
    produto(m, 'K');
    const skus = Array.from({ length: 35 }, (_v, i) => `K-${String(i).padStart(2, '0')}`);
    for (const [i, sku] of skus.entries()) {
      vinculo(m, 'K', `l${String(i)}`, sku);
      m.amazon.set(sku, listing(sku, 2));
    }
    // Committed after S1 − 20 s, and Amazon already shows the ERP's 2.
    linha(m, 'K', 2, s1 - MIN);
    m.relogio = s1 + 10_000;

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: s1,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    expect(r).toEqual({ feed: execucaoIdDaRecuperacaoFeed(CONTA, FEED, null) });
    const [envio] = doTipo(m, 'feed-enviar');
    if (envio?.tarefa.tipo !== 'feed-enviar') throw new Error('sem feed-enviar');
    expect(loteJanelaFeedAmazonSchema.parse(envio.tarefa.lote)).toMatchObject({
      manterDesdeMs: null,
      commitAposMs: s1 - MARGEM_COMMIT_MS,
      forcarPorCommit: true,
      esperaAteMs: s1 + 10_000 + HORA,
    });

    m.relogio = s1 + ESPACO_ENTRE_SNAPSHOTS_MS + 1_000;
    const enviado = await m.despachar(envio.tarefa);

    expect(enviado).toMatchObject({ tipo: 'feed-enviar', r: { acao: 'enviado', feedId: FEED } });
    expect(m.documentos[0]?.messages.map((x) => x.sku)).toEqual(skus);
    expect(m.fake.ler(VEZ)?.janela).toMatchObject({ forcarPorCommit: true });
  });

  it.each([
    [false, null],
    [true, HORA],
  ] as const)(
    '★ the recovery hand-off’s wait is keyed on forcarPorCommit, never on the commit filter: a commit-filtered window forcing %s ⇒ esperaAteMs %s after now',
    async (forcar, espera) => {
      const m = mundo();
      const s1 = commitAgora(m) + MARGEM_COMMIT_MS - 1;
      produto(m, 'K');
      for (let i = 0; i < 35; i += 1)
        vinculo(m, 'K', `l${String(i)}`, `K-${String(i).padStart(2, '0')}`);
      linha(m, 'K', 2, s1 - MIN);
      m.relogio = s1 + 10_000;
      // The recovery's planner hands over a commit-filtered window, forcing or not.
      vi.mocked(descoberta.janelaDaRecuperacao).mockImplementationOnce(({ agoraMs }) => ({
        desdeMs: s1 - 5 * MIN,
        ateMs: agoraMs,
        manterDesdeMs: null,
        commitAposMs: s1 - MARGEM_COMMIT_MS,
        forcarPorCommit: forcar,
      }));

      await m.provedor.recuperar(await m.ctx(), {
        desfecho: 'concluido',
        snapshotEmMs: s1,
        pendenteDesdeMs: null,
        referencia: FEED,
        janela: null,
      });

      const [envio] = doTipo(m, 'feed-enviar');
      expect(envio?.tarefa).toMatchObject({
        lote: {
          commitAposMs: s1 - MARGEM_COMMIT_MS,
          forcarPorCommit: forcar,
          esperaAteMs: espera === null ? null : s1 + 10_000 + espera,
        },
      });
    },
  );

  it('★ a row committed WHILE membros re-derived the window is forced by the recovery from membros’ snapshot (NEAR-MISS: a snapshot taken after the mapping leaves it to the daily run)', async () => {
    const m = mundo();
    const desde = AGORA_MS - 10 * MIN;
    simples(m, 'SKU-A', { erp: 1, carimbo: desde + 1 });
    // Our clock at membros = the fake's commit clock, so the two compare.
    m.relogio = commitAgora(m);
    let semeado = '';
    m.aoConsultar = (colecao) => {
      // After the canonical form's query read: X commits mid-derivation, at that form.
      if (colecao === 'estoques' && semeado === '' && consultasDaJanela(m).length === 1) {
        semeado = simples(m, 'SKU-X', { erp: 1, carimbo: desde + 2 });
      }
      if (colecao === 'estoques') m.relogio += 30_000;
    };
    const membros = dadosDe(await m.provedor.membros(await m.ctx(), janelaDoTick(desde, AGORA_MS)));
    expect(membros.skus).toEqual(['SKU-A']);
    const s = (membros.dados as Extract<DadosLoteEstoqueAmazon, { tipo: 'janela' }>).snapshotEmMs;
    const tardio = m.relogio;
    m.aoConsultar = null;
    const commitX = m.fake.carimboDe(semeado)?.toMillis() ?? 0;
    expect(commitX).toBeGreaterThan(s - MARGEM_COMMIT_MS);
    // NEAR-MISS: the snapshot after the mapping is past X's commit plus the margin.
    expect(commitX).toBeLessThanOrEqual(tardio - MARGEM_COMMIT_MS);
    m.relogio = AGORA_MS;

    await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    // X is forced (A too: it committed inside the 20-s margin, which no fake clock separates).
    expect(tarefasEstoque(m)).toEqual(expect.arrayContaining([['SKU-X', 'catch-up', FEED]]));
  });

  it('a window the planner refuses (a snapshot a day ahead) ⇒ the ONE request: the catch-up could not be planned', async () => {
    const m = mundo();

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: AGORA_MS * 1000,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    expect(r).toEqual({ repassado: 'reconciliacao' });
    expect(m.fake.ler(PEDIDO)).toMatchObject({ pedidoEmMs: AGORA_MS });
    expect(m.fake.ler(PEDIDO)?.reexecucaoAutomaticaEmMs ?? null).toBeNull();
  });

  it('★ a vez recovery’s 35-SKU window has NO commit filter ⇒ ONE feed-enviar with NO wait bound and no delay (NEAR-MISS: an hour’s wait set anyway)', async () => {
    const m = mundo();
    const p = AGORA_MS - 2 * MIN;
    produto(m, 'K');
    for (let i = 0; i < 35; i += 1)
      vinculo(m, 'K', `l${String(i)}`, `K-${String(i).padStart(2, '0')}`);
    linha(m, 'K', 2, p + 1);
    m.relogio = AGORA_MS;

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'vez',
      snapshotEmMs: null,
      pendenteDesdeMs: p,
      referencia: 'vez:exec-liberador',
      janela: null,
    });

    const execucaoId = execucaoIdDaRecuperacaoFeed(CONTA, 'vez:exec-liberador', p);
    expect(r).toEqual({ feed: execucaoId });
    expect(doTipo(m, 'feed-enviar')).toHaveLength(1);
    const [envio] = doTipo(m, 'feed-enviar');
    expect(envio?.atrasoS).toBe(0);
    expect(envio?.tarefa).toMatchObject({
      origem: 'recuperacao',
      lote: {
        tipo: 'janela',
        commitAposMs: null,
        forcarPorCommit: false,
        esperaAteMs: null,
        depositoId: DEP,
      },
    });
  });

  it('a conta whose depósito the stock documents cannot store ⇒ NO recovery delta at all (NEAR-MISS: the plain parse would read a window there)', async () => {
    const m = mundo();
    const ruim = 'dep.ponto';
    const refRuim = `documents/depositos/${ruim}`;
    m.fake.seed(caminhoConta(CONTA), {
      ...m.fake.ler(caminhoConta(CONTA)),
      depositoOuterRef: refRuim,
    });
    const s = commitAgora(m) + MARGEM_COMMIT_MS;
    avancarUmMs(m);
    const id = idDe('SKU-R');
    produto(m, id);
    vinculo(m, id, 'l1', 'SKU-R');
    m.fake.seed(`produtos/${id}/estoques/${makeEstoqueUid(id, ruim)}`, {
      depositoOuterRef: refRuim,
      parentId: id,
      quantidade: 1,
      quantidadeReservada: 0,
      ultimaModificacao: s + 10_000,
    });
    m.relogio = AGORA_MS;

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    expect(r).toEqual({ nada: true });
    expect(consultasDaJanela(m)).toEqual([]);
    expect(tarefasEstoque(m)).toEqual([]);
  });
});

/* ======================================================================================= */

describe('★ the turned-away RECOVERY-born batch, handed to patches past its wait', () => {
  it('its FORCED SKU goes as a catch-up named by the batch’s execucaoId (stable across retries); the others by their observations', async () => {
    const m = mundo();
    const desde = AGORA_MS - 10 * MIN;
    simples(m, 'SKU-ANTES', { erp: 1, carimbo: desde + 1 });
    const filtro = commitAgora(m);
    avancarUmMs(m);
    const caminhoX = simples(m, 'SKU-X', { erp: 1, carimbo: desde + 2 });
    const t = janelaDaRecuperacao(desde, AGORA_MS, filtro, 'exec-rec-r');
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, t));

    expect(await m.provedor.repassarParaPatches(ctx, t, membros.skus, membros.dados)).toEqual({
      tarefas: 2,
    });

    const commitX = m.fake.carimboDe(caminhoX);
    if (commitX === undefined) throw new Error('fixture');
    expect(tarefasEstoque(m)).toEqual([
      ['SKU-ANTES', 'delta', expect.any(String)],
      ['SKU-X', 'catch-up', 'exec-rec-r'],
    ]);
    expect(m.tarefasEstoque.find((x) => x.tarefa.sku === 'SKU-X')?.tarefa.referencia).not.toBe(
      referenciaDaObservacao(commitX),
    );
  });
});

/* ======================================================================================= */

describe('★ end to end: the REAL send, result and recovery handlers, a scripted Amazon', () => {
  it('a 31-SKU delta feed: the dispatch re-derives exactly those 31 (a 32nd re-stamped past ateMs is absent), reads them in 2 searches, posts ONE document of the differing ones; DONE with per-SKU errors ⇒ recusado + its aviso raised once, the feed aviso resolved; its recovery finds nothing', async () => {
    const m = mundo();
    const desde = AGORA_MS - 10 * MIN;
    const ate = AGORA_MS - 5 * MIN;
    const skus = Array.from({ length: 31 }, (_v, i) => `SKU-D-${String(i).padStart(2, '0')}`);
    for (const [i, sku] of skus.entries()) {
      // Ten already match Amazon: counted, never sent.
      simples(m, sku, { erp: 5, amazon: i < 10 ? 5 : 1, carimbo: desde + 1 + i });
    }
    simples(m, 'SKU-D-TARDE', { erp: 9, amazon: 1, carimbo: ate + 1 });
    // An earlier failure's aviso, clocked before this feed: its DONE resolves it.
    await sincronizarAvisoContaEstoqueAmazon(
      m.db,
      { increment, nowMs: m.relogio, logger: m.log.logger },
      {
        integracaoId: CONTA,
        motivo: MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
        acao: ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
        relogio: m.fake.seed('relogio/falha-antiga', {}),
      },
    );

    const envio = await m.despachar(janelaDoTick(desde, ate));

    expect(envio).toMatchObject({ tipo: 'feed-enviar', r: { acao: 'enviado', feedId: FEED } });
    expect(buscas(m)).toHaveLength(2);
    expect(buscas(m).flatMap((b) => b.skus)).toEqual(skus);
    expect(m.feedChamadas).toEqual(['POST documento', 'PUT upload', 'POST feed']);
    expect(m.documentos[0]?.messages.map((x) => x.sku)).toEqual(skus.slice(10));
    expect(m.tarefasEstoque).toEqual([]);

    // The poll rung 0, as the queue would dispatch it: DONE, two SKUs refused.
    m.rotas.relatorio = {
      header: { sellerId: SPID_A, version: '2.0', feedId: FEED },
      issues: [
        { messageId: 1, sku: 'SKU-D-10', code: '90220', severity: 'ERROR', message: 'x' },
        { messageId: 2, sku: 'SKU-D-11', code: '90220', severity: 'ERROR', message: 'x' },
      ],
      summary: {
        errors: 2,
        warnings: 0,
        messagesProcessed: 21,
        messagesAccepted: 19,
        messagesInvalid: 2,
      },
    };
    const [rung0] = doTipo(m, 'feed-resultado');
    if (rung0 === undefined) throw new Error('sem rung 0');
    m.relogio += 2 * MIN;
    const resultado = await m.despachar(rung0.tarefa);

    expect(resultado).toMatchObject({ tipo: 'feed-resultado', r: { desfecho: 'concluido' } });
    expect(
      m.fake.ler(`produtos/${idDe('SKU-D-10')}/prodAmazon/l1`)?.envioEstoqueAmazon,
    ).toMatchObject({
      via: 'feed',
      resultado: 'recusado',
      quantidade: null,
      feedId: FEED,
    });
    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))).toMatchObject({
      resolvidoEm: null,
    });
    expect(m.fake.escritasEm(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))).toHaveLength(1);
    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.feedEstoqueFalhou))?.resolvidoEm).not.toBeNull();
    expect(m.fake.ler(`feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`)).toMatchObject({
      status: 'concluido',
    });

    // The tail's recovery: nothing committed after the snapshot − 20 s ⇒ nada.
    const [recuperacao] = doTipo(m, 'feed-recuperar');
    if (recuperacao === undefined) throw new Error('sem recuperação');
    const rec = await m.despachar(recuperacao.tarefa);
    expect(rec).toMatchObject({ tipo: 'feed-recuperar', r: { resposta: 'nada' } });
    expect(m.tarefasEstoque).toEqual([]);
    expect(doTipo(m, 'feed-enviar')).toEqual([]);
  });

  it('★ the TICK’s delta feed end to end: 32 moved SKUs ⇒ the REAL tick enqueues ONE feed-enviar with the window and zero patch tasks; the 32nd re-stamped past ateMs before the dispatch is absent from it; the dispatch re-derives exactly the other 31, reads them in 2 searches, posts ONE document of the differing ones; the 32nd is in the next tick’s window', async () => {
    const m = mundo();
    const SYNC = `sincronizacaoEstoqueAmazon/${CONTA}`;
    m.fake.seed(SYNC, {
      cursorMs: AGORA_MS - 5 * MIN,
      depositoDoCursor: CANONICA,
      vez: null,
      ultimoTickMs: null,
      falhasSeguidas: 0,
      semDeposito: false,
    });
    const skus = Array.from({ length: 32 }, (_v, i) => `SKU-T-${String(i).padStart(2, '0')}`);
    for (const [i, sku] of skus.entries()) {
      // Ten already match Amazon: re-derived, read, counted — never in the document.
      simples(m, sku, { erp: 5, amazon: i < 10 ? 5 : 1, carimbo: AGORA_MS - 2 * MIN + i });
    }
    let execucoes = 0;
    const depsDoTick = (): DepsTickEstoqueAmazon => ({
      db: m.db,
      ambiente: m.ambiente,
      contas: LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
      produtor: m.raiz.produtorEstoque,
      agendador: m.raiz.agendadorLotes,
      agora: m.agora,
      logger: m.log.logger,
      increment,
      gerarExecucaoId: () => {
        execucoes += 1;
        return `tick-${String(execucoes)}`;
      },
    });

    // The tick: 32 SKUs ⇒ the delta feed, the window and never its SKUs.
    const tick = await executarTickEstoqueAmazon(depsDoTick());
    expect(tick.contas[0]).toMatchObject({
      desfecho: 'repassado',
      repasse: 'feed-necessario',
      entrega: 'enfileirada',
      skus: 32,
      tarefas: 0,
      cursorAvancou: true,
    });
    const envios = doTipo(m, 'feed-enviar');
    // The tick's window whole: the range from the cursor (AGORA − 5 min) less
    // 5 minutes, the stamp rule and the commit filter at the cursor less 20 s,
    // never forcing, no wait.
    const execucaoId = execucaoIdDaJanelaFeed(CONTA, AGORA_MS - 10 * MIN, AGORA_MS);
    expect(envios).toEqual([
      {
        tarefa: {
          v: 1,
          tipo: 'feed-enviar',
          fluxo: 'estoque',
          contaId: CONTA,
          execucaoId,
          origem: 'delta',
          lote: {
            tipo: 'janela',
            desdeMs: AGORA_MS - 10 * MIN,
            ateMs: AGORA_MS,
            manterDesdeMs: AGORA_MS - 5 * MIN - 20_000,
            commitAposMs: AGORA_MS - 5 * MIN - 20_000,
            forcarPorCommit: false,
            esperaAteMs: null,
            depositoId: DEP,
          },
        },
        id: nomeEnvioFeed(CONTA, execucaoId),
        atrasoS: 0,
      },
    ]);
    expect(m.tarefasEstoque).toEqual([]);

    // Before the dispatch, the 32nd SKU's row is stamped again, past the window's end.
    const ultimo = skus[31] as string;
    linha(m, idDe(ultimo), 4, AGORA_MS + MIN);
    m.relogio += 2 * MIN;
    const envio = await m.despachar(envios[0]?.tarefa as TarefaLoteAmazon);

    expect(envio).toMatchObject({ tipo: 'feed-enviar', r: { acao: 'enviado', feedId: FEED } });
    expect(buscas(m)).toHaveLength(2);
    expect(buscas(m).flatMap((b) => b.skus)).toEqual(skus.slice(0, 31));
    expect(m.feedChamadas).toEqual(['POST documento', 'PUT upload', 'POST feed']);
    expect(m.documentos).toHaveLength(1);
    expect(m.documentos[0]?.messages.map((x) => x.sku)).toEqual(skus.slice(10, 31));
    expect(m.tarefasEstoque).toEqual([]);

    // The next tick: the re-stamped row is in ITS window, a one-SKU batch.
    m.relogio = AGORA_MS + 5 * MIN;
    const proximo = await executarTickEstoqueAmazon(depsDoTick());
    expect(proximo.contas[0]).toMatchObject({ desfecho: 'enfileirado', skus: 1, tarefas: 1 });
    expect(m.tarefasEstoque.map((x) => [x.tarefa.sku, x.tarefa.origem])).toEqual([
      [ultimo, 'delta'],
    ]);
    expect(doTipo(m, 'feed-enviar')).toHaveLength(1);
  });

  /**
   * The tick's LATE COMMIT carried end to end: a conta whose cursor is
   * `cursorMs`, two SKUs whose rows are stamped `cursor − 30 s` and COMMIT in
   * the fake's next millisecond (SKU-L-IGUAL, which Amazon already shows at its
   * ERP value, and SKU-L-DIFERE), seeded FIRST, then 31 SKUs stamped after the
   * cursor (kept by stamp, each differing from Amazon). The clock is one tick
   * interval after the cursor. Returns the world, the tick and its one
   * `feed-enviar`.
   */
  async function tickComCommitTardio(posicaoDoCommit: (proximoCommitMs: number) => number) {
    const m = mundo();
    const cursorMs = posicaoDoCommit(commitAgora(m));
    const tardios = ['SKU-L-DIFERE', 'SKU-L-IGUAL'];
    const caminhos = tardios.map((sku) =>
      simples(m, sku, {
        erp: 5,
        amazon: sku === 'SKU-L-IGUAL' ? 5 : 1,
        carimbo: cursorMs - 30_000,
      }),
    );
    const outros = Array.from({ length: 31 }, (_v, i) => `SKU-S-${String(i).padStart(2, '0')}`);
    for (const [i, sku] of outros.entries()) {
      simples(m, sku, { erp: 5, amazon: 1, carimbo: cursorMs + MIN + i });
    }
    m.fake.seed(`sincronizacaoEstoqueAmazon/${CONTA}`, {
      cursorMs,
      depositoDoCursor: CANONICA,
      vez: null,
      ultimoTickMs: null,
      falhasSeguidas: 0,
      semDeposito: false,
    });
    m.relogio = cursorMs + 5 * MIN;
    const agoraMs = m.relogio;
    const tick = await executarTickEstoqueAmazon({
      db: m.db,
      ambiente: m.ambiente,
      contas: LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
      produtor: m.raiz.produtorEstoque,
      agendador: m.raiz.agendadorLotes,
      agora: m.agora,
      logger: m.log.logger,
      increment,
      gerarExecucaoId: () => 'tick-commit-tardio',
    });
    const envios = doTipo(m, 'feed-enviar');
    expect(envios).toHaveLength(1);
    const [envio] = envios;
    if (envio?.tarefa.tipo !== 'feed-enviar') throw new Error('sem feed-enviar');
    const commits = caminhos.map((c) => m.fake.carimboDe(c)?.toMillis() ?? Number.NaN);
    return { m, cursorMs, agoraMs, tick, envio: envio.tarefa, commits, outros };
  }

  it('★ the tick’s LATE COMMIT end to end: janelaDoTick’s window, carried WHOLE through the real hand-off and parsed by the batch schema, is re-derived by the send with ITS keep rule — a row stamped cursor − 30 s and committed after the cursor is a member and NOT forced (sent only when Amazon’s live read differs)', async () => {
    const { m, cursorMs, agoraMs, tick, envio, commits, outros } = await tickComCommitTardio(
      (proximo) => proximo - 1_000,
    );
    // Both late rows committed AFTER the cursor (the previous tick's query could not see them).
    for (const c of commits) expect(c).toBeGreaterThan(cursorMs);
    expect(tick.contas[0]).toMatchObject({
      desfecho: 'repassado',
      repasse: 'feed-necessario',
      entrega: 'enfileirada',
      skus: 33,
      tarefas: 0,
    });

    // The payload IS the planner's window: bounds and keep rule, field for field.
    const planejada = planejarJanelaDoTick({ cursorMs, agoraMs });
    if (planejada === null) throw new Error('sem janela');
    expect(planejada).toMatchObject({
      desdeMs: cursorMs - 5 * MIN,
      manterDesdeMs: cursorMs - 20_000,
      commitAposMs: cursorMs - 20_000,
      forcarPorCommit: false,
    });
    const lote = loteJanelaFeedAmazonSchema.parse(envio.lote);
    expect(lote).toEqual({
      tipo: 'janela',
      desdeMs: planejada.desdeMs,
      ateMs: planejada.ateMs,
      manterDesdeMs: planejada.manterDesdeMs,
      commitAposMs: planejada.commitAposMs,
      forcarPorCommit: planejada.forcarPorCommit,
      esperaAteMs: null,
      depositoId: DEP,
    });
    expect(envio.execucaoId).toBe(execucaoIdDaJanelaFeed(CONTA, planejada.desdeMs, agoraMs));

    // The send, a minute later: the late rows are members (read live), the
    // equal one is NOT forced into the document, the differing one is sent.
    m.relogio += MIN;
    const r = await m.despachar(envio);
    expect(r).toMatchObject({ tipo: 'feed-enviar', r: { acao: 'enviado', feedId: FEED } });
    const lidos = buscas(m).flatMap((b) => b.skus);
    expect(lidos).toEqual(expect.arrayContaining(['SKU-L-DIFERE', 'SKU-L-IGUAL']));
    expect(lidos).toHaveLength(33);
    expect(m.documentos).toHaveLength(1);
    expect(m.documentos[0]?.messages.map((x) => x.sku)).toEqual(['SKU-L-DIFERE', ...outros]);
    expect(m.tarefasEstoque).toEqual([]);
    // The lease the send wrote kept the window whole: the flag included, still false.
    expect(m.fake.ler(VEZ)?.janela).toEqual({
      desdeMs: planejada.desdeMs,
      ateMs: planejada.ateMs,
      manterDesdeMs: planejada.manterDesdeMs,
      commitAposMs: planejada.commitAposMs,
      forcarPorCommit: false,
      depositoId: DEP,
    });
  });

  it('★ NEAR-MISS: the same rows committed BEFORE cursor − 20 s (the previous tick read them) ⇒ the tick hands off 31 SKUs, and the send re-derives neither late row', async () => {
    const { m, cursorMs, tick, envio, commits, outros } = await tickComCommitTardio(
      (proximo) => proximo + 21_000,
    );
    for (const c of commits) expect(c).toBeLessThan(cursorMs - 20_000);
    expect(tick.contas[0]).toMatchObject({
      desfecho: 'repassado',
      repasse: 'feed-necessario',
      skus: 31,
    });

    m.relogio += MIN;
    expect(await m.despachar(envio)).toMatchObject({ r: { acao: 'enviado' } });
    const lidos = buscas(m).flatMap((b) => b.skus);
    expect(lidos).toEqual(outros);
    expect(m.documentos[0]?.messages.map((x) => x.sku)).toEqual(outros);
  });

  it('★ a block feed whose conta changed depósito between the decide and the send ⇒ abortado deposito-mudou, NOTHING posted, estoque-deposito-sem-linhas raised', async () => {
    const m = mundo();
    produto(m, 'u-a');
    linha(m, 'u-a', 9, 1);
    await gravarBlocoDivergenciaEstoqueAmazon(m.db, {
      contaId: CONTA,
      execucaoId: 'run-x',
      pagina: 0,
      depositoId: DEP,
      itens: [{ sku: 'SKU-A', unidadeId: 'u-a', quantidadeAmazon: 1, quantidadeErp: 9 }],
      agoraMs: m.relogio,
    });
    m.fake.seed(caminhoConta(CONTA), {
      ...(m.fake.ler(caminhoConta(CONTA)) ?? {}),
      depositoOuterRef: `documents/depositos/${OUTRO_DEP}`,
    });

    const r = await m.despachar(blocos(1));

    expect(r).toMatchObject({
      tipo: 'feed-enviar',
      r: { acao: 'liberado', motivo: 'deposito-mudou' },
    });
    expect(m.feedChamadas).toEqual([]);
    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas))).toMatchObject({
      resolvidoEm: null,
    });
    expect(m.fake.ler(VEZ)).toMatchObject({ estado: 'livre' });
  });

  it('★ a block feed under the dry-run valve: the stock provider builds the WHOLE document, ONE dry-run line, NOTHING posted (NEAR-MISS: under on + * the same block is posted)', async () => {
    const comBloco = async () => {
      const m = mundo();
      produto(m, 'u-a');
      linha(m, 'u-a', 9, 1);
      await gravarBlocoDivergenciaEstoqueAmazon(m.db, {
        contaId: CONTA,
        execucaoId: 'run-x',
        pagina: 0,
        depositoId: DEP,
        itens: [{ sku: 'SKU-A', unidadeId: 'u-a', quantidadeAmazon: 1, quantidadeErp: 9 }],
        agoraMs: m.relogio,
      });
      return m;
    };
    const m = await comBloco();
    m.ambiente[VALVULA_ENV_AMAZON.estoque] = 'dry-run';

    const r = await m.despachar(blocos(1));

    expect(r).toMatchObject({
      tipo: 'feed-enviar',
      r: { acao: 'liberado', motivo: 'simulado', mensagens: 1 },
    });
    expect(m.feedChamadas).toEqual([]);
    expect(m.documentos).toEqual([]);
    expect(
      m.log.linhas.filter((l) => l.meta?.evento === 'estoque' && l.meta.fase === 'feed'),
    ).toHaveLength(1);
    expect(m.fake.ler(VEZ)).toMatchObject({ estado: 'livre' });

    // NEAR-MISS: the same block under on + `*` is posted, its one message the ERP's 9.
    const ligado = await comBloco();
    await ligado.despachar(blocos(1));
    expect(ligado.feedChamadas).toEqual(['POST documento', 'PUT upload', 'POST feed']);
    expect(ligado.documentos.map((d) => d.messages.map((x) => x.sku))).toEqual([['SKU-A']]);
  });

  it('★ the turned-away MERGE: a 31-SKU tick batch dispatched while a reconcile feed holds the lease is RECORDED; that feed’s DONE ⇒ ONE recovery covering both its catch-up and the recorded window, ONE feed-enviar, NO reconcile request', async () => {
    const m = mundo();
    // The reconcile's block feed: one drift SKU, sent and holding the lease.
    produto(m, 'u-b');
    linha(m, 'u-b', 9, 1);
    await gravarBlocoDivergenciaEstoqueAmazon(m.db, {
      contaId: CONTA,
      execucaoId: 'run-x',
      pagina: 0,
      depositoId: DEP,
      itens: [{ sku: 'SKU-B', unidadeId: 'u-b', quantidadeAmazon: 1, quantidadeErp: 9 }],
      agoraMs: m.relogio,
    });
    expect(await m.despachar(blocos(1))).toMatchObject({ r: { acao: 'enviado', feedId: FEED } });
    const snapshot = m.fake.ler(VEZ)?.snapshotEmMs as number;

    // A busy tick's 31 SKUs, one minute later: turned away, its start recorded.
    m.relogio += MIN;
    const desde = AGORA_MS - 10 * MIN;
    const skus = Array.from({ length: 31 }, (_v, i) => `SKU-T-${String(i).padStart(2, '0')}`);
    for (const [i, sku] of skus.entries()) simples(m, sku, { erp: 3, carimbo: desde + 1 + i });
    const tick = janelaDoTick(desde, AGORA_MS - 2 * MIN);
    expect(await m.despachar({ ...tick, execucaoId: 'exec-tick-1' })).toMatchObject({
      r: { acao: 'pendente-registrado' },
    });
    expect(m.fake.ler(VEZ)).toMatchObject({ pendenteDesdeMs: desde });

    // The reconcile feed's DONE: its tail folds the start into its ONE recovery.
    const [rung0] = doTipo(m, 'feed-resultado');
    if (rung0 === undefined) throw new Error('sem rung 0');
    m.relogio += 2 * MIN;
    await m.despachar(rung0.tarefa);
    const recuperacoes = doTipo(m, 'feed-recuperar');
    expect(recuperacoes).toHaveLength(1);
    expect(recuperacoes[0]?.tarefa).toMatchObject({
      desfecho: 'concluido',
      snapshotEmMs: snapshot,
      pendenteDesdeMs: desde,
    });

    const rec = await m.despachar(recuperacoes[0]?.tarefa as TarefaLoteAmazon);

    const execucaoId = execucaoIdDaRecuperacaoFeed(CONTA, FEED, desde);
    expect(rec).toMatchObject({ r: { resposta: 'feed', envio: execucaoId } });
    const envios = doTipo(m, 'feed-enviar');
    expect(envios).toHaveLength(1);
    expect(envios[0]?.tarefa).toMatchObject({
      origem: ORIGEM_LOTE_RECUPERACAO_ESTOQUE_AMAZON,
      lote: {
        tipo: 'janela',
        manterDesdeMs: desde,
        commitAposMs: snapshot - MARGEM_COMMIT_MS,
        forcarPorCommit: true,
      },
    });
    // NEAR-MISS: the turned-away batch never became a reconcile request.
    expect(m.fake.ler(PEDIDO)).toBeUndefined();
    expect(m.tarefasEstoque).toEqual([]);
  });
});

/* ======================================================================================= */

describe('★ the recovery under the stock valve: off reads nothing, a canary list sends no feed', () => {
  it('the valve OFF ⇒ a recovery reads and writes NOTHING — no delta, no request, no task (NEAR-MISS: on, the same recovery forces its catch-up, above)', async () => {
    const m = mundo();
    const s = commitAgora(m) + MARGEM_COMMIT_MS;
    avancarUmMs(m);
    simples(m, 'SKU-X', { erp: 1, carimbo: s + 10_000 });
    m.relogio = AGORA_MS;
    m.ambiente[VALVULA_ENV_AMAZON.estoque] = undefined;
    const ctx = await m.ctx();
    const antes = m.fake.operacoes;

    const r = await m.provedor.recuperar(ctx, {
      desfecho: 'falhou',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    expect(r).toEqual({ nada: true });
    expect(m.fake.operacoes).toBe(antes);
    expect(m.tarefasEstoque).toEqual([]);
    expect(m.tarefasLote).toEqual([]);
    expect(m.fake.ler(PEDIDO)).toBeUndefined();
  });

  it('★ a canary LIST ⇒ the recovery’s 35-SKU window goes as the canary’s SKUs per SKU (forced ⇒ a catch-up of the recovered feed), NO feed-enviar (NEAR-MISS: under * it is ONE feed-enviar, above)', async () => {
    const m = mundo();
    const s1 = commitAgora(m) + MARGEM_COMMIT_MS - 1;
    produto(m, 'K');
    for (let i = 0; i < 35; i += 1)
      vinculo(m, 'K', `l${String(i)}`, `K-${String(i).padStart(2, '0')}`);
    linha(m, 'K', 2, s1 - MIN);
    m.relogio = s1 + 10_000;
    m.ambiente[CANARIO_ENV_AMAZON.estoque] = `${CONTA}:K-03,${CONTA}:K-17`;

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: s1,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    expect(doTipo(m, 'feed-enviar')).toEqual([]);
    expect(tarefasEstoque(m)).toEqual([
      ['K-03', 'catch-up', FEED],
      ['K-17', 'catch-up', FEED],
    ]);
    expect(r).toEqual({ tarefas: 2 });
    // The delta's own line names the form the hand-off took: patches, never a feed.
    expect(m.log.linhas.map((l) => l.meta)).toContainEqual(
      expect.objectContaining({ fase: 'recuperacao', entrega: 'so-patches' }),
    );
  });

  it('a canary LIST whose patches the recovery’s budget left UNSTARTED ⇒ the started ones kept, then the ONE reconcile request', async () => {
    const m = mundo();
    const s1 = commitAgora(m) + MARGEM_COMMIT_MS - 1;
    produto(m, 'K');
    const skus = Array.from({ length: 35 }, (_v, i) => `K-${String(i).padStart(2, '0')}`);
    for (const [i, sku] of skus.entries()) vinculo(m, 'K', `l${String(i)}`, sku);
    linha(m, 'K', 2, s1 - MIN);
    m.relogio = s1 + 10_000;
    // Twenty canary SKUs: more than one round of the producer's sixteen in flight.
    m.ambiente[CANARIO_ENV_AMAZON.estoque] = skus
      .slice(0, 20)
      .map((sku) => `${CONTA}:${sku}`)
      .join(',');
    let primeira = true;
    m.aoEnfileirarEstoque = () => {
      if (!primeira) return;
      primeira = false;
      m.relogio += ORCAMENTO_RECUPERACAO_ESTOQUE_AMAZON_MS + 1;
    };

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: s1,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    expect(doTipo(m, 'feed-enviar')).toEqual([]);
    expect(m.tarefasEstoque.length).toBeGreaterThan(0);
    expect(m.tarefasEstoque.length).toBeLessThan(20);
    expect(r).toEqual({ repassado: 'reconciliacao' });
    expect(m.fake.ler(PEDIDO)).toMatchObject({ pedidoEmMs: m.relogio });
  });
});

describe('★ Amazon throttling a WINDOW build', () => {
  function janelaDeDois(m: Mundo) {
    const desde = AGORA_MS - 10 * MIN;
    simples(m, 'SKU-A', { erp: 7, amazon: 2, carimbo: desde + 1 });
    simples(m, 'SKU-B', { erp: 5, carimbo: desde + 2 });
    return janelaDoTick(desde, AGORA_MS - MIN);
  }

  it('a 429 ⇒ the complete members go per SKU, the build answers ZERO messages: the real send releases sem-escrita, posts nothing, throws nothing', async () => {
    const m = mundo();
    const t = janelaDeDois(m);
    m.statusDaBusca = 429;

    const envio = await m.despachar(t);

    expect(envio).toMatchObject({
      tipo: 'feed-enviar',
      r: { acao: 'liberado', motivo: 'sem-escrita' },
    });
    expect(m.feedChamadas).toEqual([]);
    expect(tarefasEstoque(m).map(([sku, origem]) => [sku, origem])).toEqual([
      ['SKU-A', 'delta'],
      ['SKU-B', 'delta'],
    ]);
    expect(m.fake.ler(VEZ)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });
  });

  it('NEAR-MISS: a 500 is NOT a throttle — the build rejects (the queue retries it) and nothing is handed over', async () => {
    const m = mundo();
    const t = janelaDeDois(m);
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, t));
    m.statusDaBusca = 500;

    const falha: unknown = await m.provedor.montar(ctx, t, membros.skus, membros.dados).then(
      () => null,
      (err: unknown) => err,
    );

    expect(falha).toBeInstanceOf(AmazonHttpError);
    expect(falha).not.toBeInstanceOf(AmazonThrottleError);
    expect(m.tarefasEstoque).toEqual([]);
  });
});

describe('★ gravarResultado: the raise’s clock and a write-back in conflict', () => {
  const erro: ProblemaSku = {
    code: '90220',
    message: 'texto-sentinela',
    severity: 'ERROR',
    attributeNames: null,
    categories: null,
  };

  it('the raise is clocked by the write-back’s OWN link-doc read: a reconcile close that resolved AFTER the record’s outcome clock leaves it standing (NEAR-MISS: the stored clock is older than that resolve and would be dropped)', async () => {
    const m = mundo();
    produto(m, 'p1');
    vinculo(m, 'p1', 'l1', 'SKU-ERRO');
    const desfecho = m.fake.seed('relogio/desfecho', {});
    await sincronizarAvisoContaEstoqueAmazon(
      m.db,
      { increment, nowMs: m.relogio, logger: m.log.logger },
      {
        integracaoId: CONTA,
        motivo: MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon,
        acao: ACAO_AVISO_CONTA_ESTOQUE_AMAZON.resolver,
        relogio: m.fake.seed('relogio/fecho-da-reconciliacao', {}),
      },
    );
    expect(
      m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))?.resolvidoEm,
    ).not.toBeNull();

    await m.provedor.gravarResultado(await m.ctx(), {
      problemas: new Map([['SKU-ERRO', [erro]]]),
      emMs: AGORA_MS - 2 * MIN,
      feedId: FEED,
      relogio: desfecho,
    });

    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))).toMatchObject({
      resolvidoEm: null,
    });
  });

  it('a recusado whose EVERY write-back attempt loses its precondition is still counted and raises the aviso once', async () => {
    const m = mundo();
    produto(m, 'p1');
    vinculo(m, 'p1', 'l1', 'SKU-ERRO');
    const caminho = 'produtos/p1/prodAmazon/l1';
    for (let i = 0; i < 6; i += 1) {
      m.fake.antesDaProximaEscrita(caminho, () => {
        m.fake.seed(caminho, { ...(m.fake.ler(caminho) ?? {}) });
      });
    }

    await m.provedor.gravarResultado(await m.ctx(), {
      problemas: new Map([['SKU-ERRO', [erro]]]),
      emMs: AGORA_MS - 2 * MIN,
      feedId: FEED,
      relogio: m.fake.seed('relogio/desfecho', {}),
    });

    // Never landed: every attempt met a newer commit.
    expect(m.fake.ler(caminho)?.envioEstoqueAmazon).toBeUndefined();
    expect(m.fake.ler(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))).toMatchObject({
      resolvidoEm: null,
    });
    expect(m.fake.escritasEm(aviso(MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon))).toHaveLength(1);
  });
});

describe('★ a failed WINDOW feed whose own members cannot be handed over whole', () => {
  /** The failed feed's own window, `(S − 10 min, S − 6 min]`: older than its recovery delta reads. */
  const janelaPropria = (s: number) => ({
    desdeMs: s - 10 * MIN,
    ateMs: s - 6 * MIN,
    manterDesdeMs: s - 10 * MIN,
    commitAposMs: null,
    forcarPorCommit: false,
    depositoId: DEP,
  });

  it.each([
    [false, 'delta'],
    [true, 'catch-up'],
  ] as const)(
    '★ its own window is re-derived with the STORED forcarPorCommit (%s): the row it keeps by commit alone goes as a %s',
    async (forcar, origem) => {
      const m = mundo();
      const marco = commitAgora(m);
      const s = marco + MARGEM_COMMIT_MS;
      // Stamped below the window's stamp rule, committed after its commit filter.
      const caminho = simples(m, 'SKU-F', { erp: 1, carimbo: s - 8 * MIN });
      m.relogio = AGORA_MS;
      const commit = m.fake.carimboDe(caminho);
      if (commit === undefined) throw new Error('fixture');

      const r = await m.provedor.recuperar(await m.ctx(), {
        desfecho: 'falhou',
        snapshotEmMs: s,
        pendenteDesdeMs: null,
        referencia: FEED,
        janela: {
          ...janelaPropria(s),
          manterDesdeMs: s - 7 * MIN,
          commitAposMs: marco - 1_000,
          forcarPorCommit: forcar,
        },
      });

      // Outside the delta's own range (S − 5 min): only the failed window finds it.
      expect(r).toEqual({ tarefas: 1 });
      expect(tarefasEstoque(m)).toEqual([
        ['SKU-F', origem, forcar ? FEED : referenciaDaObservacao(commit)],
      ]);
    },
  );

  it('its own window re-derives TRUNCATED ⇒ exactly ONE guarded request, and none of its members per SKU', async () => {
    const m = mundo();
    const s = commitAgora(m) + MARGEM_COMMIT_MS;
    avancarUmMs(m);
    for (let i = 0; i < 2_700; i += 1) linha(m, `T${String(i).padStart(5, '0')}`, 1, s - 8 * MIN);
    m.relogio = AGORA_MS;

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'falhou',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: janelaPropria(s),
    });

    expect(r).toEqual({ repassado: 'reconciliacao' });
    expect(m.tarefasEstoque).toEqual([]);
    expect(m.fake.ler(PEDIDO)).toMatchObject({ reexecucaoAutomaticaEmMs: AGORA_MS });
    expect(doTipo(m, 'reconciliacao')).toHaveLength(1);
  });

  it('its own members the recovery’s budget left UNSTARTED ⇒ the started ones kept, then ONE guarded request (NEAR-MISS: all started ⇒ no request, above)', async () => {
    const m = mundo();
    const s = commitAgora(m) + MARGEM_COMMIT_MS;
    produto(m, 'K');
    for (let i = 0; i < 20; i += 1)
      vinculo(m, 'K', `l${String(i)}`, `K-${String(i).padStart(2, '0')}`);
    linha(m, 'K', 1, s - 8 * MIN);
    m.relogio = AGORA_MS;
    let primeira = true;
    m.aoEnfileirarEstoque = () => {
      if (!primeira) return;
      primeira = false;
      m.relogio += ORCAMENTO_RECUPERACAO_ESTOQUE_AMAZON_MS + 1;
    };

    const r = await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'falhou',
      snapshotEmMs: s,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: janelaPropria(s),
    });

    expect(m.tarefasEstoque.length).toBeGreaterThan(0);
    expect(m.tarefasEstoque.length).toBeLessThan(20);
    expect(r).toEqual({ repassado: 'reconciliacao' });
    // The request comes after the budget ran out: stamped by that later clock.
    expect(m.fake.ler(PEDIDO)).toMatchObject({ reexecucaoAutomaticaEmMs: m.relogio });
  });
});

describe('★ a BLOCK build sends only the members the valve let through', () => {
  it('membrosOn a strict subset ⇒ the left-out member is neither sent nor counted', async () => {
    const m = mundo();
    produto(m, 'u-a');
    linha(m, 'u-a', 9, 1);
    produto(m, 'u-b');
    linha(m, 'u-b', 9, 1);
    await gravarBlocoDivergenciaEstoqueAmazon(m.db, {
      contaId: CONTA,
      execucaoId: 'run-x',
      pagina: 0,
      depositoId: DEP,
      itens: [
        { sku: 'SKU-A', unidadeId: 'u-a', quantidadeAmazon: 1, quantidadeErp: 9 },
        { sku: 'SKU-B', unidadeId: 'u-b', quantidadeAmazon: 1, quantidadeErp: 9 },
      ],
      agoraMs: m.relogio,
    });
    const ctx = await m.ctx();
    const membros = dadosDe(await m.provedor.membros(ctx, blocos(1)));
    expect(membros.skus).toEqual(['SKU-A', 'SKU-B']);

    const r = await m.provedor.montar(ctx, blocos(1), ['SKU-A'], membros.dados);

    expect(skusEnviados(r)).toEqual(['SKU-A']);
    if ('abortado' in r) throw new Error('abortada');
    expect(r.diff).toMatchObject({ membros: 1, mensagens: 1 });
  });
});

describe('★ the recovery feed’s delay', () => {
  function trintaECinco(m: Mundo, carimbo: number) {
    produto(m, 'K');
    for (let i = 0; i < 35; i += 1)
      vinculo(m, 'K', `l${String(i)}`, `K-${String(i).padStart(2, '0')}`);
    linha(m, 'K', 2, carimbo);
  }

  it('rounds UP to whole seconds: a recovery at S + 10.5 s waits 30 s, so S2 ≥ S + 40 s (NEAR-MISS: rounded down it would dispatch at S + 39.5 s)', async () => {
    const m = mundo();
    const s1 = commitAgora(m) + MARGEM_COMMIT_MS - 1;
    trintaECinco(m, s1 - MIN);
    m.relogio = s1 + 10_500;

    await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: s1,
      pendenteDesdeMs: null,
      referencia: FEED,
      janela: null,
    });

    const [envio] = doTipo(m, 'feed-enviar');
    expect(envio?.atrasoS).toBe(30);
    expect(m.relogio + (envio?.atrasoS ?? 0) * 1000).toBeGreaterThanOrEqual(
      s1 + ESPACO_ENTRE_SNAPSHOTS_MS,
    );
  });

  it('is capped at the producer’s one day: a snapshot just under a day ahead waits exactly MAX_ATRASO_LOTE_S', async () => {
    const m = mundo();
    const p = AGORA_MS - 2 * MIN;
    trintaECinco(m, p + 1);
    m.relogio = AGORA_MS;

    await m.provedor.recuperar(await m.ctx(), {
      desfecho: 'concluido',
      snapshotEmMs: AGORA_MS + DIA_MS - 10_000,
      pendenteDesdeMs: p,
      referencia: FEED,
      janela: null,
    });

    const [envio] = doTipo(m, 'feed-enviar');
    expect(MAX_ATRASO_LOTE_S).toBe(86_400);
    expect(envio?.atrasoS).toBe(MAX_ATRASO_LOTE_S);
  });
});
