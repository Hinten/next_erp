/**
 * The body of the stock queue `processAmazonStockPatch` (step 12, PR 12-e1):
 * ONE stock task for ONE SKU of one conta, P0–P10, in this exact order. The
 * function file (`functions/src/filaEstoque.ts`) binds the deps
 * ({@link DepsProcessarEstoqueAmazon}) and rethrows a throw through the app's
 * sanitizing boundary; the ONE `evento: 'estoque'` dispatch line is written
 * HERE ({@link registrarDespachoEstoqueAmazon}), on every end this body
 * decides — a deliberate throw for the queue's retry included — so the root
 * writes none.
 *
 * ## The ladder
 *
 * - **P0** — `tarefaEstoqueAmazonSchema` (`.strict()`): an invalid payload is
 *   dropped with a WARNING, nothing read. The payload carries identities only:
 *   the quantity is never baked in at enqueue time.
 * - **P1** — the stock valve, read ONCE (`lerValvula`) and logged (the run-start
 *   line, `registrarValvulaAmazon`), then the target (`decidirAlvo`, the SKU).
 *   `off` ⇒ the dispatch ends `desligado` with ZERO Firestore reads and zero
 *   Amazon calls — every environment's state until the window.
 * - **P2** — the context (the read switch FIRST). Then the conta's depósito,
 *   read off the context's conta (`depositoOuterRef`, either stored form): none,
 *   or one that names no depósito ⇒ `conta-sem-deposito`, end. ⚠️ NO aviso is
 *   read or written here: the tick owns `estoque-sem-deposito`, raised on its
 *   flag's TRANSITION, so a batch of tasks never writes one aviso per task. A
 *   `reconciliacao` task whose payload `depositoId` is not the conta's depósito
 *   ⇒ `deposito-mudou`, end: its drift was computed at another depósito.
 * - **P3** — the link: every document the verdict reads, masked
 *   (`resolverEstoque.ts`), then `avaliarVinculoEstoqueAmazon`. A refusal ⇒
 *   one line naming it, end — zero Amazon calls, and no aviso per SKU (the
 *   reconcile counts the refusals a person must fix).
 * - **P4** — the ERP quantity, NOW: the unit's family at the depósito
 *   (`familiaEstoqueFirestore.ts`), then `quantidadeEstoqueAmazon`, the shared
 *   core's rule. A unit whose produto is gone ⇒ `unidade-ausente`, end (never a
 *   0 derived from a missing document).
 * - **P5** — `skuTemCaminhoAmazon`: a SKU no listings path can carry ⇒
 *   `sem-caminho`, end (only a feed carries it).
 * - **P6** — the write engine's single-target entry (`executarEscritaAmazon`):
 *   the stock valve, `alvo` = the SKU; the current state is Amazon's live
 *   listing (`listings/listingsAmazon.ts`, summaries + availability +
 *   relationships; its own 404 ⇒ `nao-listado`); the plan is the listing gate
 *   (`avaliarListingEstoqueAmazon`) then `planejarEstoqueAmazon`, with the
 *   link's latest outcome (the recent-send rule), `forcar` for a `catch-up`
 *   only, and `feedRecenteEmMs` = the stock lease's `ultimoFeedConcluidoEmMs`
 *   (ONE by-id read of `feedsAmazonEmCurso/estoque-<conta>`, masked to that
 *   field); the write is ONE availability PATCH of the ERP quantity. ⚠️ Right
 *   before the PATCH, the task's own budget: more than
 *   {@link ORCAMENTO_ANTES_DO_PATCH_MS} since the dispatch began ⇒ NO PATCH,
 *   `prazo-da-tarefa`, and a throw for the retry (which recomputes). Cloud
 *   Tasks' concurrency 1 bounds DISPATCHES, not executions: a dispatch past its
 *   timeout frees the slot while its code may still run, so a PATCH computed
 *   long ago must never go out after a fresher task's. The budget is checked
 *   with the write's credential IN HAND: the write client awaits its
 *   credential getter outside any deadline (a Firestore read, an LWA exchange
 *   when the token is stale) and then sends without another await, so the
 *   check sits inside that getter — and inside the forced refresh's — never
 *   before it. The outcome's `emMs` is our clock at that same instant,
 *   immediately before the PATCH.
 * - **P7** — after a PATCH Amazon answered, a NO-THROW boundary: the outcome
 *   written back onto every link doc of the SKU (`envioEstoqueFirestore.ts`,
 *   `via: 'patch'`: `ACCEPTED` ⇒ `aceito` / `aceito-com-avisos`, `INVALID` ⇒
 *   `recusado`), and on `INVALID` the conta aviso `estoque-recusado-pela-amazon`
 *   RAISED, clocked by the write-back's own link-doc read time — only when the
 *   outcome is, or may be, the link's latest (written, or still in conflict
 *   after every attempt): an `INVALID` that lost the watermark to a newer
 *   stored outcome, or found no link doc, raises nothing, so a late answer
 *   never reopens the row with a clock newer than a resolve already made.
 * - **P8** — inside the same boundary: ONE read-back task (`origem:
 *   'verificacao'`, named after Amazon's `submissionId`, 360 s later), only when
 *   the status was `ACCEPTED` and the origem earns one (`precisaVerificacao`:
 *   never for a read-back, never for a reconcile's patch). A read-back re-runs
 *   this very ladder: it re-reads both sides, and sends again only when the
 *   plan still writes.
 * - **P9** — the failures, by CLASS (root `CLAUDE.md` rule 6), split by the
 *   run's PHASE (whether the PATCH was reached, the engine lets both out
 *   through the same throw):
 *   - a 429 (the read's or the PATCH's: not processed) ⇒ the same payload
 *     re-enqueued UNNAMED 60 s later and NO throw, so no queue attempt is spent
 *     (`pausado`); that re-enqueue failing with a named class (the queue valve,
 *     a transient, a region, a raw SDK failure) ⇒ the queue's OWN retry instead
 *     (nothing was sent, and a retry needs no enqueue): the line first
 *     (`retentar`, the loss named), then a throw;
 *   - before the PATCH, the shared read ladder (`classificarFalhaDeLeituraAmazon`):
 *     a conta or credential refusal ⇒ WARNING, end; a transient ⇒ a throw for
 *     the retry; anything definite ⇒ `leitura-falhou`, ERROR, end;
 *   - the PATCH cut, a 5xx, a dropped connection or a 2xx off its schema — it
 *     MAY HAVE LANDED ⇒ FIRST, inside a no-throw boundary, the provisional
 *     write-back `envioIncerto(emMs, quantidade)`, so the retry treats that
 *     PATCH as a recent send of its quantity (it may apply up to 15 minutes
 *     later, after a retry that read the old value as equal); then
 *     `escrita-incerta` and a throw for the retry, which re-reads first;
 *   - any other 4xx of the PATCH (a second 401/403 included) ⇒
 *     `escrita-falhou`, ERROR, end.
 * - **P10** — ONE dispatch line: the origem, the SKU, the closed motivo, both
 *   quantities, the direction, Amazon's status, the issue codes through their
 *   grammar, the error class. Never an issue message, a seller id or a body.
 *
 * ## The no-throw boundary
 *
 * Everything after a PATCH that may have landed (P7, P8, the provisional
 * write-back of P9) CONTAINS its named failures — a Firestore error, the stock
 * producer's own (the queue valve, a transient, a raw SDK failure, a missing or
 * malformed region) — and names the first one in the line (`perda`): a throw
 * there would read as the write failing, and its retry would send again. An
 * unnamed failure is a bug, and crosses.
 *
 * ## Rule 7
 *
 * The PATCH body is an ABSOLUTE quantity computed at dispatch from a fresh
 * read; the queue's `maxConcurrentDispatches: 1` serialises one conta's
 * patches, and the budget above keeps a stale execution from sending after a
 * fresher dispatch. The ONLY Firestore writes are the outcome write-back (tier
 * 2 on `emMs`, through a tier-1 precondition, `envioEstoqueFirestore.ts`) and
 * the aviso raise (the shared seam, tier 2 on the Firestore timeline). No
 * transaction.
 *
 * Two residues, accepted as they stand:
 *
 * - The only "maybe sent" record is the provisional `incerto`, written once a
 *   PATCH failure is OBSERVED. A dispatch that dies after its PATCH left (the
 *   instance killed, or the dispatch's code outliving its timeout), an answered
 *   PATCH whose write-back is lost inside the boundary, or a provisional entry
 *   landing only after the retry's P3 read, leaves the retry (or the read-back)
 *   without it: inside Amazon's 15-minute lag it may read the pre-PATCH value,
 *   and with the ERP moved back to that value it takes `igual`, so the late
 *   PATCH stands until the SKU moves again or the daily reconcile. A record
 *   written AHEAD of every PATCH would close it, at one masked read and one
 *   update per PATCH.
 * - The 429 pause carries no counter: under a 429 that never ends, a task
 *   re-enqueues itself every 60 s, spending no attempt, until Amazon answers,
 *   the stock valve is `off` (P1 reads nothing), the read switch is not `on`
 *   (the context refuses), or a pause enqueue fails (then the queue's own five
 *   attempts bound it).
 *
 * ## The depósito comes from the context's conta
 *
 * The conta is the context loader's (`core/contaCache.ts`): a depósito the
 * operator moved is seen by this task within that cache's TTL (15 minutes) on
 * an instance that already held the conta. The tick hands a depósito change to
 * a reconcile, whose tasks are delayed past that bound.
 *
 * ⚠️ D11: nothing here reaches Amazon while the read switch is off (the context
 * refuses first), and a PATCH also needs the stock valve `on` and a canary hit.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import { vezFeedAmazonCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonSchemaError,
  AmazonThrottleError,
  DADOS_LISTING_AMAZON,
  type EnvioListingAmazon,
  OPERACAO_ENVIAR_LISTING,
  skuTemCaminhoAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioEstoqueAmazon,
  FLUXO_FEED_AMAZON,
  MOTIVO_CONTA_AMAZON,
  idVezFeedAmazon,
  type vezFeedAmazonSchema,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_ESTOQUE_AMAZON,
  sincronizarAvisoContaEstoqueAmazon,
} from '../avisos/avisos';
import type { ContextoAmazon, ContextoAmazonDeps } from '../core/contexto';
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
import { CODIGO_OUTRO, codigoDeErroSeguro, passaPredicadoAmazon } from '../core/redacao';
import {
  FLUXO_AMAZON,
  MODO_AMAZON,
  type MotivoDryRunAmazon,
  decidirAlvo,
  lerValvula,
  registrarValvulaAmazon,
} from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import {
  type LeituraListingNaAmazon,
  enviarDisponibilidadeNaAmazon,
  lerListingNaAmazon,
} from '../listings/listingsAmazon';
import {
  FALHA_LEITURA_AMAZON,
  type FalhaLeituraAmazon,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import { STATUS_ENVIO_LISTING_AMAZON, envioDoPatch, envioIncerto } from './envioEstoque';
import { gravarEnvioEstoqueAmazon } from './envioEstoqueFirestore';
import { depositoIdDaContaEstoqueAmazon, quantidadeEstoqueAmazon } from './familiaEstoque';
import { lerFamiliaEstoqueAmazon } from './familiaEstoqueFirestore';
import { type VeredictoListingEstoqueAmazon, avaliarListingEstoqueAmazon } from './gateListing';
import {
  type ContadorEstoqueAmazon,
  MOTIVO_ESTOQUE_AMAZON,
  type MotivoEstoqueAmazon,
  RECUSAS_HUMANAS_ESTOQUE_AMAZON,
} from './motivosEstoque';
import {
  type DirecaoEstoqueAmazon,
  type PlanoEstoqueAmazon,
  type RegraEscritaEstoqueAmazon,
  planejarEstoqueAmazon,
} from './planoEstoque';
import {
  AmazonEstoqueRegiaoDaFilaInvalidaError,
  AmazonEstoqueTarefasDesligadasError,
  FILA_ESTOQUE_AMAZON,
  type ProdutorEstoqueAmazon,
  type ResultadoEnfileiramentoEstoqueAmazon,
} from './produtorEstoque';
import { lerVinculoEstoqueAmazon } from './resolverEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type OrigemTarefaEstoqueAmazon,
  REFERENCIA_SUBMISSAO_REGEX,
  type TarefaEstoqueAmazon,
  precisaVerificacao,
  tarefaEstoqueAmazonSchema,
} from './tarefaEstoque';
import { type VinculoAptoEstoqueAmazon, avaliarVinculoEstoqueAmazon } from './vinculoEstoque';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/**
 * The task's own budget before its PATCH, in ms (module header, P6), checked
 * with the write's credential in hand before EVERY PATCH (the forced refresh's
 * second one included), so a PATCH that goes out always goes out inside its
 * dispatch. It sits below the queue's 300-s timeout minus 80 s (the PATCH, its
 * forced refresh and a second PATCH), so the answers fit too.
 */
export const ORCAMENTO_ANTES_DO_PATCH_MS = 200_000;

/** The ONE lease field this task reads: the end of the conta's last stock feed that may have applied. */
export const CAMPO_FEED_RECENTE_ESTOQUE_AMAZON =
  'ultimoFeedConcluidoEmMs' as const satisfies keyof typeof vezFeedAmazonSchema.shape;

/** The datasets the live read asks for: the gate reads exactly these. */
export const DADOS_LEITURA_ESTOQUE_AMAZON = [
  DADOS_LISTING_AMAZON.resumos,
  DADOS_LISTING_AMAZON.disponibilidade,
  DADOS_LISTING_AMAZON.relacoes,
] as const;

/** The queue dispatch this run is: its 0-based attempt and its task id. */
export interface RegistroEstoqueAmazon {
  readonly tentativa: number;
  readonly idTarefa: string | null;
}

/** The context loader, as `core/contexto.ts` exports it (`loadAmazonContext`). */
export type CarregadorDeContextoAmazon = (
  db: Firestore,
  integracaoId: string,
  deps: ContextoAmazonDeps,
) => Promise<ContextoAmazon>;

/** Everything one dispatch needs — bound by `functions/src/filaEstoque.ts`, doubles in the tests. */
export interface DepsProcessarEstoqueAmazon {
  readonly db: Firestore;
  /** The process environment: the read switch, the LWA pair, the stock valve and canary. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS (the budget, the plan's instant, the outcome's `emMs`). */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** The context loader (the read switch FIRST). */
  readonly carregarContexto: CarregadorDeContextoAmazon;
  /** The stock queue's producer (the read-back and the 429 pause) — built only when one is due. */
  readonly produtor: () => ProdutorEstoqueAmazon;
  readonly registro: RegistroEstoqueAmazon;
  /** Test seams, forwarded to the context and the write engine as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** What one dispatch did (closed). */
export type AcaoTarefaEstoqueAmazon =
  /** P0: the payload is not this queue's — dropped, WARNING. */
  | 'payload-invalido'
  /** Ended with no PATCH sent: the valve, a refusal, equal quantities, a definite failure. */
  | 'encerrado'
  /** A dry-run (or `on` outside the canary): the live read and the engine's diff line only. */
  | 'simulado'
  /** ONE PATCH, and Amazon answered it. */
  | 'enviado'
  /** A 429: the same payload re-enqueued unnamed, no attempt spent. */
  | 'pausado'
  /** A deliberate throw for the queue's retry (a transient, the budget, a PATCH that may have landed). */
  | 'retentar';

export const ACAO_TAREFA_ESTOQUE_AMAZON = {
  payloadInvalido: 'payload-invalido',
  encerrado: 'encerrado',
  simulado: 'simulado',
  enviado: 'enviado',
  pausado: 'pausado',
  retentar: 'retentar',
} as const satisfies Record<string, AcaoTarefaEstoqueAmazon>;

/** A side effect lost INSIDE the no-throw boundary (module header). */
export type EfeitoPerdidoEstoqueAmazon = 'gravacao' | 'aviso' | 'verificacao' | 'pausa';

/** What the read-back enqueue came to. */
export type VerificacaoEstoqueAmazon =
  | ResultadoEnfileiramentoEstoqueAmazon
  /** Amazon's `submissionId` is absent or outside the task-name grammar: no read-back. */
  | 'sem-submissao'
  /** The enqueue failed inside the no-throw boundary (`perda` names it). */
  | 'perdida';

/** The dispatch's result, logged ONCE ({@link registrarDespachoEstoqueAmazon}). */
export interface ResultadoTarefaEstoqueAmazon {
  readonly acao: AcaoTarefaEstoqueAmazon;
  /** The closed outcome; `null` only for `payload-invalido`. */
  readonly motivo: MotivoEstoqueAmazon | null;
  readonly contaId: string | null;
  readonly sku: string | null;
  readonly origem: OrigemTarefaEstoqueAmazon | null;
  /** The ERP quantity computed at THIS dispatch (P4), once computed. */
  readonly quantidadeErp: number | null;
  /** Amazon's live quantity (the gate's), once read. */
  readonly quantidadeAmazon: number | null;
  readonly direcao: DirecaoEstoqueAmazon | null;
  /** Why the plan writes (`null` when it does not, or was never made). */
  readonly regra: RegraEscritaEstoqueAmazon | null;
  /** Why a dry-run did not write (the valve, the canary). */
  readonly dryRun: MotivoDryRunAmazon | null;
  /** Amazon's submission status, raw (the line keeps only the two it reads). */
  readonly status: string | null;
  /** The PATCH answer's issue codes, raw (the line keeps them through their grammar). */
  readonly problemas: readonly string[];
  /** An HTTP failure's codes, raw (the line keeps only the closed ones). */
  readonly codigos: readonly string[];
  /** The shared ladder's token of a read-side failure. */
  readonly falha: FalhaLeituraAmazon | null;
  /** A failure's CLASS (and gRPC/SDK code) — never its message. */
  readonly erro: string | null;
  /** The shapes the verdict and the gate only COUNT. */
  readonly contagens: readonly ContadorEstoqueAmazon[];
  /** The outcome write-back, counted, when one ran and landed. */
  readonly gravados: number | null;
  readonly emConflito: number | null;
  /** Whether `estoque-recusado-pela-amazon` was raised. */
  readonly avisoLevantado: boolean;
  readonly verificacao: VerificacaoEstoqueAmazon | null;
  /** The first side effect lost inside the no-throw boundary, and its class. */
  readonly perda: { readonly efeito: EfeitoPerdidoEstoqueAmazon; readonly erro: string } | null;
}

/**
 * The budget before the PATCH was spent (module header, P6): NOTHING was sent.
 * Its own class, so the retry it asks for is never mistaken for a PATCH that
 * may have landed.
 */
export class AmazonEstoquePrazoDaTarefaError extends Error {
  constructor() {
    super(
      '[amazon/estoque] o orçamento da tarefa antes do PATCH acabou; nada foi enviado ' +
        '(a nova tentativa recalcula a quantidade)',
    );
    this.name = 'AmazonEstoquePrazoDaTarefaError';
  }
}

/* -------------------------------------------------------------------------- */
/*                               the dispatch line                            */
/* -------------------------------------------------------------------------- */

/** Ends a person must read the log for. */
const MOTIVOS_EM_WARNING: ReadonlySet<string> = new Set<string>([
  ...RECUSAS_HUMANAS_ESTOQUE_AMAZON,
  MOTIVO_ESTOQUE_AMAZON.contaIndisponivel,
  MOTIVO_ESTOQUE_AMAZON.contaSemDeposito,
  MOTIVO_ESTOQUE_AMAZON.depositoMudou,
  MOTIVO_ESTOQUE_AMAZON.unidadeAusente,
  MOTIVO_ESTOQUE_AMAZON.escritaIncerta,
  MOTIVO_ESTOQUE_AMAZON.prazoDaTarefa,
  MOTIVO_ESTOQUE_AMAZON.leituraFalhou,
]);

/** Ends that are a defect of the app, a grant or a request, never of this SKU's data. */
const MOTIVOS_EM_ERROR: ReadonlySet<string> = new Set<string>([
  MOTIVO_ESTOQUE_AMAZON.escritaFalhou,
]);

/** The dispatch line's severity: ERROR for a definite failure, WARNING whenever a person has to look. */
export function severidadeDoDespachoEstoqueAmazon(
  r: ResultadoTarefaEstoqueAmazon,
): SeveridadeAmazon {
  if (r.motivo !== null && MOTIVOS_EM_ERROR.has(r.motivo)) return 'ERROR';
  // A definite read failure (not a transient the retry absorbs) is an ERROR too.
  if (
    r.motivo === MOTIVO_ESTOQUE_AMAZON.leituraFalhou &&
    r.acao === ACAO_TAREFA_ESTOQUE_AMAZON.encerrado
  ) {
    return 'ERROR';
  }
  if (
    r.acao === ACAO_TAREFA_ESTOQUE_AMAZON.payloadInvalido ||
    r.avisoLevantado ||
    r.perda !== null ||
    r.falha === FALHA_LEITURA_AMAZON.chamadasDesligadas
  ) {
    return 'WARNING';
  }
  return r.motivo !== null && MOTIVOS_EM_WARNING.has(r.motivo) ? 'WARNING' : 'INFO';
}

/** Amazon's submission status as the line keeps it: the two it reads, else `<outro>`. */
function statusSeguro(status: string | null): string | null {
  if (status === null) return null;
  return status === STATUS_ENVIO_LISTING_AMAZON.aceito ||
    status === STATUS_ENVIO_LISTING_AMAZON.invalido
    ? status
    : CODIGO_OUTRO;
}

/** A listings issue code through its grammar, else `<outro>`. */
function problemaSeguro(codigo: string): string {
  return passaPredicadoAmazon('codigoListing', codigo) ? codigo : CODIGO_OUTRO;
}

/** A list as one campo: joined with `,`, `null` when empty. */
function juntar(lista: readonly string[]): string | null {
  return lista.length === 0 ? null : lista.join(',');
}

/**
 * The ONE `evento: 'estoque'` dispatch line (module header, P10): ids, closed
 * codes and counts only.
 */
export function registrarDespachoEstoqueAmazon(
  logger: LoggerAmazon,
  r: ResultadoTarefaEstoqueAmazon,
  registro: RegistroEstoqueAmazon,
): void {
  const campos: CamposLogAmazon = {
    fila: FILA_ESTOQUE_AMAZON,
    acao: r.acao,
    motivo: r.motivo,
    origem: r.origem,
    sku: r.sku,
    quantidadeErp: r.quantidadeErp,
    quantidadeAmazon: r.quantidadeAmazon,
    direcao: r.direcao,
    regra: r.regra,
    dryRun: r.dryRun,
    status: statusSeguro(r.status),
    problemas: juntar(r.problemas.map(problemaSeguro)),
    codigos: juntar(r.codigos.map(codigoDeErroSeguro)),
    falha: r.falha,
    erro: r.erro,
    contagens: juntar(r.contagens),
    gravados: r.gravados,
    emConflito: r.emConflito,
    avisoLevantado: r.avisoLevantado,
    verificacao: r.verificacao,
    perda: r.perda?.efeito ?? null,
    erroPerda: r.perda?.erro ?? null,
  };
  registrarEventoAmazon(
    logger,
    'estoque',
    severidadeDoDespachoEstoqueAmazon(r),
    `[amazon] tarefa da fila de estoque: ${r.acao}`,
    campos,
    {
      conta: r.contaId,
      fluxo: FLUXO_AMAZON.estoque,
      tentativa: registro.tentativa,
      idTarefa: registro.idTarefa,
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                           one dispatch's own state                         */
/* -------------------------------------------------------------------------- */

/** A dispatch in flight: its payload, its start, and what it learned so far. */
interface Execucao {
  readonly deps: DepsProcessarEstoqueAmazon;
  readonly t: TarefaEstoqueAmazon;
  /** ms — when the dispatch began (the budget's origin). */
  readonly inicioMs: number;
  quantidadeErp: number | null;
  plano: PlanoEstoqueAmazon | null;
  contagens: ContadorEstoqueAmazon[];
  perda: ResultadoTarefaEstoqueAmazon['perda'];
}

/** A result for `e`, every field not given taken from what the dispatch learned. */
function resultado(
  e: Execucao,
  r: Partial<Omit<ResultadoTarefaEstoqueAmazon, 'acao' | 'motivo'>> & {
    readonly acao: AcaoTarefaEstoqueAmazon;
    readonly motivo: MotivoEstoqueAmazon;
  },
): ResultadoTarefaEstoqueAmazon {
  const diff = e.plano?.diff ?? null;
  return {
    contaId: e.t.contaId,
    sku: e.t.sku,
    origem: e.t.origem,
    quantidadeErp: e.quantidadeErp,
    quantidadeAmazon: diff?.quantidadeAmazon ?? null,
    direcao: diff?.direcao ?? null,
    regra: diff?.regra ?? null,
    dryRun: null,
    status: null,
    problemas: [],
    codigos: [],
    falha: null,
    erro: null,
    contagens: [...new Set(e.contagens)].sort(),
    gravados: null,
    emConflito: null,
    avisoLevantado: false,
    verificacao: null,
    perda: e.perda,
    ...r,
  };
}

/** An end with no PATCH sent. */
function encerrar(
  e: Execucao,
  motivo: MotivoEstoqueAmazon,
  extra: Partial<ResultadoTarefaEstoqueAmazon> = {},
): ResultadoTarefaEstoqueAmazon {
  return resultado(e, { ...extra, acao: ACAO_TAREFA_ESTOQUE_AMAZON.encerrado, motivo });
}

/**
 * A deliberate throw for the queue's retry, carrying the line to write first:
 * module-private, so the one catch that reads it (in
 * {@link processarEstoqueAmazon}) narrows by THIS class and rethrows `causa`.
 */
class RetentativaEstoqueAmazon extends Error {
  readonly resultado: ResultadoTarefaEstoqueAmazon;
  readonly causa: unknown;

  constructor(resultado: ResultadoTarefaEstoqueAmazon, causa: unknown) {
    super('[amazon/estoque] nova tentativa da tarefa de estoque');
    this.name = 'RetentativaEstoqueAmazon';
    this.resultado = resultado;
    this.causa = causa;
  }
}

/** Write the line, then throw `causa` for the queue's retry. */
function retentar(
  e: Execucao,
  motivo: MotivoEstoqueAmazon,
  causa: unknown,
  extra: Partial<ResultadoTarefaEstoqueAmazon> = {},
): never {
  throw new RetentativaEstoqueAmazon(
    resultado(e, { ...extra, acao: ACAO_TAREFA_ESTOQUE_AMAZON.retentar, motivo }),
    causa,
  );
}

/* -------------------------------------------------------------------------- */
/*                         the no-throw boundary (P7–P9)                      */
/* -------------------------------------------------------------------------- */

/**
 * The failures the no-throw boundary contains (module header): a Firestore
 * error and the stock producer's own. Anything else is an unnamed bug, and
 * crosses.
 */
function ehFalhaContida(err: unknown): boolean {
  return (
    isGrpcStatusError(err) ||
    err instanceof AmazonTarefasTransitoriasError ||
    err instanceof AmazonEstoqueTarefasDesligadasError ||
    err instanceof MissingRegionError ||
    err instanceof AmazonEstoqueRegiaoDaFilaInvalidaError ||
    ehFalhaDoSdkDeTarefasAmazon(err)
  );
}

/** A failure's CLASS — its `name`, a Firestore one with its gRPC code, an SDK one described; never a message. */
function classeDoErro(err: unknown): string {
  if (isGrpcStatusError(err)) return `Firestore/${String(err.code)}`;
  if (ehFalhaDoSdkDeTarefasAmazon(err)) return descreverFalhaDoSdkDeTarefasAmazon(err);
  const nome = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : null;
  return typeof nome === 'string' ? nome : 'desconhecido';
}

/**
 * ONE side effect inside the boundary: its value, or — for a contained failure
 * — `null`, with the FIRST loss recorded for the line.
 */
async function protegido<T>(
  e: Execucao,
  efeito: EfeitoPerdidoEstoqueAmazon,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (!ehFalhaContida(err)) throw err;
    e.perda ??= { efeito, erro: classeDoErro(err) };
    return null;
  }
}

/** The SKU's link docs, as the write-back takes them (the `dono`'s, by path). */
function linksDoEnvio(vinculo: VinculoAptoEstoqueAmazon) {
  return vinculo.linkIds.map((linkId) => ({ produtoId: vinculo.donoId, linkId }));
}

/** The outcome written back onto the SKU's link docs (P7, P9), inside the boundary. */
function gravarEnvio(e: Execucao, vinculo: VinculoAptoEstoqueAmazon, envio: EnvioEstoqueAmazon) {
  return protegido(e, 'gravacao', () =>
    gravarEnvioEstoqueAmazon(
      e.deps.db,
      {
        contaId: e.t.contaId,
        sku: e.t.sku,
        links: linksDoEnvio(vinculo),
        envio,
        agoraMs: e.deps.agora(),
      },
      { logger: e.deps.logger },
    ),
  );
}

/* -------------------------------------------------------------------------- */
/*                                the outcome (P7, P8)                         */
/* -------------------------------------------------------------------------- */

/** A non-empty string, or `null`. */
function textoNaoVazio(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** P7–P8: Amazon answered the PATCH; everything here is inside the boundary. */
async function respostaDoPatch(
  e: Execucao,
  vinculo: VinculoAptoEstoqueAmazon,
  plano: PlanoEstoqueAmazon,
  emMs: number,
  resposta: EnvioListingAmazon,
): Promise<ResultadoTarefaEstoqueAmazon> {
  const status = textoNaoVazio(resposta.status);
  const problemas = (resposta.issues ?? [])
    .map((i) => textoNaoVazio(i.code))
    .filter((c): c is string => c !== null);
  const envio = envioDoPatch(resposta, emMs, plano.quantidade);

  // P7: the outcome onto every link doc of the SKU.
  const gravacao = await gravarEnvio(e, vinculo, envio);

  // P7: an INVALID patch raises the conta aviso, clocked by the write-back's
  // read — only when this outcome is, or may be, the link's latest (module
  // header): a stale INVALID that every link doc kept a newer outcome against
  // (or that found no link doc) raises nothing.
  let avisoLevantado = false;
  if (
    status === STATUS_ENVIO_LISTING_AMAZON.invalido &&
    gravacao !== null &&
    gravacao.relogio !== null &&
    (gravacao.gravados > 0 || gravacao.emConflito > 0)
  ) {
    const relogio = gravacao.relogio;
    const aviso = await protegido(e, 'aviso', () =>
      sincronizarAvisoContaEstoqueAmazon(
        e.deps.db,
        { increment: e.deps.increment, nowMs: e.deps.agora(), logger: e.deps.logger },
        {
          integracaoId: e.t.contaId,
          motivo: MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon,
          acao: ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
          relogio,
        },
      ),
    );
    avisoLevantado = aviso !== null;
  }

  // P8: ONE read-back, only for an ACCEPTED patch of an origem that earns one.
  let verificacao: VerificacaoEstoqueAmazon | null = null;
  if (status === STATUS_ENVIO_LISTING_AMAZON.aceito && precisaVerificacao(e.t.origem)) {
    const submissionId = textoNaoVazio(resposta.submissionId);
    if (submissionId === null || !REFERENCIA_SUBMISSAO_REGEX.test(submissionId)) {
      verificacao = 'sem-submissao';
    } else {
      verificacao =
        (await protegido(e, 'verificacao', () =>
          e.deps.produtor().enfileirarVerificacao(e.t, submissionId),
        )) ?? 'perdida';
    }
  }

  // A 2xx that is neither ACCEPTED nor INVALID was recorded `incerto` (no read-back).
  const motivo =
    status === STATUS_ENVIO_LISTING_AMAZON.aceito || status === STATUS_ENVIO_LISTING_AMAZON.invalido
      ? MOTIVO_ESTOQUE_AMAZON.enviado
      : MOTIVO_ESTOQUE_AMAZON.escritaIncerta;
  return resultado(e, {
    acao: ACAO_TAREFA_ESTOQUE_AMAZON.enviado,
    motivo,
    status,
    problemas,
    gravados: gravacao?.gravados ?? null,
    emConflito: gravacao?.emConflito ?? null,
    avisoLevantado,
    verificacao,
  });
}

/* -------------------------------------------------------------------------- */
/*                                  the failures (P9)                          */
/* -------------------------------------------------------------------------- */

/** An HTTP failure's codes, or none. */
function codigosDe(err: unknown): readonly string[] {
  return err instanceof AmazonHttpError ? err.codigosErro : [];
}

/**
 * A 429 (not processed): the same payload, UNNAMED, 60 s later, and NO throw —
 * the dispatch ends, so no queue attempt is spent. The re-enqueue itself
 * failing with a NAMED class (the queue valve, a Cloud Tasks transient, a
 * missing or malformed region, a raw SDK failure) falls back to the queue's
 * OWN retry: nothing was sent, and a retry needs no enqueue — so the SKU's
 * update is kept at the cost of one attempt, never dropped. The line is
 * written first (`retentar`, the loss named), as for every deliberate throw;
 * anything else crosses.
 */
async function pausar(
  e: Execucao,
  extra: Partial<ResultadoTarefaEstoqueAmazon>,
): Promise<ResultadoTarefaEstoqueAmazon> {
  try {
    await e.deps.produtor().enfileirarPausa(e.t);
  } catch (err) {
    if (!ehFalhaContida(err)) throw err;
    e.perda ??= { efeito: 'pausa', erro: classeDoErro(err) };
    return retentar(e, MOTIVO_ESTOQUE_AMAZON.pausado, err, extra);
  }
  return resultado(e, {
    ...extra,
    acao: ACAO_TAREFA_ESTOQUE_AMAZON.pausado,
    motivo: MOTIVO_ESTOQUE_AMAZON.pausado,
  });
}

/**
 * A read-side failure (the context, or the live read before the PATCH): nothing
 * was sent (module header, P9).
 */
async function falhaDeLeitura(e: Execucao, err: unknown): Promise<ResultadoTarefaEstoqueAmazon> {
  const falha = classificarFalhaDeLeituraAmazon(err);
  const extra: Partial<ResultadoTarefaEstoqueAmazon> = {
    falha,
    erro: classeDoErro(err),
    codigos: codigosDe(err),
  };
  switch (falha) {
    case FALHA_LEITURA_AMAZON.pausa:
      return pausar(e, extra);
    case FALHA_LEITURA_AMAZON.transitorio:
      return retentar(e, MOTIVO_ESTOQUE_AMAZON.leituraFalhou, err, extra);
    case FALHA_LEITURA_AMAZON.chamadasDesligadas:
      return encerrar(e, MOTIVO_ESTOQUE_AMAZON.desligado, extra);
    case FALHA_LEITURA_AMAZON.contaInativa:
    case FALHA_LEITURA_AMAZON.contaIndisponivel:
    case FALHA_LEITURA_AMAZON.authLwa:
      return encerrar(e, MOTIVO_ESTOQUE_AMAZON.contaIndisponivel, extra);
    case FALHA_LEITURA_AMAZON.authSpApi:
    case FALHA_LEITURA_AMAZON.naoEncontrado:
    case FALHA_LEITURA_AMAZON.httpDefinitivo:
    case FALHA_LEITURA_AMAZON.esquema:
    case FALHA_LEITURA_AMAZON.ilegivel:
      return encerrar(e, MOTIVO_ESTOQUE_AMAZON.leituraFalhou, extra);
    case FALHA_LEITURA_AMAZON.relancar:
      // A Firestore error, the LWA pair missing, a bug: the queue retries it.
      throw err;
  }
}

/**
 * Whether the PATCH's OWN failure means it MAY HAVE LANDED: a 5xx, a dropped
 * connection or a timeout, or a 2xx off its schema — each of the SP-API's
 * answer to `patchListingsItem` itself, never an LWA exchange's.
 */
function patchIncerto(err: unknown): boolean {
  if (err instanceof AmazonAuthError || err instanceof AmazonThrottleError) return false;
  if (err instanceof AmazonHttpError) {
    return err.transitorio && err.destino === 'sp-api' && err.operacao === OPERACAO_ENVIAR_LISTING;
  }
  if (err instanceof AmazonNetworkError || err instanceof AmazonSchemaError) {
    return err.destino === 'sp-api' && err.operacao === OPERACAO_ENVIAR_LISTING;
  }
  return false;
}

/** A failure once the PATCH was reached (module header, P9). */
async function falhaDeEscrita(
  e: Execucao,
  vinculo: VinculoAptoEstoqueAmazon,
  plano: PlanoEstoqueAmazon,
  emMs: number,
  err: unknown,
): Promise<ResultadoTarefaEstoqueAmazon> {
  const extra: Partial<ResultadoTarefaEstoqueAmazon> = {
    erro: classeDoErro(err),
    codigos: codigosDe(err),
  };
  // A 429 was not processed.
  if (err instanceof AmazonThrottleError) return pausar(e, extra);
  // It MAY HAVE LANDED: the provisional outcome FIRST, then the retry.
  if (patchIncerto(err)) {
    const gravacao = await gravarEnvio(e, vinculo, envioIncerto(emMs, plano.quantidade));
    return retentar(e, MOTIVO_ESTOQUE_AMAZON.escritaIncerta, err, {
      ...extra,
      gravados: gravacao?.gravados ?? null,
      emConflito: gravacao?.emConflito ?? null,
    });
  }
  // Amazon answered the PATCH with a definite refusal: a 4xx (a second 401/403
  // after the forced refresh included), a 3xx never followed.
  if (
    err instanceof AmazonHttpError &&
    err.destino === 'sp-api' &&
    err.operacao === OPERACAO_ENVIAR_LISTING
  ) {
    return encerrar(e, MOTIVO_ESTOQUE_AMAZON.escritaFalhou, extra);
  }
  // Not the PATCH's own answer (the forced refresh's LWA exchange, a parked
  // credential the getter refused): nothing was sent — the read ladder.
  return falhaDeLeitura(e, err);
}

/* -------------------------------------------------------------------------- */
/*                                  the reads                                  */
/* -------------------------------------------------------------------------- */

/**
 * The end of the conta's last stock feed that may have applied (P6), ms, or
 * `null` when none is on record: ONE by-id read of the stock lease (no index),
 * masked to {@link CAMPO_FEED_RECENTE_ESTOQUE_AMAZON}. A value this repo's own
 * writer could not have stamped reads as none.
 */
async function lerFeedRecenteEmMs(db: Firestore, contaId: string): Promise<number | null> {
  const ref = vezFeedAmazonCollection.docRef(
    db,
    {},
    idVezFeedAmazon(FLUXO_FEED_AMAZON.estoque, contaId),
  );
  const [snap] = await db.getAll(ref, { fieldMask: [CAMPO_FEED_RECENTE_ESTOQUE_AMAZON] });
  if (snap?.exists !== true) return null;
  const valor: unknown = (snap.data() ?? {})[CAMPO_FEED_RECENTE_ESTOQUE_AMAZON];
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
}

/* -------------------------------------------------------------------------- */
/*                                the dispatch                                */
/* -------------------------------------------------------------------------- */

/** P0's drop: the payload is not this queue's. */
function payloadInvalido(): ResultadoTarefaEstoqueAmazon {
  return {
    acao: ACAO_TAREFA_ESTOQUE_AMAZON.payloadInvalido,
    motivo: null,
    contaId: null,
    sku: null,
    origem: null,
    quantidadeErp: null,
    quantidadeAmazon: null,
    direcao: null,
    regra: null,
    dryRun: null,
    status: null,
    problemas: [],
    codigos: [],
    falha: null,
    erro: null,
    contagens: [],
    gravados: null,
    emConflito: null,
    avisoLevantado: false,
    verificacao: null,
    perda: null,
  };
}

/** P0–P10, every end returned or thrown as a {@link RetentativaEstoqueAmazon}. */
async function executar(
  dados: unknown,
  deps: DepsProcessarEstoqueAmazon,
): Promise<ResultadoTarefaEstoqueAmazon> {
  const inicioMs = deps.agora();

  // ---- P0: the payload. ----
  const lido = tarefaEstoqueAmazonSchema.safeParse(dados);
  if (!lido.success) return payloadInvalido();
  const t = lido.data;
  const e: Execucao = {
    deps,
    t,
    inicioMs,
    quantidadeErp: null,
    plano: null,
    contagens: [],
    perda: null,
  };
  const registro = {
    fluxo: FLUXO_AMAZON.estoque,
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  };

  // ---- P1: the valve, read ONCE, logged, then the target — before any read. ----
  const valvula = lerValvula(FLUXO_AMAZON.estoque, deps.ambiente);
  registrarValvulaAmazon(deps.logger, valvula, {
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  });
  if (decidirAlvo(valvula, t.contaId, t.sku).modo === MODO_AMAZON.off) {
    return encerrar(e, MOTIVO_ESTOQUE_AMAZON.desligado);
  }

  // ---- P2: the context — the read switch first —, then the conta's depósito. ----
  const depsDoContexto: ContextoAmazonDeps = {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    registro,
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  let contexto: ContextoAmazon;
  try {
    contexto = await deps.carregarContexto(deps.db, t.contaId, depsDoContexto);
  } catch (err) {
    // Rule 6: a class the read ladder does not name (a Firestore error, the LWA
    // pair missing) is the queue's to retry.
    if (classificarFalhaDeLeituraAmazon(err) === FALHA_LEITURA_AMAZON.relancar) throw err;
    return falhaDeLeitura(e, err);
  }
  const sellerId = contexto.conta.selling_partner_id;
  if (sellerId === null || sellerId === undefined) {
    // The loader refuses an unconnected conta; kept total.
    return encerrar(e, MOTIVO_ESTOQUE_AMAZON.contaIndisponivel);
  }
  const depositoId = depositoIdDaContaEstoqueAmazon(contexto.conta.depositoOuterRef);
  if (depositoId === null) return encerrar(e, MOTIVO_ESTOQUE_AMAZON.contaSemDeposito);
  if (t.origem === ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao && t.depositoId !== depositoId) {
    return encerrar(e, MOTIVO_ESTOQUE_AMAZON.depositoMudou);
  }

  // ---- P3: the link, read masked, then its verdict. ----
  const vinculo = avaliarVinculoEstoqueAmazon(
    await lerVinculoEstoqueAmazon(deps.db, t.contaId, t.sku),
  );
  if (!vinculo.apto) return encerrar(e, vinculo.motivo);
  e.contagens.push(...vinculo.contagens);

  // ---- P4: the ERP quantity, NOW (never from the payload). ----
  const membro = await lerFamiliaEstoqueAmazon(deps.db, vinculo.unidadeId, depositoId);
  if (membro === null) return encerrar(e, MOTIVO_ESTOQUE_AMAZON.unidadeAusente);
  const quantidadeErp = quantidadeEstoqueAmazon(membro);
  e.quantidadeErp = quantidadeErp;

  // ---- P5: a SKU no listings path can carry. ----
  if (!skuTemCaminhoAmazon(t.sku)) return encerrar(e, MOTIVO_ESTOQUE_AMAZON.semCaminho);

  // ---- P6: the engine — the live read, the plan, at most ONE PATCH. ----
  const feedRecenteEmMs = await lerFeedRecenteEmMs(deps.db, t.contaId);
  const forcar = t.origem === ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp;
  // Written by the closures, read by the catch: an object, so neither is narrowed away.
  const corrida: { gate: VeredictoListingEstoqueAmazon | null; emMs: number | null } = {
    gate: null,
    emMs: null,
  };
  // The write's credential getter — the one the write client awaits before
  // every PATCH, and the forced refresh's — wrapped: the budget is checked and
  // `emMs` stamped with the credential IN HAND, the last await before a PATCH
  // leaves (module header, P6). The live read keeps the context's own client.
  const contextoDaEscrita: Pick<ContextoAmazon, 'integracaoId' | 'obterAcesso'> = {
    integracaoId: contexto.integracaoId,
    obterAcesso: async (opcoes) => {
      const credencial = await contexto.obterAcesso(opcoes);
      const agoraMs = deps.agora();
      if (agoraMs - e.inicioMs > ORCAMENTO_ANTES_DO_PATCH_MS) {
        throw new AmazonEstoquePrazoDaTarefaError();
      }
      corrida.emMs = agoraMs;
      return credencial;
    },
  };
  let r: ResultadoEscritaAmazon<LeituraListingNaAmazon, PlanoEstoqueAmazon, EnvioListingAmazon>;
  try {
    r = await executarEscritaAmazon({
      valvula,
      contaId: t.contaId,
      alvo: t.sku,
      contexto: contextoDaEscrita,
      deps: depsDoContexto,
      registro,
      lerAtual: () =>
        lerListingNaAmazon(contexto, {
          sellerId,
          sku: t.sku,
          incluir: DADOS_LEITURA_ESTOQUE_AMAZON,
        }),
      planejar: (listing) => {
        const gate = avaliarListingEstoqueAmazon(listing, vinculo);
        corrida.gate = gate;
        const plano = planejarEstoqueAmazon(
          quantidadeErp,
          gate,
          vinculo.envioRecente,
          deps.agora(),
          {
            forcar,
            feedRecenteEmMs,
          },
        );
        e.plano = plano;
        return plano;
      },
      // The budget and `emMs` live in the credential getter above, which the
      // client awaits right before it sends.
      escrever: (cliente, plano) =>
        enviarDisponibilidadeNaAmazon(cliente, {
          sellerId,
          sku: t.sku,
          quantidade: plano.quantidade,
        }),
    });
  } catch (err) {
    if (corrida.gate?.enviavel === true) e.contagens.push(...corrida.gate.contagens);
    if (err instanceof AmazonEstoquePrazoDaTarefaError) {
      return retentar(e, MOTIVO_ESTOQUE_AMAZON.prazoDaTarefa, err, { erro: err.name });
    }
    if (corrida.emMs === null || e.plano === null) return falhaDeLeitura(e, err);
    return falhaDeEscrita(e, vinculo, e.plano, corrida.emMs, err);
  }
  if (corrida.gate?.enviavel === true) e.contagens.push(...corrida.gate.contagens);

  switch (r.tipo) {
    case 'desligado':
      // P1 already answered `off` on the same snapshot; kept total.
      return encerrar(e, MOTIVO_ESTOQUE_AMAZON.desligado);
    case 'simulado': {
      // The engine wrote its ONE diff line; ours names why nothing was sent.
      const motivo: MotivoEstoqueAmazon = !r.plano.escrever
        ? r.plano.diff.motivo
        : r.motivo === 'fora-do-canario'
          ? MOTIVO_ESTOQUE_AMAZON.foraDoCanario
          : MOTIVO_ESTOQUE_AMAZON.simulado;
      return resultado(e, { acao: ACAO_TAREFA_ESTOQUE_AMAZON.simulado, motivo, dryRun: r.motivo });
    }
    case 'sem-escrita':
      return encerrar(e, r.plano.diff.motivo);
    case 'escrito': {
      if (corrida.emMs === null) {
        throw new TypeError('processarEstoque.ts: um PATCH escrito sem o seu instante');
      }
      return respostaDoPatch(e, vinculo, r.plano, corrida.emMs, r.resposta);
    }
  }
}

/**
 * ONE dispatch, P0–P10 (module header). Writes the ONE dispatch line and
 * returns the result; throws only what the queue must retry — a deliberate
 * retry (after its line), a Firestore error, a bug — RAW: the functions root
 * sanitizes it.
 */
export async function processarEstoqueAmazon(
  dados: unknown,
  deps: DepsProcessarEstoqueAmazon,
): Promise<ResultadoTarefaEstoqueAmazon> {
  let r: ResultadoTarefaEstoqueAmazon;
  try {
    r = await executar(dados, deps);
  } catch (err) {
    if (!(err instanceof RetentativaEstoqueAmazon)) throw err;
    registrarDespachoEstoqueAmazon(deps.logger, err.resultado, deps.registro);
    throw err.causa;
  }
  registrarDespachoEstoqueAmazon(deps.logger, r, deps.registro);
  return r;
}
