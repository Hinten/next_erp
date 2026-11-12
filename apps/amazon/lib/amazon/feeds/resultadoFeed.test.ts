/**
 * The feed RESULT handler (step 12a, PR 12-c), R0–R8 and the TAIL, end to end
 * against the fake Firestore: the REAL context, the REAL lease I/O and pure
 * lease machine, the REAL record writes, the REAL aviso seam, and the REAL jobs
 * producer over a RECORDING queue (every enqueue re-validated against the
 * payload schema, its name and its whole-seconds delay; a held name answers
 * Cloud Tasks' own refusal). A scripted `fetch` serves `getFeed`,
 * `getFeedDocument`, the report (an S3-shaped fake URL) and — for the
 * cross-handler cases — `createFeedDocument`, the upload and `createFeed`; it
 * refuses anything it was not scripted for. The providers are FAKES built here:
 * a window provider and a price provider, neither of which imports a stock
 * module.
 *
 * The fake keeps JSON-shaped data only, and the record's outcome clock is a
 * Firestore `Timestamp`: {@link comRelogios} stores it as its two numbers and
 * hands it back `Timestamp`-shaped, so the handler reads exactly what the
 * server would return.
 *
 * ⚠️ D11: the global `fetch` refuses; the read switch is `on` ONLY in the object
 * literal handed in as `ambiente`. PLACEHOLDERS ONLY (public repository).
 */
import { gzipSync } from 'node:zlib';

import {
  MAX_RELATORIO_JSON_BYTES,
  URL_BASE_SP_API,
  URL_TOKEN_LWA,
} from '@delfrance/integrations-amazon-sp-api';
import type { Firestore } from 'firebase-admin/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { vezFeedAmazonCollection } from '@delfrance/data/admin/collections';
import {
  DESFECHO_FEED_AMAZON,
  ESTADO_VEZ_FEED_AMAZON,
  FLUXO_FEED_AMAZON,
  type FluxoFeedAmazon,
  MOTIVO_CONTA_AMAZON,
  type RegistroFeedAmazon,
  STATUS_REGISTRO_FEED_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
  idRegistroFeedAmazon,
  idVezFeedAmazon,
  registroFeedAmazonSchema,
} from '@delfrance/schemas';

import { chaveContaPrecisaAtencao, relogioDoDocumentoUs } from '../avisos/avisos';
import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { CANARIO_ENV_AMAZON, VALVULA_ENV_AMAZON } from '../core/valvulas';
import { type CarimboFake, FakeDb, grpc, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente, falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  DIA_MS,
  SPID_A,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  loggerEspiao,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import { type FilaLotesAmazon, criarAgendadorLotesAmazon } from './agendadorLotes';
import { ACAO_ENVIO_FEED, enviarFeedAmazon } from './enviarFeed';
import { CONSULTA_HORARIA_FEED_S, ESCADA_CONSULTA_FEED_S } from './escadaFeed';
import { avisarContaDoLoteAmazon } from './incertoFeed';
import { type DepsProcessarLoteAmazon, processarLoteAmazon } from './processarLote';
import {
  ESPACO_MINIMO_ENTRE_FEEDS_MS,
  ESPERA_LOTE_EM_VEZ_S,
  ESPERA_MAXIMA_ATRAS_DE_FEED_MS,
  ESPERA_SONDA_DISJUNTOR_MS,
  type ProvedorLoteAmazon,
  type RecuperacaoLoteAmazon,
  type ResultadoLoteAmazon,
} from './provedorLote';
import { ABANDONO_FEED_MS, PRAZO_FEED_MS } from './registroFeed';
import {
  ACAO_RESULTADO_FEED,
  AmazonRegistroFeedEmConflitoError,
  type DesfechoTerminalFeedAmazon,
  MAX_TENTATIVAS_REGISTRO_FEED,
  type ResultadoConsultaFeedAmazon,
  processarResultadoFeedAmazon,
} from './resultadoFeed';
import {
  DESFECHO_RECUPERACAO_FEED_AMAZON,
  ORIGEM_RESULTADO_FEED_AMAZON,
  type OrigemResultadoFeedAmazon,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaEnviarFeedAmazon,
  type TarefaLoteAmazon,
  type TarefaResultadoFeedAmazon,
  nomeConsultaFeed,
  nomeRecuperacaoFeed,
  referenciaVezFeed,
  tarefaEnviarFeedAmazonSchema,
  tarefaResultadoFeedAmazonSchema,
} from './tarefaLote';
import { VALIDADE_VEZ_ENVIADO_MS } from './vezFeed';

/* ---------------------------------- constants ---------------------------------- */

const CONTA = 'conta-amz-resultado';
const OUTRA_CONTA = 'conta-amz-resultado-2';
const FEED = '50001234567';
const FEED_2 = '50007654321';
const EXEC = 'exec-resultado-teste';
const MIN = 60_000;
const HORA = 60 * MIN;
/** The submission's stamp: rung 0 runs two minutes later, at AGORA. */
const ANTES = AGORA_MS - 2 * MIN;
const VEZ = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, CONTA)}`;
const VEZ_PRECO = `feedsAmazonEmCurso/${idVezFeedAmazon(FLUXO_FEED_AMAZON.preco, CONTA)}`;
const REG = (conta = CONTA, feed = FEED) => `feedsAmazon/${idRegistroFeedAmazon(conta, feed)}`;
const AVISO = caminhoAviso(chaveContaPrecisaAtencao(CONTA, MOTIVO_CONTA_AMAZON.contaSemOperacao));
const URL_RELATORIO =
  'https://example-bucket.s3.amazonaws.com/relatorio?X-Amz-Signature=0000relatorio-sentinela';
const URL_UPLOAD = 'https://example-bucket.s3.amazonaws.com/entrada?X-Amz-Signature=0000entrada';
const ORIGEM_S3 = new URL(URL_RELATORIO).origin;
const CAMINHO_DOCUMENTOS = '/feeds/2021-06-30/documents';
const CAMINHO_FEEDS = '/feeds/2021-06-30/feeds';
const SKUS = Array.from({ length: 31 }, (_, i) => `SKU-TESTE-${String(i + 1).padStart(2, '0')}`);
const JANELA = {
  desdeMs: ANTES - 10 * MIN,
  ateMs: ANTES - 5 * MIN,
  manterDesdeMs: ANTES - 10 * MIN,
  commitAposMs: null,
  depositoId: 'deposito-teste',
};

/** A processing report: two SKUs attributed (one with spaces, exactly as written), one feed-level issue. */
const RELATORIO = {
  header: { sellerId: SPID_A, version: '2.0', feedId: FEED },
  issues: [
    {
      messageId: 1,
      sku: 'SKU-TESTE-01',
      code: '90220',
      severity: 'ERROR',
      message: 'texto-da-amazon-sentinela',
      attributeName: 'fulfillment_availability',
    },
    { messageId: 2, sku: ' SKU com espaco ', code: '99001', severity: 'WARNING', message: 'x' },
    { messageId: 3, code: '18000', severity: 'ERROR', message: 'sem sku' },
  ],
  summary: {
    errors: 2,
    warnings: 1,
    messagesProcessed: 31,
    messagesAccepted: 29,
    messagesInvalid: 2,
  },
};

/* ------------------------- the Timestamp-shaped record field ------------------------- */

/** A stored clock, as the fake keeps it: its two numbers. */
interface RelogioGuardado {
  readonly seconds: number;
  readonly nanoseconds: number;
}

function ehRelogio(v: unknown): v is RelogioGuardado {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { seconds?: unknown }).seconds === 'number' &&
    typeof (v as { nanoseconds?: unknown }).nanoseconds === 'number'
  );
}

/** The clock `Timestamp`-shaped again, as a read of the server hands it back. */
function relogioVivo(r: RelogioGuardado): CarimboFake {
  const { seconds, nanoseconds } = r;
  return {
    seconds,
    nanoseconds,
    isEqual: (o: unknown) => ehRelogio(o) && o.seconds === seconds && o.nanoseconds === nanoseconds,
    toMillis: () => seconds * 1000 + Math.floor(nanoseconds / 1_000_000),
  };
}

function guardar(dados: unknown): unknown {
  if (typeof dados !== 'object' || dados === null) return dados;
  const d = dados as Record<string, unknown>;
  const r = d.relogioDesfecho;
  if (!ehRelogio(r)) return dados;
  return { ...d, relogioDesfecho: { seconds: r.seconds, nanoseconds: r.nanoseconds } };
}

function hidratar(dados: unknown): unknown {
  if (typeof dados !== 'object' || dados === null) return dados;
  const d = dados as Record<string, unknown>;
  const r = d.relogioDesfecho;
  if (!ehRelogio(r)) return dados;
  return { ...d, relogioDesfecho: relogioVivo(r) };
}

type Snap = Record<string, unknown> & { data: () => unknown };

function snapHidratado(snap: Snap): Snap {
  return { ...snap, data: () => hidratar(snap.data()) };
}

/** The fake, with the record's clock field stored as numbers and read back `Timestamp`-shaped. */
function comRelogios(fake: FakeDb): Firestore {
  const membro = (alvo: object, prop: string | symbol): unknown => {
    const v: unknown = Reflect.get(alvo, prop, alvo);
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(alvo) : v;
  };
  const doc = (ref: Record<string | symbol, unknown>) =>
    new Proxy(ref, {
      get(alvo, prop) {
        if (prop === 'get') {
          return async () => snapHidratado((await (alvo.get as () => Promise<Snap>)()) as Snap);
        }
        if (prop === 'update') {
          return (patch: unknown, pre?: unknown) =>
            (alvo.update as (p: unknown, q?: unknown) => Promise<unknown>)(guardar(patch), pre);
        }
        if (prop === 'create') {
          return (dados: unknown) =>
            (alvo.create as (d: unknown) => Promise<unknown>)(guardar(dados));
        }
        return Reflect.get(alvo, prop, alvo);
      },
    });
  const colecao = (col: Record<string, unknown>) =>
    new Proxy(col, {
      get(alvo, prop) {
        if (prop === 'doc') {
          return (id: string) =>
            doc((alvo.doc as (i: string) => Record<string | symbol, unknown>)(id));
        }
        return Reflect.get(alvo, prop, alvo);
      },
    });
  return new Proxy(fake, {
    get(alvo, prop) {
      if (prop === 'collection') {
        // Through the member, not a `.collection(` call: this proxy only forwards it.
        const colecaoDoFake = membro(alvo, prop) as (c: string) => Record<string, unknown>;
        return (c: string) => colecao(colecaoDoFake(c));
      }
      if (prop === 'getAll') {
        return async (...refs: unknown[]) =>
          ((await alvo.getAll(...refs)) as unknown as Snap[]).map(snapHidratado);
      }
      return membro(alvo, prop);
    },
  }) as unknown as Firestore;
}

/* ------------------------------------ seeds ------------------------------------ */

function registro(campos: Partial<RegistroFeedAmazon> = {}): RegistroFeedAmazon {
  const antes = campos.antesDoEnvioMs ?? ANTES;
  return registroFeedAmazonSchema.parse({
    contaId: CONTA,
    feedId: FEED,
    fluxo: FLUXO_FEED_AMAZON.estoque,
    execucaoId: EXEC,
    origem: 'delta',
    tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
    janela: JANELA,
    snapshotEmMs: antes - MIN,
    antesDoEnvioMs: antes,
    mensagens: SKUS.length,
    bytes: 3_100,
    status: STATUS_REGISTRO_FEED_AMAZON.enviado,
    // Later than the submission by its own latency: the write-back counts from antesDoEnvioMs.
    criadoEmMs: antes + 3_000,
    atualizadoEmMs: antes,
    prazoEmMs: antes + PRAZO_FEED_MS,
    expiraEm: new Date(antes + 180 * DIA_MS),
    ...campos,
  });
}

function vez(campos: Partial<VezFeedAmazon> = {}): VezFeedAmazon {
  const antes = campos.antesDoEnvioMs ?? ANTES;
  return vezFeedAmazonCollection.parse({
    estado: ESTADO_VEZ_FEED_AMAZON.enviado,
    execucaoId: EXEC,
    feedId: FEED,
    snapshotEmMs: antes - MIN,
    antesDoEnvioMs: antes,
    mensagens: SKUS.length,
    bytes: 3_100,
    ateMs: antes + VALIDADE_VEZ_ENVIADO_MS,
    atualizadoEmMs: antes,
    origem: 'delta',
    tipoLote: TIPO_LOTE_FEED_AMAZON.janela,
    janela: JANELA,
    ultimoEnvioMs: antes,
    falhasSeguidas: 1,
    ultimaFalhaEmMs: antes - DIA_MS,
    ...campos,
  });
}

/* ------------------------------------ payloads --------------------------------- */

function rodada(
  n: number,
  origem: OrigemResultadoFeedAmazon = ORIGEM_RESULTADO_FEED_AMAZON.consulta,
  contaId: string | null = CONTA,
  feedId = FEED,
): TarefaResultadoFeedAmazon {
  return tarefaResultadoFeedAmazonSchema.parse({
    v: 1,
    tipo: TIPO_TAREFA_LOTE_AMAZON.resultado,
    contaId,
    feedId,
    rodada: n,
    origem,
  });
}

/** A TICK-born window batch of another run. */
function janelaDoTick(execucaoId: string, fluxo: FluxoFeedAmazon = FLUXO_FEED_AMAZON.estoque) {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: TIPO_TAREFA_LOTE_AMAZON.enviar,
    fluxo,
    contaId: CONTA,
    execucaoId,
    origem: 'delta',
    lote: {
      tipo: TIPO_LOTE_FEED_AMAZON.janela,
      desdeMs: AGORA_MS - 4 * MIN,
      ateMs: AGORA_MS - MIN,
      manterDesdeMs: AGORA_MS - 4 * MIN,
      commitAposMs: null,
      esperaAteMs: null,
      depositoId: 'deposito-teste',
    },
  });
}

/** A BLOCK batch of another run (a price batch is one too). */
function blocos(execucaoId: string, fluxo: FluxoFeedAmazon = FLUXO_FEED_AMAZON.estoque) {
  return tarefaEnviarFeedAmazonSchema.parse({
    v: 1,
    tipo: TIPO_TAREFA_LOTE_AMAZON.enviar,
    fluxo,
    contaId: CONTA,
    execucaoId,
    origem: 'reconciliacao',
    lote: { tipo: TIPO_LOTE_FEED_AMAZON.blocos, partes: 1, esperaAteMs: AGORA_MS + 6 * HORA },
  });
}

/* ------------------------------------- world ------------------------------------ */

interface Roteiro {
  readonly status?: number;
  readonly corpo?: unknown;
  /** The download's raw body. */
  readonly bytes?: Uint8Array<ArrayBuffer> | string;
  /** Reject the fetch itself (a dropped connection). */
  readonly rede?: true;
}

interface Enfileirada {
  readonly tarefa: TarefaLoteAmazon;
  readonly nome: string | null;
  readonly atrasoS: number;
  readonly vez: Record<string, unknown> | undefined;
  readonly registro: Record<string, unknown> | undefined;
  /** How many Amazon requests had been made by then. */
  readonly chamadas: number;
}

interface Espiao {
  membros: number;
  readonly gravacoes: ResultadoLoteAmazon[];
  readonly recuperacoes: RecuperacaoLoteAmazon[];
  readonly repasses: (readonly string[])[];
}

function mensagem(sku: string) {
  return {
    sku,
    patches: [
      {
        op: 'merge' as const,
        path: '/attributes/fulfillment_availability',
        value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 5 }],
      },
    ],
  };
}

/** A fake provider of `fluxo`: it imports no stock module. */
function provedorDeTeste(
  espiao: Espiao,
  fluxo: 'estoque' | 'preco',
): ProvedorLoteAmazon<'estoque' | 'preco', number> {
  return {
    fluxo,
    membros: (ctx) => {
      espiao.membros += 1;
      return Promise.resolve({ skus: SKUS, dados: ctx.agora() });
    },
    montar: (_ctx, _e, on, snapshotEmMs) =>
      Promise.resolve({
        mensagens: on.map(mensagem),
        snapshotEmMs,
        diff: { acao: 'enviaria', skusMudados: on.length },
      }),
    gravarResultado: (_ctx, r) => {
      espiao.gravacoes.push(r);
      return Promise.resolve();
    },
    recuperar: (_ctx, r) => {
      espiao.recuperacoes.push(r);
      return Promise.resolve({ tarefas: 3 });
    },
    repassarParaPatches: (_ctx, _e, skus) => {
      espiao.repasses.push(skus);
      return Promise.resolve({ tarefas: skus.length });
    },
    motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
  };
}

function proxima(fila: Roteiro[]): Roteiro {
  const r = fila.length > 1 ? fila.shift() : fila[0];
  if (r === undefined) throw new Error('teste: rota sem resposta');
  return r;
}

function feedEm(processingStatus: string, resultFeedDocumentId: string | null = 'doc-rel-1') {
  return {
    status: 200,
    corpo: {
      feedId: FEED,
      feedType: 'JSON_LISTINGS_FEED',
      processingStatus,
      ...(resultFeedDocumentId === null ? {} : { resultFeedDocumentId }),
    },
  };
}

function mundo() {
  const fake = new FakeDb();
  seedConta(fake, CONTA, { nome: 'Conta resultado', selling_partner_id: SPID_A });
  // A token far from expiry: no LWA exchange unless a test forces one.
  seedCredencial(fake, CONTA, { expirationDate: AGORA_MS + 30 * DIA_MS });
  const db = comRelogios(fake);
  const log = loggerEspiao();
  const ids = new Set<string>();
  const espiao: Espiao = { membros: 0, gravacoes: [], recuperacoes: [], repasses: [] };
  const m = {
    fake,
    db,
    log,
    espiao,
    relogio: AGORA_MS,
    chamadas: [] as string[],
    enfileiradas: [] as Enfileirada[],
    rotas: {
      feed: [feedEm('IN_PROGRESS')] as Roteiro[],
      documento: [{ status: 200 }] as Roteiro[],
      relatorio: [{ status: 200, bytes: JSON.stringify(RELATORIO) }] as Roteiro[],
      criarFeed: [{ status: 202, corpo: { feedId: FEED } }] as Roteiro[],
    },
    falhasDaFila: [] as (() => Error)[],
    /** Runs at each enqueue, after it is recorded. */
    aoEnfileirar: null as ((x: Enfileirada) => void) | null,
    ambiente: {
      ...AMBIENTE_LIGADO,
      [VALVULA_ENV_AMAZON.estoque]: 'on',
      [CANARIO_ENV_AMAZON.estoque]: '*',
      [VALVULA_ENV_AMAZON.preco]: 'on',
      [CANARIO_ENV_AMAZON.preco]: '*',
    } as Record<string, string | undefined>,
    provedores: {
      estoque: provedorDeTeste(espiao, 'estoque'),
      preco: provedorDeTeste(espiao, 'preco'),
    } as Record<'estoque' | 'preco', ProvedorLoteAmazon<'estoque' | 'preco', number> | null>,
    deps(): DepsProcessarLoteAmazon {
      return {
        ambiente: m.ambiente,
        agora: () => m.relogio,
        logger: log.logger,
        increment,
        agendador: () =>
          criarAgendadorLotesAmazon({
            desligado: false,
            fila: (): FilaLotesAmazon => ({
              enqueue: (tarefa, opcoes) => {
                const falha = m.falhasDaFila.shift();
                if (falha !== undefined) return Promise.reject(falha());
                const id = opcoes?.id;
                if (id !== undefined) {
                  if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
                  ids.add(id);
                }
                const x: Enfileirada = {
                  tarefa,
                  nome: id ?? null,
                  atrasoS: opcoes?.scheduleDelaySeconds ?? 0,
                  vez: fake.ler(VEZ),
                  registro: fake.ler(REG()),
                  chamadas: m.chamadas.length,
                };
                m.enfileiradas.push(x);
                m.aoEnfileirar?.(x);
                return Promise.resolve();
              },
            }),
          }),
        provedorDe: (fluxo) => m.provedores[fluxo],
        registro: { tentativa: 0, idTarefa: 'tarefa-lote-teste-1' },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const metodo = init?.method ?? 'GET';
          if (url.href === URL_TOKEN_LWA) {
            m.chamadas.push('LWA');
            return tokenDeAcesso();
          }
          if (url.origin === ORIGEM_S3) {
            if (metodo === 'PUT') {
              m.chamadas.push('PUT upload');
              return new Response(null, { status: 200 });
            }
            m.chamadas.push('GET relatorio');
            const r = proxima(m.rotas.relatorio);
            if (r.rede === true) throw new TypeError('fetch failed');
            return new Response(r.bytes ?? null, { status: r.status ?? 200 });
          }
          if (url.origin === URL_BASE_SP_API) {
            if (metodo === 'POST' && url.pathname === CAMINHO_DOCUMENTOS) {
              m.chamadas.push('POST documento');
              return respostaJson(201, { feedDocumentId: 'doc-entrada-1', url: URL_UPLOAD });
            }
            if (metodo === 'POST' && url.pathname === CAMINHO_FEEDS) {
              m.chamadas.push('POST feed');
              const r = proxima(m.rotas.criarFeed);
              return respostaJson(r.status ?? 202, r.corpo ?? { feedId: FEED });
            }
            if (metodo === 'GET' && url.pathname.startsWith(`${CAMINHO_FEEDS}/`)) {
              m.chamadas.push('GET feed');
              const r = proxima(m.rotas.feed);
              if (r.rede === true) throw new TypeError('fetch failed');
              return respostaJson(r.status ?? 200, r.corpo ?? {});
            }
            if (metodo === 'GET' && url.pathname.startsWith(`${CAMINHO_DOCUMENTOS}/`)) {
              m.chamadas.push('GET documento');
              const r = proxima(m.rotas.documento);
              return respostaJson(
                r.status ?? 200,
                r.corpo ?? { feedDocumentId: 'doc-rel-1', url: URL_RELATORIO },
              );
            }
          }
          m.chamadas.push(`fora do roteiro: ${metodo} ${url.pathname}`);
          throw new Error('teste: requisição fora do roteiro');
        },
        gerarCorrelationId: () => 'corr-lote-teste',
      };
    },
    resultado(t: TarefaResultadoFeedAmazon): Promise<ResultadoConsultaFeedAmazon> {
      return processarResultadoFeedAmazon(db, t, m.deps());
    },
    enviar(t: TarefaEnviarFeedAmazon) {
      const deps = m.deps();
      return enviarFeedAmazon(db, t, { ...deps, provedor: deps.provedorDe(t.fluxo) });
    },
    /** A task as the queue would dispatch it: through the dispatcher. */
    despachar(t: TarefaLoteAmazon) {
      return processarLoteAmazon(db, t, m.deps());
    },
  };
  return m;
}

type Mundo = ReturnType<typeof mundo>;

const rede: string[] = [];

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
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

const daFila = (m: Mundo, tipo: TarefaLoteAmazon['tipo']) =>
  m.enfileiradas.filter((x) => x.tarefa.tipo === tipo);
const lease = (m: Mundo, caminho = VEZ) => m.fake.ler(caminho) as VezFeedAmazon | undefined;
const reg = (m: Mundo, caminho = REG()) => m.fake.ler(caminho) as RegistroFeedAmazon | undefined;
const doAmazon = (m: Mundo, rotulo: string) => m.chamadas.filter((c) => c === rotulo).length;
const semear = (m: Mundo, r: RegistroFeedAmazon, v: VezFeedAmazon | null = vez()) => {
  m.fake.seed(REG(r.contaId, r.feedId), r);
  if (v !== null) m.fake.seed(VEZ, v);
};
/** The aviso row's state: raised (`resolvidoEm` null) or resolved, and its clock. */
const avisoDe = (m: Mundo) =>
  m.fake.ler(AVISO) as { resolvidoEm: unknown; relogioEvento: number } | undefined;

/* ------------------------------------------------------------------------------ */

describe('R1 — the record, and the successor FIRST', () => {
  it('★ every rung enqueues its successor BEFORE any Amazon call: rung 0 ⇒ rung 1, NAMED, 300 s (whole seconds)', async () => {
    const m = mundo();
    semear(m, registro());
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({ acao: ACAO_RESULTADO_FEED.processando, sucessor: 'enfileirada' });
    const [sucessor] = daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado);
    expect(sucessor).toMatchObject({
      nome: nomeConsultaFeed(CONTA, FEED, 1),
      atrasoS: ESCADA_CONSULTA_FEED_S[1],
      tarefa: { rodada: 1, origem: 'consulta', contaId: CONTA, feedId: FEED },
      // Recorded before the first Amazon request.
      chamadas: 0,
    });
  });

  it.each<[string, () => Roteiro[]]>([
    ['a getFeed (R4) that answers 500', () => [{ status: 500, corpo: {} }]],
    ['a getFeed whose connection drops', () => [{ rede: true }]],
  ])(
    '★ %s five times ⇒ every attempt throws, the chain stays alive: ONE successor, and it runs',
    async (_caso, rota) => {
      const m = mundo();
      semear(m, registro());
      m.rotas.feed = rota();
      for (let tentativa = 0; tentativa < 5; tentativa += 1) {
        await expect(m.resultado(rodada(0))).rejects.toThrow();
      }
      const sucessores = daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado);
      expect(sucessores.map((x) => x.nome)).toEqual([nomeConsultaFeed(CONTA, FEED, 1)]);
      expect(reg(m)?.status).toBe(STATUS_REGISTRO_FEED_AMAZON.enviado);
      expect(lease(m)).toMatchObject({ estado: 'enviado', feedId: FEED });

      // The successor carries the chain past the last attempt.
      m.rotas.feed = [feedEm('IN_PROGRESS')];
      m.relogio += 5 * MIN;
      const proximo = await m.resultado(sucessores[0]?.tarefa as TarefaResultadoFeedAmazon);
      expect(proximo).toMatchObject({ acao: ACAO_RESULTADO_FEED.processando, rodada: 1 });
    },
  );

  it('★ a report download that throws five times (S3 503) leaves the chain alive and the feed open', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('DONE')];
    m.rotas.relatorio = [{ status: 503 }];
    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      await expect(m.resultado(rodada(0))).rejects.toThrow();
    }
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado)).toHaveLength(1);
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toEqual([]);
    expect(reg(m)?.status).toBe(STATUS_REGISTRO_FEED_AMAZON.enviado);
    expect(lease(m)).toMatchObject({ estado: 'enviado', feedId: FEED });
    expect(m.espiao.gravacoes).toEqual([]);
  });

  it('★ a wake-up for an unknown feedId ⇒ feed-desconhecido, ZERO Amazon calls, nothing enqueued or written', async () => {
    const m = mundo();
    const r = await m.resultado(rodada(0, ORIGEM_RESULTADO_FEED_AMAZON.notificacao, null));
    expect(r).toMatchObject({ acao: ACAO_RESULTADO_FEED.feedDesconhecido, contas: 0, fluxo: null });
    expect(m.chamadas).toEqual([]);
    expect(m.enfileiradas).toEqual([]);
    expect(m.fake.escritas).toEqual([]);
    expect(m.log.linhas.at(-1)).toMatchObject({
      nivel: 'info',
      meta: { evento: 'feed', fase: 'resultado', acao: 'feed-desconhecido' },
    });
  });

  it('★ two ACTIVE contas holding the feedId ⇒ feed-ambiguo, ZERO Amazon calls (NEAR-MISS: an inactive twin is ignored)', async () => {
    const m = mundo();
    seedConta(m.fake, OUTRA_CONTA, { nome: 'Outra conta', selling_partner_id: SPID_A });
    semear(m, registro());
    m.fake.seed(REG(OUTRA_CONTA), registro({ contaId: OUTRA_CONTA }));
    const r = await m.resultado(rodada(0, ORIGEM_RESULTADO_FEED_AMAZON.notificacao, null));
    expect(r).toMatchObject({ acao: ACAO_RESULTADO_FEED.feedAmbiguo, contas: 2 });
    expect(m.chamadas).toEqual([]);
    expect(m.enfileiradas).toEqual([]);
    expect(m.fake.escritas).toEqual([]);

    const n = mundo();
    seedConta(n.fake, OUTRA_CONTA, { nome: 'Outra conta', ativo: false });
    semear(n, registro());
    n.fake.seed(REG(OUTRA_CONTA), registro({ contaId: OUTRA_CONTA }));
    const s = await n.resultado(rodada(0, ORIGEM_RESULTADO_FEED_AMAZON.notificacao, null));
    expect(s).toMatchObject({ acao: ACAO_RESULTADO_FEED.processando, contaId: CONTA });
  });

  it('a poll rung of a conta with no such record ⇒ feed-desconhecido, nothing called', async () => {
    const m = mundo();
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({ acao: ACAO_RESULTADO_FEED.feedDesconhecido });
    expect(m.chamadas).toEqual([]);
    expect(m.enfileiradas).toEqual([]);
  });

  it('a stored record that no longer parses ⇒ AmazonRegistroFeedInvalidoError naming its FIELDS, nothing else done', async () => {
    const m = mundo();
    m.fake.seed(REG(), { ...registro(), status: 'quase-pronto' });
    await expect(m.resultado(rodada(0))).rejects.toMatchObject({
      name: 'AmazonRegistroFeedInvalidoError',
      campos: ['status'],
    });
    expect(m.enfileiradas).toEqual([]);
    expect(m.chamadas).toEqual([]);
  });
});

describe('★ no fork: a wake-up or an adoption names the live chain’s pending rung', () => {
  it('a wake-up during a live chain ⇒ ALREADY_EXISTS on the pending rung: exactly one chain polls (NEAR-MISS: by the payload’s rung 0 it would mint rung 1)', async () => {
    const m = mundo();
    semear(m, registro({ rodadas: 1, atualizadoEmMs: ANTES + 7 * MIN }));
    m.relogio = ANTES + 17 * MIN;
    // Rung 2 runs and enqueues rung 3.
    await m.resultado(rodada(2));
    expect(reg(m)?.rodadas).toBe(2);
    // The notification arrives: its payload says rung 0, the record says 2.
    m.relogio += MIN;
    const r = await m.resultado(rodada(0, ORIGEM_RESULTADO_FEED_AMAZON.notificacao, null));
    expect(r).toMatchObject({ rodada: 2, sucessor: 'ja-enfileirada' });
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado).map((x) => x.nome)).toEqual([
      nomeConsultaFeed(CONTA, FEED, 3),
    ]);
    expect(nomeConsultaFeed(CONTA, FEED, 1)).not.toBe(nomeConsultaFeed(CONTA, FEED, 3));
  });

  it('an adoption rung takes the record’s rodadas too', async () => {
    const m = mundo();
    semear(m, registro({ rodadas: 4 }));
    m.relogio = ANTES + 2 * HORA;
    const r = await m.resultado(rodada(0, ORIGEM_RESULTADO_FEED_AMAZON.adocao));
    expect(r).toMatchObject({ rodada: 4 });
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado)[0]?.nome).toBe(
      nomeConsultaFeed(CONTA, FEED, 5),
    );
  });

  it('★ an IN_PROGRESS rung 7 h after antesDoEnvioMs still advances atualizadoEmMs to now (and rodadas), its successor hourly', async () => {
    const m = mundo();
    semear(m, registro({ rodadas: 8, status: STATUS_REGISTRO_FEED_AMAZON.processando }));
    m.relogio = ANTES + 7 * HORA;
    const r = await m.resultado(rodada(9));
    expect(r).toMatchObject({ acao: 'processando', atrasoS: CONSULTA_HORARIA_FEED_S });
    expect(reg(m)).toMatchObject({ rodadas: 9, atualizadoEmMs: m.relogio, status: 'processando' });
  });
});

describe('R2 — a terminal record', () => {
  it('★ the lease still names the feed (a lost release) ⇒ R2 releases it, a stored start to its NAMED vez first; ZERO Amazon calls, no successor, no recovery', async () => {
    const m = mundo();
    const pendente = AGORA_MS - 3 * MIN;
    semear(
      m,
      registro({ status: STATUS_REGISTRO_FEED_AMAZON.concluido, concluidoEmMs: AGORA_MS - MIN }),
      vez({ pendenteDesdeMs: pendente, falhasSeguidas: 2 }),
    );
    const r = await m.resultado(rodada(3));
    expect(r).toMatchObject({
      acao: ACAO_RESULTADO_FEED.feedJaConcluido,
      desfecho: 'concluido',
      liberacao: 'liberada',
      vezPara: pendente,
    });
    expect(m.chamadas).toEqual([]);
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado)).toEqual([]);
    const [vezRec] = daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar);
    expect(vezRec).toMatchObject({
      nome: nomeRecuperacaoFeed(CONTA, referenciaVezFeed(FEED), pendente),
      tarefa: { desfecho: 'vez', pendenteDesdeMs: pendente },
    });
    expect(vezRec?.vez).toMatchObject({ estado: 'enviado', pendenteDesdeMs: pendente });
    expect(lease(m)).toMatchObject({ estado: 'livre', falhasSeguidas: 0, pendenteDesdeMs: null });
  });

  it('a terminal record the lease no longer names ⇒ feed-ja-concluido, nothing written', async () => {
    const m = mundo();
    semear(
      m,
      registro({ status: STATUS_REGISTRO_FEED_AMAZON.falhou }),
      vez({ estado: ESTADO_VEZ_FEED_AMAZON.livre, feedId: null }),
    );
    const r = await m.resultado(rodada(3));
    expect(r).toMatchObject({ acao: ACAO_RESULTADO_FEED.feedJaConcluido, liberacao: null });
    expect(m.fake.escritas).toEqual([]);
    expect(m.enfileiradas).toEqual([]);
  });
});

describe('R3 — the context', () => {
  it('the read switch off ⇒ contexto-recusado (WARNING): the successor already waits, ZERO Amazon calls', async () => {
    const m = mundo();
    semear(m, registro());
    m.ambiente.AMAZON_CHAMADAS = undefined;
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({
      acao: ACAO_RESULTADO_FEED.contextoRecusado,
      motivo: 'chamadas-desligadas',
      sucessor: 'enfileirada',
    });
    expect(m.chamadas).toEqual([]);
    expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
  });

  it.each<[string, (m: Mundo) => void, string]>([
    [
      'an inactive conta',
      (m) => seedConta(m.fake, CONTA, { selling_partner_id: SPID_A, ativo: false }),
      'conta-inativa',
    ],
    [
      'a conta with no credential',
      (m) => {
        m.fake.apagar(caminhoCredencial(CONTA));
      },
      'conta-indisponivel',
    ],
  ])(
    '★ %s ⇒ contexto-recusado (WARNING), no throw: the successor already waits, ZERO Amazon calls',
    async (_caso, preparar, motivo) => {
      const m = mundo();
      semear(m, registro());
      preparar(m);
      const r = await m.resultado(rodada(0));
      expect(r).toMatchObject({
        acao: ACAO_RESULTADO_FEED.contextoRecusado,
        motivo,
        sucessor: 'enfileirada',
      });
      expect(m.chamadas).toEqual([]);
      expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado)).toHaveLength(1);
      expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
    },
  );
});

describe('R5 — still processing', () => {
  it('IN_PROGRESS ⇒ ONE tier-1 rung write: processando, rodadas, atualizadoEmMs, processingStatus; no lease read before 30 min', async () => {
    const m = mundo();
    semear(m, registro());
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({
      acao: 'processando',
      processingStatus: 'IN_PROGRESS',
      reconhecido: true,
    });
    const escritas = m.fake.escritasEm(REG());
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.comPrecondicao).toBe(true);
    expect(reg(m)).toMatchObject({
      status: 'processando',
      rodadas: 0,
      atualizadoEmMs: AGORA_MS,
      processingStatus: 'IN_PROGRESS',
    });
    expect(m.fake.leituras).not.toContain(VEZ);
  });

  it('★ processando → processando: no status move, yet rodadas and atualizadoEmMs advance', async () => {
    const m = mundo();
    semear(m, registro({ status: STATUS_REGISTRO_FEED_AMAZON.processando, rodadas: 1 }));
    m.relogio = ANTES + 17 * MIN;
    await m.resultado(rodada(2));
    expect(reg(m)).toMatchObject({ status: 'processando', rodadas: 2, atualizadoEmMs: m.relogio });
  });

  it('a processingStatus the model does not list ⇒ processando, unrecognised, WARNING; logged as <outro> unless a short token', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('PAUSED')];
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({
      acao: 'processando',
      reconhecido: false,
      processingStatus: 'PAUSED',
    });
    expect(reg(m)?.processingStatus).toBe('PAUSED');
    expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });

    const n = mundo();
    semear(n, registro());
    n.rotas.feed = [feedEm('texto livre da amazon')];
    expect(await n.resultado(rodada(0))).toMatchObject({ processingStatus: '<outro>' });
  });

  it('★ the slow holder: rung 3 at +1,920 s with a stored start ⇒ ONE vez recovery, the start cleared, NO aviso, the lease still enviado (NEAR-MISS: rung 2 at +1,020 s keeps it)', async () => {
    const cedo = mundo();
    const pendente = ANTES + 5 * MIN;
    semear(cedo, registro(), vez({ pendenteDesdeMs: pendente }));
    cedo.relogio = ANTES + 1_020_000;
    await cedo.resultado(rodada(2));
    expect(lease(cedo)?.pendenteDesdeMs).toBe(pendente);
    expect(daFila(cedo, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toEqual([]);

    const m = mundo();
    semear(m, registro(), vez({ pendenteDesdeMs: pendente }));
    m.relogio = ANTES + 1_920_000;
    const r = await m.resultado(rodada(3));
    expect(r).toMatchObject({ acao: 'processando', vezPara: pendente, aviso: null });
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toEqual([
      expect.objectContaining({
        nome: nomeRecuperacaoFeed(CONTA, referenciaVezFeed(FEED), pendente),
        tarefa: expect.objectContaining({ desfecho: 'vez', pendenteDesdeMs: pendente }),
        // Enqueued while the start was still stored.
        vez: expect.objectContaining({ pendenteDesdeMs: pendente }),
      }),
    ]);
    expect(lease(m)).toMatchObject({ estado: 'enviado', feedId: FEED, pendenteDesdeMs: null });
    expect(avisoDe(m)).toBeUndefined();
  });

  it('★ the two R5 bounds are INCLUSIVE: AT antesDoEnvioMs + 30 min the start is consumed, 1 ms before it stays; AT the 12-h deadline the aviso is raised, 1 ms before it is not', async () => {
    const pendente = ANTES + 5 * MIN;
    const lenta = (relogio: number) => {
      const m = mundo();
      semear(m, registro(), vez({ pendenteDesdeMs: pendente }));
      m.relogio = relogio;
      return m;
    };
    const naBorda = lenta(ANTES + ESPERA_MAXIMA_ATRAS_DE_FEED_MS);
    expect(await naBorda.resultado(rodada(3))).toMatchObject({ vezPara: pendente });
    expect(lease(naBorda)?.pendenteDesdeMs).toBeNull();
    const antesDaBorda = lenta(ANTES + ESPERA_MAXIMA_ATRAS_DE_FEED_MS - 1);
    expect(await antesDaBorda.resultado(rodada(3))).toMatchObject({ vezPara: null });
    expect(lease(antesDaBorda)?.pendenteDesdeMs).toBe(pendente);

    const noPrazo = (relogio: number) => {
      const m = mundo();
      semear(m, registro({ rodadas: 14, atualizadoEmMs: ANTES + PRAZO_FEED_MS - 30 * MIN }));
      m.relogio = relogio;
      return m;
    };
    const exato = noPrazo(ANTES + PRAZO_FEED_MS);
    expect(await exato.resultado(rodada(15))).toMatchObject({ avisoPrazo: true });
    expect(avisoDe(exato)).toMatchObject({ resolvidoEm: null });
    const cedo = noPrazo(ANTES + PRAZO_FEED_MS - 1);
    expect(await cedo.resultado(rodada(15))).toMatchObject({ avisoPrazo: false, aviso: null });
    expect(avisoDe(cedo)).toBeUndefined();
  });

  it('★ behind the slow holder a window batch at +31 min goes as patches, one at +29 min is recorded; a block batch at +31 min still waits', async () => {
    const tarde = mundo();
    semear(tarde, registro());
    tarde.relogio = ANTES + ESPERA_MAXIMA_ATRAS_DE_FEED_MS + MIN;
    const r = await tarde.enviar(janelaDoTick('exec-outra-janela'));
    expect(r).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo: 'ocupada-lenta' });
    expect(tarde.espiao.repasses).toHaveLength(1);
    expect(doAmazon(tarde, 'POST feed')).toBe(0);
    expect(tarde.fake.escritasEm(VEZ)).toEqual([]);

    const cedo = mundo();
    semear(cedo, registro());
    cedo.relogio = ANTES + ESPERA_MAXIMA_ATRAS_DE_FEED_MS - MIN;
    const s = await cedo.enviar(janelaDoTick('exec-outra-janela'));
    expect(s).toMatchObject({ acao: ACAO_ENVIO_FEED.pendenteRegistrado });
    expect(cedo.espiao.repasses).toEqual([]);
    expect(lease(cedo)?.pendenteDesdeMs).toBe(AGORA_MS - 4 * MIN);

    const bloco = mundo();
    semear(bloco, registro());
    bloco.relogio = ANTES + ESPERA_MAXIMA_ATRAS_DE_FEED_MS + MIN;
    const b = await bloco.enviar(blocos('exec-bloco'));
    expect(b).toMatchObject({ acao: ACAO_ENVIO_FEED.aguardando, atrasoS: ESPERA_LOTE_EM_VEZ_S });
    expect(bloco.espiao.repasses).toEqual([]);
  });

  it('★ the 12-h prazo rung: the aviso raised ONCE (clocked by that rung’s record read), a stored start to ONE vez, the lease still enviado; the next window batch goes as patches', async () => {
    const m = mundo();
    const pendente = ANTES + 20 * MIN;
    semear(
      m,
      registro({ rodadas: 14, atualizadoEmMs: ANTES + PRAZO_FEED_MS - 30 * MIN }),
      vez({ pendenteDesdeMs: pendente }),
    );
    m.relogio = ANTES + PRAZO_FEED_MS + 30 * MIN;
    const relogioDaLeitura = m.fake.carimboDe(VEZ);
    const r = await m.resultado(rodada(15));
    expect(r).toMatchObject({
      acao: 'processando',
      prazo: true,
      avisoPrazo: true,
      aviso: 'levantado',
      vezPara: pendente,
      atrasoS: CONSULTA_HORARIA_FEED_S,
    });
    // The rung's record read is the latest stamp then: the lease's seed.
    expect(avisoDe(m)).toMatchObject({
      resolvidoEm: null,
      relogioEvento: relogioDoDocumentoUs(relogioDaLeitura ?? { seconds: 0, nanoseconds: 0 }),
    });
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toHaveLength(1);
    expect(lease(m)).toMatchObject({ estado: 'enviado', pendenteDesdeMs: null });
    expect(m.fake.escritasEm(AVISO)).toHaveLength(1);

    // The next hourly rung raises nothing more.
    m.relogio += HORA;
    const s = await m.resultado(rodada(16));
    expect(s).toMatchObject({ avisoPrazo: false, aviso: null });
    expect(m.fake.escritasEm(AVISO)).toHaveLength(1);

    // And a window batch behind the overdue holder goes as patches.
    const e = await m.enviar(janelaDoTick('exec-depois-do-prazo'));
    expect(e).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo: 'ocupada-vencida' });
  });

  it('a seam with no provider still writes the rung (and raises no deadline aviso)', async () => {
    const m = mundo();
    m.provedores.estoque = null;
    semear(m, registro({ atualizadoEmMs: ANTES + PRAZO_FEED_MS - MIN }));
    m.relogio = ANTES + PRAZO_FEED_MS + MIN;
    const r = await m.resultado(rodada(14));
    expect(r).toMatchObject({ acao: 'processando', avisoPrazo: false });
    expect(avisoDe(m)).toBeUndefined();
    expect(reg(m)?.status).toBe('processando');
  });
});

describe('★ the 48-h rung abandons — with ZERO Amazon calls', () => {
  it('no successor, no getFeed, no download: the recovery abandonado, the lease released (+1), the aviso raised, the record abandonado LAST', async () => {
    const m = mundo();
    semear(m, registro({ rodadas: 50, status: STATUS_REGISTRO_FEED_AMAZON.processando }));
    m.relogio = ANTES + ABANDONO_FEED_MS;
    const r = await m.resultado(rodada(50));
    expect(r).toMatchObject({
      acao: ACAO_RESULTADO_FEED.encerrado,
      desfecho: 'abandonado',
      sucessor: 'abandonar',
      liberacao: 'liberada',
      aviso: 'levantado',
    });
    expect(m.chamadas).toEqual([]);
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado)).toEqual([]);
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toEqual([
      expect.objectContaining({
        nome: nomeRecuperacaoFeed(CONTA, FEED, null),
        tarefa: expect.objectContaining({ desfecho: 'abandonado', feedId: FEED, janela: JANELA }),
      }),
    ]);
    expect(lease(m)).toMatchObject({
      estado: 'livre',
      falhasSeguidas: 2,
      ultimaFalhaEmMs: m.relogio,
      ultimoFeedConcluidoEmMs: m.relogio,
    });
    expect(reg(m)).toMatchObject({ status: 'abandonado', concluidoEmMs: m.relogio });
    expect(avisoDe(m)).toMatchObject({ resolvidoEm: null });
  });

  it('NEAR-MISS: one ms before 48 h the rung reads Amazon and enqueues its successor', async () => {
    const m = mundo();
    semear(m, registro({ rodadas: 50 }));
    m.relogio = ANTES + ABANDONO_FEED_MS - 1;
    const r = await m.resultado(rodada(50));
    expect(r).toMatchObject({ acao: 'processando', sucessor: 'enfileirada' });
    expect(doAmazon(m, 'GET feed')).toBe(1);
  });
});

describe('R6 — CANCELLED', () => {
  it('★ ⇒ the recovery cancelado, the aviso raised, NO download; the lease released +1 without the feed-recent stamp', async () => {
    const m = mundo();
    semear(m, registro(), vez({ ultimoFeedConcluidoEmMs: ANTES - HORA }));
    m.rotas.feed = [feedEm('CANCELLED')];
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({ desfecho: 'cancelado', aviso: 'levantado' });
    expect(doAmazon(m, 'GET documento')).toBe(0);
    expect(m.espiao.gravacoes).toEqual([]);
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)[0]?.tarefa).toMatchObject({
      desfecho: 'cancelado',
    });
    expect(lease(m)).toMatchObject({
      estado: 'livre',
      falhasSeguidas: 2,
      ultimoFeedConcluidoEmMs: ANTES - HORA,
    });
    expect(reg(m)?.status).toBe('cancelado');
  });
});

describe('R7 — DONE / FATAL, the report', () => {
  it('★ DONE with per-SKU errors COMPLETES: one download, attribution by the issue’s own sku, exactly as written, the write-back, the counts, the tail; motivoFalha RESOLVED', async () => {
    const m = mundo();
    semear(m, registro());
    // An earlier failure left the aviso raised.
    await avisarContaDoLoteAmazon(
      m.db,
      { agora: () => m.relogio, increment, logger: m.log.logger },
      CONTA,
      MOTIVO_CONTA_AMAZON.contaSemOperacao,
      m.fake.carimboDe(REG()) as CarimboFake,
    );
    m.rotas.feed = [feedEm('DONE')];
    const r = await m.resultado(rodada(0));

    expect(r).toMatchObject({
      acao: ACAO_RESULTADO_FEED.encerrado,
      desfecho: 'concluido',
      relatorio: 'baixado',
      skusComProblema: 2,
      skusGravados: 2,
      semSkuErros: 1,
      codigos: '18000,90220,99001',
      aviso: 'resolvido',
      liberacao: 'liberada',
    });
    expect([doAmazon(m, 'GET documento'), doAmazon(m, 'GET relatorio')]).toEqual([1, 1]);
    const [gravado] = m.espiao.gravacoes;
    expect([...(gravado?.problemas.keys() ?? [])]).toEqual(['SKU-TESTE-01', ' SKU com espaco ']);
    expect(gravado?.problemas.get('SKU-TESTE-01')?.[0]).toMatchObject({
      code: '90220',
      severity: 'ERROR',
      attributeNames: ['fulfillment_availability'],
    });
    expect(gravado).toMatchObject({ emMs: ANTES, feedId: FEED });
    // The write-back's clock is the STORED outcome clock.
    expect(ehRelogio(gravado?.relogio)).toBe(true);
    expect(m.fake.ler(REG())?.relogioDesfecho).toEqual({
      seconds: gravado?.relogio.seconds,
      nanoseconds: gravado?.relogio.nanoseconds,
    });
    expect(reg(m)).toMatchObject({
      status: 'concluido',
      resultado: { erros: 2, avisos: 1, processadas: 31, aceitas: 29, invalidas: 2 },
      problemasSemSku: { erros: 1, avisos: 0 },
      skusComProblema: 2,
      skusGravados: 2,
      processingStatus: 'DONE',
    });
    expect(lease(m)).toMatchObject({
      estado: 'livre',
      falhasSeguidas: 0,
      ultimoFeedConcluidoEmMs: m.relogio,
    });
    expect(avisoDe(m)?.resolvidoEm).not.toBeNull();
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)[0]?.tarefa).toMatchObject({
      desfecho: 'concluido',
      snapshotEmMs: ANTES - MIN,
      pendenteDesdeMs: null,
      janela: JANELA,
    });
  });

  it('★ the order of the tail: the clock, the counts, the recovery (lease still enviado), the release, the aviso, the terminal status LAST', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('FATAL')];
    await m.resultado(rodada(0));
    const [recuperacao] = daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar);
    expect(recuperacao?.vez).toMatchObject({ estado: 'enviado', feedId: FEED });
    expect(recuperacao?.registro).toMatchObject({ status: 'processando' });
    expect(recuperacao?.registro?.relogioDesfecho).not.toBeNull();
    const ordem = m.fake.escritas.map((w) => w.caminho);
    const ultimaDoRegistro = ordem.lastIndexOf(REG());
    expect(ordem.indexOf(VEZ)).toBeLessThan(ordem.indexOf(AVISO));
    expect(ordem.indexOf(AVISO)).toBeLessThan(ultimaDoRegistro);
    expect(m.fake.escritasEm(REG()).at(-1)?.dados).toMatchObject({ status: 'falhou' });
  });

  it('★ FATAL ⇒ the write-back, the recovery falhou, motivoFalha RAISED, +1 on the breaker', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('FATAL')];
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({ desfecho: 'falhou', aviso: 'levantado', relatorio: 'baixado' });
    expect(m.espiao.gravacoes).toHaveLength(1);
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)[0]?.tarefa).toMatchObject({
      desfecho: 'falhou',
    });
    expect(lease(m)).toMatchObject({ estado: 'livre', falhasSeguidas: 2 });
    expect(avisoDe(m)).toMatchObject({ resolvidoEm: null });
    expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
  });

  it.each<[string, DesfechoTerminalFeedAmazon]>([
    ['DONE', DESFECHO_FEED_AMAZON.concluido],
    ['FATAL', DESFECHO_FEED_AMAZON.falhou],
  ])(
    '★ %s WITHOUT a resultFeedDocumentId ⇒ ZERO getFeedDocument, resultado null, WARNING, the tail (%s)',
    async (status, desfecho) => {
      const m = mundo();
      semear(m, registro());
      m.rotas.feed = [feedEm(status, null)];
      const r = await m.resultado(rodada(0));
      expect(r).toMatchObject({ desfecho, relatorio: 'sem-documento' });
      expect(doAmazon(m, 'GET documento')).toBe(0);
      expect(m.espiao.gravacoes).toEqual([]);
      expect(reg(m)).toMatchObject({ resultado: null, status: desfecho });
      expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });
    },
  );

  it('★ a DETERMINISTIC download failure (S3 404) ⇒ WARNING, resultado null, the tail — never a loop (NEAR-MISS: S3 503 throws for the retry)', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('DONE')];
    m.rotas.relatorio = [{ status: 404 }];
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({
      desfecho: 'concluido',
      relatorio: 'falhou',
      falhaRelatorio: 'AmazonDocumentoFeedError',
      motivoRelatorio: 'http',
    });
    expect(reg(m)).toMatchObject({ status: 'concluido', resultado: null });
    expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'warn' });

    const n = mundo();
    semear(n, registro());
    n.rotas.feed = [feedEm('DONE')];
    n.rotas.relatorio = [{ status: 503 }];
    await expect(n.resultado(rodada(0))).rejects.toMatchObject({
      name: 'AmazonDocumentoFeedError',
    });
    expect(reg(n)?.status).toBe('enviado');
  });

  it('★ a 403 on getFeedDocument that persists after the forced refresh ⇒ deterministic: relatorio falhou, the tail, no throw (NEAR-MISS: read as transient, every rung would retry it until the 48-h abandonment)', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('DONE')];
    m.rotas.documento = [
      { status: 403, corpo: { errors: [{ code: 'Unauthorized', message: 'x' }] } },
    ];
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({
      desfecho: 'concluido',
      relatorio: 'falhou',
      falhaRelatorio: 'AmazonAuthError',
    });
    expect(doAmazon(m, 'GET documento')).toBe(2);
    expect(m.chamadas).toContain('LWA');
    expect(doAmazon(m, 'GET relatorio')).toBe(0);
    expect(reg(m)).toMatchObject({ status: 'concluido', resultado: null });
    expect(lease(m)).toMatchObject({ estado: 'livre' });
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toHaveLength(1);
  });

  it(
    '★ the 32-MiB bound, through the handler: a report of EXACTLY MAX_RELATORIO_JSON_BYTES is written back; ONE byte over is grande-demais — the tail with resultado null',
    { timeout: 60_000 },
    async () => {
      const relatorioDeTamanho = (n: number): Uint8Array => {
        const base = JSON.stringify(RELATORIO);
        // JSON whitespace pads the document to exactly n bytes.
        return new TextEncoder().encode(base.slice(0, -1) + ' '.repeat(n - base.length) + '}');
      };
      const m = mundo();
      semear(m, registro());
      m.rotas.feed = [feedEm('DONE')];
      m.rotas.documento = [
        {
          corpo: { feedDocumentId: 'doc-rel-1', url: URL_RELATORIO, compressionAlgorithm: 'GZIP' },
        },
      ];
      m.rotas.relatorio = [
        {
          bytes: new Uint8Array(
            gzipSync(relatorioDeTamanho(MAX_RELATORIO_JSON_BYTES), { level: 1 }),
          ),
        },
      ];
      expect(await m.resultado(rodada(0))).toMatchObject({ relatorio: 'baixado' });
      expect(m.espiao.gravacoes).toHaveLength(1);

      const n = mundo();
      semear(n, registro());
      n.rotas.feed = [feedEm('DONE')];
      n.rotas.documento = m.rotas.documento;
      n.rotas.relatorio = [
        {
          bytes: new Uint8Array(
            gzipSync(relatorioDeTamanho(MAX_RELATORIO_JSON_BYTES + 1), { level: 1 }),
          ),
        },
      ];
      expect(await n.resultado(rodada(0))).toMatchObject({
        relatorio: 'falhou',
        motivoRelatorio: 'grande-demais',
        desfecho: 'concluido',
      });
      expect(n.espiao.gravacoes).toEqual([]);
      expect(reg(n)).toMatchObject({ status: 'concluido', resultado: null });
    },
  );

  it('a seam with no provider still downloads, counts and ends the feed; the write-back and the aviso are skipped', async () => {
    const m = mundo();
    m.provedores.estoque = null;
    semear(m, registro());
    m.rotas.feed = [feedEm('DONE')];
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({ desfecho: 'concluido', semProvedor: true, aviso: null });
    expect(reg(m)).toMatchObject({ status: 'concluido', skusComProblema: 2 });
    expect(avisoDe(m)).toBeUndefined();
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toHaveLength(1);
  });
});

describe('★ duplicates: the notification first, the poll second', () => {
  it('ONE download, ONE write-back, ONE recovery: the second finds the record terminal', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('DONE')];
    m.relogio = ANTES + MIN;
    const primeiro = await m.resultado(rodada(0, ORIGEM_RESULTADO_FEED_AMAZON.notificacao, null));
    expect(primeiro).toMatchObject({ acao: 'encerrado', contaId: CONTA, desfecho: 'concluido' });

    m.relogio = ANTES + 2 * MIN;
    const segundo = await m.resultado(rodada(0));
    expect(segundo).toMatchObject({ acao: ACAO_RESULTADO_FEED.feedJaConcluido });
    expect([doAmazon(m, 'GET feed'), doAmazon(m, 'GET relatorio')]).toEqual([1, 1]);
    expect(m.espiao.gravacoes).toHaveLength(1);
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toHaveLength(1);
  });
});

describe('★ the TAIL is idempotent: a crash anywhere re-runs it', () => {
  it('a throw after the recovery enqueue and before the terminal write ⇒ the retry: one recovery (the name), released ONCE, the report NOT downloaded again, the record terminal', async () => {
    const m = mundo();
    semear(m, registro());
    // A FATAL raises the aviso: that write fails after the release.
    m.rotas.feed = [feedEm('FATAL')];
    m.fake.falharEscrita(AVISO, grpc(14, 'indisponível'));
    await expect(m.resultado(rodada(0))).rejects.toThrow();
    expect(lease(m)?.estado).toBe('livre');
    expect(reg(m)?.status).toBe('processando');
    m.fake.falharEscrita(AVISO, null);

    m.relogio += MIN;
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({
      acao: 'encerrado',
      relatorio: 'reaproveitado',
      recuperacao: 'ja-enfileirada',
      liberacao: 'livre',
    });
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toHaveLength(1);
    expect(m.fake.escritasEm(VEZ)).toHaveLength(1);
    expect([doAmazon(m, 'GET documento'), doAmazon(m, 'GET relatorio')]).toEqual([1, 1]);
    expect(m.espiao.gravacoes).toHaveLength(1);
    expect(reg(m)?.status).toBe('falhou');
  });

  it('a throw on the release (the lease write) ⇒ the retry re-enqueues the SAME recovery and releases once', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('FATAL')];
    m.fake.falharEscrita(VEZ, grpc(14, 'indisponível'));
    await expect(m.resultado(rodada(0))).rejects.toThrow();
    expect(lease(m)?.estado).toBe('enviado');
    m.fake.falharEscrita(VEZ, null);
    await m.resultado(rodada(0));
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toHaveLength(1);
    expect(m.fake.escritasEm(VEZ)).toHaveLength(1);
    expect(lease(m)).toMatchObject({ estado: 'livre', falhasSeguidas: 2 });
    expect(reg(m)?.status).toBe('falhou');
  });

  it('★ the tail folds the lease’s start into its OWN recovery (no separate vez); a SMALLER start written before the release ⇒ the 9 re-read hands it to ONE vez', async () => {
    const m = mundo();
    const dobrado = AGORA_MS - 3 * MIN;
    const menor = AGORA_MS - 8 * MIN;
    semear(m, registro(), vez({ pendenteDesdeMs: dobrado }));
    m.rotas.feed = [feedEm('DONE')];
    m.fake.antesDaProximaEscrita(VEZ, () => {
      const atual = lease(m);
      if (atual === undefined) throw new Error('sem vez');
      m.fake.seed(VEZ, { ...atual, pendenteDesdeMs: menor });
    });
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({ pendenteDobrado: dobrado, vezPara: menor, liberacao: 'liberada' });
    const recuperacoes = daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar);
    expect(recuperacoes.map((x) => x.nome)).toEqual([
      nomeRecuperacaoFeed(CONTA, FEED, dobrado),
      nomeRecuperacaoFeed(CONTA, referenciaVezFeed(FEED), menor),
    ]);
    expect(recuperacoes[0]?.tarefa).toMatchObject({
      desfecho: 'concluido',
      pendenteDesdeMs: dobrado,
    });
    expect(recuperacoes[1]?.vez).toMatchObject({ estado: 'enviado', pendenteDesdeMs: menor });
    expect(lease(m)).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });

  it('★ NEAR-MISS: a LARGER start written before the release ⇒ NO vez (the folded start covers it)', async () => {
    const m = mundo();
    const dobrado = AGORA_MS - 8 * MIN;
    semear(m, registro(), vez({ pendenteDesdeMs: dobrado }));
    m.rotas.feed = [feedEm('DONE')];
    m.fake.antesDaProximaEscrita(VEZ, () => {
      const atual = lease(m);
      if (atual === undefined) throw new Error('sem vez');
      m.fake.seed(VEZ, { ...atual, pendenteDesdeMs: AGORA_MS - 3 * MIN });
    });
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({ vezPara: null, liberacao: 'liberada' });
    expect(daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)).toHaveLength(1);
  });

  it('★ a throw between that vez enqueue and the release write ⇒ the retry covers the smaller start (its own recovery folds it), the vez enqueued ONCE, the lease released ONCE', async () => {
    const m = mundo();
    const dobrado = AGORA_MS - 3 * MIN;
    const menor = AGORA_MS - 8 * MIN;
    semear(m, registro(), vez({ pendenteDesdeMs: dobrado }));
    m.rotas.feed = [feedEm('DONE')];
    m.fake.antesDaProximaEscrita(VEZ, () => {
      const atual = lease(m);
      if (atual === undefined) throw new Error('sem vez');
      m.fake.seed(VEZ, { ...atual, pendenteDesdeMs: menor });
    });
    m.aoEnfileirar = (x) => {
      if (
        x.tarefa.tipo === TIPO_TAREFA_LOTE_AMAZON.recuperar &&
        x.tarefa.desfecho === DESFECHO_RECUPERACAO_FEED_AMAZON.vez
      ) {
        m.fake.falharEscrita(VEZ, grpc(14, 'indisponível'));
      }
    };
    await expect(m.resultado(rodada(0))).rejects.toThrow();
    expect(lease(m)).toMatchObject({ estado: 'enviado', pendenteDesdeMs: menor });
    m.fake.falharEscrita(VEZ, null);
    m.aoEnfileirar = null;

    await m.resultado(rodada(0));
    const recuperacoes = daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar);
    expect(
      recuperacoes.filter(
        (x) =>
          x.tarefa.tipo === TIPO_TAREFA_LOTE_AMAZON.recuperar &&
          x.tarefa.desfecho === DESFECHO_RECUPERACAO_FEED_AMAZON.vez,
      ),
    ).toHaveLength(1);
    // The retry's read shows the smaller start: its own recovery folds it.
    expect(recuperacoes.map((x) => x.nome)).toContain(nomeRecuperacaoFeed(CONTA, FEED, menor));
    expect(m.fake.escritasEm(VEZ).filter((w) => w.dados?.estado === 'livre')).toHaveLength(1);
    expect(lease(m)).toMatchObject({ estado: 'livre', pendenteDesdeMs: null });
  });
});

describe('★ the tail’s clock: the STORED relogioDesfecho', () => {
  it('stored ONCE, from the first dispatch’s record read, BEFORE the download; every later attempt reuses it', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('DONE')];
    m.rotas.relatorio = [{ status: 503 }];
    await expect(m.resultado(rodada(0))).rejects.toThrow();
    const primeiro = m.fake.ler(REG())?.relogioDesfecho;
    expect(ehRelogio(primeiro)).toBe(true);
    m.rotas.relatorio = [{ status: 200, bytes: JSON.stringify(RELATORIO) }];
    await m.resultado(rodada(0));
    expect(m.fake.ler(REG())?.relogioDesfecho).toEqual(primeiro);
    expect(m.espiao.gravacoes[0]?.relogio).toMatchObject(primeiro as RelogioGuardado);
  });

  it('★ a retried tail of feed F1 after feed F2’s send raised motivoFalha resolves with F1’s stored clock — and leaves F2’s raise open (NEAR-MISS: a fresh clock closes it)', async () => {
    const preparar = (comRelogioAntigo: boolean) => {
      const m = mundo();
      const antigo = m.fake.carimboDe(caminhoConta(CONTA)) as CarimboFake;
      const r = registro();
      m.fake.seed(
        REG(),
        comRelogioAntigo
          ? { ...r, relogioDesfecho: { seconds: antigo.seconds, nanoseconds: antigo.nanoseconds } }
          : r,
      );
      m.fake.seed(VEZ, vez());
      m.rotas.feed = [feedEm('DONE')];
      return m;
    };
    const levantarDeF2 = async (m: Mundo) => {
      await avisarContaDoLoteAmazon(
        m.db,
        { agora: () => m.relogio, increment, logger: m.log.logger },
        CONTA,
        MOTIVO_CONTA_AMAZON.contaSemOperacao,
        m.fake.carimboDe(VEZ) as CarimboFake,
      );
    };

    const m = preparar(true);
    await levantarDeF2(m);
    const r = await m.resultado(rodada(0));
    expect(r).toMatchObject({ desfecho: 'concluido', aviso: 'resolvido' });
    expect(avisoDe(m)).toMatchObject({ resolvidoEm: null });

    const n = preparar(false);
    await levantarDeF2(n);
    await n.resultado(rodada(0));
    expect(avisoDe(n)?.resolvidoEm).not.toBeNull();
  });
});

describe('★ the breaker, from the tail’s side', () => {
  it('a third failure opens it; a window batch inside the hour goes as patches; an hour later ONE window batch probes, and its DONE closes it', async () => {
    const m = mundo();
    semear(m, registro(), vez({ falhasSeguidas: 2 }));
    m.rotas.feed = [feedEm('FATAL')];
    await m.resultado(rodada(0));
    const falhouEm = m.relogio;
    expect(lease(m)).toMatchObject({
      estado: 'livre',
      falhasSeguidas: 3,
      ultimaFalhaEmMs: falhouEm,
    });

    m.relogio = falhouEm + 10 * MIN;
    const fechada = await m.enviar(janelaDoTick('exec-janela-b'));
    expect(fechada).toMatchObject({ acao: ACAO_ENVIO_FEED.repassado, motivo: 'disjuntor' });
    expect(doAmazon(m, 'POST feed')).toBe(0);

    m.relogio = falhouEm + ESPERA_SONDA_DISJUNTOR_MS;
    m.rotas.criarFeed = [{ status: 202, corpo: { feedId: FEED_2 } }];
    const sonda = await m.enviar(janelaDoTick('exec-janela-sonda'));
    expect(sonda).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, sonda: true, feedId: FEED_2 });

    // A second window batch meeting the probe's lease is recorded, never a second probe.
    m.relogio += MIN;
    const segunda = await m.enviar(janelaDoTick('exec-janela-c'));
    expect(segunda).toMatchObject({ acao: ACAO_ENVIO_FEED.pendenteRegistrado });

    m.relogio += 2 * MIN;
    m.rotas.feed = [
      {
        status: 200,
        corpo: { feedId: FEED_2, processingStatus: 'DONE', resultFeedDocumentId: 'doc-rel-2' },
      },
    ];
    const fim = await m.resultado(rodada(0, ORIGEM_RESULTADO_FEED_AMAZON.consulta, CONTA, FEED_2));
    expect(fim).toMatchObject({ desfecho: 'concluido' });
    expect(lease(m)).toMatchObject({ estado: 'livre', falhasSeguidas: 0, pendenteDesdeMs: null });

    m.relogio += ESPACO_MINIMO_ENTRE_FEEDS_MS;
    m.rotas.criarFeed = [{ status: 202, corpo: { feedId: '50001111111' } }];
    const depois = await m.enviar(janelaDoTick('exec-janela-d'));
    expect(depois).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, sonda: false });
  });
});

describe('★ the submission floor, across a fast DONE', () => {
  it('a feed released 90 s after antesDoEnvioMs ⇒ the next send waits 30 s UNNAMED, zero lease writes, and submits at 120 s', async () => {
    const m = mundo();
    semear(m, registro({ antesDoEnvioMs: AGORA_MS }), vez({ antesDoEnvioMs: AGORA_MS }));
    m.relogio = AGORA_MS + 90_000;
    m.rotas.feed = [feedEm('DONE')];
    await m.resultado(rodada(0, ORIGEM_RESULTADO_FEED_AMAZON.notificacao, null));
    expect(lease(m)?.estado).toBe('livre');
    const escritasAntes = m.fake.escritasEm(VEZ).length;

    const espera = await m.enviar(janelaDoTick('exec-depois-rapido'));
    expect(espera).toMatchObject({ acao: ACAO_ENVIO_FEED.aguardando, atrasoS: 30 });
    expect(m.fake.escritasEm(VEZ)).toHaveLength(escritasAntes);
    const reenvio = m.enfileiradas.at(-1);
    expect(reenvio).toMatchObject({ nome: null, atrasoS: 30 });

    m.relogio = AGORA_MS + ESPACO_MINIMO_ENTRE_FEEDS_MS;
    m.rotas.criarFeed = [{ status: 202, corpo: { feedId: FEED_2 } }];
    const envio = await m.enviar(janelaDoTick('exec-depois-rapido'));
    expect(envio).toMatchObject({ acao: ACAO_ENVIO_FEED.enviado, feedId: FEED_2 });
    expect(lease(m)?.ultimoEnvioMs).toBeGreaterThanOrEqual(AGORA_MS + ESPACO_MINIMO_ENTRE_FEEDS_MS);
  });
});

describe('★ a fake PRICE provider drives send → result → recovery, through the dispatcher, with no stock import', () => {
  it('every enqueued task is dispatched in turn; the lines say evento preco', async () => {
    const m = mundo();
    m.provedores.estoque = null;
    const t = blocos('exec-preco-1', FLUXO_FEED_AMAZON.preco);
    const envio = await m.despachar(t);
    expect(envio).toMatchObject({ tipo: 'feed-enviar', r: { acao: 'enviado', feedId: FEED } });
    expect(lease(m, VEZ_PRECO)).toMatchObject({ estado: 'enviado', feedId: FEED });
    expect(reg(m)).toMatchObject({ fluxo: 'preco', tipoLote: 'blocos', janela: null });

    // Rung 0, as the queue dispatches it.
    const rung0 = daFila(m, TIPO_TAREFA_LOTE_AMAZON.resultado)[0]?.tarefa;
    m.rotas.feed = [feedEm('DONE')];
    m.relogio += 2 * MIN;
    const resultado = await m.despachar(rung0 as TarefaLoteAmazon);
    expect(resultado).toMatchObject({
      tipo: 'feed-resultado',
      r: { fluxo: 'preco', desfecho: 'concluido', relatorio: 'baixado' },
    });
    expect(m.espiao.gravacoes).toHaveLength(1);
    expect(lease(m, VEZ_PRECO)).toMatchObject({ estado: 'livre', falhasSeguidas: 0 });

    // The recovery, as the queue dispatches it.
    const recuperar = daFila(m, TIPO_TAREFA_LOTE_AMAZON.recuperar)[0]?.tarefa;
    const recuperado = await m.despachar(recuperar as TarefaLoteAmazon);
    expect(recuperado).toMatchObject({
      tipo: 'feed-recuperar',
      r: { acao: 'recuperado', resposta: 'tarefas', tarefas: 3, referencia: FEED },
    });
    expect(m.espiao.recuperacoes).toEqual([
      {
        desfecho: 'concluido',
        snapshotEmMs: expect.any(Number) as number,
        pendenteDesdeMs: null,
        referencia: FEED,
        janela: null,
      },
    ]);
    const eventos = new Set(
      m.log.linhas.map((l) => l.meta?.evento).filter((e) => e === 'preco' || e === 'estoque'),
    );
    expect([...eventos]).toEqual(['preco']);
  });
});

describe('R8 — the ONE dispatch line', () => {
  it('evento of the record’s fluxo, fase resultado — never a SKU, an issue message, a URL or a seller id', async () => {
    const m = mundo();
    semear(m, registro());
    m.rotas.feed = [feedEm('DONE')];
    await m.resultado(rodada(0));
    const linhas = m.log.linhas.filter((l) => l.meta?.fase === 'resultado');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toMatchObject({ evento: 'estoque', acao: 'encerrado', feedId: FEED });
    const tudo = JSON.stringify(m.log.linhas);
    expect(tudo).not.toContain('SKU-TESTE-01');
    expect(tudo).not.toContain('texto-da-amazon-sentinela');
    expect(tudo).not.toContain('relatorio-sentinela');
    expect(tudo).not.toContain(SPID_A);
  });
});

describe('record writes and the successor enqueue', () => {
  it('a record write that fails for any reason but a lost precondition PROPAGATES as itself (never a conflict)', async () => {
    const m = mundo();
    semear(m, registro());
    m.fake.falharEscrita(REG(), grpc(14, 'indisponível'));
    await expect(m.resultado(rodada(0))).rejects.toMatchObject({ code: 14 });
  });

  it(`★ ${String(MAX_TENTATIVAS_REGISTRO_FEED)} lost record preconditions in a row ⇒ AmazonRegistroFeedEmConflitoError, the rung write never lands (NEAR-MISS: two losses, the third attempt lands)`, async () => {
    // A concurrent writer moves the record between each attempt's read and its write.
    const perder = (m: Mundo, vezes: number) => {
      for (let i = 0; i < vezes; i += 1) {
        m.fake.antesDaProximaEscrita(REG(), () => {
          m.fake.seed(REG(), { ...m.fake.ler(REG()) });
        });
      }
    };
    const m = mundo();
    semear(m, registro());
    perder(m, MAX_TENTATIVAS_REGISTRO_FEED);
    const erro: unknown = await m.resultado(rodada(0)).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(AmazonRegistroFeedEmConflitoError);
    expect((erro as AmazonRegistroFeedEmConflitoError).tentativas).toBe(3);
    expect(m.fake.escritasEm(REG())).toEqual([]);
    expect(reg(m)).toMatchObject({ status: 'enviado' });

    const quase = mundo();
    semear(quase, registro());
    perder(quase, MAX_TENTATIVAS_REGISTRO_FEED - 1);
    await quase.resultado(rodada(0));
    expect(quase.fake.escritasEm(REG())).toHaveLength(1);
    expect(reg(quase)).toMatchObject({ status: 'processando' });
  });

  it('a successor enqueue that fails transiently throws BEFORE any Amazon call', async () => {
    const m = mundo();
    semear(m, registro());
    m.falhasDaFila.push(() => falhaDoFunctions('unavailable'));
    await expect(m.resultado(rodada(0))).rejects.toThrow();
    expect(m.chamadas).toEqual([]);
  });
});
