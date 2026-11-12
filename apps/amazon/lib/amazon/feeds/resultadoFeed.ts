/**
 * The feed RESULT handler (step 12a, PR 12-c), `tipo: 'feed-resultado'`: one
 * poll rung of a submitted `JSON_LISTINGS_FEED`, a `FEED_PROCESSING_FINISHED`
 * wake-up, or an adoption — all three run the SAME ladder, R0–R8, and end a
 * feed through the SAME tail. The dispatcher parsed the payload (R0); the jobs
 * root binds the deps and the seam (`./destinosLote`), read here once the record
 * names its fluxo. This module writes the ONE dispatch line its result describes
 * ({@link registrarDespachoResultadoFeedAmazon}).
 *
 * ## The ladder
 *
 * - **R1** — the record `feedsAmazon/{contaId}_{feedId}`: one read when the
 *   payload names the conta; for a wake-up (`contaId: null`, the notification
 *   names a seller) ONE `getAll` of that id over every ACTIVE Amazon conta.
 *   None ⇒ `feed-desconhecido`; more than one ⇒ `feed-ambiguo` (each record's
 *   own poll chain carries it); ZERO Amazon calls in both. Then, for a record
 *   that is not terminal, the SUCCESSOR FIRST, before any Amazon call: rung
 *   `n + 1` NAMED `nomeConsultaFeed(conta, feed, n + 1)`, delayed by the ladder
 *   (`./escadaFeed`) from `antesDoEnvioMs`, where `n` is the payload's `rodada`
 *   for a poll rung and the record's `rodadas` for a wake-up or an adoption —
 *   so those two name the live chain's pending rung (`ALREADY_EXISTS`) instead
 *   of forking a second chain. A rung whose attempts all die below therefore
 *   still leaves its successor durable. `abandonar` (48 h) ⇒ no successor: this
 *   rung ends the feed — with ZERO Amazon calls, straight to the tail
 *   (`abandonado`), so not even a failing `getFeed` can keep the lease held.
 * - **R2** — a TERMINAL record ⇒ when the lease still names this `feedId`
 *   (a tail whose release was lost), it is released, holder-checked by the feed,
 *   any recorded start handed to its NAMED `vez` recovery first;
 *   `feed-ja-concluido` (the duplicate of a wake-up and a poll, a chain's
 *   trailing rung). Nothing else.
 * - **R3** — the context (the read switch first): a switch, conta or credential
 *   refusal is ONE WARNING line and the end (the successor already waits).
 * - **R4** — `getFeed` (`./feedsAmazon`). A failure is rethrown, sanitized: the
 *   queue retries, and the successor carries the chain past the last attempt.
 * - **R5** — `IN_QUEUE` / `IN_PROGRESS` (or a value the model does not list,
 *   logged) ⇒ ONE tier-1 rung write — `processando` forward-only, `rodadas` and
 *   `atualizadoEmMs` ALWAYS (`./registroFeed`), so a healthy chain never looks
 *   stale. From `antesDoEnvioMs` + 30 min on, the lease's recorded start is
 *   handed to its NAMED `vez` recovery and cleared (a slow feed is not a
 *   failure: no aviso; from then on the lease reads `ocupada-lenta` and window
 *   batches go per SKU). The FIRST rung at or past the 12-h deadline raises the
 *   fluxo's aviso, clocked by this rung's record read.
 * - **R6** — `CANCELLED` ⇒ the tail, `cancelado` (nothing applied; no download).
 * - **R7** — `DONE` / `FATAL` ⇒ the report: `getFeedDocument` and the bounded
 *   download (`./feedsAmazon`), `reduzirRelatorioFeed(relatorio)` — attribution
 *   by the issue's own `sku`, exactly as written — then the provider's
 *   `gravarResultado` (at most `MAX_SKUS_COM_PROBLEMA_GRAVADOS` SKUs; whether a
 *   SKU is linked is the provider's), then the record's counts (tier 1, status
 *   still `processando`). No `resultFeedDocumentId` ⇒ `resultado: null`,
 *   WARNING, no `getFeedDocument`. A transient download failure is rethrown; a
 *   deterministic one is a WARNING, `resultado: null`, and the tail. A record
 *   that already holds its counts (a retried tail) reuses them: one download
 *   per feed. Then the tail, `concluido` (`DONE`) or `falhou` (`FATAL`). A
 *   report with per-SKU errors COMPLETES: it never throws and never loops.
 * - **R8** — ONE dispatch line: `evento` = the record's fluxo (`feed` when no
 *   record is known), `fase: 'resultado'`, closed codes, ids, counts, the rung
 *   — never a SKU, an issue message or a URL.
 *
 * ## The tail's clock
 *
 * The first dispatch to reach R6, R7 or the abandonment stores
 * `relogioDesfecho` = its record read's `readTime` (a one-field tier-1 write,
 * BEFORE anything else on that path) when the record holds none; every later
 * attempt reuses the STORED value. So `gravarResultado`'s raise and the tail's
 * aviso are clocked alike on every attempt, and a retried tail of an older feed
 * resolves with ITS clock, which loses to a newer feed's raise.
 *
 * ## The tail, in this order (each step idempotent: a crash re-runs it from 1)
 *
 *  1. ONE lease read: `p` = its pending start when it still names this feed
 *     (else `null`), then `feed-recuperar` (the outcome, the record's snapshot
 *     and window, `p` FOLDED in) NAMED `nomeRecuperacaoFeed(conta, feed, p)`:
 *     the batches the lease turned away ride this feed's own recovery.
 *  2. The release, holder-checked by the `feedId` (`decidirLiberacao`: 0 failures
 *     after `concluido`, +1 otherwise; every end but `cancelado` stamps the
 *     feed-recent clock). A lost precondition re-reads; a start SMALLER than
 *     `p` (a batch turned away after step 1's read) gets its own NAMED `vez`
 *     recovery BEFORE the write.
 *  3. The fluxo's aviso, clocked by the STORED `relogioDesfecho`: `concluido`
 *     resolves it WHATEVER its per-SKU errors (those are the provider's to
 *     raise), every other end raises it.
 *  4. The record's TERMINAL status, LAST: it is also the duplicate gate, so
 *     nothing may remain to do once it is stored.
 *
 * ## Root rule 7
 *
 * The record's `create` is the send handler's (tier 0). Every write here is
 * tier 1: `update(…, { lastUpdateTime })` on the snapshot the patch was derived
 * from; FAILED_PRECONDITION (9) or NOT_FOUND (5) ⇒ re-read and re-derive, at
 * most {@link MAX_TENTATIVAS_REGISTRO_FEED}, then
 * {@link AmazonRegistroFeedEmConflitoError} (retryable). The lease's writes are
 * `./vezFeedFirestore`'s. No multi-document atomic write.
 *
 * ⚠️ Every record and lease stamp is MILLISECONDS; aviso clocks are Firestore
 * `readTime`s, converted only by `avisos/avisos.ts`; Cloud Tasks delays are
 * WHOLE SECONDS.
 */
import type { DocumentSnapshot, Firestore, Timestamp } from 'firebase-admin/firestore';
import { feedAmazonCollection } from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';
import {
  AmazonDocumentoFeedError,
  AmazonError,
  type FeedAmazon,
  type RelatorioProcessamentoListings,
} from '@delfrance/integrations-amazon-sp-api';
import {
  CONTA_ID_AMAZON_REGEX,
  DESFECHO_FEED_AMAZON,
  type DesfechoFeedAmazon,
  ESTADO_VEZ_FEED_AMAZON,
  type FluxoFeedAmazon,
  type MotivoContaAmazon,
  type RegistroFeedAmazon,
  STATUS_REGISTRO_FEED_AMAZON,
  type StatusRegistroFeedAmazon,
  type TimestampLike,
  idRegistroFeedAmazon,
  registroFeedAmazonSchema,
} from '@delfrance/schemas';

import { sincronizarAvisosDaContaAmazon } from '../avisos/avisos';
import { listarContasAmazon } from '../core/contas';
import { type ContextoAmazon, type ContextoAmazonDeps, loadAmazonContext } from '../core/contexto';
import { EVENTO_DO_LOTE_AMAZON } from '../core/escrita';
import {
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import type { FluxoComLoteAmazon } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import { sanitizarFalhaDaTarefaAmazon } from '../notificacoes/notificacao';
import {
  FALHA_LEITURA_AMAZON,
  type FalhaLeituraAmazon,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import type { AgendadorLotesAmazon, ResultadoEnfileiramentoLoteAmazon } from './agendadorLotes';
import { falhaDefinitivaDoDocumento } from './enviarFeed';
import { TIPO_CONSULTA_FEED, proximaConsultaFeed } from './escadaFeed';
import { baixarRelatorioFeedNaAmazon, lerFeedNaAmazon } from './feedsAmazon';
import { type RegistroLoteAmazon, enfileirarVezPeloAgendador } from './incertoFeed';
import {
  type ContextoLoteAmazon,
  ESPERA_MAXIMA_ATRAS_DE_FEED_MS,
  type ProvedorLoteAmazon,
} from './provedorLote';
import {
  atualizacaoDaRodadaFeed,
  desfechoDoStatus,
  prazoDoFeed,
  proximoStatusFeed,
  statusDoProcessamento,
  statusTerminalFeed,
} from './registroFeed';
import { type ReducaoRelatorioFeed, reduzirRelatorioFeed, skusParaGravar } from './relatorioFeed';
import {
  ORIGEM_RESULTADO_FEED_AMAZON,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaResultadoFeedAmazon,
  VERSAO_TAREFA_LOTE_AMAZON,
  nomeConsultaFeed,
  nomeRecuperacaoFeed,
  referenciaDaRecuperacaoFeed,
  tarefaRecuperarFeedAmazonSchema,
  tarefaResultadoFeedAmazonSchema,
} from './tarefaLote';
import {
  CONSUMO_DO_PENDENTE,
  LIBERACAO_VEZ_FEED,
  type LiberacaoVezFeed,
  type MotivoRecusaDaVez,
  faseDaVez,
} from './vezFeed';
import {
  type AlvoVezFeed,
  type EnfileirarVezFeed,
  consumirPendenteVezFeed,
  lerVezFeed,
  liberarVezFeed,
} from './vezFeedFirestore';

/** Read-derive-write attempts of one record write before giving up. */
export const MAX_TENTATIVAS_REGISTRO_FEED = 3;

/* ----------------------------------- contract ---------------------------------- */

/** Everything one result dispatch needs — bound by the jobs root, doubles in the tests. */
export interface DepsResultadoFeedAmazon {
  /** The process environment: the read switch and the LWA pair. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS. Read per decision, never captured. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** The jobs queue's producer — built only when an enqueue is due. */
  readonly agendador: () => AgendadorLotesAmazon;
  /**
   * The fluxo's provider from the seam, asked once the RECORD names the fluxo
   * (the payload does not); `null` while the row is empty.
   */
  readonly provedorDe: (
    fluxo: FluxoComLoteAmazon,
  ) => ProvedorLoteAmazon<FluxoComLoteAmazon, unknown> | null;
  readonly registro: RegistroLoteAmazon;
  /**
   * REQUIRED, never the global: the SAME `fetch` serves the context's read
   * client and the report's download, so one scripted `fetch` sees every request.
   */
  readonly fetch: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** What one result dispatch did (closed). */
export const ACAO_RESULTADO_FEED = {
  /** R1: no record of this feed (another app's feed, or one lost to the uncertain path). */
  feedDesconhecido: 'feed-desconhecido',
  /** R1: a wake-up whose `feedId` two active contas record. */
  feedAmbiguo: 'feed-ambiguo',
  /** R2: the record is terminal already. */
  feedJaConcluido: 'feed-ja-concluido',
  /** R3: the switch, the conta or its credential refused. */
  contextoRecusado: 'contexto-recusado',
  /** R5: Amazon is still processing it; the rung written. */
  processando: 'processando',
  /** R5–R7 or the abandonment: the tail ran. */
  encerrado: 'encerrado',
} as const;
export type AcaoResultadoFeedAmazon =
  (typeof ACAO_RESULTADO_FEED)[keyof typeof ACAO_RESULTADO_FEED];

/** How a feed ended here: every outcome but the send side's `incerto`. */
export type DesfechoTerminalFeedAmazon = Exclude<DesfechoFeedAmazon, 'incerto'>;

/** What became of the report at R7 (closed). */
export const RELATORIO_FEED = {
  /** Downloaded, reduced, written back, counted. */
  baixado: 'baixado',
  /** The record already holds its counts (a retried tail): nothing downloaded again. */
  reaproveitado: 'reaproveitado',
  /** Amazon named no report document. */
  semDocumento: 'sem-documento',
  /** The download failed deterministically. */
  falhou: 'falhou',
} as const;
export type RelatorioResultadoFeed = (typeof RELATORIO_FEED)[keyof typeof RELATORIO_FEED];

/** The dispatch's result, logged ONCE ({@link registrarDespachoResultadoFeedAmazon}). */
export interface ResultadoConsultaFeedAmazon {
  /** The record's fluxo, once a record is known. */
  readonly fluxo: FluxoFeedAmazon | null;
  /** The record's conta, once known (a wake-up names none). */
  readonly contaId: string | null;
  readonly feedId: string;
  readonly acao: AcaoResultadoFeedAmazon;
  /** R3's refusal token. */
  readonly motivo: FalhaLeituraAmazon | null;
  /** The rung this dispatch ran as: the payload's for a poll, the record's otherwise. */
  readonly rodada: number | null;
  /** The successor rung's enqueue, or `abandonar` (none), or `null` (not reached). */
  readonly sucessor: ResultadoEnfileiramentoLoteAmazon | 'abandonar' | null;
  /** The successor's delay, in whole seconds. */
  readonly atrasoS: number | null;
  /** The ladder's answer: past the 12-h deadline. */
  readonly prazo: boolean;
  /** This rung raised the deadline's aviso (once per feed). */
  readonly avisoPrazo: boolean;
  /** Amazon's `processingStatus`, when it is a short token; `<outro>` otherwise. */
  readonly processingStatus: string | null;
  /** Whether that value is one the model lists. */
  readonly reconhecido: boolean | null;
  /** How the feed ended (the tail ran). */
  readonly desfecho: DesfechoTerminalFeedAmazon | null;
  readonly relatorio: RelatorioResultadoFeed | null;
  /** The deterministic download failure's class and closed `motivo`. */
  readonly falhaRelatorio: string | null;
  readonly motivoRelatorio: string | null;
  readonly resumo: ReducaoRelatorioFeed['resumo'] | null;
  readonly skusComProblema: number | null;
  readonly skusGravados: number | null;
  readonly skusOmitidos: number | null;
  readonly semSkuErros: number | null;
  readonly semSkuAvisos: number | null;
  /** The report's issue codes, joined (short tokens only, `./relatorioFeed`). */
  readonly codigos: string | null;
  /** The seam row is empty: the write-back (or the aviso) skipped. */
  readonly semProvedor: boolean;
  /** The tail's recovery enqueue. */
  readonly recuperacao: ResultadoEnfileiramentoLoteAmazon | null;
  /** The start the tail folded into its recovery. */
  readonly pendenteDobrado: number | null;
  /** A lease release (R2, the tail): landed, or why it wrote nothing. */
  readonly liberacao: 'liberada' | MotivoRecusaDaVez | null;
  /** A start this dispatch handed to a NAMED `vez` recovery before a lease write. */
  readonly vezPara: number | null;
  /** The fluxo's aviso the tail (or R5's deadline) raised or resolved. */
  readonly aviso: 'levantado' | 'resolvido' | null;
  /** A wake-up's `getAll`: how many active contas record this feed. */
  readonly contas: number | null;
}

/* ------------------------------------ errors ----------------------------------- */

/**
 * Every attempt of one record write lost its precondition: the record kept
 * moving under it. Nothing of the losing attempts was written. Retryable.
 */
export class AmazonRegistroFeedEmConflitoError extends Error {
  readonly contaId: string;
  readonly feedId: string;
  readonly tentativas: number;

  constructor(contaId: string, feedId: string, tentativas: number) {
    super(
      `O registro do feed ${feedId} da conta da Amazon ${contaId} mudou durante as ` +
        `${String(tentativas)} tentativas de gravá-lo.`,
    );
    this.name = 'AmazonRegistroFeedEmConflitoError';
    this.contaId = contaId;
    this.feedId = feedId;
    this.tentativas = tentativas;
  }
}

/**
 * A stored record no longer parses: only a hand edit can make one (every write
 * goes through the schema). The chain cannot read its record, so it stops here
 * (the daily backstop's case); the message names the broken top-level FIELDS,
 * never a value.
 */
export class AmazonRegistroFeedInvalidoError extends Error {
  readonly contaId: string;
  readonly feedId: string;
  readonly campos: readonly string[];

  constructor(contaId: string, feedId: string, campos: readonly string[]) {
    super(
      `O registro do feed ${feedId} da conta da Amazon ${contaId} não é válido ` +
        `(campos: ${campos.join(', ')}).`,
    );
    this.name = 'AmazonRegistroFeedInvalidoError';
    this.contaId = contaId;
    this.feedId = feedId;
    this.campos = campos;
  }
}

/* ---------------------------------- the record --------------------------------- */

/** One read of the record. */
interface RegistroLido {
  readonly registro: RegistroFeedAmazon;
  /** The precondition of a write derived from this read. */
  readonly updateTime: Timestamp;
  /** WHEN this observation held: R5's deadline clock, the tail's first clock. */
  readonly readTime: Timestamp;
}

/** The record's ids, as one rung knows them. */
interface AlvoRegistro {
  readonly contaId: string;
  readonly feedId: string;
}

function refDoRegistro(db: Firestore, alvo: AlvoRegistro) {
  return feedAmazonCollection.docRef(db, {}, idRegistroFeedAmazon(alvo.contaId, alvo.feedId));
}

/** A snapshot, strictly parsed; `null` when no document exists. */
function registroDoSnapshot(snap: DocumentSnapshot, alvo: AlvoRegistro): RegistroLido | null {
  if (!snap.exists) return null;
  const updateTime = snap.updateTime;
  if (updateTime === undefined) {
    throw new TypeError('feedsAmazon: documento existente sem updateTime');
  }
  const lido = registroFeedAmazonSchema.safeParse(snap.data());
  if (!lido.success) {
    const campos = new Set(lido.error.issues.map((i) => String(i.path[0] ?? '(raiz)')));
    throw new AmazonRegistroFeedInvalidoError(alvo.contaId, alvo.feedId, [...campos].sort());
  }
  return { registro: lido.data, updateTime, readTime: snap.readTime };
}

async function lerRegistro(db: Firestore, alvo: AlvoRegistro): Promise<RegistroLido | null> {
  return registroDoSnapshot(await refDoRegistro(db, alvo).get(), alvo);
}

/**
 * ONE tier-1 write of the record (module header, "Root rule 7"): `derivar`
 * answers the patch from a FRESH read, or `null` (nothing to write). Answers
 * the read the write was derived from, or `null` when the record is gone.
 */
async function gravarNoRegistro(
  db: Firestore,
  alvo: AlvoRegistro,
  derivar: (lido: RegistroLido) => Record<string, unknown> | null,
): Promise<RegistroLido | null> {
  const ref = refDoRegistro(db, alvo);
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_REGISTRO_FEED; tentativa += 1) {
    const lido = registroDoSnapshot(await ref.get(), alvo);
    if (lido === null) return null;
    const patch = derivar(lido);
    if (patch === null) return lido;
    try {
      await ref.update(feedAmazonCollection.parseMerge(patch) as Record<string, unknown>, {
        lastUpdateTime: lido.updateTime,
      });
      return lido;
    } catch (err) {
      // Rule 6: only a lost precondition, or the document gone since the read,
      // is re-derived; anything else propagates.
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    }
  }
  throw new AmazonRegistroFeedEmConflitoError(
    alvo.contaId,
    alvo.feedId,
    MAX_TENTATIVAS_REGISTRO_FEED,
  );
}

/** Amazon's `processingStatus` as the record stores it: the read, or what it held. */
function statusDeAmazon(feed: FeedAmazon | null): string | null {
  return typeof feed?.processingStatus === 'string' ? feed.processingStatus : null;
}

/** A `processingStatus` a line may carry: a short token, never free text. */
const STATUS_LOGAVEL = /^[A-Z_]{1,32}$/;

/** The record's terminal status of an outcome. */
function statusDoDesfecho(desfecho: DesfechoTerminalFeedAmazon): StatusRegistroFeedAmazon {
  switch (desfecho) {
    case DESFECHO_FEED_AMAZON.concluido:
      return STATUS_REGISTRO_FEED_AMAZON.concluido;
    case DESFECHO_FEED_AMAZON.falhou:
      return STATUS_REGISTRO_FEED_AMAZON.falhou;
    case DESFECHO_FEED_AMAZON.cancelado:
      return STATUS_REGISTRO_FEED_AMAZON.cancelado;
    case DESFECHO_FEED_AMAZON.abandonado:
      return STATUS_REGISTRO_FEED_AMAZON.abandonado;
  }
}

/** The lease release of an outcome. */
function liberacaoDoDesfecho(desfecho: DesfechoTerminalFeedAmazon): LiberacaoVezFeed {
  switch (desfecho) {
    case DESFECHO_FEED_AMAZON.concluido:
      return LIBERACAO_VEZ_FEED.concluido;
    case DESFECHO_FEED_AMAZON.falhou:
      return LIBERACAO_VEZ_FEED.falhou;
    case DESFECHO_FEED_AMAZON.cancelado:
      return LIBERACAO_VEZ_FEED.cancelado;
    case DESFECHO_FEED_AMAZON.abandonado:
      return LIBERACAO_VEZ_FEED.abandonado;
  }
}

/* ----------------------------------- the line ---------------------------------- */

/** The outcomes a person may have to look at. */
const DESFECHOS_EM_WARNING: ReadonlySet<string> = new Set<string>([
  DESFECHO_FEED_AMAZON.falhou,
  DESFECHO_FEED_AMAZON.cancelado,
  DESFECHO_FEED_AMAZON.abandonado,
]);

/** The line's severity: WARNING whenever a person may have to look. */
export function severidadeDoResultadoFeedAmazon(r: ResultadoConsultaFeedAmazon): SeveridadeAmazon {
  if (r.acao === ACAO_RESULTADO_FEED.contextoRecusado) return 'WARNING';
  if (r.desfecho !== null && DESFECHOS_EM_WARNING.has(r.desfecho)) return 'WARNING';
  if (r.relatorio === RELATORIO_FEED.semDocumento || r.relatorio === RELATORIO_FEED.falhou) {
    return 'WARNING';
  }
  if (r.avisoPrazo || r.reconhecido === false) return 'WARNING';
  return 'INFO';
}

/**
 * The ONE `feed-resultado` line: ids, closed codes, ms stamps and counts only —
 * never a SKU, an issue message, a document URL or a seller id.
 */
export function registrarDespachoResultadoFeedAmazon(
  logger: LoggerAmazon,
  t: Pick<TarefaResultadoFeedAmazon, 'origem' | 'rodada'>,
  r: ResultadoConsultaFeedAmazon,
  registro: RegistroLoteAmazon,
): void {
  const campos: CamposLogAmazon = {
    fase: 'resultado',
    acao: r.acao,
    motivo: r.motivo,
    feedId: r.feedId,
    origem: t.origem,
    rodadaPedida: t.rodada,
    rodada: r.rodada,
    sucessor: r.sucessor,
    atrasoS: r.atrasoS,
    prazo: r.prazo,
    avisoPrazo: r.avisoPrazo,
    processingStatus: r.processingStatus,
    reconhecido: r.reconhecido,
    desfecho: r.desfecho,
    relatorio: r.relatorio,
    falhaRelatorio: r.falhaRelatorio,
    motivoRelatorio: r.motivoRelatorio,
    erros: r.resumo?.erros ?? null,
    avisos: r.resumo?.avisos ?? null,
    processadas: r.resumo?.processadas ?? null,
    aceitas: r.resumo?.aceitas ?? null,
    invalidas: r.resumo?.invalidas ?? null,
    skusComProblema: r.skusComProblema,
    skusGravados: r.skusGravados,
    skusOmitidos: r.skusOmitidos,
    semSkuErros: r.semSkuErros,
    semSkuAvisos: r.semSkuAvisos,
    codigos: r.codigos,
    semProvedor: r.semProvedor,
    recuperacao: r.recuperacao,
    pendenteDobrado: r.pendenteDobrado,
    liberacao: r.liberacao,
    vezPara: r.vezPara,
    aviso: r.aviso,
    contas: r.contas,
  };
  registrarEventoAmazon(
    logger,
    r.fluxo === null ? 'feed' : EVENTO_DO_LOTE_AMAZON[r.fluxo],
    severidadeDoResultadoFeedAmazon(r),
    `[amazon] feed ${r.fluxo ?? '-'}: resultado (${r.acao})`,
    campos,
    {
      conta: r.contaId,
      ...(r.fluxo === null ? {} : { fluxo: r.fluxo }),
      tentativa: registro.tentativa,
      idTarefa: registro.idTarefa,
    },
  );
}

/* --------------------------------- one dispatch -------------------------------- */

const VAZIO = {
  fluxo: null,
  contaId: null,
  motivo: null,
  rodada: null,
  sucessor: null,
  atrasoS: null,
  prazo: false,
  avisoPrazo: false,
  processingStatus: null,
  reconhecido: null,
  desfecho: null,
  relatorio: null,
  falhaRelatorio: null,
  motivoRelatorio: null,
  resumo: null,
  skusComProblema: null,
  skusGravados: null,
  skusOmitidos: null,
  semSkuErros: null,
  semSkuAvisos: null,
  codigos: null,
  semProvedor: false,
  recuperacao: null,
  pendenteDobrado: null,
  liberacao: null,
  vezPara: null,
  aviso: null,
  contas: null,
} as const;

type Extra = Partial<Omit<ResultadoConsultaFeedAmazon, 'feedId' | 'acao'>>;

function resultado(
  t: TarefaResultadoFeedAmazon,
  acao: AcaoResultadoFeedAmazon,
  extra: Extra = {},
): ResultadoConsultaFeedAmazon {
  return { ...VAZIO, contaId: t.contaId, feedId: t.feedId, acao, ...extra };
}

/** One dispatch, bound once its record is known. */
interface Execucao {
  readonly db: Firestore;
  readonly t: TarefaResultadoFeedAmazon;
  readonly deps: DepsResultadoFeedAmazon;
  readonly alvo: AlvoRegistro;
  readonly alvoVez: AlvoVezFeed;
  readonly provedor: ProvedorLoteAmazon<FluxoComLoteAmazon, unknown> | null;
  /** The rung this dispatch runs as (module header, R1). */
  readonly rodada: number;
  readonly enfileirarVez: EnfileirarVezFeed;
  /** What every later line of this dispatch carries. */
  readonly base: Extra;
}

/**
 * ONE result dispatch, R1–R8 (module header). Returns the result it logged;
 * throws only what the queue must retry (an Amazon read before the tail, a
 * transient report download, a Firestore or Cloud Tasks failure, the record's
 * and the lease's own conflict and corruption classes), with an Amazon error
 * sanitized.
 */
export async function processarResultadoFeedAmazon(
  db: Firestore,
  t: TarefaResultadoFeedAmazon,
  deps: DepsResultadoFeedAmazon,
): Promise<ResultadoConsultaFeedAmazon> {
  let r: ResultadoConsultaFeedAmazon;
  try {
    r = await executarConsulta(db, t, deps);
  } catch (err) {
    // The ONE boundary: a package error leaves as its class and status only.
    throw sanitizarFalhaDaTarefaAmazon(err);
  }
  registrarDespachoResultadoFeedAmazon(deps.logger, t, r, deps.registro);
  return r;
}

/** R1's lookup: the record, none, or several (a wake-up only). */
type Localizacao =
  | { readonly tipo: 'um'; readonly lido: RegistroLido }
  | { readonly tipo: 'nenhum'; readonly contas: number | null }
  | { readonly tipo: 'varios'; readonly contas: number };

/** R1 (module header): the payload's conta, or every ACTIVE conta for a wake-up. */
async function localizarRegistro(
  db: Firestore,
  t: TarefaResultadoFeedAmazon,
): Promise<Localizacao> {
  if (t.contaId !== null) {
    const lido = await lerRegistro(db, { contaId: t.contaId, feedId: t.feedId });
    return lido === null ? { tipo: 'nenhum', contas: null } : { tipo: 'um', lido };
  }
  // Uncached: the answer decides which conta's record this rung writes.
  const { contas } = await listarContasAmazon(db);
  const ativas = contas
    .filter((c) => c.ativo && CONTA_ID_AMAZON_REGEX.test(c.integracaoId))
    .map((c) => c.integracaoId);
  if (ativas.length === 0) return { tipo: 'nenhum', contas: 0 };
  const snaps = await db.getAll(
    ...ativas.map((contaId) => refDoRegistro(db, { contaId, feedId: t.feedId })),
  );
  const achados = snaps.flatMap((snap, i) => {
    const contaId = ativas[i];
    if (contaId === undefined) return [];
    const lido = registroDoSnapshot(snap, { contaId, feedId: t.feedId });
    return lido === null ? [] : [lido];
  });
  const [unico] = achados;
  if (achados.length > 1) return { tipo: 'varios', contas: achados.length };
  if (unico === undefined) return { tipo: 'nenhum', contas: 0 };
  return { tipo: 'um', lido: unico };
}

async function executarConsulta(
  db: Firestore,
  t: TarefaResultadoFeedAmazon,
  deps: DepsResultadoFeedAmazon,
): Promise<ResultadoConsultaFeedAmazon> {
  // ---- R1: the record. ----
  const local = await localizarRegistro(db, t);
  if (local.tipo === 'nenhum') {
    return resultado(t, ACAO_RESULTADO_FEED.feedDesconhecido, { contas: local.contas });
  }
  if (local.tipo === 'varios') {
    return resultado(t, ACAO_RESULTADO_FEED.feedAmbiguo, { contas: local.contas });
  }
  const { lido } = local;
  const { registro } = lido;
  const provedor = deps.provedorDe(registro.fluxo);
  if (provedor !== null && provedor.fluxo !== registro.fluxo) {
    throw new TypeError('resultadoFeed.ts: o provedor e o registro nomeiam fluxos diferentes');
  }
  const rodada = t.origem === ORIGEM_RESULTADO_FEED_AMAZON.consulta ? t.rodada : registro.rodadas;
  const e: Execucao = {
    db,
    t,
    deps,
    alvo: { contaId: registro.contaId, feedId: registro.feedId },
    alvoVez: { fluxo: registro.fluxo, contaId: registro.contaId },
    provedor,
    rodada,
    enfileirarVez: enfileirarVezPeloAgendador(deps.agendador),
    base: { fluxo: registro.fluxo, contaId: registro.contaId, rodada },
  };

  // ---- R2: a terminal record — only a lost release may be left to do. ----
  if (statusTerminalFeed(registro.status)) return jaConcluido(e, registro.status);

  // ---- R1 (cont.): the SUCCESSOR first, before any Amazon call. ----
  const agoraMs = deps.agora();
  const proxima = proximaConsultaFeed(rodada + 1, agoraMs, registro.antesDoEnvioMs);
  if (proxima.tipo === TIPO_CONSULTA_FEED.abandonar) {
    // No successor: this rung ends the feed, with no Amazon call at all.
    const clock = await garantirRelogioDesfecho(e);
    if (clock === null) return resultado(t, ACAO_RESULTADO_FEED.feedDesconhecido, e.base);
    return encerrar(e, clock, DESFECHO_FEED_AMAZON.abandonado, null, {
      ...e.base,
      sucessor: 'abandonar',
      prazo: true,
    });
  }
  const sucessor = await e.deps.agendador().enfileirarLote(tarefaDaRodada(registro, rodada + 1), {
    nome: nomeConsultaFeed(registro.contaId, registro.feedId, rodada + 1),
    atrasoS: proxima.atrasoS,
  });
  const comSucessor: Extra = {
    ...e.base,
    sucessor,
    atrasoS: proxima.atrasoS,
    prazo: proxima.tipo === TIPO_CONSULTA_FEED.prazo,
  };

  // ---- R3: the context — the read switch first. ----
  const contexto = await carregarContexto(e);
  if (typeof contexto === 'string') {
    return resultado(t, ACAO_RESULTADO_FEED.contextoRecusado, { ...comSucessor, motivo: contexto });
  }

  // ---- R4: getFeed. ----
  const feed = await lerFeedNaAmazon(contexto, registro.feedId);
  const lidoDoStatus = statusDoProcessamento(feed.processingStatus);
  const bruto = statusDeAmazon(feed);
  const comStatus: Extra = {
    ...comSucessor,
    processingStatus: bruto === null ? null : STATUS_LOGAVEL.test(bruto) ? bruto : '<outro>',
    reconhecido: lidoDoStatus.reconhecido,
  };

  switch (lidoDoStatus.status) {
    // ---- R5: still processing. ----
    case STATUS_REGISTRO_FEED_AMAZON.processando:
      return emProcessamento(e, lido, feed, comStatus);
    // ---- R6: cancelled — nothing applied, no download. ----
    case STATUS_REGISTRO_FEED_AMAZON.cancelado: {
      const clock = await garantirRelogioDesfecho(e);
      if (clock === null) return resultado(t, ACAO_RESULTADO_FEED.feedDesconhecido, comStatus);
      return encerrar(e, clock, DESFECHO_FEED_AMAZON.cancelado, feed, comStatus);
    }
    // ---- R7: done or fatal — the report, then the tail. ----
    case STATUS_REGISTRO_FEED_AMAZON.concluido:
    case STATUS_REGISTRO_FEED_AMAZON.falhou:
      return comRelatorio(e, contexto, feed, lidoDoStatus.status, comStatus);
    case STATUS_REGISTRO_FEED_AMAZON.enviado:
    case STATUS_REGISTRO_FEED_AMAZON.abandonado:
      // `statusDoProcessamento` answers neither: only a bug lands here.
      throw new TypeError('resultadoFeed.ts: status de processamento fora do conjunto');
  }
}

/** A result rung of `registro`'s feed, as its successor carries it. */
function tarefaDaRodada(registro: RegistroFeedAmazon, rodada: number): TarefaResultadoFeedAmazon {
  return tarefaResultadoFeedAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.resultado,
    contaId: registro.contaId,
    feedId: registro.feedId,
    rodada,
    origem: ORIGEM_RESULTADO_FEED_AMAZON.consulta,
  });
}

/** R3: the context, or the refusal token that ends the dispatch. */
async function carregarContexto(e: Execucao): Promise<ContextoAmazon | FalhaLeituraAmazon> {
  const deps: ContextoAmazonDeps = {
    ambiente: e.deps.ambiente,
    agora: e.deps.agora,
    logger: e.deps.logger,
    registro: {
      fluxo: e.alvoVez.fluxo,
      tentativa: e.deps.registro.tentativa,
      idTarefa: e.deps.registro.idTarefa,
    },
    fetch: e.deps.fetch,
    gerarCorrelationId: e.deps.gerarCorrelationId,
  };
  try {
    return await loadAmazonContext(e.db, e.alvo.contaId, deps);
  } catch (err) {
    const token = classificarFalhaDeLeituraAmazon(err);
    if (
      token !== FALHA_LEITURA_AMAZON.chamadasDesligadas &&
      token !== FALHA_LEITURA_AMAZON.contaInativa &&
      token !== FALHA_LEITURA_AMAZON.contaIndisponivel
    ) {
      throw err;
    }
    return token;
  }
}

/** The context the provider receives at R7 (no lease read here: no send-side clock). */
function contextoDoLote(e: Execucao, contexto: ContextoAmazon): ContextoLoteAmazon {
  const sellerId = contexto.conta.selling_partner_id;
  if (typeof sellerId !== 'string' || sellerId === '') {
    // The context loader refuses a conta with no seller: only a bug reaches this.
    throw new TypeError('resultadoFeed.ts: o contexto não nomeia o vendedor');
  }
  return {
    contexto,
    db: e.db,
    logger: e.deps.logger,
    agora: e.deps.agora,
    sellerId,
    relogioVez: null,
  };
}

/** The fluxo's aviso, raised or resolved, clocked by `relogio` (a stored Firestore clock). */
async function sincronizarAviso(
  e: Execucao,
  provedor: ProvedorLoteAmazon<FluxoComLoteAmazon, unknown>,
  modo: 'levantado' | 'resolvido',
  relogio: TimestampLike,
): Promise<'levantado' | 'resolvido'> {
  const motivo: MotivoContaAmazon = provedor.motivoFalha;
  await sincronizarAvisosDaContaAmazon(
    e.db,
    { increment: e.deps.increment, nowMs: e.deps.agora(), logger: e.deps.logger },
    {
      integracaoId: e.alvo.contaId,
      levantar: modo === 'levantado' ? [motivo] : [],
      resolver: modo === 'resolvido' ? [motivo] : [],
      relogio,
    },
  );
  return modo;
}

/* ------------------------------------- R2 -------------------------------------- */

/** A terminal record: the lease released when it still names this feed (module header, R2). */
async function jaConcluido(
  e: Execucao,
  status: StatusRegistroFeedAmazon,
): Promise<ResultadoConsultaFeedAmazon> {
  const desfecho = desfechoDoStatus(status);
  if (desfecho === null || desfecho === DESFECHO_FEED_AMAZON.incerto) {
    throw new TypeError('resultadoFeed.ts: um status terminal sem desfecho');
  }
  const vez = await lerVezFeed(e.db, e.alvoVez);
  if (vez.vez === null || vez.vez.feedId !== e.alvo.feedId) {
    return resultado(e.t, ACAO_RESULTADO_FEED.feedJaConcluido, { ...e.base, desfecho });
  }
  const liberada = await liberarVezFeed(
    e.db,
    e.alvoVez,
    { feedId: e.alvo.feedId },
    liberacaoDoDesfecho(desfecho),
    { agora: e.deps.agora, pendenteDobrado: null, enfileirarVez: e.enfileirarVez },
  );
  return resultado(e.t, ACAO_RESULTADO_FEED.feedJaConcluido, {
    ...e.base,
    desfecho,
    liberacao: liberada.tipo === 'escrito' ? 'liberada' : liberada.motivo,
    vezPara: liberada.tipo === 'escrito' ? liberada.liberacao.vezPara : null,
  });
}

/* ------------------------------------- R5 -------------------------------------- */

/** R5 (module header): the deadline's aviso once, the waiting batches past 30 min, the rung write. */
async function emProcessamento(
  e: Execucao,
  lido: RegistroLido,
  feed: FeedAmazon,
  extra: Extra,
): Promise<ResultadoConsultaFeedAmazon> {
  const { registro } = lido;
  const agoraMs = e.deps.agora();

  // The deadline's aviso, ONCE: this is the first rung at or past it (the
  // previous rung's stamp precedes it). Clocked by THIS rung's record read.
  let avisoPrazo = false;
  if (
    e.provedor !== null &&
    agoraMs >= prazoDoFeed(registro.antesDoEnvioMs) &&
    registro.atualizadoEmMs < registro.prazoEmMs
  ) {
    await sincronizarAviso(e, e.provedor, 'levantado', lido.readTime);
    avisoPrazo = true;
  }

  // Past the slow bound: the lease's waiting batches leave through their own
  // `vez` recovery (the lease stays `enviado`).
  let vezPara: number | null = null;
  if (agoraMs >= registro.antesDoEnvioMs + ESPERA_MAXIMA_ATRAS_DE_FEED_MS) {
    const consumo = await consumirPendenteVezFeed(
      e.db,
      e.alvoVez,
      { tipo: CONSUMO_DO_PENDENTE.rodada, feedId: e.alvo.feedId },
      { agora: e.deps.agora, enfileirarVez: e.enfileirarVez },
    );
    if (consumo.tipo === 'escrito') vezPara = consumo.vezPara;
  }

  // The rung write: ALWAYS, even when the status does not move.
  const lidoDoStatus = statusDoProcessamento(feed.processingStatus);
  await gravarNoRegistro(e.db, e.alvo, (fresco) => {
    if (statusTerminalFeed(fresco.registro.status)) return null;
    return {
      ...atualizacaoDaRodadaFeed(fresco.registro, lidoDoStatus.status, e.rodada, e.deps.agora()),
      processingStatus: statusDeAmazon(feed) ?? fresco.registro.processingStatus,
    };
  });
  return resultado(e.t, ACAO_RESULTADO_FEED.processando, {
    ...extra,
    avisoPrazo,
    aviso: avisoPrazo ? 'levantado' : null,
    vezPara,
  });
}

/* ------------------------------------- R7 -------------------------------------- */

/**
 * The tail's clock (module header): the STORED `relogioDesfecho`, or — the
 * first dispatch to get here — this dispatch's record read `readTime`, stored
 * first. Answers the record as it now stands and the clock; `null` when the
 * record is gone.
 */
async function garantirRelogioDesfecho(
  e: Execucao,
): Promise<{ readonly lido: RegistroLido; readonly relogio: TimestampLike } | null> {
  const lido = await gravarNoRegistro(e.db, e.alvo, (fresco) =>
    fresco.registro.relogioDesfecho === null ? { relogioDesfecho: fresco.readTime } : null,
  );
  if (lido === null) return null;
  // The read the write was decided on: its stored clock, else the one just written.
  return { lido, relogio: lido.registro.relogioDesfecho ?? lido.readTime };
}

/** The class a deterministic download failure is logged by, and its closed motivo. */
function falhaDoRelatorio(err: unknown): {
  readonly classe: string;
  readonly motivo: string | null;
} {
  if (err instanceof AmazonDocumentoFeedError) return { classe: err.name, motivo: err.motivo };
  return { classe: err instanceof AmazonError ? err.name : '<outro>', motivo: null };
}

/** R7 (module header): the report, the write-back, the counts, then the tail. */
async function comRelatorio(
  e: Execucao,
  contexto: ContextoAmazon,
  feed: FeedAmazon,
  status: typeof STATUS_REGISTRO_FEED_AMAZON.concluido | typeof STATUS_REGISTRO_FEED_AMAZON.falhou,
  extra: Extra,
): Promise<ResultadoConsultaFeedAmazon> {
  const desfecho =
    status === STATUS_REGISTRO_FEED_AMAZON.concluido
      ? DESFECHO_FEED_AMAZON.concluido
      : DESFECHO_FEED_AMAZON.falhou;
  // The tail's clock FIRST: the write-back and the tail both read it.
  const clock = await garantirRelogioDesfecho(e);
  if (clock === null) return resultado(e.t, ACAO_RESULTADO_FEED.feedDesconhecido, extra);
  const { registro } = clock.lido;

  const documento = feed.resultFeedDocumentId;
  if (registro.resultado !== null) {
    // A retried tail: the counts landed AFTER the write-back, so both are done.
    return encerrar(e, clock, desfecho, feed, {
      ...extra,
      relatorio: RELATORIO_FEED.reaproveitado,
      resumo: registro.resultado,
    });
  }
  if (typeof documento !== 'string' || documento === '') {
    return encerrar(e, clock, desfecho, feed, { ...extra, relatorio: RELATORIO_FEED.semDocumento });
  }

  let relatorio: RelatorioProcessamentoListings;
  try {
    relatorio = await baixarRelatorioFeedNaAmazon(contexto, documento, { fetch: e.deps.fetch });
  } catch (err) {
    // Rule 6: a transient failure (or anything not the package's) is retried
    // by the queue — the successor is already durable; a deterministic one
    // would fail the same way on every rung.
    if (!falhaDefinitivaDoDocumento(err)) throw err;
    const falha = falhaDoRelatorio(err);
    return encerrar(e, clock, desfecho, feed, {
      ...extra,
      relatorio: RELATORIO_FEED.falhou,
      falhaRelatorio: falha.classe,
      motivoRelatorio: falha.motivo,
    });
  }

  // Attribution by the issue's own `sku`, exactly as written (`./relatorioFeed`):
  // the handler holds no list of the SKUs the feed sent.
  const reducao = reduzirRelatorioFeed(relatorio);
  const { problemas, omitidos } = skusParaGravar(reducao.porSku);
  if (e.provedor !== null) {
    await e.provedor.gravarResultado(contextoDoLote(e, contexto), {
      problemas,
      emMs: registro.antesDoEnvioMs,
      feedId: registro.feedId,
      relogio: clock.relogio,
    });
  }
  const lidoDoStatus = statusDoProcessamento(feed.processingStatus);
  const contado = await gravarNoRegistro(e.db, e.alvo, (fresco) => {
    if (statusTerminalFeed(fresco.registro.status)) return null;
    return {
      ...atualizacaoDaRodadaFeed(fresco.registro, lidoDoStatus.status, e.rodada, e.deps.agora()),
      processingStatus: statusDeAmazon(feed) ?? fresco.registro.processingStatus,
      resultado: reducao.resumo,
      problemasSemSku: reducao.semSku,
      skusComProblema: reducao.porSku.size,
      skusGravados: problemas.size,
    };
  });
  if (contado === null) return resultado(e.t, ACAO_RESULTADO_FEED.feedDesconhecido, extra);
  return encerrar(e, clock, desfecho, feed, {
    ...extra,
    relatorio: RELATORIO_FEED.baixado,
    resumo: reducao.resumo,
    skusComProblema: reducao.porSku.size,
    skusGravados: problemas.size,
    skusOmitidos: omitidos,
    semSkuErros: reducao.semSku.erros,
    semSkuAvisos: reducao.semSku.avisos,
    codigos: reducao.codigos.length === 0 ? null : reducao.codigos.join(','),
    semProvedor: e.provedor === null,
  });
}

/* ----------------------------------- the TAIL ---------------------------------- */

/**
 * The TAIL (module header), in its exact order: the recovery (the start
 * folded), the release, the aviso, the terminal status LAST.
 */
async function encerrar(
  e: Execucao,
  clock: { readonly lido: RegistroLido; readonly relogio: TimestampLike },
  desfecho: DesfechoTerminalFeedAmazon,
  feed: FeedAmazon | null,
  extra: Extra,
): Promise<ResultadoConsultaFeedAmazon> {
  const { registro } = clock.lido;

  // 1. The lease's pending start, folded into this feed's NAMED recovery.
  const lidaVez = await lerVezFeed(e.db, e.alvoVez);
  const vez = lidaVez.vez;
  const nomeiaEsteFeed =
    vez !== null &&
    faseDaVez(vez) === ESTADO_VEZ_FEED_AMAZON.enviado &&
    vez.feedId === registro.feedId;
  const pendenteDobrado = nomeiaEsteFeed ? vez.pendenteDesdeMs : null;
  const tarefa = tarefaRecuperarFeedAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.recuperar,
    fluxo: registro.fluxo,
    contaId: registro.contaId,
    desfecho,
    feedId: registro.feedId,
    execucaoId: registro.execucaoId,
    snapshotEmMs: registro.snapshotEmMs,
    pendenteDesdeMs: pendenteDobrado,
    janela: registro.janela,
  });
  const recuperacao = await e.deps.agendador().enfileirarLote(tarefa, {
    nome: nomeRecuperacaoFeed(
      registro.contaId,
      referenciaDaRecuperacaoFeed(tarefa),
      pendenteDobrado,
    ),
  });

  // 2. The release, holder-checked by the feed; a smaller start gets its own `vez`.
  const liberada = await liberarVezFeed(
    e.db,
    e.alvoVez,
    { feedId: registro.feedId },
    liberacaoDoDesfecho(desfecho),
    { agora: e.deps.agora, pendenteDobrado, enfileirarVez: e.enfileirarVez },
  );

  // 3. The fluxo's aviso, clocked by the STORED outcome clock.
  const aviso =
    e.provedor === null
      ? null
      : await sincronizarAviso(
          e,
          e.provedor,
          desfecho === DESFECHO_FEED_AMAZON.concluido ? 'resolvido' : 'levantado',
          clock.relogio,
        );

  // 4. The terminal status, LAST.
  const terminal = statusDoDesfecho(desfecho);
  await gravarNoRegistro(e.db, e.alvo, (fresco) => {
    if (proximoStatusFeed(fresco.registro.status, terminal) === null) return null;
    const agoraMs = e.deps.agora();
    return {
      status: terminal,
      concluidoEmMs: agoraMs,
      atualizadoEmMs: agoraMs,
      rodadas: Math.max(fresco.registro.rodadas, e.rodada),
      processingStatus: statusDeAmazon(feed) ?? fresco.registro.processingStatus,
    };
  });

  return resultado(e.t, ACAO_RESULTADO_FEED.encerrado, {
    ...extra,
    desfecho,
    recuperacao,
    pendenteDobrado,
    liberacao: liberada.tipo === 'escrito' ? 'liberada' : liberada.motivo,
    vezPara: liberada.tipo === 'escrito' ? liberada.liberacao.vezPara : null,
    aviso,
    semProvedor: e.provedor === null,
  });
}
