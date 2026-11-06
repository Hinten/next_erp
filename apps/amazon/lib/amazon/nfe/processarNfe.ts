/**
 * The body of the NF-e queue `processAmazonNfeUpload` (step 14, PR 14-c): ONE
 * dispatch of an upload, P0–P12, in this exact order. The function file
 * (`functions/src/filaNfe.ts`) binds the deps and writes the ONE `evento: 'nfe'`
 * dispatch line this module's result describes
 * ({@link registrarDespachoNfeAmazon}).
 *
 * ## The ladder
 *
 * - **P0** — `tarefaNfeAmazonSchema` (`.strict()`): an invalid payload is
 *   dropped with a WARNING (nothing to key an aviso on).
 * - **P1** — the NF-e valve, read ONCE (`lerValvula`) and logged
 *   (`registrarValvulaAmazon`) on every dispatch, BEFORE any read. Only P6 and
 *   the engine consult it.
 * - **P2** — the raw `nfev4` document, through the LEVEL predicate
 *   (`decideNfeUploadDispatch`) — never the transition one: an NF-e cancelled
 *   between the enqueue and the run must not upload. Not ready: fase `envio` ⇒
 *   `nfe-nao-pronta`, log only; fase `verificacao` and the document is now
 *   `'c'` ⇒ the aviso `nfe-cancelada` (a submit already happened); any other
 *   not-ready in `verificacao` ⇒ log only.
 * - **P3** — the raw pedido: the ownership proof and the emission block
 *   (`avaliarPedidoParaTarefaNfeAmazon` — never the trigger's stored DBA
 *   pre-filter: DBA is decided LIVE). A STORED cancelled sale (`cancelado` or
 *   `estornadoIntegralmente`: `vendaCanceladaAmazon`) ⇒ the incidente
 *   `amz-nfe-pedido-cancelado` + the resolve `pedido-cancelado`, ZERO Amazon
 *   calls. Its `readTime` clocks EVERY aviso of the dispatch; its watermark
 *   (`pisoDoPedidoAmazon`) is P8's floor.
 * - **P4** — the sale gate: a legible non-sale note ⇒ log; an ILLEGIBLE one ⇒
 *   aviso + stamp `xml-invalido`.
 * - **P5** — ONE unfiltered listing of `pedidos/{id}/nfev4` (a subcollection:
 *   no index) ⇒ the siblings; another eligible sale note ⇒ aviso `nfe-ambigua`,
 *   before any Amazon call, in both fases.
 * - **P6** — fase `envio` ONLY: the target under the valve; `off` ⇒ aviso
 *   `envio-nao-ligado`, with NO context and NO Amazon read. A verification is a
 *   read-only look governed by the read switch alone (step-14 plan §3 decision
 *   25), so a valve flip never ends a chain that already submitted.
 * - **P7** — the context (the read switch FIRST): `chamadas-desligadas`;
 *   an inactive conta ⇒ log `conta-inativa`; absent, unconnected, parked or
 *   credential ⇒ `conta-indisponivel`.
 * - **P8** — the LIVE order on EVERY dispatch, through the one `getOrder`
 *   caller (`pedidos/lerPedidoAmazon.ts`) with the stored watermark as its
 *   floor. Fase `envio`: every gate but `segue` stops before any submit (the
 *   cancelled sale ⇒ the incidente + resolve; the open request ⇒ its aviso +
 *   `amazonPedidoPrecisaAtencao` `aceitar-cancelamento`; an unknown status ⇒
 *   aviso `status-pedido-desconhecido`; `nao-dba`, `nf-nao-requerida` ⇒ log).
 *   Fase `verificacao` (it never submits): only the cancelled sale ends the
 *   chain; every other gate result is logged (`portao`) and the read goes on.
 *   The open request raises its per-pedido row at P8, and its NF-e row only
 *   when the verification's outcome wrote nothing to that row
 *   (`avisoDoCancelamentoAberto`: one row, one clock, written once).
 * - **P9** — fase `envio`: the write ENGINE (`core/escrita.ts`): the status
 *   read FIRST (`entregaAmazon.ts`), the envio table, then — under `on` and in
 *   the canary — ONE `submitInvoice` of the stored proc's bytes
 *   (`conteudoNfe.ts`). Dry-run (or outside the canary) ⇒ the engine's diff
 *   line, and the aviso `envio-nao-ligado` when the plan would submit. Fase
 *   `verificacao`: the status read, then the verification table — no valve,
 *   no engine.
 * - **P10** — the submit and EVERYTHING after it is a NO-THROW boundary
 *   ({@link desfechoDoEnvio}, and every later write through the boundary of
 *   `executarEfeito`): the queue's retry would re-read status inside the
 *   read-after-write lag, read `sem-nota`, and submit again. Only an unnamed bug
 *   crosses it.
 * - **P11** — before the submit: a 429 on ANY call ⇒ the pause re-enqueue
 *   (`pausaNfeAmazon`, `PAUSAS_NFE_AMAZON_S[pausas]`; no queue attempt spent),
 *   and at the bound `amazon-indisponivel` (envio) or the next rung
 *   (verificacao); a 5xx, a cut connection or a lagging order read THROWS for
 *   the queue — and on the LAST attempt: `amazon-indisponivel` (envio) or the
 *   next rung (verificacao: a transient never ends a chain early, only the
 *   ladder's end does). A Firestore error or a bug before the submit rethrows
 *   on every attempt, sanitized (`sanitizarFalhaDaTarefaAmazon`).
 * - **P12** — an outcome's writes in THIS order: aviso → the due re-enqueue →
 *   stamp → resolve; for `aceita`: the clear (only from a stored `error`) →
 *   resolve `nfe-validada` → the step-15 seam (`destinoAceite.ts`, null).
 *   Every enqueue goes through a `tarefaNfe.ts` builder (the copy rules), and
 *   once a chain enqueue succeeded nothing later in the dispatch throws, so a
 *   retry never forks a chain. A LOST chain enqueue is never a silent drop
 *   ({@link EnfileiramentoNfe}): the queue valve, on any attempt, ⇒
 *   `tarefas-desligadas`; any other contained loss inside the boundary, or
 *   before it on the LAST attempt, ⇒ where the chain ends without that step
 *   (the pause: `amazon-indisponivel` in envio; a rung or a read-back:
 *   `aceite-nao-confirmado`; the resubmit: `envio-nao-confirmado`). After OUR
 *   submit the verification enqueue keeps P10's row whatever the class.
 *
 * ## What never reaches a line, an aviso or a payload
 *
 * The XML, its base64, its digest (`contentMD5Value`), the access key, Amazon's
 * free text. The dispatch line carries ids, closed codes (motivos, readings,
 * Amazon's error codes through `codigoDeErroSeguro`) and counts only.
 *
 * ## Rule 7
 *
 * The happy path writes NO document (a submit, a `processando`, an `aceita`
 * with no stored stamp). The stamp and the clear are tier 1
 * (`carimboFreteNfe.ts`); the avisos are the shared seam's, clocked by P3's
 * `readTime`; the incidente is tier 0. No multi-document atomic write is
 * opened. The ordering guard between ONE order's dispatches is the queue's
 * `maxConcurrentDispatches: 1`.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import type { ResultadoAviso } from '@delfrance/data/admin/avisos';
import { nfev4Collection, pedidoCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  type ResultadoEnvioNotaFiscal,
} from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_NFE,
  MOTIVO_PEDIDO_AMAZON,
  decideNfeUploadDispatch,
  finalidadeDaNfeProc,
} from '@delfrance/schemas';

import {
  type AvisoDepsAmazon,
  type CommitDoDocumento,
  MOTIVO_AVISO_AMAZON,
  agoraUsDe,
  sincronizarAvisosDoPedidoAmazon,
} from '../avisos/avisos';
import { type ContextoAmazon, type ContextoAmazonDeps, loadAmazonContext } from '../core/contexto';
import {
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
} from '../core/erros';
import { type ResultadoEscritaAmazon, executarEscritaAmazon } from '../core/escrita';
import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';
import {
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import { codigoDeErroSeguro } from '../core/redacao';
import {
  FLUXO_AMAZON,
  MODO_AMAZON,
  decidirAlvo,
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
import { registrarIncidenteNfePedidoCanceladoAmazon } from '../pedidos/incidentesPedidoAmazon';
import { lerPedidoAmazon } from '../pedidos/lerPedidoAmazon';
import {
  type AgendadorNfeAmazon,
  AmazonNfeRegiaoDaFilaInvalidaError,
  AmazonNfeTarefasDesligadasError,
} from './agendadorNfe';
import { avisarNfeAmazon, resolverNfeAmazon } from './avisoNfe';
import {
  AmazonNfeCarimboEmConflitoError,
  type MotivoCarimboNfeAmazon,
  carimbarFreteNfeAmazon,
  limparCarimboNfeAmazon,
} from './carimboFreteNfe';
import { conteudoDaNfeAmazon } from './conteudoNfe';
import {
  type DecisaoEnvioNfeAmazon,
  type DecisaoVerificacaoNfeAmazon,
  type PlanoEnvioNfeAmazon,
  decidirVerificacaoNfeAmazon,
  planoDeEnvioNfeAmazon,
} from './decisaoNfe';
import { DESTINO_ACEITE_NFE_AMAZON } from './destinoAceite';
import { enviarNfeNaAmazon, lerStatusNfeNaAmazon } from './entregaAmazon';
import { type MotivoPortaoPedidoNfeAmazon, gatesDoPedidoAmazonParaNfe } from './gatesPedidoNfe';
import {
  MOTIVOS_NFE_QUE_CARIMBAM,
  MOTIVOS_NFE_SO_LOG_EM_WARNING,
  MOTIVO_NFE_AMAZON,
  type MotivoNfeAmazon,
  type MotivoNfeQueAvisaAmazon,
} from './motivosNfe';
import {
  type IrmaosDaNfeAmazon,
  avaliarPedidoParaTarefaNfeAmazon,
  irmaosDaNfeAmazon,
  pisoDoPedidoAmazon,
  vendaCanceladaAmazon,
} from './pedidoNfe';
import type { LeituraStatusNfe, TipoLeituraStatusNfe } from './statusNfe';
import {
  ESCADA_VERIFICACAO_NFE_AMAZON_S,
  FASE_NFE_AMAZON,
  FILA_NFE_AMAZON,
  type FaseNfeAmazon,
  type LeituraAntesNfeAmazon,
  PAUSAS_NFE_AMAZON_S,
  TENTATIVAS_NFE_AMAZON,
  type TarefaNfeAmazon,
  aposEnvioNfeAmazon,
  pausaNfeAmazon,
  proximoDegrauNfeAmazon,
  reenvioNfeAmazon,
  tarefaNfeAmazonSchema,
} from './tarefaNfe';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/** The queue dispatch this run is: its 0-based attempt and its task id. */
export interface RegistroNfeAmazon {
  readonly tentativa: number;
  readonly idTarefa: string | null;
}

/** Everything one dispatch needs — bound by `functions/src/filaNfe.ts`, doubles in the tests. */
export interface DepsProcessarNfeAmazon {
  /** The process environment: the read switch, the LWA pair, the NF-e valve and canary. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS (read once per dispatch for the writes; per call by the clients). */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** The NF-e queue's producer, for the handler's own re-enqueues — built only when one is due. */
  readonly agendador: () => AgendadorNfeAmazon;
  readonly registro: RegistroNfeAmazon;
  /** Test seams, forwarded to the context and the write engine as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** What one dispatch did (closed). */
export type AcaoNfeAmazon =
  /** P0: the payload is not this queue's — dropped, WARNING. */
  | 'payload-invalido'
  /** A log-only reason ended it. */
  | 'descartado'
  /** An aviso was raised (and, per `motivosNfe.ts`, maybe a stamp). */
  | 'avisado'
  /** Amazon accepted the invoices it holds: the `aceita` path. */
  | 'aceita'
  /** A chain step was enqueued: the verification after an envio, the next rung, the resubmit. */
  | 'enfileirado'
  /** A 429: the same dispatch re-enqueued after a pause. */
  | 'pausado';

/** What the submit did (only when one was attempted). */
export type EnvioNfeAmazon =
  | 'aceito'
  | 'erros'
  | 'recusado'
  | 'incerto'
  | 'nao-processado'
  | 'invalido';

/** Which write a post-submit failure lost. */
export type EscritaNfeAmazon =
  | 'aviso'
  | 'enfileiramento'
  | 'carimbo'
  | 'limpeza'
  | 'resolucao'
  | 'incidente'
  | 'atencao'
  | 'destino';

/** The chain step a dispatch enqueued. */
export interface ProximaTarefaNfeAmazon {
  readonly fase: FaseNfeAmazon;
  readonly degrau: number;
  readonly reenvios: number;
  readonly pausas: number;
  /** The delay handed to the queue, in seconds (0: none). */
  readonly atrasoS: number;
}

/** The dispatch's result, logged ONCE by the queue ({@link registrarDespachoNfeAmazon}). */
export interface ResultadoNfeAmazon {
  readonly acao: AcaoNfeAmazon;
  /** The closed reason of the outcome, when one applies. */
  readonly motivo: MotivoNfeAmazon | null;
  readonly fase: FaseNfeAmazon | null;
  readonly degrau: number | null;
  readonly pedidoId: string | null;
  readonly nfeId: string | null;
  /** The conta, once the pedido is proved. */
  readonly contaId: string | null;
  /** Amazon's order id, once the pedido is proved. */
  readonly pedido: string | null;
  /** The status reading the decision was made on. */
  readonly statusAmazon: TipoLeituraStatusNfe | null;
  readonly envio: EnvioNfeAmazon | null;
  /** Amazon's error codes, raw (the line keeps only the closed ones). */
  readonly codigos: readonly string[];
  /** A live gate a verification logged and went past. */
  readonly portao: MotivoPortaoPedidoNfeAmazon | null;
  readonly aviso: ResultadoAviso | null;
  readonly carimbo: MotivoCarimboNfeAmazon | null;
  readonly proxima: ProximaTarefaNfeAmazon | null;
  /** A write lost INSIDE the no-throw boundary: which, and the failure's class. */
  readonly posEnvio: { readonly escrita: EscritaNfeAmazon; readonly erro: string } | null;
}

/* -------------------------------------------------------------------------- */
/*                               the dispatch line                            */
/* -------------------------------------------------------------------------- */

/** The dispatch line's severity: WARNING whenever a person has to look. */
export function severidadeDoDespachoNfeAmazon(r: ResultadoNfeAmazon): SeveridadeAmazon {
  if (r.acao === 'payload-invalido' || r.acao === 'avisado' || r.posEnvio !== null) {
    return 'WARNING';
  }
  return r.motivo !== null && MOTIVOS_NFE_SO_LOG_EM_WARNING.has(r.motivo) ? 'WARNING' : 'INFO';
}

/**
 * The ONE `evento: 'nfe'` dispatch line (module header): ids, closed codes and
 * counts only. A post-submit loss names itself (`motivo: pos-envio-falhou`,
 * the outcome's own motivo in `desfecho`, the lost write and its class).
 */
export function registrarDespachoNfeAmazon(
  logger: LoggerAmazon,
  r: ResultadoNfeAmazon,
  registro: RegistroNfeAmazon,
): void {
  const perdeu = r.posEnvio !== null;
  const campos: CamposLogAmazon = {
    fila: FILA_NFE_AMAZON,
    acao: r.acao,
    motivo: perdeu ? MOTIVO_NFE_AMAZON.posEnvioFalhou : r.motivo,
    desfecho: perdeu ? r.motivo : null,
    escritaPerdida: r.posEnvio?.escrita ?? null,
    erro: r.posEnvio?.erro ?? null,
    fase: r.fase,
    degrau: r.degrau,
    pedidoId: r.pedidoId,
    nfeId: r.nfeId,
    pedido: r.pedido,
    statusAmazon: r.statusAmazon,
    envio: r.envio,
    codigos: r.codigos.length === 0 ? null : r.codigos.map(codigoDeErroSeguro).join(','),
    portao: r.portao,
    aviso: r.aviso,
    carimbo: r.carimbo,
    proximaFase: r.proxima?.fase ?? null,
    proximoDegrau: r.proxima?.degrau ?? null,
    atrasoS: r.proxima?.atrasoS ?? null,
  };
  registrarEventoAmazon(
    logger,
    'nfe',
    severidadeDoDespachoNfeAmazon(r),
    `[amazon] tarefa da fila de NF-e: ${perdeu ? MOTIVO_NFE_AMAZON.posEnvioFalhou : r.acao}`,
    campos,
    {
      conta: r.contaId,
      fluxo: FLUXO_AMAZON.nfe,
      tentativa: registro.tentativa,
      idTarefa: registro.idTarefa,
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                           one dispatch's own state                         */
/* -------------------------------------------------------------------------- */

/** The pedido a proved dispatch is about. */
interface Alvo {
  readonly integracaoId: string;
  readonly pedidoId: string;
  readonly numero: string;
}

/** A dispatch in flight: its payload, its clock, and the no-throw boundary's state. */
interface Execucao {
  readonly db: Firestore;
  readonly deps: DepsProcessarNfeAmazon;
  readonly t: TarefaNfeAmazon;
  readonly agoraMs: number;
  readonly agoraUs: number;
  /** Set at P3 once proved. */
  alvo: Alvo | null;
  /** P3's `readTime`: the clock of every aviso of the dispatch. */
  relogio: CommitDoDocumento | null;
  /**
   * The NO-THROW boundary (P10/P12): set once a submit was attempted or a chain
   * enqueue succeeded — every later write's failure of a named class is
   * contained in {@link Execucao.posEnvio}, never thrown.
   */
  protegido: boolean;
  posEnvio: { readonly escrita: EscritaNfeAmazon; readonly erro: string } | null;
}

/** A result for `e`, every field not given left null. */
function resultado(
  e: Execucao,
  r: Partial<Omit<ResultadoNfeAmazon, 'acao'>> & { readonly acao: AcaoNfeAmazon },
): ResultadoNfeAmazon {
  return {
    motivo: null,
    fase: e.t.fase,
    degrau: e.t.degrau,
    pedidoId: e.t.pedidoId,
    nfeId: e.t.nfeId,
    contaId: e.alvo?.integracaoId ?? null,
    pedido: e.alvo?.numero ?? null,
    statusAmazon: null,
    envio: null,
    codigos: [],
    portao: null,
    aviso: null,
    carimbo: null,
    proxima: null,
    posEnvio: e.posEnvio,
    ...r,
  };
}

/**
 * The failures the no-throw boundary contains (P10): a Firestore error, the
 * stamp's named conflict, and the queue's own failures — a transient, the
 * valve, a raw SDK failure the producer rethrew, a missing or malformed region
 * (the two deploy shapes a root raises per enqueue). Anything else is an
 * unnamed bug, and crosses.
 */
function ehFalhaContida(err: unknown): boolean {
  return (
    isGrpcStatusError(err) ||
    err instanceof AmazonNfeCarimboEmConflitoError ||
    err instanceof AmazonTarefasTransitoriasError ||
    err instanceof AmazonNfeTarefasDesligadasError ||
    err instanceof MissingRegionError ||
    err instanceof AmazonNfeRegiaoDaFilaInvalidaError ||
    ehFalhaDoSdkDeTarefasAmazon(err)
  );
}

/** A contained failure's CLASS (and gRPC/SDK code) — never its message. */
function classeDaFalha(err: unknown): string {
  if (isGrpcStatusError(err)) return `Firestore/${String(err.code)}`;
  if (ehFalhaDoSdkDeTarefasAmazon(err)) return descreverFalhaDoSdkDeTarefasAmazon(err);
  if (err instanceof AmazonNfeCarimboEmConflitoError) return err.name;
  if (err instanceof AmazonTarefasTransitoriasError) return err.name;
  if (err instanceof AmazonNfeTarefasDesligadasError) return err.name;
  if (err instanceof MissingRegionError) return err.name;
  if (err instanceof AmazonNfeRegiaoDaFilaInvalidaError) return err.name;
  return 'desconhecido';
}

/** Record a write lost INSIDE the boundary: the FIRST loss names the line, later ones are dropped. */
function registrarPerda(e: Execucao, escrita: EscritaNfeAmazon, err: unknown): void {
  e.posEnvio ??= { escrita, erro: classeDaFalha(err) };
}

/**
 * Run ONE write of an outcome. Outside the boundary it throws as it fails;
 * inside, a contained failure is recorded (the FIRST one) and answered `null`.
 */
async function executarEfeito<T>(
  e: Execucao,
  escrita: EscritaNfeAmazon,
  fn: () => Promise<T>,
): Promise<{ readonly ok: true; readonly valor: T } | { readonly ok: false }> {
  if (!e.protegido) return { ok: true, valor: await fn() };
  try {
    return { ok: true, valor: await fn() };
  } catch (err) {
    if (!ehFalhaContida(err)) throw err;
    registrarPerda(e, escrita, err);
    return { ok: false };
  }
}

function depsDoAviso(e: Execucao): AvisoDepsAmazon {
  return { increment: e.deps.increment, nowMs: e.agoraMs, logger: e.deps.logger };
}

function exigirAlvo(e: Execucao): { readonly alvo: Alvo; readonly relogio: CommitDoDocumento } {
  if (e.alvo === null || e.relogio === null) {
    throw new TypeError('processarNfe.ts: efeito antes da prova do pedido (P3)');
  }
  return { alvo: e.alvo, relogio: e.relogio };
}

/* -------------------------------------------------------------------------- */
/*                         the outcome's writes (P12)                         */
/* -------------------------------------------------------------------------- */

/**
 * What one chain enqueue came to. A LOST enqueue is one this dispatch ANSWERS
 * with an aviso instead of throwing, so the pedido lands on the aviso list
 * rather than vanishing with a dropped task (the edge is consumed once, and no
 * NF-e sweep exists):
 *
 * - the queue valve (`AmazonNfeTarefasDesligadasError`), on ANY attempt and
 *   on either side of the boundary — deterministic, so a retry would only
 *   repeat the Amazon reads (`desligada`);
 * - any contained failure INSIDE the no-throw boundary (recorded in
 *   `posEnvio`);
 * - any contained failure BEFORE the boundary on the queue's LAST attempt (a
 *   throw there drops the task with no aviso).
 *
 * Before the boundary, every other contained failure throws for the queue's
 * retry (nothing was sent by this dispatch, and the retry re-reads); an
 * unnamed one is a bug and throws always.
 */
type EnfileiramentoNfe =
  | { readonly tipo: 'enfileirada'; readonly proxima: ProximaTarefaNfeAmazon }
  | { readonly tipo: 'perdida'; readonly desligada: boolean };

/** One enqueue through the producer, with its delay ({@link EnfileiramentoNfe}). */
async function enfileirar(
  e: Execucao,
  tarefa: TarefaNfeAmazon,
  atrasoS: number,
): Promise<EnfileiramentoNfe> {
  try {
    await e.deps.agendador().enfileirar(tarefa, atrasoS);
  } catch (err) {
    if (!ehFalhaContida(err)) throw err;
    const desligada = err instanceof AmazonNfeTarefasDesligadasError;
    if (e.protegido) registrarPerda(e, 'enfileiramento', err);
    else if (!desligada && !ultimaTentativa(e)) throw err;
    return { tipo: 'perdida', desligada };
  }
  // A chain step is durable: from here on, nothing in this dispatch throws.
  e.protegido = true;
  return {
    tipo: 'enfileirada',
    proxima: {
      fase: tarefa.fase,
      degrau: tarefa.degrau,
      reenvios: tarefa.reenvios,
      pausas: tarefa.pausas,
      atrasoS,
    },
  };
}

/**
 * The aviso a LOST chain enqueue ends the dispatch on: `tarefas-desligadas`
 * for the queue valve (its worklist, and a re-drive cannot help until the
 * valve reopens), else `motivo` — where the chain ends when that step cannot
 * be taken (the pause bound's answer, the ladder's end, the resubmit's).
 */
function semFila(
  e: Execucao,
  perda: { readonly desligada: boolean },
  motivo: MotivoNfeQueAvisaAmazon,
  extra: Partial<ResultadoNfeAmazon> = {},
): Promise<ResultadoNfeAmazon> {
  return avisar(e, perda.desligada ? MOTIVO_NFE_AMAZON.tarefasDesligadas : motivo, extra);
}

/**
 * aviso → stamp (P12), for a motivo of set A; the stamp only for set S. The
 * aviso is clocked by P3's `readTime`.
 */
async function avisar(
  e: Execucao,
  motivo: MotivoNfeQueAvisaAmazon,
  extra: Partial<ResultadoNfeAmazon> = {},
): Promise<ResultadoNfeAmazon> {
  const { alvo, relogio } = exigirAlvo(e);
  const aviso = await executarEfeito(e, 'aviso', () =>
    avisarNfeAmazon(e.db, depsDoAviso(e), { ...alvo, motivo, relogio }),
  );
  let carimbo: MotivoCarimboNfeAmazon | null = null;
  if (MOTIVOS_NFE_QUE_CARIMBAM.has(motivo)) {
    const r = await executarEfeito(e, 'carimbo', () =>
      carimbarFreteNfeAmazon(e.db, alvo.pedidoId, e.agoraUs),
    );
    carimbo = r.ok ? r.valor : null;
  }
  return resultado(e, {
    acao: 'avisado',
    motivo,
    aviso: aviso.ok ? aviso.valor : null,
    carimbo,
    ...extra,
  });
}

/** A log-only end. */
function descartar(
  e: Execucao,
  motivo: MotivoNfeAmazon,
  extra: Partial<ResultadoNfeAmazon> = {},
): ResultadoNfeAmazon {
  return resultado(e, { acao: 'descartado', motivo, ...extra });
}

/** A cancelled SALE (P3 stored, P8 live): the incidente, then the resolve `pedido-cancelado`. */
async function vendaCancelada(
  e: Execucao,
  extra: Partial<ResultadoNfeAmazon> = {},
): Promise<ResultadoNfeAmazon> {
  const { alvo, relogio } = exigirAlvo(e);
  await executarEfeito(e, 'incidente', () =>
    registrarIncidenteNfePedidoCanceladoAmazon(e.db, {
      pedidoId: alvo.pedidoId,
      orderId: alvo.numero,
      nowUs: e.agoraUs,
    }),
  );
  await executarEfeito(e, 'resolucao', () =>
    resolverNfeAmazon(
      e.db,
      { nowMs: e.agoraMs },
      { ...alvo, motivo: MOTIVO_AVISO_AMAZON.pedidoCancelado, relogio },
    ),
  );
  return descartar(e, MOTIVO_NFE_AMAZON.pedidoCancelado, extra);
}

/** The open cancellation request's NF-e row (`cancelamento-solicitado`), clocked by P3's read. */
async function avisoDoCancelamento(e: Execucao): Promise<ResultadoAviso | null> {
  const { alvo, relogio } = exigirAlvo(e);
  const aviso = await executarEfeito(e, 'aviso', () =>
    avisarNfeAmazon(e.db, depsDoAviso(e), {
      ...alvo,
      motivo: MOTIVO_NFE_AMAZON.cancelamentoSolicitado,
      relogio,
    }),
  );
  return aviso.ok ? aviso.valor : null;
}

/** The open cancellation request's per-pedido row: `amazonPedidoPrecisaAtencao` `aceitar-cancelamento`. */
async function atencaoDoCancelamento(e: Execucao): Promise<void> {
  const { alvo, relogio } = exigirAlvo(e);
  await executarEfeito(e, 'atencao', () =>
    sincronizarAvisosDoPedidoAmazon(e.db, depsDoAviso(e), {
      integracaoId: alvo.integracaoId,
      orderId: alvo.numero,
      pedidoId: alvo.pedidoId,
      levantar: [MOTIVO_PEDIDO_AMAZON.aceitarCancelamento],
      resolver: [],
      relogio,
    }),
  );
}

/** Fase envio's open cancellation request: both rows, and the dispatch stops before any submit. */
async function cancelamentoSolicitado(e: Execucao): Promise<ResultadoAviso | null> {
  const aviso = await avisoDoCancelamento(e);
  await atencaoDoCancelamento(e);
  return aviso;
}

/**
 * Fase verificacao's open cancellation request, its NF-e row (P8 raised the
 * per-pedido row and the read went on): raised only when the verification's
 * outcome wrote NOTHING to that row — a chain step was enqueued (`enfileirado`,
 * `pausado`). Every raise of one dispatch carries P3's clock and the shared
 * seam DROPS an equal clock, so a second write of the row in the same dispatch
 * is silently lost: raised first, the request would hide the outcome (an
 * `nfe-recusada` whose stamp still lands, an `aceite-nao-confirmado`, the
 * `nfe-validada` resolve). One dispatch writes the row at most once — after
 * the re-enqueue, the one departure from P12's "aviso first" order.
 */
async function avisoDoCancelamentoAberto(
  e: Execucao,
  r: ResultadoNfeAmazon,
): Promise<ResultadoNfeAmazon> {
  if (r.acao !== 'enfileirado' && r.acao !== 'pausado') return r;
  const aviso = await avisoDoCancelamento(e);
  return { ...r, aviso, posEnvio: e.posEnvio };
}

/** The `aceita` path (P12): the clear → resolve `nfe-validada` → the step-15 seam. */
async function aceita(
  e: Execucao,
  leitura: LeituraStatusNfe,
  extra: Partial<ResultadoNfeAmazon> = {},
): Promise<ResultadoNfeAmazon> {
  const { alvo, relogio } = exigirAlvo(e);
  const limpeza = await executarEfeito(e, 'limpeza', () =>
    limparCarimboNfeAmazon(e.db, alvo.pedidoId, e.agoraUs),
  );
  await executarEfeito(e, 'resolucao', () =>
    resolverNfeAmazon(
      e.db,
      { nowMs: e.agoraMs },
      { ...alvo, motivo: MOTIVO_AVISO_AMAZON.nfeValidada, relogio },
    ),
  );
  const agendar = DESTINO_ACEITE_NFE_AMAZON.agendar;
  if (agendar !== null) {
    await executarEfeito(e, 'destino', () =>
      agendar({
        contaId: alvo.integracaoId,
        pedidoId: alvo.pedidoId,
        nfeId: e.t.nfeId,
        orderId: alvo.numero,
      }),
    );
  }
  return resultado(e, {
    acao: 'aceita',
    motivo: e.t.fase === FASE_NFE_AMAZON.envio ? MOTIVO_NFE_AMAZON.jaAceita : null,
    statusAmazon: leitura.tipo,
    carimbo: limpeza.ok ? limpeza.valor : null,
    ...extra,
  });
}

/** The verification after an envio dispatch: rung 0, after the ladder's first delay. */
async function verificar(
  e: Execucao,
  leituraAntes: LeituraAntesNfeAmazon | null,
  envioIncerto: boolean,
): Promise<EnfileiramentoNfe> {
  const tarefa = aposEnvioNfeAmazon(e.t, leituraAntes, envioIncerto);
  return enfileirar(e, tarefa, ESCADA_VERIFICACAO_NFE_AMAZON_S[tarefa.degrau] ?? 0);
}

/**
 * The next rung of a verification, or — at the ladder's end, or when the rung
 * is lost ({@link semFila}) — the aviso `aceite-nao-confirmado`.
 */
async function proximoDegrauOuFim(
  e: Execucao,
  extra: Partial<ResultadoNfeAmazon> = {},
): Promise<ResultadoNfeAmazon> {
  const proxima = proximoDegrauNfeAmazon(e.t);
  if (proxima === null) return avisar(e, MOTIVO_NFE_AMAZON.aceiteNaoConfirmado, extra);
  const fila = await enfileirar(e, proxima, ESCADA_VERIFICACAO_NFE_AMAZON_S[proxima.degrau] ?? 0);
  if (fila.tipo === 'perdida') {
    return semFila(e, fila, MOTIVO_NFE_AMAZON.aceiteNaoConfirmado, extra);
  }
  return resultado(e, { acao: 'enfileirado', proxima: fila.proxima, ...extra });
}

/**
 * P11's 429: the pause re-enqueue, or at the bound the fase's last-chance
 * answer. A LOST pause ends where the chain cannot go on: fase `envio` (the
 * submit's 429 included — a 429 is not processed, so the NF-e is NOT at
 * Amazon) ⇒ `amazon-indisponivel`; fase `verificacao` ⇒ the ladder's end.
 */
async function pausar(
  e: Execucao,
  extra: Partial<ResultadoNfeAmazon> = {},
): Promise<ResultadoNfeAmazon> {
  const proxima = pausaNfeAmazon(e.t);
  if (proxima !== null) {
    const fila = await enfileirar(e, proxima, PAUSAS_NFE_AMAZON_S[e.t.pausas] ?? 0);
    if (fila.tipo === 'perdida') {
      return semFila(
        e,
        fila,
        e.t.fase === FASE_NFE_AMAZON.envio
          ? MOTIVO_NFE_AMAZON.amazonIndisponivel
          : MOTIVO_NFE_AMAZON.aceiteNaoConfirmado,
        extra,
      );
    }
    return resultado(e, {
      acao: 'pausado',
      motivo: MOTIVO_NFE_AMAZON.taxaLimitada,
      proxima: fila.proxima,
      ...extra,
    });
  }
  return e.t.fase === FASE_NFE_AMAZON.envio
    ? avisar(e, MOTIVO_NFE_AMAZON.amazonIndisponivel, extra)
    : proximoDegrauOuFim(e, extra);
}

/* -------------------------------------------------------------------------- */
/*                     a failure BEFORE the submit (P7, P8, P11)              */
/* -------------------------------------------------------------------------- */

/** How a failure before the submit is answered. */
type FalhaAntesDoEnvio =
  | { readonly tipo: 'pausa' }
  | { readonly tipo: 'transitorio' }
  | { readonly tipo: 'avisar'; readonly motivo: MotivoNfeQueAvisaAmazon }
  | { readonly tipo: 'descartar'; readonly motivo: MotivoNfeAmazon }
  | { readonly tipo: 'relancar' };

/**
 * A failure of the context, of `getOrder` or of the status read — before any
 * submit, so a throw is safe (the retry re-reads status first). The CLASS is
 * read by the shared read-side ladder (`classificarFalhaDeLeituraAmazon`,
 * `pedidos/falhaLeituraAmazon.ts`: most-derived classes first, rule 6, the
 * ladder this module ran inline until step 15 extracted it), and this table
 * answers each of its tokens the NF-e way. TOTAL over the tokens: a new one
 * fails this module's typecheck until the NF-e task answers it. The status
 * read's own 4xx and schema refusals never reach here: `entregaAmazon.ts`
 * reads them as a reading.
 */
const FALHA_ANTES_DO_ENVIO: Readonly<Record<FalhaLeituraAmazon, FalhaAntesDoEnvio>> = {
  [FALHA_LEITURA_AMAZON.pausa]: { tipo: 'pausa' },
  [FALHA_LEITURA_AMAZON.transitorio]: { tipo: 'transitorio' },
  // A second SP-API 401/403 after the forced refresh is a grant this app does
  // not hold; an LWA refusal is the conta's authorization.
  [FALHA_LEITURA_AMAZON.authLwa]: { tipo: 'avisar', motivo: MOTIVO_NFE_AMAZON.contaIndisponivel },
  [FALHA_LEITURA_AMAZON.authSpApi]: { tipo: 'avisar', motivo: MOTIVO_NFE_AMAZON.semPermissao },
  [FALHA_LEITURA_AMAZON.naoEncontrado]: {
    tipo: 'avisar',
    motivo: MOTIVO_NFE_AMAZON.pedidoNaoEncontradoNaAmazon,
  },
  [FALHA_LEITURA_AMAZON.httpDefinitivo]: {
    tipo: 'avisar',
    motivo: MOTIVO_NFE_AMAZON.statusPedidoDesconhecido,
  },
  [FALHA_LEITURA_AMAZON.esquema]: {
    tipo: 'avisar',
    motivo: MOTIVO_NFE_AMAZON.statusPedidoDesconhecido,
  },
  [FALHA_LEITURA_AMAZON.ilegivel]: {
    tipo: 'avisar',
    motivo: MOTIVO_NFE_AMAZON.statusNfeDesconhecido,
  },
  [FALHA_LEITURA_AMAZON.chamadasDesligadas]: {
    tipo: 'avisar',
    motivo: MOTIVO_NFE_AMAZON.chamadasDesligadas,
  },
  [FALHA_LEITURA_AMAZON.contaInativa]: {
    tipo: 'descartar',
    motivo: MOTIVO_NFE_AMAZON.contaInativa,
  },
  [FALHA_LEITURA_AMAZON.contaIndisponivel]: {
    tipo: 'avisar',
    motivo: MOTIVO_NFE_AMAZON.contaIndisponivel,
  },
  // AmazonConfigError (nothing was sent: a bug), a Firestore error, a deploy
  // shape (the LWA pair missing), a bug: the queue's retry.
  [FALHA_LEITURA_AMAZON.relancar]: { tipo: 'relancar' },
};

/** A failure before the submit, answered through {@link FALHA_ANTES_DO_ENVIO}. */
function classificarFalhaAntesDoEnvio(err: unknown): FalhaAntesDoEnvio {
  return FALHA_ANTES_DO_ENVIO[classificarFalhaDeLeituraAmazon(err)];
}

/** Whether this dispatch is the queue's last attempt. */
function ultimaTentativa(e: Execucao): boolean {
  return e.deps.registro.tentativa + 1 >= TENTATIVAS_NFE_AMAZON;
}

/**
 * Answer a failure before the submit (module header, P11), or `null` when the
 * queue must retry it: a transient before the last attempt, a Firestore error,
 * a refused input, a bug. The caller rethrows `null` SANITIZED.
 */
async function falhaAntesDoEnvio(
  e: Execucao,
  err: unknown,
  extra: Partial<ResultadoNfeAmazon> = {},
): Promise<ResultadoNfeAmazon | null> {
  const c = classificarFalhaAntesDoEnvio(err);
  switch (c.tipo) {
    case 'pausa':
      return pausar(e, extra);
    case 'avisar':
      return avisar(e, c.motivo, extra);
    case 'descartar':
      return descartar(e, c.motivo, extra);
    case 'transitorio':
      if (!ultimaTentativa(e)) return null;
      return e.t.fase === FASE_NFE_AMAZON.envio
        ? avisar(e, MOTIVO_NFE_AMAZON.amazonIndisponivel, extra)
        : proximoDegrauOuFim(e, extra);
    case 'relancar':
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                         the submit's outcome (P10)                         */
/* -------------------------------------------------------------------------- */

/** What the submit's outcome means. */
type DesfechoDoEnvio =
  | { readonly tipo: 'verificar'; readonly incerto: boolean; readonly envio: EnvioNfeAmazon }
  | {
      readonly tipo: 'avisar';
      readonly motivo: MotivoNfeQueAvisaAmazon;
      readonly envio: EnvioNfeAmazon;
      readonly codigos: readonly string[];
    }
  | { readonly tipo: 'pausa' };

/**
 * The submit's outcome, narrowed by CLASS (rule 6), most-derived first. `null`
 * for an `AmazonConfigError` (nothing was sent — a bug, rethrown) and for
 * anything unnamed (a bug crosses the boundary).
 */
function desfechoDoEnvio(
  r:
    | { readonly ok: true; readonly resposta: ResultadoEnvioNotaFiscal }
    | { readonly ok: false; readonly err: unknown },
): DesfechoDoEnvio | null {
  if (r.ok) {
    return r.resposta.tipo === 'aceito-para-processamento'
      ? { tipo: 'verificar', incerto: false, envio: 'aceito' }
      : {
          tipo: 'avisar',
          motivo: MOTIVO_NFE_AMAZON.envioRecusado,
          envio: 'erros',
          codigos: r.resposta.codigos,
        };
  }
  const err = r.err;
  // A 429 was not processed: the pause, never a spent attempt.
  if (err instanceof AmazonThrottleError) return { tipo: 'pausa' };
  if (err instanceof AmazonAuthError) {
    return {
      tipo: 'avisar',
      motivo:
        err.destino === 'lwa'
          ? MOTIVO_NFE_AMAZON.contaIndisponivel
          : MOTIVO_NFE_AMAZON.semPermissao,
      envio: 'nao-processado',
      codigos: err.codigosErro,
    };
  }
  // An answer about the ORDER entity, never this NF-e: no stamp.
  if (err instanceof AmazonNotFoundError) {
    return {
      tipo: 'avisar',
      motivo: MOTIVO_NFE_AMAZON.pedidoNaoEncontradoNaAmazon,
      envio: 'recusado',
      codigos: err.codigosErro,
    };
  }
  if (err instanceof AmazonHttpError) {
    // A 5xx MAY HAVE LANDED: read it back, never resubmit here.
    if (err.transitorio) return { tipo: 'verificar', incerto: true, envio: 'incerto' };
    // A 3xx: the redirect is never followed (the endpoint moved), so the POST
    // was not processed — an answer about the transport, never a deterministic
    // one about THIS NF-e: no stamp. The status read reads a 3xx the same way
    // (`indeterminado` ⇒ `status-nfe-desconhecido`).
    if (err.status < 400) {
      return {
        tipo: 'avisar',
        motivo: MOTIVO_NFE_AMAZON.statusNfeDesconhecido,
        envio: 'nao-processado',
        codigos: err.codigosErro,
      };
    }
    if (err.status === 413) {
      return {
        tipo: 'avisar',
        motivo: MOTIVO_NFE_AMAZON.nfeGrandeDemais,
        envio: 'recusado',
        codigos: err.codigosErro,
      };
    }
    if (err.status === 400 && err.codigosErro.includes('EntityNotFound')) {
      return {
        tipo: 'avisar',
        motivo: MOTIVO_NFE_AMAZON.pedidoNaoEncontradoNaAmazon,
        envio: 'recusado',
        codigos: err.codigosErro,
      };
    }
    return {
      tipo: 'avisar',
      motivo: MOTIVO_NFE_AMAZON.envioRecusado,
      envio: 'recusado',
      codigos: err.codigosErro,
    };
  }
  if (err instanceof AmazonSchemaError)
    return { tipo: 'verificar', incerto: true, envio: 'incerto' };
  if (err instanceof AmazonNetworkError) {
    return { tipo: 'verificar', incerto: true, envio: 'incerto' };
  }
  // The credential vanished or was parked before the request (or during the
  // forced refresh after a 401): nothing landed.
  if (
    err instanceof ContaAmazonParadaError ||
    err instanceof CredencialAmazonAusenteError ||
    err instanceof CredencialAmazonInvalidaError
  ) {
    return {
      tipo: 'avisar',
      motivo: MOTIVO_NFE_AMAZON.contaIndisponivel,
      envio: 'nao-processado',
      codigos: [],
    };
  }
  return null;
}

/** P10 → P12 for one submit attempt (module header). Never throws a named failure. */
async function depoisDoEnvio(
  e: Execucao,
  r:
    | { readonly ok: true; readonly resposta: ResultadoEnvioNotaFiscal }
    | { readonly ok: false; readonly err: unknown },
  leituraAntes: LeituraAntesNfeAmazon,
  statusAmazon: TipoLeituraStatusNfe,
): Promise<ResultadoNfeAmazon> {
  const desfecho = desfechoDoEnvio(r);
  if (desfecho === null) {
    // An AmazonConfigError means nothing was sent (a bug: the retry re-reads
    // status first); anything unnamed is a bug. Both cross, sanitized.
    throw sanitizarFalhaDaTarefaAmazon(r.ok ? new TypeError('desfecho impossível') : r.err);
  }
  switch (desfecho.tipo) {
    case 'pausa':
      return pausar(e, { statusAmazon, envio: 'nao-processado' });
    case 'avisar':
      return avisar(e, desfecho.motivo, {
        statusAmazon,
        envio: desfecho.envio,
        codigos: desfecho.codigos,
      });
    case 'verificar': {
      // `reenvios` COPIED, `leituraAntes` = the reading the submit was planned on.
      const fila = await verificar(e, leituraAntes, desfecho.incerto);
      if (fila.tipo === 'perdida') {
        // The verification enqueue was lost after OUR submit — the queue valve
        // included: the note WAS sent, so the aviso says what to confirm in
        // Seller Central (P10's row), and the lost class stays in the line.
        return avisar(
          e,
          desfecho.incerto
            ? MOTIVO_NFE_AMAZON.envioNaoConfirmado
            : MOTIVO_NFE_AMAZON.aceiteNaoConfirmado,
          { statusAmazon, envio: desfecho.envio },
        );
      }
      return resultado(e, {
        acao: 'enfileirado',
        statusAmazon,
        envio: desfecho.envio,
        proxima: fila.proxima,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                          the decisions without a submit                    */
/* -------------------------------------------------------------------------- */

/**
 * An envio decision that does not submit: a dry-run (or `on` outside the
 * canary) of one that WOULD — the engine wrote the diff line — or a plan that
 * writes nothing. Only the submit is gated by the valve: the read-back of a
 * `processando`, the `aceita` path and the avisos write nothing to Amazon.
 */
async function aplicarEnvioSemEscrita(
  e: Execucao,
  decisao: DecisaoEnvioNfeAmazon,
  leitura: LeituraStatusNfe,
): Promise<ResultadoNfeAmazon> {
  const statusAmazon = leitura.tipo;
  switch (decisao.acao) {
    case 'enviar':
      return avisar(e, MOTIVO_NFE_AMAZON.envioNaoLigado, { statusAmazon });
    case 'verificar': {
      // Our own earlier submit, or one made outside the ERP: read it back, no
      // submit in this chain (`leituraAntes: null`).
      const fila = await verificar(e, null, false);
      if (fila.tipo === 'perdida') {
        return semFila(e, fila, MOTIVO_NFE_AMAZON.aceiteNaoConfirmado, { statusAmazon });
      }
      return resultado(e, { acao: 'enfileirado', statusAmazon, proxima: fila.proxima });
    }
    case 'aceita':
      return aceita(e, leitura, { statusAmazon });
    case 'avisar':
      return avisar(e, decisao.motivo, { statusAmazon });
  }
}

/** A verification decision (it never submits; the resubmit is an enqueue). */
async function aplicarVerificacao(
  e: Execucao,
  decisao: DecisaoVerificacaoNfeAmazon,
  leitura: LeituraStatusNfe,
  extra: Partial<ResultadoNfeAmazon>,
): Promise<ResultadoNfeAmazon> {
  const statusAmazon = leitura.tipo;
  switch (decisao.acao) {
    case 'proximo-degrau':
      return proximoDegrauOuFim(e, { statusAmazon, ...extra });
    case 'reenviar': {
      const reenvio = reenvioNfeAmazon(e.t);
      // The table answers `reenviar` only while the chain has its resubmit left.
      if (reenvio === null) {
        return avisar(e, MOTIVO_NFE_AMAZON.envioNaoConfirmado, { statusAmazon, ...extra });
      }
      const fila = await enfileirar(e, reenvio, 0);
      if (fila.tipo === 'perdida') {
        return semFila(e, fila, MOTIVO_NFE_AMAZON.envioNaoConfirmado, { statusAmazon, ...extra });
      }
      return resultado(e, { acao: 'enfileirado', statusAmazon, proxima: fila.proxima, ...extra });
    }
    case 'aceita':
      return aceita(e, leitura, { statusAmazon, ...extra });
    case 'avisar':
      return avisar(e, decisao.motivo, { statusAmazon, ...extra });
  }
}

/** P9 in fase `verificacao`: the status read, then the verification table — no valve, no engine. */
async function verificacaoNaAmazon(
  e: Execucao,
  contexto: ContextoAmazon,
  irmaos: IrmaosDaNfeAmazon,
  portao: MotivoPortaoPedidoNfeAmazon | null,
): Promise<ResultadoNfeAmazon> {
  const { alvo } = exigirAlvo(e);
  let leitura: LeituraStatusNfe;
  try {
    leitura = await lerStatusNfeNaAmazon(contexto, alvo.numero);
  } catch (err) {
    const r = await falhaAntesDoEnvio(e, err, { portao });
    if (r === null) throw sanitizarFalhaDaTarefaAmazon(err);
    return r;
  }
  return aplicarVerificacao(e, decidirVerificacaoNfeAmazon(leitura, e.t, irmaos), leitura, {
    portao,
  });
}

/* -------------------------------------------------------------------------- */
/*                                the dispatch                                */
/* -------------------------------------------------------------------------- */

/**
 * ONE dispatch, P0–P12 (module header). Returns the result the queue logs;
 * throws only what the queue must retry (a transient before the submit, a
 * Firestore error before the submit, a bug), sanitized.
 */
export async function processarNfeAmazon(
  db: Firestore,
  dados: unknown,
  deps: DepsProcessarNfeAmazon,
): Promise<ResultadoNfeAmazon> {
  // ---- P0: the payload. ----
  const lido = tarefaNfeAmazonSchema.safeParse(dados);
  if (!lido.success) {
    return {
      acao: 'payload-invalido',
      motivo: null,
      fase: null,
      degrau: null,
      pedidoId: null,
      nfeId: null,
      contaId: null,
      pedido: null,
      statusAmazon: null,
      envio: null,
      codigos: [],
      portao: null,
      aviso: null,
      carimbo: null,
      proxima: null,
      posEnvio: null,
    };
  }
  const t = lido.data;
  const agoraMs = deps.agora();
  const e: Execucao = {
    db,
    deps,
    t,
    agoraMs,
    agoraUs: agoraUsDe({ nowMs: agoraMs }),
    alvo: null,
    relogio: null,
    protegido: false,
    posEnvio: null,
  };

  // ---- P1: the valve, read ONCE, logged — before any read. ----
  const valvula = lerValvula(FLUXO_AMAZON.nfe, deps.ambiente);
  registrarValvulaAmazon(deps.logger, valvula, {
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  });

  // ---- P2: the NF-e document, through the LEVEL predicate. ----
  const nfeSnap = await nfev4Collection.docRef(db, { pedidoId: t.pedidoId }, t.nfeId).get();
  const nfe = nfeSnap.exists ? ((nfeSnap.data() ?? {}) as Record<string, unknown>) : undefined;
  const pronta = decideNfeUploadDispatch(undefined, nfe);
  const canceladaNaVerificacao =
    pronta.action === 'skip' &&
    t.fase === FASE_NFE_AMAZON.verificacao &&
    nfe?.estado === ESTADO_NFE.cancelada;
  if (pronta.action === 'skip' && !canceladaNaVerificacao) {
    return descartar(e, MOTIVO_NFE_AMAZON.nfeNaoPronta);
  }

  // ---- P3: the pedido — the proof, the emission block, a stored cancelled sale. ----
  const pedidoSnap = await pedidoCollection.docRef(db, {}, t.pedidoId).get();
  const raw = pedidoSnap.exists ? ((pedidoSnap.data() ?? {}) as Record<string, unknown>) : null;
  const avaliacao = avaliarPedidoParaTarefaNfeAmazon(t.pedidoId, raw);
  if (!avaliacao.ok) return descartar(e, avaliacao.motivo);
  e.alvo = { integracaoId: avaliacao.contaId, pedidoId: t.pedidoId, numero: avaliacao.orderId };
  e.relogio = pedidoSnap.readTime;
  const vendaJaCancelada = vendaCanceladaAmazon(raw);

  if (canceladaNaVerificacao) {
    // A submit happened (ours or another's) and the note is now cancelled at
    // SEFAZ: the operator acts; a cancelled SALE is the incidente's (the
    // trigger's T3c rule), never this aviso's.
    if (vendaJaCancelada) return descartar(e, MOTIVO_NFE_AMAZON.pedidoCancelado);
    return avisar(e, MOTIVO_NFE_AMAZON.nfeCancelada);
  }
  if (vendaJaCancelada) return vendaCancelada(e);
  const pisoUs = pisoDoPedidoAmazon(raw);

  // ---- P4: the sale gate (P2 proved a string proc). ----
  const xml = typeof nfe?.xml_nfe_proc === 'string' ? nfe.xml_nfe_proc : '';
  const finalidade = finalidadeDaNfeProc(xml);
  if (finalidade === 'outra') return descartar(e, MOTIVO_NFE_AMAZON.nfeNaoEDeVenda);
  if (finalidade === 'ilegivel') return avisar(e, MOTIVO_NFE_AMAZON.xmlInvalido);

  // ---- P5: the siblings — ONE unfiltered listing, before any Amazon call. ----
  const lista = await nfev4Collection.ref(db, { pedidoId: t.pedidoId }).get();
  const irmaos: IrmaosDaNfeAmazon = irmaosDaNfeAmazon(
    t.nfeId,
    lista.docs.map((d) => ({ id: d.id, raw: (d.data() ?? {}) as Record<string, unknown> })),
  );
  if (irmaos.outraElegivel) return avisar(e, MOTIVO_NFE_AMAZON.nfeAmbigua);

  const { alvo } = exigirAlvo(e);

  // ---- P6: fase envio ONLY — the target under the valve. ----
  if (
    t.fase === FASE_NFE_AMAZON.envio &&
    decidirAlvo(valvula, alvo.integracaoId, alvo.numero).modo === MODO_AMAZON.off
  ) {
    return avisar(e, MOTIVO_NFE_AMAZON.envioNaoLigado);
  }

  // ---- P7: the context — the read switch first. ----
  const depsDoContexto: ContextoAmazonDeps = {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    registro: {
      fluxo: FLUXO_AMAZON.nfe,
      tentativa: deps.registro.tentativa,
      idTarefa: deps.registro.idTarefa,
    },
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  let contexto: ContextoAmazon;
  try {
    contexto = await loadAmazonContext(db, alvo.integracaoId, depsDoContexto);
  } catch (err) {
    const r = await falhaAntesDoEnvio(e, err);
    if (r === null) throw sanitizarFalhaDaTarefaAmazon(err);
    return r;
  }

  // ---- P8: the LIVE order, on every dispatch, floored by the stored watermark. ----
  let portao: MotivoPortaoPedidoNfeAmazon | null = null;
  let cancelamentoAberto = false;
  try {
    const leitura = await lerPedidoAmazon(
      contexto,
      { amazonOrderId: alvo.numero, pisoUs },
      { tentativa: deps.registro.tentativa },
    );
    if (leitura.tipo === 'marketplace-estrangeiro') {
      return descartar(e, MOTIVO_NFE_AMAZON.marketplaceEstrangeiro);
    }
    const gate = gatesDoPedidoAmazonParaNfe(leitura.order);
    if (!gate.segue) {
      if (gate.motivo === MOTIVO_NFE_AMAZON.pedidoCancelado) return vendaCancelada(e);
      if (t.fase === FASE_NFE_AMAZON.envio) {
        switch (gate.motivo) {
          case MOTIVO_NFE_AMAZON.cancelamentoSolicitado: {
            const aviso = await cancelamentoSolicitado(e);
            return resultado(e, { acao: 'avisado', motivo: gate.motivo, aviso });
          }
          case MOTIVO_NFE_AMAZON.pedidoPendente:
          case MOTIVO_NFE_AMAZON.statusPedidoDesconhecido:
            return avisar(e, gate.motivo);
          case MOTIVO_NFE_AMAZON.naoDba:
          case MOTIVO_NFE_AMAZON.nfNaoRequerida:
            return descartar(e, gate.motivo);
        }
      }
      // Fase verificacao: every gate is logged (`portao`) and the read goes
      // on. The open request raises its per-pedido row NOW; its NF-e row waits
      // for the verification's outcome (`avisoDoCancelamentoAberto`).
      if (gate.motivo === MOTIVO_NFE_AMAZON.cancelamentoSolicitado) {
        await atencaoDoCancelamento(e);
        cancelamentoAberto = true;
      }
      portao = gate.motivo;
    }
  } catch (err) {
    const r = await falhaAntesDoEnvio(e, err);
    if (r === null) throw sanitizarFalhaDaTarefaAmazon(err);
    return r;
  }

  // ---- P9 (verificacao): the status read, then the verification table. ----
  if (t.fase === FASE_NFE_AMAZON.verificacao) {
    const r = await verificacaoNaAmazon(e, contexto, irmaos, portao);
    return cancelamentoAberto ? avisoDoCancelamentoAberto(e, r) : r;
  }

  // ---- P9 (envio): the write engine — status FIRST, then at most ONE submit. ----
  // The plan the engine runs, kept: a submit that THROWS still needs the
  // reading it was planned on (the verification's `leituraAntes`).
  let plano: PlanoEnvioNfeAmazon | null = null;
  let execucao: ResultadoEscritaAmazon<
    LeituraStatusNfe,
    PlanoEnvioNfeAmazon,
    ResultadoEnvioNotaFiscal
  >;
  try {
    execucao = await executarEscritaAmazon({
      valvula,
      contaId: alvo.integracaoId,
      alvo: alvo.numero,
      contexto,
      deps: depsDoContexto,
      registro: depsDoContexto.registro,
      lerAtual: () => lerStatusNfeNaAmazon(contexto, alvo.numero),
      planejar: (leitura) => {
        plano = planoDeEnvioNfeAmazon(leitura, irmaos);
        return plano;
      },
      escrever: (escritor) => {
        // From here on, the outcome may have landed: P10's boundary.
        e.protegido = true;
        return enviarNfeNaAmazon(escritor, alvo.numero, conteudoDaNfeAmazon(xml));
      },
    });
  } catch (err) {
    if (!e.protegido) {
      const r = await falhaAntesDoEnvio(e, err);
      if (r === null) throw sanitizarFalhaDaTarefaAmazon(err);
      return r;
    }
    // ---- P10: the submit threw. ----
    const planejado = planoQueEnvia(plano);
    return depoisDoEnvio(e, { ok: false, err }, planejado.leituraAntes, planejado.statusAmazon);
  }

  switch (execucao.tipo) {
    case 'desligado':
      // P6 already answered `off`; kept total.
      return avisar(e, MOTIVO_NFE_AMAZON.envioNaoLigado);
    case 'simulado':
    case 'sem-escrita':
      return aplicarEnvioSemEscrita(e, execucao.plano.decisao, execucao.plano.leitura);
    case 'escrito': {
      const planejado = planoQueEnvia(execucao.plano);
      return depoisDoEnvio(
        e,
        { ok: true, resposta: execucao.resposta },
        planejado.leituraAntes,
        planejado.statusAmazon,
      );
    }
  }
}

/**
 * The reading a submit was planned on. Only an `enviar` plan writes, so a
 * submit with any other plan (or none) is a bug of the engine's contract.
 */
function planoQueEnvia(plano: PlanoEnvioNfeAmazon | null): {
  readonly leituraAntes: LeituraAntesNfeAmazon;
  readonly statusAmazon: TipoLeituraStatusNfe;
} {
  if (plano === null || plano.decisao.acao !== 'enviar') {
    throw new TypeError('processarNfe.ts: um envio sem uma decisão de enviar');
  }
  return { leituraAntes: plano.decisao.leituraAntes, statusAmazon: plano.leitura.tipo };
}
