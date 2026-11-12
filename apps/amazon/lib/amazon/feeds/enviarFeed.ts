/**
 * The feed SEND handler (step 12a, PR 12-c), `tipo: 'feed-enviar'`: one
 * dispatch builds one batch of a fluxo (stock, price) and submits it as ONE
 * `JSON_LISTINGS_FEED`, under the per-(fluxo, conta) lease
 * `feedsAmazonEmCurso` (`./vezFeedFirestore`). The ONE caller of the write
 * engine's batch entry (`executarLoteEscritaAmazon`, `core/escrita.ts`). The
 * jobs root binds the deps and the fluxo's provider (`./destinosLote`); the
 * dispatcher parsed the payload (E0). This module writes the ONE dispatch line
 * its result describes ({@link registrarDespachoEnvioFeedAmazon}).
 *
 * ## The ladder
 *
 * - **E1** — the fluxo's valve, read ONCE and logged, before any read; `off`
 *   ends the run with ZERO Firestore operations.
 * - **E2** — the provider; a `null` seam row ends the run (`sem-provedor`),
 *   having taken nothing.
 * - **E3** — the context (the read switch FIRST): a switch, conta or credential
 *   refusal is ONE WARNING line and the end; anything else is rethrown.
 * - **E4** — the lease, classified on a FRESH read (`entrarNaVezFeed`):
 *   - taken (`tomar`, the breaker's half-open probe included) or this run's
 *     own `montando` (`retomar`: nothing was posted) ⇒ E5;
 *   - this run's own `enviando` (`garantir-incerto`) ⇒ the NAMED `feed-incerto`
 *     re-ensured, NEVER a second `createFeed`; its own `enviado`
 *     (`retomar-consulta`) ⇒ the record created from the LEASE's fields when
 *     missing (tier 0) and rung 0 re-enqueued under its name;
 *   - another run holds it ⇒ the batch's route (`destinoDoLoteRecusado`): its
 *     start recorded on the lease (a tick-born window batch, MIN-merged); the
 *     batch handed to the per-SKU path (a window batch behind a slow, uncertain
 *     or overdue holder, or the open breaker: `membros` re-derives it, the
 *     provider enqueues its patches, ZERO lease writes — except a start a
 *     crashed holder left behind, handed to its NAMED `vez` recovery FIRST and
 *     then cleared); the same payload re-enqueued UNNAMED (a block or
 *     recovery-born batch waiting, the 120-s submission floor); or expired.
 *     Then, behind an expired `enviado` (`adotar-resultado`), the adoption rung
 *     is enqueued; behind an uncertain lease at or past its 12 h
 *     (`incerta-recuperar`), the holder's uncertain path runs here
 *     (`./incertoFeed`), folding any recorded start into its recovery.
 * - **E5** — `membros`, then the batch entry with `montar` bound as the engine
 *   expects (a refusal passes through; zero messages ⇒ an EMPTY plan, never a
 *   document; otherwise the package's document). `membros` and `montar` share
 *   ONE build budget, {@link ORCAMENTO_MONTAGEM_LOTE_MS} from E5's start: the
 *   provider checks it before each read batch, and this handler checks it again
 *   after each answer, so a build past it is `snapshot-lento` — nothing posted.
 *   When it is THIS handler's check that finds the overrun, the members are
 *   already complete, and a WINDOW batch's go to the per-SKU path before the
 *   release (movement nothing else will see again); a provider's own abort
 *   makes that hand-off itself.
 *   A WINDOW batch's stored snapshot is never later than E5's start (before
 *   `membros`' first window query: a row committed during the re-derivation
 *   then falls after the snapshot, and the recovery forces it). The engine's
 *   `escrever` is, in this exact order: `createFeedDocument` → the upload →
 *   `marcarEnviando` → `createFeed`. `marcarEnviando` FIRST enqueues the NAMED
 *   `feed-incerto` (delayed to the feed's 12-h deadline, in WHOLE seconds) and
 *   only THEN writes the lease `enviando` with this attempt's stamp, so a
 *   failed enqueue leaves the lease `montando` (nothing posted) and a crash
 *   after the write leaves a durable recovery. A forced refresh (a 401/403 the
 *   engine's rule refreshes once) re-runs the WHOLE `escrever`: a new document,
 *   a new upload, and a re-entry `enviando → enviando` keyed by the stamp the
 *   previous attempt wrote.
 * - **E6** — the outcome:
 *   - `escrito` ⇒ the lease `enviado` FIRST (the `feedId` durable where a
 *     retry looks), then the record `create` (tier 0), then rung 0 NAMED and
 *     delayed 120 s;
 *   - `simulado`, `sem-escrita`, `desligado` ⇒ the lease released; `so-patches`
 *     ⇒ the canary members handed to the per-SKU path, then released;
 *     `abortado` ⇒ released, the aviso the provider named;
 *   - a document or upload failure ⇒ nothing submitted: released (from
 *     `enviando` only by THIS attempt's stamp); transient ⇒ rethrown for the
 *     queue's retry, deterministic ⇒ WARNING + the fluxo's aviso;
 *   - `createFeed` 429 ⇒ not processed: back to `montando`, released, the
 *     payload re-enqueued UNNAMED after 120 s, no attempt spent;
 *   - a non-auth 4xx, or a 401/403 after the refresh ⇒ definitive: released,
 *     the fluxo's aviso, no retry;
 *   - after a release that LANDED (a definitive refusal, a deterministic
 *     document failure, an abort), a TRANSIENT failure of the aviso's write is
 *     contained (`avisoFalhou`, logged), never rethrown: the queue's retry
 *     would read the lease `livre`, take it again and repeat the batch — one
 *     more `createFeed` after a final refusal, one more failure counted;
 *   - cut, 5xx, network, or a 2xx failing its schema ⇒ UNCERTAIN: never
 *     retried; the lease stays `enviando` but EXPIRES AT ONCE (so every other
 *     run reads `incerta-aguardar` and window batches go per SKU instead of
 *     waiting 12 h), any recorded start handed to its `vez` recovery first, and
 *     the fluxo's aviso raised NOW.
 *
 * Every send-side aviso is clocked by E4's lease read `readTime`. Every lease
 * write consuming a recorded start enqueues that start's NAMED `vez` recovery
 * BEFORE the write (`./vezFeedFirestore`).
 *
 * ## Which `createFeed` failures were never SENT
 *
 * The write client reads its credential right before the request: a stale
 * token is refreshed there (LWA, then a Firestore write), and a forced refresh
 * runs between two attempts. A failure raised there never reached `createFeed`,
 * so it is handled as "not processed", never as uncertain: an
 * `AmazonThrottleError` or an `AmazonAuthError` by its class (the rows above),
 * anything else released as `documento-transitorio` (nothing submitted, the
 * queue retries) and rethrown. Only an SP-API answer of the `createFeed`
 * request ITSELF, or its lost answer, can be uncertain.
 *
 * ## Units
 *
 * Every lease and record stamp is MILLISECONDS; aviso clocks are Firestore
 * `readTime`s, converted by `avisos/avisos.ts`; Cloud Tasks delays are WHOLE
 * SECONDS.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { feedAmazonCollection } from '@delfrance/data/admin/collections';
import { isAlreadyExists, isTransientGrpcError } from '@delfrance/data/admin/grpcErrors';
import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonDocumentoFeedError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonSchemaError,
  AmazonThrottleError,
  type SpApiEscritaClient,
  ehTransitoriaDocumentoFeed,
  montarDocumentoListingsFeed,
} from '@delfrance/integrations-amazon-sp-api';
import {
  type FluxoFeedAmazon,
  type MotivoContaAmazon,
  RETENCAO_FEED_AMAZON_DIAS,
  type RegistroFeedAmazon,
  STATUS_REGISTRO_FEED_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
  expiraEmApos,
  idRegistroFeedAmazon,
} from '@delfrance/schemas';

import { type ContextoAmazon, type ContextoAmazonDeps, loadAmazonContext } from '../core/contexto';
import {
  EVENTO_DO_LOTE_AMAZON,
  type PlanoLoteAmazon,
  type ResultadoLoteEscritaAmazon,
  executarLoteEscritaAmazon,
} from '../core/escrita';
import {
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import {
  type FluxoComLoteAmazon,
  MODO_AMAZON,
  type ValvulaAmazon,
  lerValvula,
  registrarValvulaAmazon,
} from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import { sanitizarFalhaDaTarefaAmazon } from '../notificacoes/notificacao';
import {
  FALHA_LEITURA_AMAZON,
  type FalhaLeituraAmazon,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import { TIPO_CONSULTA_FEED, proximaConsultaFeed } from './escadaFeed';
import { criarFeedNaAmazon, enviarDocumentoFeedNaAmazon } from './feedsAmazon';
import {
  type DepsIncertoFeedAmazon,
  type DesfechoCaminhoIncertoFeed,
  atrasoAtePrazoDoFeedS,
  avisarContaDoLoteAmazon,
  camposDoCaminhoIncerto,
  enfileirarVezPeloAgendador,
  percorrerCaminhoIncertoFeed,
  tarefaIncertoFeed,
} from './incertoFeed';
import {
  type AbortoLoteAmazon,
  type ContextoLoteAmazon,
  ESPACO_MINIMO_ENTRE_FEEDS_MS,
  MOTIVO_ABORTO_LOTE,
  type MotivoAbortoLote,
  type ProvedorLoteAmazon,
} from './provedorLote';
import { prazoDoFeed } from './registroFeed';
import {
  ORIGEM_RESULTADO_FEED_AMAZON,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaEnviarFeedAmazon,
  type TarefaResultadoFeedAmazon,
  VERSAO_TAREFA_LOTE_AMAZON,
  nomeConsultaFeed,
  nomeIncertoFeed,
  tarefaResultadoFeedAmazonSchema,
} from './tarefaLote';
import {
  DESTINO_DO_LOTE,
  LIBERACAO_VEZ_FEED,
  type LiberacaoVezFeed,
  type MotivoRecusaDaVez,
  type MotivoRepasseLote,
  TOMADA_DA_VEZ,
  type TipoTomadaDaVez,
  type TomadaDaVezFeed,
} from './vezFeed';
import {
  type AlvoVezFeed,
  type EnfileirarVezFeed,
  type EntradaNaVezFeed,
  type LeituraVezFeed,
  consumirPendenteVezFeed,
  entrarNaVezFeed,
  expirarIncertoVezFeed,
  liberarVezFeed,
  marcarEnviadoVezFeed,
  marcarEnviandoVezFeed,
  voltarParaMontandoVezFeed,
} from './vezFeedFirestore';

/* ---------------------------------- the budget --------------------------------- */

/**
 * The ONE build budget `membros` and `montar` share, from E5's start (240 s):
 * past it the batch is `snapshot-lento`, nothing posted. With the submission's
 * worst case on top it fits the jobs queue's 540-s timeout.
 */
export const ORCAMENTO_MONTAGEM_LOTE_MS = 240_000;

/** The delay of a 429's re-enqueue, in whole seconds: the submission floor. */
export const ESPERA_APOS_LIMITE_FEED_S = ESPACO_MINIMO_ENTRE_FEEDS_MS / 1000;

/* ----------------------------------- contract ---------------------------------- */

/** Everything one send dispatch needs — bound by the jobs root, doubles in the tests. */
export interface DepsEnviarFeedAmazon extends DepsIncertoFeedAmazon {
  /** The process environment: the read switch, the LWA pair, the fluxo's valve and canary. */
  readonly ambiente: AmbienteAmazon;
  /**
   * REQUIRED, never the global: the SAME `fetch` serves the context, the write
   * client and the document upload, so one scripted `fetch` sees every request.
   */
  readonly fetch: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** What one send dispatch did (closed). */
export const ACAO_ENVIO_FEED = {
  /** E1: the valve is `off`, nothing read. */
  valvulaDesligada: 'valvula-desligada',
  /** E2: the seam row is empty. */
  semProvedor: 'sem-provedor',
  /** E3: the switch, the conta or its credential refused. */
  contextoRecusado: 'contexto-recusado',
  /** E6: submitted, recorded, rung 0 enqueued. */
  enviado: 'enviado',
  /** E6: the answer was lost — the lease expired in place, never retried. */
  incerto: 'incerto',
  /** E6: the lease released (`motivo` is the release kind). */
  liberado: 'liberado',
  /** E6: a 429 — released, re-enqueued after the floor. */
  limitado: 'limitado',
  /** E4: the same payload re-enqueued unnamed (a wait, the submission floor). */
  aguardando: 'aguardando',
  /** E4: a tick-born window batch's start recorded on a held lease. */
  pendenteRegistrado: 'pendente-registrado',
  /** E4: the batch handed to the per-SKU path (`motivo` says why). */
  repassado: 'repassado',
  /** E4: the hand-off's re-derivation refused to build (`motivo`): nothing handed, nothing written. */
  repasseAbortado: 'repasse-abortado',
  /** E4: a block batch past its wait: the next daily run re-walks. */
  loteExpirado: 'lote-expirado',
  /** E4: this run's own `enviando` — the uncertain wait re-ensured. */
  incertoGarantido: 'incerto-garantido',
  /** E4: this run's own `enviado` — the record ensured, rung 0 re-enqueued. */
  consultaRetomada: 'consulta-retomada',
  /** E5/E6: another attempt holds the lease now; this one wrote nothing more. */
  vezPerdida: 'vez-perdida',
} as const;
export type AcaoEnvioFeedAmazon = (typeof ACAO_ENVIO_FEED)[keyof typeof ACAO_ENVIO_FEED];

/** The closed reason of an outcome. */
export type MotivoEnvioFeedAmazon = LiberacaoVezFeed | MotivoRepasseLote | FalhaLeituraAmazon;

/** The dispatch's result, logged ONCE ({@link registrarDespachoEnvioFeedAmazon}). */
export interface ResultadoEnvioFeedAmazon {
  readonly fluxo: FluxoFeedAmazon;
  readonly contaId: string;
  readonly acao: AcaoEnvioFeedAmazon;
  readonly motivo: MotivoEnvioFeedAmazon | null;
  /** E4's classification of the lease, when it was read. */
  readonly tomada: TipoTomadaDaVez | null;
  /** The take probes an open breaker. */
  readonly sonda: boolean;
  readonly feedId: string | null;
  /** The document's message and byte counts, when one was built. */
  readonly mensagens: number | null;
  readonly bytes: number | null;
  /** How the members decided under the valve, when the batch entry ran. */
  readonly membros: number | null;
  readonly membrosOn: number | null;
  /** The re-enqueue's delay, in whole seconds. */
  readonly atrasoS: number | null;
  /** The per-SKU tasks the provider enqueued. */
  readonly tarefas: number | null;
  /** A lease write of this run that wrote nothing, and why. */
  readonly recusa: MotivoRecusaDaVez | null;
  /** The start this run handed to a NAMED `vez` recovery before one of its writes. */
  readonly vezPara: number | null;
  /** The start recorded on the lease (`pendente-registrado`). */
  readonly pendenteDesdeMs: number | null;
  /** The adoption rung was enqueued (behind an expired `enviado`). */
  readonly adocao: boolean;
  /** The record's `create`: landed, or already there. */
  readonly registro: 'criado' | 'ja-registrado' | null;
  /** The holder's uncertain path, when this run ran it (E4). */
  readonly caminhoIncerto: DesfechoCaminhoIncertoFeed | null;
  /** The aviso this run raised, if any. */
  readonly aviso: MotivoContaAmazon | null;
  /** An aviso due after a LANDED release whose write failed transiently: contained. */
  readonly avisoFalhou: boolean;
}

/* ------------------------------------ the line ---------------------------------- */

/** The releases that raise the fluxo's feed-failure aviso, logged at WARNING. */
const LIBERACOES_EM_WARNING: ReadonlySet<string> = new Set<string>([
  LIBERACAO_VEZ_FEED.documentoFalhou,
  LIBERACAO_VEZ_FEED.recusaDefinitiva,
  LIBERACAO_VEZ_FEED.snapshotLento,
  LIBERACAO_VEZ_FEED.depositoMudou,
  LIBERACAO_VEZ_FEED.janelaGrande,
]);

/** The line's severity: WARNING whenever a person may have to look. */
export function severidadeDoEnvioFeedAmazon(r: ResultadoEnvioFeedAmazon): SeveridadeAmazon {
  if (r.acao === ACAO_ENVIO_FEED.incerto || r.acao === ACAO_ENVIO_FEED.contextoRecusado) {
    return 'WARNING';
  }
  if (r.acao === ACAO_ENVIO_FEED.liberado && r.motivo !== null) {
    return LIBERACOES_EM_WARNING.has(r.motivo) ? 'WARNING' : 'INFO';
  }
  if (r.caminhoIncerto?.tipo === 'recuperado') return 'WARNING';
  return 'INFO';
}

/**
 * The ONE `feed-enviar` line: ids, closed codes, ms stamps and counts only —
 * never a SKU, a document URL, a seller id or Amazon's text.
 */
export function registrarDespachoEnvioFeedAmazon(
  logger: LoggerAmazon,
  t: Pick<TarefaEnviarFeedAmazon, 'execucaoId' | 'origem' | 'lote'>,
  r: ResultadoEnvioFeedAmazon,
  registro: DepsIncertoFeedAmazon['registro'],
): void {
  const campos: CamposLogAmazon = {
    fase: 'envio',
    acao: r.acao,
    motivo: r.motivo,
    tomada: r.tomada,
    sonda: r.sonda,
    execucaoId: t.execucaoId,
    origem: t.origem,
    tipoLote: t.lote.tipo,
    feedId: r.feedId,
    mensagens: r.mensagens,
    bytes: r.bytes,
    membros: r.membros,
    membrosOn: r.membrosOn,
    atrasoS: r.atrasoS,
    tarefas: r.tarefas,
    recusa: r.recusa,
    vezPara: r.vezPara,
    pendenteDesdeMs: r.pendenteDesdeMs,
    adocao: r.adocao,
    registro: r.registro,
    aviso: r.aviso,
    avisoFalhou: r.avisoFalhou,
    ...(r.caminhoIncerto === null ? {} : camposDoCaminhoIncerto(r.caminhoIncerto)),
  };
  registrarEventoAmazon(
    logger,
    EVENTO_DO_LOTE_AMAZON[r.fluxo],
    severidadeDoEnvioFeedAmazon(r),
    `[amazon] feed ${r.fluxo}: envio (${r.acao})`,
    campos,
    {
      conta: r.contaId,
      fluxo: r.fluxo,
      tentativa: registro.tentativa,
      idTarefa: registro.idTarefa,
    },
  );
}

/* ---------------------------------- one dispatch -------------------------------- */

/** What the batch entry's `montar` hands `escrever`: the document and its snapshot. */
interface PlanoFeedAmazon extends PlanoLoteAmazon {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** ms — the stored snapshot (module header, E5). */
  readonly snapshotEmMs: number;
}

/** What one submission answered. */
interface EnvioFeedAmazon {
  readonly feedId: string;
  /** ms — the stamp the winning attempt's `marcarEnviando` wrote. */
  readonly antesDoEnvioMs: number;
}

/** Where `escrever` stood when it failed (module header, E6). */
const FASE_ENVIO = {
  montagem: 'montagem',
  documento: 'documento',
  marcacao: 'marcacao',
  submissao: 'submissao',
} as const;
type FaseEnvioFeed = (typeof FASE_ENVIO)[keyof typeof FASE_ENVIO];

/** `escrever`'s state across the forced refresh's re-run. */
interface EstadoDoEnvio {
  fase: FaseEnvioFeed;
  /** ms — the stamp THIS dispatch's last `marcarEnviando` wrote; `null` before the first. */
  antesDoEnvioMs: number | null;
  /** What `createFeed` itself threw (to tell it from a failure of the refresh after it). */
  erroDoCriarFeed: unknown;
  /**
   * The members `montar` was handed when THIS handler's budget check (never
   * the provider's) found the overrun; `null` otherwise.
   */
  estouro: readonly string[] | null;
}

/**
 * The batch's own lease write refused: another attempt (a copy of the same
 * payload) stamped the lease first. Thrown out of `escrever` BEFORE `createFeed`,
 * so nothing is submitted; answered `vez-perdida`, never retried.
 */
export class AmazonVezFeedPerdidaError extends Error {
  readonly motivo: MotivoRecusaDaVez;

  constructor(motivo: MotivoRecusaDaVez) {
    super(`a vez do feed foi tomada por outra tentativa antes do envio (${motivo})`);
    this.name = 'AmazonVezFeedPerdidaError';
    this.motivo = motivo;
  }
}

/** One dispatch, bound. */
interface Execucao {
  readonly db: Firestore;
  readonly t: TarefaEnviarFeedAmazon;
  readonly deps: DepsEnviarFeedAmazon;
  readonly provedor: ProvedorLoteAmazon<FluxoComLoteAmazon, unknown>;
  readonly alvo: AlvoVezFeed;
  readonly valvula: ValvulaAmazon<FluxoComLoteAmazon>;
  readonly depsDoContexto: ContextoAmazonDeps;
  readonly contexto: ContextoAmazon;
  readonly enfileirarVez: EnfileirarVezFeed;
}

const VAZIO = {
  motivo: null,
  tomada: null,
  sonda: false,
  feedId: null,
  mensagens: null,
  bytes: null,
  membros: null,
  membrosOn: null,
  atrasoS: null,
  tarefas: null,
  recusa: null,
  vezPara: null,
  pendenteDesdeMs: null,
  adocao: false,
  registro: null,
  caminhoIncerto: null,
  aviso: null,
  avisoFalhou: false,
} as const;

function resultado(
  t: TarefaEnviarFeedAmazon,
  acao: AcaoEnvioFeedAmazon,
  extra: Partial<Omit<ResultadoEnvioFeedAmazon, 'fluxo' | 'contaId' | 'acao'>> = {},
): ResultadoEnvioFeedAmazon {
  return { fluxo: t.fluxo, contaId: t.contaId, acao, ...VAZIO, ...extra };
}

/** The context the provider receives: this dispatch's, clocked by its lease read. */
function contextoDoLote(e: Execucao, lida: LeituraVezFeed): ContextoLoteAmazon {
  const sellerId = e.contexto.conta.selling_partner_id;
  if (typeof sellerId !== 'string' || sellerId === '') {
    // The context loader refuses a conta with no seller: only a bug reaches this.
    throw new TypeError('enviarFeed.ts: o contexto não nomeia o vendedor');
  }
  return {
    contexto: e.contexto,
    db: e.db,
    logger: e.deps.logger,
    agora: e.deps.agora,
    sellerId,
    relogioVez: lida.readTime,
  };
}

/** Re-enqueue the SAME payload, UNNAMED (a wait: a tombstone would refuse the next). */
async function reenfileirar(e: Execucao, atrasoS: number): Promise<void> {
  await e.deps.agendador().enfileirarLote(e.t, { atrasoS });
}

/**
 * The NAMED uncertain wait of this run (`ja-enfileirada` is the normal answer
 * on a retry or a refresh re-run), delayed to the feed's 12-h deadline counted
 * from `antesDoEnvioMs`, in WHOLE seconds.
 */
async function garantirIncerto(e: Execucao, antesDoEnvioMs: number): Promise<number> {
  const atrasoS = atrasoAtePrazoDoFeedS(antesDoEnvioMs, e.deps.agora());
  await e.deps
    .agendador()
    .enfileirarLote(
      tarefaIncertoFeed({ fluxo: e.t.fluxo, contaId: e.t.contaId, execucaoId: e.t.execucaoId }),
      { nome: nomeIncertoFeed(e.t.contaId, e.t.execucaoId), atrasoS },
    );
  return atrasoS;
}

/** A result rung of `feedId`, NAMED: rung `rodada` of the ladder, or the adoption. */
function tarefaDeResultado(
  e: Execucao,
  feedId: string,
  origem: TarefaResultadoFeedAmazon['origem'],
): TarefaResultadoFeedAmazon {
  return tarefaResultadoFeedAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.resultado,
    contaId: e.t.contaId,
    feedId,
    rodada: 0,
    origem,
  });
}

/** Rung 0 of `feedId`, NAMED, delayed by the ladder's first step from `antesDoEnvioMs`. */
async function enfileirarRodadaZero(
  e: Execucao,
  feedId: string,
  antesDoEnvioMs: number,
): Promise<number> {
  const proxima = proximaConsultaFeed(0, e.deps.agora(), antesDoEnvioMs);
  const atrasoS = proxima.tipo === TIPO_CONSULTA_FEED.abandonar ? 0 : proxima.atrasoS;
  await e.deps
    .agendador()
    .enfileirarLote(tarefaDeResultado(e, feedId, ORIGEM_RESULTADO_FEED_AMAZON.consulta), {
      nome: nomeConsultaFeed(e.t.contaId, feedId, 0),
      atrasoS,
    });
  return atrasoS;
}

/**
 * The record of the feed the lease names, built from the LEASE's fields (the
 * send's `escrito` and `retomar-consulta` share it, so a re-created record is
 * the one the first would have written).
 *
 * @throws {TypeError} a lease missing a field the record needs (a hand edit).
 */
export function registroDaVezFeed(
  alvo: AlvoVezFeed,
  vez: VezFeedAmazon,
  agoraMs: number,
): RegistroFeedAmazon {
  const { feedId, execucaoId, origem, tipoLote, snapshotEmMs, antesDoEnvioMs, mensagens, bytes } =
    vez;
  if (
    feedId === null ||
    execucaoId === null ||
    origem === null ||
    tipoLote === null ||
    snapshotEmMs === null ||
    antesDoEnvioMs === null ||
    mensagens === null ||
    bytes === null
  ) {
    throw new TypeError('enviarFeed.ts: a vez não tem os campos de que o registro precisa');
  }
  return feedAmazonCollection.parse({
    contaId: alvo.contaId,
    feedId,
    fluxo: alvo.fluxo,
    execucaoId,
    origem,
    tipoLote,
    janela: vez.janela,
    snapshotEmMs,
    antesDoEnvioMs,
    mensagens,
    bytes,
    status: STATUS_REGISTRO_FEED_AMAZON.enviado,
    criadoEmMs: agoraMs,
    atualizadoEmMs: agoraMs,
    prazoEmMs: prazoDoFeed(antesDoEnvioMs),
    expiraEm: expiraEmApos(agoraMs, RETENCAO_FEED_AMAZON_DIAS),
  });
}

/** The record's `create` (tier 0): `ALREADY_EXISTS` means already recorded. */
async function criarRegistro(e: Execucao, vez: VezFeedAmazon): Promise<'criado' | 'ja-registrado'> {
  const registro = registroDaVezFeed(e.alvo, vez, e.deps.agora());
  try {
    await feedAmazonCollection
      .docRef(e.db, {}, idRegistroFeedAmazon(registro.contaId, registro.feedId))
      .create(registro);
    return 'criado';
  } catch (err) {
    if (isAlreadyExists(err)) return 'ja-registrado';
    throw err;
  }
}

/** A release of the lease by this run (module header: the `vez` recovery first). */
async function liberar(
  e: Execucao,
  liberacao: LiberacaoVezFeed,
  antesDoEnvioAnteriorMs: number | null = null,
): Promise<{ readonly recusa: MotivoRecusaDaVez | null; readonly vezPara: number | null }> {
  const r = await liberarVezFeed(e.db, e.alvo, { execucaoId: e.t.execucaoId }, liberacao, {
    agora: e.deps.agora,
    pendenteDobrado: null,
    antesDoEnvioAnteriorMs,
    enfileirarVez: e.enfileirarVez,
  });
  return r.tipo === 'escrito'
    ? { recusa: null, vezPara: r.liberacao.vezPara }
    : { recusa: r.motivo, vezPara: null };
}

/** The fluxo's feed-failure aviso (or a provider abort's), clocked by E4's lease read. */
async function avisar(
  e: Execucao,
  motivo: MotivoContaAmazon,
  relogio: LeituraVezFeed['readTime'],
): Promise<MotivoContaAmazon> {
  await avisarContaDoLoteAmazon(e.db, e.deps, e.t.contaId, motivo, relogio);
  return motivo;
}

/**
 * The fluxo's aviso AFTER this run's release (module header, E6). Once the
 * release LANDED, a TRANSIENT failure of the aviso's write is contained: the
 * queue's retry would find the lease `livre` and repeat a batch that already
 * ended. Anything else, and any failure behind a release that wrote nothing,
 * is rethrown.
 */
async function avisarAposLiberar(
  e: Execucao,
  motivo: MotivoContaAmazon,
  relogio: LeituraVezFeed['readTime'],
  liberada: { readonly recusa: MotivoRecusaDaVez | null },
): Promise<Pick<ResultadoEnvioFeedAmazon, 'aviso' | 'avisoFalhou'>> {
  try {
    return { aviso: await avisar(e, motivo, relogio), avisoFalhou: false };
  } catch (err) {
    if (liberada.recusa !== null || !isTransientGrpcError(err)) throw err;
    return { aviso: null, avisoFalhou: true };
  }
}

/** The members, deduplicated in their order (the batch entry counts each once). */
function semRepetir(skus: readonly string[]): readonly string[] {
  return [...new Set(skus)];
}

/* ------------------------------------ E1–E3 ------------------------------------ */

/**
 * ONE send dispatch, E1–E6 (module header). Returns the result it logged;
 * throws only what the queue must retry (a transient before the submission, a
 * Firestore or Cloud Tasks failure, the lease's own conflict and corruption
 * classes), with an Amazon error sanitized — never after an uncertain
 * `createFeed`.
 */
export async function enviarFeedAmazon(
  db: Firestore,
  t: TarefaEnviarFeedAmazon,
  deps: DepsEnviarFeedAmazon,
): Promise<ResultadoEnvioFeedAmazon> {
  let r: ResultadoEnvioFeedAmazon;
  try {
    r = await executarEnvio(db, t, deps);
  } catch (err) {
    // The ONE boundary: a package error leaves as its class and status only.
    throw sanitizarFalhaDaTarefaAmazon(err);
  }
  registrarDespachoEnvioFeedAmazon(deps.logger, t, r, deps.registro);
  return r;
}

async function executarEnvio(
  db: Firestore,
  t: TarefaEnviarFeedAmazon,
  deps: DepsEnviarFeedAmazon,
): Promise<ResultadoEnvioFeedAmazon> {
  // ---- E1: the valve, read ONCE, logged — before any read. ----
  const valvula = lerValvula(t.fluxo, deps.ambiente);
  registrarValvulaAmazon(deps.logger, valvula, {
    conta: t.contaId,
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  });
  if (valvula.modo === MODO_AMAZON.off) return resultado(t, ACAO_ENVIO_FEED.valvulaDesligada);

  // ---- E2: the provider. ----
  const provedor = deps.provedor;
  if (provedor === null) return resultado(t, ACAO_ENVIO_FEED.semProvedor);
  if (provedor.fluxo !== t.fluxo) {
    throw new TypeError('enviarFeed.ts: o provedor e a tarefa nomeiam fluxos diferentes');
  }

  // ---- E3: the context — the read switch first. ----
  const depsDoContexto: ContextoAmazonDeps = {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    registro: {
      fluxo: t.fluxo,
      tentativa: deps.registro.tentativa,
      idTarefa: deps.registro.idTarefa,
    },
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  let contexto: ContextoAmazon;
  try {
    contexto = await loadAmazonContext(db, t.contaId, depsDoContexto);
  } catch (err) {
    const token = classificarFalhaDeLeituraAmazon(err);
    if (
      token !== FALHA_LEITURA_AMAZON.chamadasDesligadas &&
      token !== FALHA_LEITURA_AMAZON.contaInativa &&
      token !== FALHA_LEITURA_AMAZON.contaIndisponivel
    ) {
      throw err;
    }
    return resultado(t, ACAO_ENVIO_FEED.contextoRecusado, { motivo: token });
  }

  const e: Execucao = {
    db,
    t,
    deps,
    provedor,
    alvo: { fluxo: t.fluxo, contaId: t.contaId },
    valvula,
    depsDoContexto,
    contexto,
    enfileirarVez: enfileirarVezPeloAgendador(deps.agendador),
  };
  return entrarNaVez(e);
}

/* ------------------------------------- E4 -------------------------------------- */

async function entrarNaVez(e: Execucao): Promise<ResultadoEnvioFeedAmazon> {
  const entrada = await entrarNaVezFeed(e.db, e.t, { agora: e.deps.agora });
  const { lida } = entrada;
  switch (entrada.tipo) {
    case 'tomada':
      return montarEEnviar(e, lida, { tomada: TOMADA_DA_VEZ.tomar, sonda: entrada.sonda });
    case 'propria':
      switch (entrada.tomada.tipo) {
        case TOMADA_DA_VEZ.retomar:
          return montarEEnviar(e, lida, { tomada: TOMADA_DA_VEZ.retomar, sonda: false });
        case TOMADA_DA_VEZ.garantirIncerto: {
          // NEVER a second `createFeed`: the uncertain wait is all this run may do.
          const atrasoS = await garantirIncerto(e, lida.vez?.antesDoEnvioMs ?? e.deps.agora());
          return resultado(e.t, ACAO_ENVIO_FEED.incertoGarantido, {
            tomada: entrada.tomada.tipo,
            atrasoS,
          });
        }
        case TOMADA_DA_VEZ.retomarConsulta:
          return retomarConsulta(e, lida);
      }
      break;
    case 'pendente-registrado': {
      const extra = await acoesAtrasDoDono(e, entrada.tomada, lida);
      return resultado(e.t, ACAO_ENVIO_FEED.pendenteRegistrado, {
        tomada: entrada.tomada.tipo,
        pendenteDesdeMs: entrada.pendenteDesdeMs,
        ...extra,
      });
    }
    case 'recusada':
      return loteRecusado(e, entrada.tomada, entrada.destino, lida);
  }
  // Every inner switch arm returns: only an impossible classification lands here.
  throw new TypeError('enviarFeed.ts: classificação da vez fora do conjunto fechado');
}

/** This run's own `enviado`: the record from the LEASE when missing, then rung 0 again. */
async function retomarConsulta(
  e: Execucao,
  lida: LeituraVezFeed,
): Promise<ResultadoEnvioFeedAmazon> {
  const vez = lida.vez;
  if (vez === null || vez.feedId === null || vez.antesDoEnvioMs === null) {
    throw new TypeError('enviarFeed.ts: retomar-consulta sem o feed na vez');
  }
  const registro = await criarRegistro(e, vez);
  const atrasoS = await enfileirarRodadaZero(e, vez.feedId, vez.antesDoEnvioMs);
  return resultado(e.t, ACAO_ENVIO_FEED.consultaRetomada, {
    tomada: TOMADA_DA_VEZ.retomarConsulta,
    feedId: vez.feedId,
    registro,
    atrasoS,
  });
}

/**
 * What a turned-away batch does BESIDES its own route, by the holder's
 * classification (module header, E4): the adoption rung behind an expired
 * `enviado`; the holder's uncertain path behind an uncertain lease at or past
 * its 12 h.
 */
async function acoesAtrasDoDono(
  e: Execucao,
  tomada: TomadaDaVezFeed,
  lida: LeituraVezFeed,
): Promise<Pick<ResultadoEnvioFeedAmazon, 'adocao' | 'caminhoIncerto'>> {
  const vez = lida.vez;
  if (tomada.tipo === TOMADA_DA_VEZ.adotarResultado && vez?.feedId != null) {
    await e.deps
      .agendador()
      .enfileirarLote(tarefaDeResultado(e, vez.feedId, ORIGEM_RESULTADO_FEED_AMAZON.adocao), {
        nome: nomeConsultaFeed(e.t.contaId, vez.feedId, ORIGEM_RESULTADO_FEED_AMAZON.adocao),
      });
    return { adocao: true, caminhoIncerto: null };
  }
  if (tomada.tipo === TOMADA_DA_VEZ.incertaRecuperar && vez?.execucaoId != null) {
    const caminhoIncerto = await percorrerCaminhoIncertoFeed(
      e.db,
      { fluxo: e.t.fluxo, contaId: e.t.contaId, execucaoId: vez.execucaoId },
      e.deps,
      { reenfileirarSeCedo: false },
    );
    return { adocao: false, caminhoIncerto };
  }
  return { adocao: false, caminhoIncerto: null };
}

/** The routes a turned-away batch can take (the `recusada` arm of `entrarNaVezFeed`). */
type DestinoRecusado = Extract<EntradaNaVezFeed, { readonly tipo: 'recusada' }>['destino'];

/**
 * A batch another run's lease turned away (module header, E4): its own route,
 * and what the holder's classification asks of any run that reads it.
 *
 * A hand-off to the per-SKU path goes FIRST (behind `incerta-recuperar` the
 * holder's uncertain path then runs on a lease the hand-off did not touch).
 * A WAIT goes LAST: its re-enqueue is UNNAMED, so it must be the dispatch's
 * last fallible effect — a side action failing after it would have the queue
 * retry the dispatch and enqueue a second copy of the same payload, and a copy
 * that outlives the first one's run re-runs a batch that already ended.
 */
async function loteRecusado(
  e: Execucao,
  tomada: TomadaDaVezFeed,
  destino: DestinoRecusado,
  lida: LeituraVezFeed,
): Promise<ResultadoEnvioFeedAmazon> {
  if (destino.tipo === DESTINO_DO_LOTE.aguardar) {
    const extra = await acoesAtrasDoDono(e, tomada, lida);
    const rota = await rotaDoLoteRecusado(e, tomada, destino, lida);
    return { ...rota, ...extra };
  }
  const rota = await rotaDoLoteRecusado(e, tomada, destino, lida);
  const extra = await acoesAtrasDoDono(e, tomada, lida);
  return { ...rota, ...extra };
}

async function rotaDoLoteRecusado(
  e: Execucao,
  tomada: TomadaDaVezFeed,
  destino: DestinoRecusado,
  lida: LeituraVezFeed,
): Promise<ResultadoEnvioFeedAmazon> {
  switch (destino.tipo) {
    case DESTINO_DO_LOTE.repassarParaPatches:
      return repassar(e, tomada, destino.motivo, lida);
    case DESTINO_DO_LOTE.aguardar:
      await reenfileirar(e, destino.atrasoS);
      return resultado(e.t, ACAO_ENVIO_FEED.aguardando, {
        tomada: tomada.tipo,
        atrasoS: destino.atrasoS,
      });
    case DESTINO_DO_LOTE.loteExpirado:
      return resultado(e.t, ACAO_ENVIO_FEED.loteExpirado, { tomada: tomada.tipo });
  }
}

/**
 * A window batch handed to the per-SKU path: its members RE-DERIVED, the
 * provider's patch tasks, and ZERO lease writes — except a recorded start the
 * read shows (a holder that crashed releases nothing), handed to its NAMED `vez`
 * recovery FIRST and then cleared. Behind `incerta-recuperar` the holder's
 * uncertain path right after folds that start into its own recovery instead.
 */
async function repassar(
  e: Execucao,
  tomada: TomadaDaVezFeed,
  motivo: MotivoRepasseLote,
  lida: LeituraVezFeed,
): Promise<ResultadoEnvioFeedAmazon> {
  const ctx = contextoDoLote(e, lida);
  const membros = await e.provedor.membros(ctx, e.t);
  if ('abortado' in membros) {
    // Nothing to hand over and nothing taken: the provider's aviso, no lease write.
    const aviso = membros.aviso === null ? null : await avisar(e, membros.aviso, lida.readTime);
    return resultado(e.t, ACAO_ENVIO_FEED.repasseAbortado, {
      tomada: tomada.tipo,
      motivo: membros.abortado,
      aviso,
    });
  }
  const skus = semRepetir(membros.skus);
  const { tarefas } = await e.provedor.repassarParaPatches(ctx, e.t, skus, membros.dados);
  let vezPara: number | null = null;
  if (tomada.tipo !== TOMADA_DA_VEZ.incertaRecuperar && lida.vez?.pendenteDesdeMs != null) {
    const consumo = await consumirPendenteVezFeed(
      e.db,
      e.alvo,
      { tipo: 'repasse' },
      { agora: e.deps.agora, enfileirarVez: e.enfileirarVez },
    );
    if (consumo.tipo === 'escrito') vezPara = consumo.vezPara;
  }
  return resultado(e.t, ACAO_ENVIO_FEED.repassado, {
    tomada: tomada.tipo,
    motivo,
    membros: skus.length,
    tarefas,
    vezPara,
  });
}

/* ------------------------------------- E5 -------------------------------------- */

/** The refusal of a build past the shared budget: nothing posted, the fluxo's aviso. */
function abortoLento(e: Execucao): AbortoLoteAmazon {
  return { abortado: MOTIVO_ABORTO_LOTE.snapshotLento, aviso: e.provedor.motivoFalha };
}

/** Whether the build ran PAST the shared budget counted from `inicioMs`. */
function foraDoOrcamento(e: Execucao, inicioMs: number): boolean {
  return e.deps.agora() - inicioMs > ORCAMENTO_MONTAGEM_LOTE_MS;
}

/**
 * `montar`, bound as the engine expects (module header, E5): the provider's
 * refusal passes through; a build past the budget is `snapshot-lento`; zero
 * messages is an EMPTY plan, built without the package (which refuses a
 * document with no message); otherwise the package's document. A window
 * batch's snapshot is capped at E5's start.
 */
async function montarPlano(
  e: Execucao,
  ctx: ContextoLoteAmazon,
  estado: EstadoDoEnvio,
  inicioMs: number,
  membrosOn: readonly string[],
  dados: unknown,
): Promise<PlanoFeedAmazon | AbortoLoteAmazon> {
  if (foraDoOrcamento(e, inicioMs)) {
    estado.estouro = membrosOn;
    return abortoLento(e);
  }
  const montagem = await e.provedor.montar(ctx, e.t, membrosOn, dados);
  if ('abortado' in montagem) return montagem;
  if (foraDoOrcamento(e, inicioMs)) {
    estado.estouro = membrosOn;
    return abortoLento(e);
  }
  const snapshotEmMs =
    e.t.lote.tipo === TIPO_LOTE_FEED_AMAZON.janela
      ? Math.min(montagem.snapshotEmMs, inicioMs)
      : montagem.snapshotEmMs;
  if (montagem.mensagens.length === 0) {
    return { bytes: new Uint8Array(0), mensagens: 0, diff: montagem.diff, snapshotEmMs };
  }
  const documento = montarDocumentoListingsFeed({
    sellerId: ctx.sellerId,
    mensagens: montagem.mensagens,
  });
  return {
    bytes: documento.bytes,
    mensagens: documento.mensagens,
    diff: montagem.diff,
    snapshotEmMs,
  };
}

/**
 * The engine's ONE `escrever` (module header, E5): the document and its upload,
 * then `marcarEnviando` (the NAMED uncertain wait FIRST, then the lease), then
 * `createFeed` — never repeated here. A forced refresh re-runs all of it, the
 * re-entry keyed by the stamp the previous attempt wrote.
 */
async function escrever(
  e: Execucao,
  estado: EstadoDoEnvio,
  cliente: SpApiEscritaClient,
  plano: PlanoFeedAmazon,
): Promise<EnvioFeedAmazon> {
  estado.fase = FASE_ENVIO.documento;
  const { feedDocumentId } = await enviarDocumentoFeedNaAmazon(cliente, plano.bytes, {
    fetch: e.deps.fetch,
    agora: e.deps.agora,
  });

  estado.fase = FASE_ENVIO.marcacao;
  const antesDoEnvioMs = e.deps.agora();
  const marcado = await marcarEnviandoVezFeed(
    e.db,
    e.alvo,
    {
      execucaoId: e.t.execucaoId,
      envio: {
        snapshotEmMs: plano.snapshotEmMs,
        antesDoEnvioMs,
        mensagens: plano.mensagens,
        bytes: plano.bytes.byteLength,
      },
      antesDoEnvioAnteriorMs: estado.antesDoEnvioMs,
    },
    {
      agora: e.deps.agora,
      antesDaEscrita: async () => {
        await garantirIncerto(e, antesDoEnvioMs);
      },
    },
  );
  if (marcado.tipo === 'recusado') throw new AmazonVezFeedPerdidaError(marcado.motivo);
  estado.antesDoEnvioMs = antesDoEnvioMs;

  estado.fase = FASE_ENVIO.submissao;
  estado.erroDoCriarFeed = undefined;
  try {
    const { feedId } = await criarFeedNaAmazon(cliente, feedDocumentId);
    return { feedId, antesDoEnvioMs };
  } catch (err) {
    estado.erroDoCriarFeed = err;
    throw err;
  }
}

/** E5: the members, the batch entry, then E6 on its outcome. */
async function montarEEnviar(
  e: Execucao,
  lida: LeituraVezFeed,
  tomada: { readonly tomada: TipoTomadaDaVez; readonly sonda: boolean },
): Promise<ResultadoEnvioFeedAmazon> {
  const base = { tomada: tomada.tomada, sonda: tomada.sonda };
  const ctx = contextoDoLote(e, lida);
  const inicioMs = e.deps.agora();

  const membros = await e.provedor.membros(ctx, e.t);
  if ('abortado' in membros) return abortado(e, lida, membros, base);
  const skus = semRepetir(membros.skus);
  if (foraDoOrcamento(e, inicioMs)) return estourou(e, lida, ctx, skus, membros.dados, base);

  const estado: EstadoDoEnvio = {
    fase: FASE_ENVIO.montagem,
    antesDoEnvioMs: null,
    erroDoCriarFeed: undefined,
    estouro: null,
  };
  let r: ResultadoLoteEscritaAmazon<PlanoFeedAmazon, AbortoLoteAmazon, EnvioFeedAmazon>;
  try {
    r = await executarLoteEscritaAmazon<PlanoFeedAmazon, AbortoLoteAmazon, EnvioFeedAmazon>({
      valvula: e.valvula,
      contaId: e.t.contaId,
      contexto: e.contexto,
      deps: {
        logger: e.depsDoContexto.logger,
        fetch: e.depsDoContexto.fetch,
        agora: e.depsDoContexto.agora,
        gerarCorrelationId: e.depsDoContexto.gerarCorrelationId,
      },
      registro: e.depsDoContexto.registro,
      membros: skus,
      montar: (on) => montarPlano(e, ctx, estado, inicioMs, on, membros.dados),
      escrever: (cliente, plano) => escrever(e, estado, cliente, plano),
    });
  } catch (err) {
    const resposta = await falhaDoEnvio(e, lida, estado, err, base);
    if (resposta === null) throw err;
    return resposta;
  }
  return desfechoDoLote(e, lida, ctx, estado, r, membros.dados, base);
}

/* ------------------------------------- E6 -------------------------------------- */

type Base = Pick<ResultadoEnvioFeedAmazon, 'tomada' | 'sonda'>;

/** A build the provider (or the budget) refused: released, the aviso it named. */
async function abortado(
  e: Execucao,
  lida: LeituraVezFeed,
  aborto: AbortoLoteAmazon,
  base: Base,
): Promise<ResultadoEnvioFeedAmazon> {
  const motivo: MotivoAbortoLote = aborto.abortado;
  const liberada = await liberar(e, motivo);
  const aviso =
    aborto.aviso === null
      ? { aviso: null, avisoFalhou: false }
      : await avisarAposLiberar(e, aborto.aviso, lida.readTime, liberada);
  return resultado(e.t, ACAO_ENVIO_FEED.liberado, { ...base, motivo, ...aviso, ...liberada });
}

/**
 * THIS handler's budget check found the overrun (module header, E5), so the
 * members are complete: a WINDOW batch's go to the per-SKU path FIRST (a block
 * batch's never do: the next daily reconcile re-walks them), then the
 * `snapshot-lento` release and the fluxo's aviso.
 */
async function estourou(
  e: Execucao,
  lida: LeituraVezFeed,
  ctx: ContextoLoteAmazon,
  skus: readonly string[],
  dados: unknown,
  base: Base,
): Promise<ResultadoEnvioFeedAmazon> {
  let tarefas: number | null = null;
  if (e.t.lote.tipo === TIPO_LOTE_FEED_AMAZON.janela) {
    ({ tarefas } = await e.provedor.repassarParaPatches(ctx, e.t, skus, dados));
  }
  const liberado = await abortado(e, lida, abortoLento(e), base);
  return { ...liberado, tarefas };
}

/** The batch entry's outcome (module header, E6). */
async function desfechoDoLote(
  e: Execucao,
  lida: LeituraVezFeed,
  ctx: ContextoLoteAmazon,
  estado: EstadoDoEnvio,
  r: ResultadoLoteEscritaAmazon<PlanoFeedAmazon, AbortoLoteAmazon, EnvioFeedAmazon>,
  dados: unknown,
  base: Base,
): Promise<ResultadoEnvioFeedAmazon> {
  if (r.tipo === 'desligado') {
    const liberada = await liberar(e, LIBERACAO_VEZ_FEED.desligado);
    return resultado(e.t, ACAO_ENVIO_FEED.liberado, {
      ...base,
      motivo: LIBERACAO_VEZ_FEED.desligado,
      ...liberada,
    });
  }
  const contagem = { membros: r.contagem.total, membrosOn: r.contagem.on };
  switch (r.tipo) {
    case 'abortado': {
      const liberado =
        estado.estouro === null
          ? await abortado(e, lida, r.aborto, base)
          : await estourou(e, lida, ctx, estado.estouro, dados, base);
      return { ...liberado, ...contagem };
    }
    case 'simulado':
    case 'sem-escrita': {
      const liberacao =
        r.tipo === 'simulado' ? LIBERACAO_VEZ_FEED.simulado : LIBERACAO_VEZ_FEED.semEscrita;
      const liberada = await liberar(e, liberacao);
      return resultado(e.t, ACAO_ENVIO_FEED.liberado, {
        ...base,
        ...contagem,
        motivo: liberacao,
        mensagens: r.plano.mensagens,
        bytes: r.plano.bytes.byteLength,
        ...liberada,
      });
    }
    case 'so-patches': {
      const { tarefas } = await e.provedor.repassarParaPatches(ctx, e.t, r.membros, dados);
      const liberada = await liberar(e, LIBERACAO_VEZ_FEED.soPatches);
      return resultado(e.t, ACAO_ENVIO_FEED.liberado, {
        ...base,
        ...contagem,
        motivo: LIBERACAO_VEZ_FEED.soPatches,
        tarefas,
        ...liberada,
      });
    }
    case 'escrito':
      return registrarEnvio(e, r.resposta, {
        ...base,
        ...contagem,
        mensagens: r.plano.mensagens,
        bytes: r.plano.bytes.byteLength,
      });
  }
}

/**
 * `escrito`: the lease names the `feedId` FIRST, then the record, then rung 0.
 * A failure from here on is rethrown: the retry reads its own `enviado`
 * (`retomar-consulta`) or, if even the lease write was lost, its own
 * `enviando` (`garantir-incerto`) — never a second `createFeed`.
 */
async function registrarEnvio(
  e: Execucao,
  envio: EnvioFeedAmazon,
  extra: Partial<ResultadoEnvioFeedAmazon>,
): Promise<ResultadoEnvioFeedAmazon> {
  const marcado = await marcarEnviadoVezFeed(
    e.db,
    e.alvo,
    { execucaoId: e.t.execucaoId, feedId: envio.feedId },
    { agora: e.deps.agora },
  );
  if (marcado.tipo === 'recusado') {
    // No transition moves this run's own `enviando` away: only a hand edit.
    return resultado(e.t, ACAO_ENVIO_FEED.vezPerdida, {
      ...extra,
      feedId: envio.feedId,
      recusa: marcado.motivo,
    });
  }
  const registro = await criarRegistro(e, marcado.vez);
  const atrasoS = await enfileirarRodadaZero(e, envio.feedId, envio.antesDoEnvioMs);
  return resultado(e.t, ACAO_ENVIO_FEED.enviado, {
    ...extra,
    feedId: envio.feedId,
    registro,
    atrasoS,
  });
}

/** Whether a failure is an SP-API answer (or a lost one) of `createFeed` itself. */
function respostaDoCriarFeed(estado: EstadoDoEnvio, err: unknown): boolean {
  if (err !== estado.erroDoCriarFeed) return false;
  return (
    (err instanceof AmazonHttpError ||
      err instanceof AmazonSchemaError ||
      err instanceof AmazonNetworkError) &&
    err.destino === 'sp-api'
  );
}

/**
 * Whether a document or upload failure would fail again unchanged (module
 * header, E6): the package's deterministic refusals. A transport hiccup, a
 * Firestore failure or a bug is not. The result handler classifies its report
 * download (`getFeedDocument` and the transfer) through this same predicate.
 */
export function falhaDefinitivaDoDocumento(err: unknown): boolean {
  if (err instanceof AmazonDocumentoFeedError) return !ehTransitoriaDocumentoFeed(err);
  if (err instanceof AmazonThrottleError) return false;
  if (err instanceof AmazonAuthError) return true;
  if (err instanceof AmazonHttpError) return !err.transitorio;
  return err instanceof AmazonSchemaError || err instanceof AmazonConfigError;
}

/**
 * A failure out of the batch entry, by where `escrever` stood (module header,
 * E6). Answers the result, or `null` when the queue must retry it (the caller
 * rethrows it sanitized).
 */
async function falhaDoEnvio(
  e: Execucao,
  lida: LeituraVezFeed,
  estado: EstadoDoEnvio,
  err: unknown,
  base: Base,
): Promise<ResultadoEnvioFeedAmazon | null> {
  if (err instanceof AmazonVezFeedPerdidaError) {
    return resultado(e.t, ACAO_ENVIO_FEED.vezPerdida, { ...base, recusa: err.motivo });
  }
  switch (estado.fase) {
    case FASE_ENVIO.montagem: {
      // The package refused the document itself: the same build would be refused again.
      if (!(err instanceof AmazonConfigError)) return null;
      return documentoFalhou(e, lida, estado, base);
    }
    case FASE_ENVIO.documento: {
      if (falhaDefinitivaDoDocumento(err)) return documentoFalhou(e, lida, estado, base);
      // Nothing submitted, transient (or not the package's): released, the queue retries.
      await liberar(e, LIBERACAO_VEZ_FEED.documentoTransitorio, estado.antesDoEnvioMs);
      return null;
    }
    case FASE_ENVIO.marcacao: {
      // The FIRST attempt's lease is still `montando` (the uncertain wait's
      // enqueue, or the write, failed): left as it is, the retry resumes it
      // (`retomar`). A refresh re-run's is the previous attempt's `enviando`,
      // whose `createFeed` was refused 401/403 (not processed): released by that
      // attempt's stamp, so the retry is not held 12 h for a feed never taken.
      if (estado.antesDoEnvioMs !== null) {
        await liberar(e, LIBERACAO_VEZ_FEED.documentoTransitorio, estado.antesDoEnvioMs);
      }
      return null;
    }
    case FASE_ENVIO.submissao:
      return falhaDoCriarFeed(e, lida, estado, err, base);
  }
}

/** A deterministic document failure: released by this attempt, WARNING, the fluxo's aviso. */
async function documentoFalhou(
  e: Execucao,
  lida: LeituraVezFeed,
  estado: EstadoDoEnvio,
  base: Base,
): Promise<ResultadoEnvioFeedAmazon> {
  const liberada = await liberar(e, LIBERACAO_VEZ_FEED.documentoFalhou, estado.antesDoEnvioMs);
  const aviso = await avisarAposLiberar(e, e.provedor.motivoFalha, lida.readTime, liberada);
  return resultado(e.t, ACAO_ENVIO_FEED.liberado, {
    ...base,
    motivo: LIBERACAO_VEZ_FEED.documentoFalhou,
    ...aviso,
    ...liberada,
  });
}

/** A `createFeed` failure (module header, E6 and "Which failures were never SENT"). */
async function falhaDoCriarFeed(
  e: Execucao,
  lida: LeituraVezFeed,
  estado: EstadoDoEnvio,
  err: unknown,
  base: Base,
): Promise<ResultadoEnvioFeedAmazon | null> {
  // A 429 (Amazon's, or the refresh's before the request): not processed.
  if (err instanceof AmazonThrottleError) {
    const voltou = await voltarParaMontandoVezFeed(e.db, e.alvo, e.t.execucaoId, {
      agora: e.deps.agora,
    });
    const liberada =
      voltou.tipo === 'escrito'
        ? await liberar(e, LIBERACAO_VEZ_FEED.limitado)
        : { recusa: voltou.motivo, vezPara: null };
    await reenfileirar(e, ESPERA_APOS_LIMITE_FEED_S);
    return resultado(e.t, ACAO_ENVIO_FEED.limitado, {
      ...base,
      motivo: LIBERACAO_VEZ_FEED.limitado,
      atrasoS: ESPERA_APOS_LIMITE_FEED_S,
      ...liberada,
    });
  }
  // A 401/403 after the forced refresh, or the refresh itself refused: not processed, final.
  if (err instanceof AmazonAuthError) return recusaDefinitiva(e, lida, base);
  if (!respostaDoCriarFeed(estado, err)) {
    // Raised before the request left (the credential read, the refresh): nothing submitted.
    await liberar(e, LIBERACAO_VEZ_FEED.documentoTransitorio, estado.antesDoEnvioMs);
    return null;
  }
  if (err instanceof AmazonHttpError && !err.transitorio) return recusaDefinitiva(e, lida, base);
  return incerto(e, lida, base);
}

/** A definitive refusal: released, the fluxo's aviso, no retry. */
async function recusaDefinitiva(
  e: Execucao,
  lida: LeituraVezFeed,
  base: Base,
): Promise<ResultadoEnvioFeedAmazon> {
  const liberada = await liberar(e, LIBERACAO_VEZ_FEED.recusaDefinitiva);
  const aviso = await avisarAposLiberar(e, e.provedor.motivoFalha, lida.readTime, liberada);
  return resultado(e.t, ACAO_ENVIO_FEED.liberado, {
    ...base,
    motivo: LIBERACAO_VEZ_FEED.recusaDefinitiva,
    ...aviso,
    ...liberada,
  });
}

/**
 * The UNCERTAIN outcome: never retried; the lease expired IN PLACE (its start
 * handed to its `vez` recovery first), the fluxo's aviso raised NOW. The NAMED
 * `feed-incerto` is already durable (`marcarEnviando` enqueued it first).
 */
async function incerto(
  e: Execucao,
  lida: LeituraVezFeed,
  base: Base,
): Promise<ResultadoEnvioFeedAmazon> {
  const expirado = await expirarIncertoVezFeed(e.db, e.alvo, e.t.execucaoId, {
    agora: e.deps.agora,
    enfileirarVez: e.enfileirarVez,
  });
  const aviso = await avisar(e, e.provedor.motivoFalha, lida.readTime);
  return resultado(e.t, ACAO_ENVIO_FEED.incerto, {
    ...base,
    motivo: LIBERACAO_VEZ_FEED.incerto,
    aviso,
    recusa: expirado.tipo === 'escrito' ? null : expirado.motivo,
    vezPara: expirado.tipo === 'escrito' ? expirado.vezPara : null,
  });
}
