/**
 * The Amazon push receiver (master plan step 3, PR 3-c): what
 * `POST /api/webhooks/amazon` does with one delivery from the AWS relay
 * (SQS → EventBridge Pipe → API destination). The route is THIN; every
 * decision lives here, with every dependency injected — the clock and the
 * deadline timer included.
 *
 * ## The answer table (step-3 plan §3 decision 18)
 *
 * | answer | when |
 * | --- | --- |
 * | 503 | the receiver is not configured (nothing was read) |
 * | 401 | the relay key did not match (the body was never read) |
 * | 500 | a failure could not be persisted in time — or anything unexpected (rethrown) |
 * | 200 | everything else, EVERY drop included |
 *
 * Never 400, 404 or 413 (D5): 401, 5xx and timeouts are what the API
 * destination retries, then dead-letters; any other 4xx is not retried and may
 * feed the pipe's auto-disable.
 *
 * ## The order of operations
 *
 *  1. CONFIG, before reading anything ⇒ 503 with ONE WARNING naming the refused
 *     KEYS: the relay secret (32–512 visible ASCII), the previous one when set,
 *     `AMAZON_APPLICATION_ID` (the package's `applicationIdValido`) and the
 *     queue's region (`MissingRegionError`, or outside the queue path's grammar).
 *  2. AUTH: `CABECALHO_CHAVE_RELAY_AMAZON` against the current secret AND, when
 *     one is set, the previous one — BOTH comparisons always run, through the
 *     shared constant-time `verifyStaticSecret`. Neither ⇒ 401, body unread.
 *     The match is kept as `chave: atual | anterior` (the current wins) on every
 *     later line, so a rotation can be verified from the logs. While a previous
 *     secret is configured, ONE WARNING per instance says the rotation is open.
 *  3. BODY, bounded at 2 MiB (`corpo.ts`: twice SQS's 1 MiB maximum, so a
 *     bound on the read, never a filter on Amazon's input) ⇒ over it,
 *     `corpo-grande`.
 *  4. JSON ⇒ `json-invalido`.
 *  5. The relay WRAPPER (`envelope.ts`) ⇒ `sem-envelope-do-relay`.
 *  6. TYPE and CASING ⇒ `forma-ambigua`, `sem-tipo`, `tipo-desconhecido`.
 *  7. `ApplicationId` must EQUAL ours, with no trim and no fold ⇒
 *     `aplicacao-estrangeira`, logged with an 8-hex sha256 prefix of the
 *     received id, never the id (§5 risk 1).
 *  8. ROUTING fields by grammar ⇒ `campo-invalido:<wire name>`.
 *  9. `FEED_PROCESSING_FINISHED` ⇒ `feed-sem-consumidor` until step 12a.
 * 10. ENQUEUE the ids-only push payload, raced against
 *     {@link PRAZO_ENFILEIRAMENTO_RECEPTOR_MS} (`prazo.ts`) ⇒ 200.
 * 11. An enqueue failure of the four CONTAINED classes (the valve, a named
 *     transient, the deadline, a raw SDK error) is persisted as `failed` under
 *     the deterministic `push:` id, raced against
 *     {@link PRAZO_PERSISTENCIA_RECEPTOR_MS} ⇒ 200; a `ZodError` from the
 *     persist ⇒ 200 + `falha-nao-persistivel`; the persist's deadline ⇒ 500;
 *     anything else, from either, is RETHROWN (500, which the pipe retries).
 *
 * ## The payload is ids only, STRIPPED
 *
 * `{ tipo, origem: 'push', sellerId, amazonOrderId, notificationId,
 * publishTimeMs }`, built field by field. ⚠️ A declared departure from the
 * `webhook-notifications` skill's `.passthrough()` / normalize-then-safeParse
 * rule (step-3 plan §3 decision 29): the body carries buyer data, D5 forbids
 * mapping it, and the task re-fetches the order. The payload is checked
 * against the task schema BEFORE the enqueue: the dispatched task drops a
 * payload its schema refuses, without a trace.
 *
 * ## One line per delivery (`evento: 'notificacao'`)
 *
 * `chave`, `forma`, `casing`, `tipo`, `resultado`, `detalhe`, `bytes`,
 * `amazonOrderId`, `atrasoMs` (now − `PublishTime`), `duracaoMs` (receipt to
 * answer) and the envelope's `idNotificacao` (`push:<NotificationId>`, the
 * task's own). NEVER the seller id, the raw application id, a header or any
 * body text. A late enqueue rejection adds one line of its own (`prazo.ts`).
 *
 * D11: no Amazon call and no Amazon client here (`estrutura.test.ts`). The only
 * outbound call is the Cloud Tasks enqueue; the happy path touches no
 * Firestore (`db` is resolved only to persist a failure).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import { MissingRegionError } from '@delfrance/core/region';
import { sha256Hex } from '@delfrance/data/admin';
import { verifyStaticSecret } from '@delfrance/data/admin/signatures';
import {
  CABECALHO_CHAVE_RELAY_AMAZON,
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
} from '@delfrance/schemas';

import {
  type AmbienteAmazon,
  type ConfigReceptorAmazon,
  TASKS_REGION_ENV,
  lerConfigDoReceptorAmazon,
} from '../env';
import {
  type CampoLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import {
  type AgendadorAmazon,
  AmazonTarefasDesligadasError,
  AmazonTarefasTransitoriasError,
  type FalhaDeEnfileiramentoAmazon,
  descreverFalhaDeEnfileiramentoAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
  regiaoDaFilaValidaAmazon,
} from './agendador';
import { MAX_CORPO_RECEPTOR_BYTES, lerCorpoLimitado } from './corpo';
import {
  type CasingAmazon,
  type FormaDoRelayAmazon,
  TIPO_FEED_PROCESSING_FINISHED,
  desembrulharRelay,
  lerEnvelopeAmazon,
} from './envelope';
import {
  type PayloadNotificacaoAmazon,
  docIdNotificacaoAmazon,
  persistirFalhaNotificacaoAmazon,
} from './notificacao';
import {
  type AgendadorDePrazoAmazon,
  agendarPrazoPadraoAmazon,
  correrComPrazoAmazon,
} from './prazo';

/**
 * The enqueue's deadline. With the persist's, a 500-ms allowance for the
 * auth, the bounded body and the parse, and a 1-s margin, it fits the API
 * destination's 5-s timeout (`prazos.test.ts`): a Cloud Tasks hiccup becomes a
 * persisted document and a 200, never a pipe failure. A cold start is outside
 * this budget (§3 decision 16).
 */
export const PRAZO_ENFILEIRAMENTO_RECEPTOR_MS = 2000;
/** The failure persist's deadline (see {@link PRAZO_ENFILEIRAMENTO_RECEPTOR_MS}). */
export const PRAZO_PERSISTENCIA_RECEPTOR_MS = 1500;

/** What the receiver reads off the request: `Request` satisfies it. */
export interface RequisicaoReceptorAmazon {
  readonly headers: { get(nome: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

/** Per-instance memory: the rotation WARNING is written once per instance. */
export interface EstadoDaInstanciaReceptorAmazon {
  rotacaoAvisada: boolean;
}

export function criarEstadoDaInstanciaReceptorAmazon(): EstadoDaInstanciaReceptorAmazon {
  return { rotacaoAvisada: false };
}

export interface DepsReceptorAmazon {
  /** The process environment (the relay secrets and the application id). */
  readonly ambiente: AmbienteAmazon;
  /** The composition root's region resolver: throws `MissingRegionError` when unset. */
  readonly regiao: () => string;
  /** The reads-queue producer (`agendador.ts`), bound by the root. */
  readonly agendador: AgendadorAmazon;
  /** The Admin Firestore, resolved ONLY to persist a failure. */
  readonly db: () => Firestore;
  readonly logger: LoggerAmazon;
  /** Now, in milliseconds. */
  readonly agora: () => number;
  readonly instancia: EstadoDaInstanciaReceptorAmazon;
  /** The deadline timer; the production one is an unref'd `setTimeout`. */
  readonly agendarPrazo?: AgendadorDePrazoAmazon;
}

export type StatusReceptorAmazon = 200 | 401 | 500 | 503;

/**
 * - `enfileirada`: on the reads queue;
 * - `descartada`: acknowledged and dropped (never ours, or unusable);
 * - `persistida`: the enqueue failed, the `failed` document is durable;
 * - `recusada`: 503 (config) or 401 (key);
 * - `falhou`: 500 — not durable, the relay redelivers.
 */
export type ResultadoReceptorAmazon =
  | 'enfileirada'
  | 'descartada'
  | 'persistida'
  | 'recusada'
  | 'falhou';

export interface RespostaReceptorAmazon {
  readonly status: StatusReceptorAmazon;
  readonly resultado: ResultadoReceptorAmazon;
  readonly detalhe: string;
}

/** The detail of a drop: why a delivery was acknowledged and not enqueued. */
export const MOTIVO_DESCARTE_RECEPTOR_AMAZON = {
  corpoGrande: 'corpo-grande',
  jsonInvalido: 'json-invalido',
  semEnvelopeDoRelay: 'sem-envelope-do-relay',
  formaAmbigua: 'forma-ambigua',
  semTipo: 'sem-tipo',
  tipoDesconhecido: 'tipo-desconhecido',
  aplicacaoEstrangeira: 'aplicacao-estrangeira',
  feedSemConsumidor: 'feed-sem-consumidor',
  falhaNaoPersistivel: 'falha-nao-persistivel',
} as const;

/** The 8-hex sha256 prefix a foreign application id is logged as: tells two ids apart, reveals neither. */
export function digestCurto(valor: string): string {
  return sha256Hex(valor).slice(0, 8);
}

/** Everything the delivery's one line may carry — all primitives, every key always present. */
interface LinhaDaEntrega {
  chave: 'atual' | 'anterior' | null;
  forma: FormaDoRelayAmazon | null;
  casing: CasingAmazon | null;
  tipo: string | null;
  bytes: number | null;
  amazonOrderId: string | null;
  atrasoMs: number | null;
  /** Set only on the line that needs it (refused keys, a foreign app id's digest). */
  extras: Readonly<Record<string, CampoLogAmazon>>;
  idNotificacao: string | null;
}

const MENSAGEM: Readonly<Record<ResultadoReceptorAmazon, string>> = {
  enfileirada: '[amazon/receptor] notificação enfileirada',
  descartada: '[amazon/receptor] notificação descartada (200)',
  persistida: '[amazon/receptor] enfileiramento falhou — notificação persistida para a varredura',
  recusada: '[amazon/receptor] entrega recusada',
  falhou: '[amazon/receptor] entrega não pôde ser registrada — 5xx, o relay reentrega',
};

/** The class name of whatever was thrown, for a log line — never its message. */
function nomeDaClasse(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const nome: unknown = (err as { name?: unknown }).name;
    if (typeof nome === 'string' && nome !== '') return nome;
    return '<objeto>';
  }
  return typeof err;
}

/**
 * Receive one delivery (module header). Returns the answer; RETHROWS what no
 * branch contains, after writing the delivery's line (rule 6).
 */
export async function receberNotificacaoAmazon(
  req: RequisicaoReceptorAmazon,
  deps: DepsReceptorAmazon,
): Promise<RespostaReceptorAmazon> {
  const inicio = deps.agora();
  const agendarPrazo = deps.agendarPrazo ?? agendarPrazoPadraoAmazon;
  const linha: LinhaDaEntrega = {
    chave: null,
    forma: null,
    casing: null,
    tipo: null,
    bytes: null,
    amazonOrderId: null,
    atrasoMs: null,
    extras: {},
    idNotificacao: null,
  };

  const responder = (
    severidade: SeveridadeAmazon,
    status: StatusReceptorAmazon,
    resultado: ResultadoReceptorAmazon,
    detalhe: string,
  ): RespostaReceptorAmazon => {
    const campos: Record<string, CampoLogAmazon> = {
      ...linha.extras,
      status,
      resultado,
      detalhe,
      chave: linha.chave,
      forma: linha.forma,
      casing: linha.casing,
      tipo: linha.tipo,
      bytes: linha.bytes,
      amazonOrderId: linha.amazonOrderId,
      atrasoMs: linha.atrasoMs,
      duracaoMs: deps.agora() - inicio,
    };
    registrarEventoAmazon(deps.logger, 'notificacao', severidade, MENSAGEM[resultado], campos, {
      idNotificacao: linha.idNotificacao,
    });
    return { status, resultado, detalhe };
  };
  const descartar = (severidade: SeveridadeAmazon, detalhe: string) =>
    responder(severidade, 200, 'descartada', detalhe);

  // 1. Configuration, before anything is read.
  const config = lerConfigDoReceptorAmazon(deps.ambiente);
  const recusadas = config.completa ? [] : [...config.faltando];
  let regiaoValida: boolean;
  try {
    regiaoValida = regiaoDaFilaValidaAmazon(deps.regiao());
  } catch (err) {
    if (!(err instanceof MissingRegionError)) throw err;
    regiaoValida = false;
  }
  if (!regiaoValida) recusadas.push(TASKS_REGION_ENV);
  if (!config.completa || recusadas.length > 0) {
    linha.extras = { chaves: recusadas.join(',') };
    return responder('WARNING', 503, 'recusada', 'config');
  }

  // 2. The relay key — both comparisons, always.
  avisarRotacaoAberta(config, deps);
  const recebida = req.headers.get(CABECALHO_CHAVE_RELAY_AMAZON);
  const casaAtual = verifyStaticSecret({ received: recebida, expected: config.segredoAtual });
  const casaAnterior =
    config.segredoAnterior === null
      ? false
      : verifyStaticSecret({ received: recebida, expected: config.segredoAnterior });
  if (!casaAtual && !casaAnterior) {
    return responder(
      'WARNING',
      401,
      'recusada',
      recebida === null || recebida === '' ? 'chave-ausente' : 'chave-invalida',
    );
  }
  linha.chave = casaAtual ? 'atual' : 'anterior';

  // 3. The body, bounded.
  const corpo = await lerCorpoLimitado(
    req.body,
    req.headers.get('content-length'),
    MAX_CORPO_RECEPTOR_BYTES,
  );
  linha.bytes = corpo.bytes;
  if (corpo.tipo === 'grande') {
    return descartar('WARNING', MOTIVO_DESCARTE_RECEPTOR_AMAZON.corpoGrande);
  }

  // 4. JSON.
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(corpo.dados));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return descartar('WARNING', MOTIVO_DESCARTE_RECEPTOR_AMAZON.jsonInvalido);
  }

  // 5. The relay wrapper.
  const relay = desembrulharRelay(json);
  linha.forma = relay.forma;
  if (relay.tipo === 'descartada') return descartar('WARNING', relay.motivo);

  // 6. Type and casing.
  const envelope = lerEnvelopeAmazon(relay.envelope);
  linha.casing = envelope.casing;
  if (envelope.tipo === 'descartada') {
    linha.tipo = envelope.tipoNotificacao;
    return descartar(envelope.motivo === 'tipo-desconhecido' ? 'INFO' : 'WARNING', envelope.motivo);
  }
  linha.tipo = envelope.tipo;

  // 7. Ours, exactly — then 8, the routing fields. Both types, in that order.
  const estrangeira = (applicationId: string | null) => {
    linha.extras = {
      aplicacaoDigest: applicationId === null ? null : digestCurto(applicationId),
    };
    return descartar('WARNING', MOTIVO_DESCARTE_RECEPTOR_AMAZON.aplicacaoEstrangeira);
  };
  const campoInvalido = (campo: string) => descartar('WARNING', `campo-invalido:${campo}`);

  // 9. A feed result is checked like any delivery, then dropped: no consumer
  // before step 12a (§3 decision 17).
  if (envelope.tipo === TIPO_FEED_PROCESSING_FINISHED) {
    const feed = envelope.leitura;
    if (feed.applicationId !== config.applicationId) return estrangeira(feed.applicationId);
    if (feed.tipo === 'campo-invalido') return campoInvalido(feed.campo);
    return descartar('INFO', MOTIVO_DESCARTE_RECEPTOR_AMAZON.feedSemConsumidor);
  }
  const pedido = envelope.leitura;
  if (pedido.applicationId !== config.applicationId) return estrangeira(pedido.applicationId);
  if (pedido.tipo === 'campo-invalido') return campoInvalido(pedido.campo);

  const payload: PayloadNotificacaoAmazon = {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.push,
    sellerId: pedido.campos.sellerId,
    amazonOrderId: pedido.campos.amazonOrderId,
    notificationId: pedido.campos.notificationId,
    publishTimeMs: pedido.campos.publishTimeMs,
  };
  linha.amazonOrderId = payload.amazonOrderId;
  linha.atrasoMs = inicio - payload.publishTimeMs;
  // `docIdNotificacaoAmazon` runs the TASK schema over the payload (a TypeError
  // otherwise) — the gate the dispatched task would apply silently, run here,
  // before the enqueue. Every field already passed its grammar, so it holds.
  linha.idNotificacao = docIdNotificacaoAmazon(payload);

  // 10. Enqueue, against the deadline.
  const aoRejeitarTarde = (operacao: 'enfileiramento' | 'persistencia') => (erro: unknown) => {
    registrarRejeicaoTardia(deps, linha, operacao, erro);
  };
  const enfileiramento = await correrComPrazoAmazon(
    () => deps.agendador.enfileirar(payload),
    PRAZO_ENFILEIRAMENTO_RECEPTOR_MS,
    { agendarPrazo, aoRejeitarTarde: aoRejeitarTarde('enfileiramento') },
  );
  if (enfileiramento.tipo === 'concluida') {
    return responder('INFO', 200, 'enfileirada', 'ok');
  }

  // 11. The enqueue failed: contain the four classes, rethrow the rest.
  let falha: FalhaDeEnfileiramentoAmazon;
  if (enfileiramento.tipo === 'prazo') {
    falha = AmazonTarefasTransitoriasError.porPrazo();
  } else {
    const err = enfileiramento.erro;
    if (
      err instanceof AmazonTarefasDesligadasError ||
      err instanceof AmazonTarefasTransitoriasError ||
      ehFalhaDoSdkDeTarefasAmazon(err)
    ) {
      falha = err;
    } else {
      responder('ERROR', 500, 'falhou', `enfileiramento/${nomeDaClasse(err)}`);
      throw err;
    }
  }
  const motivo = `enfileiramento/${descreverFalhaDeEnfileiramentoAmazon(falha)}`;
  const persistencia = await correrComPrazoAmazon(
    () => persistirFalhaNotificacaoAmazon(deps.db(), payload, motivo),
    PRAZO_PERSISTENCIA_RECEPTOR_MS,
    { agendarPrazo, aoRejeitarTarde: aoRejeitarTarde('persistencia') },
  );
  if (persistencia.tipo === 'concluida') {
    // A raw SDK error is deploy-shaped (IAM, no queue in that region): the
    // sweep still drains it, but someone must look.
    return responder(
      ehFalhaDoSdkDeTarefasAmazon(falha) ? 'ERROR' : 'WARNING',
      200,
      'persistida',
      motivo,
    );
  }
  if (persistencia.tipo === 'prazo') {
    // Retried by the relay; a persist landing late is absorbed by the retried
    // delivery's `create` hitting ALREADY_EXISTS.
    return responder('ERROR', 500, 'falhou', 'persistencia/prazo');
  }
  const err = persistencia.erro;
  if (err instanceof ZodError) {
    return descartar('ERROR', MOTIVO_DESCARTE_RECEPTOR_AMAZON.falhaNaoPersistivel);
  }
  responder('ERROR', 500, 'falhou', `persistencia/${nomeDaClasse(err)}`);
  throw err;
}

/** ONE WARNING per instance while a previous relay secret is configured. */
function avisarRotacaoAberta(config: ConfigReceptorAmazon, deps: DepsReceptorAmazon): void {
  if (config.segredoAnterior === null || deps.instancia.rotacaoAvisada) return;
  deps.instancia.rotacaoAvisada = true;
  registrarEventoAmazon(
    deps.logger,
    'notificacao',
    'WARNING',
    '[amazon/receptor] rotação da chave do relay em aberto: AMAZON_RELAY_PREVIOUS_SECRET ainda está definida',
    { resultado: 'rotacao-aberta' },
  );
}

/**
 * The late-rejection line (`prazo.ts`'s consume-all): the operation that LOST
 * its deadline rejected after the answer. The CLASS only. A named enqueue
 * failure is a WARNING (the delivery already has its record); anything else —
 * a raw SDK error is deploy-shaped, a persist failure is a Firestore one, a
 * `TypeError` a bug — is an ERROR.
 */
function registrarRejeicaoTardia(
  deps: DepsReceptorAmazon,
  linha: LinhaDaEntrega,
  operacao: 'enfileiramento' | 'persistencia',
  erro: unknown,
): void {
  const nomeada =
    operacao === 'enfileiramento' &&
    (erro instanceof AmazonTarefasTransitoriasError ||
      erro instanceof AmazonTarefasDesligadasError);
  registrarEventoAmazon(
    deps.logger,
    'notificacao',
    nomeada ? 'WARNING' : 'ERROR',
    '[amazon/receptor] rejeição tardia depois do prazo — consumida',
    { resultado: 'rejeicao-tardia', operacao, classe: nomeDaClasse(erro) },
    { idNotificacao: linha.idNotificacao },
  );
}
