/**
 * The DAILY RECONCILE of the Amazon stock sync (step 12, PR 12-f): per conta,
 * ONE run walks every link doc of the conta, evaluates each SKU (the link
 * verdict, the ERP quantity, Amazon's live read and the listing gate, through
 * the evaluator the window feed shares), stores what drifted in blocks, and
 * then sends the drift — as patch tasks (≤ 30 SKUs), as block feeds (31 or
 * more: one per {@link MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON} walked pages), or
 * nothing (no drift, or a depósito that would zero the catalogue).
 * Nothing here PATCHes or posts: every send is an enqueue, and the task or the
 * feed send recomputes every quantity when it runs.
 *
 * ## Request ({@link solicitarReconciliacaoEstoqueAmazon})
 *
 * `pendente: true` and `pedidoEmMs` on the REQUEST document
 * `pedidoReconciliacaoEstoqueAmazon/{contaId}` — never on the run's, so a
 * request never breaks a page's precondition — tier 1 (`create`, or
 * `update(…, { lastUpdateTime })` on the read it decided from; a lost
 * precondition re-reads and re-decides, at most three times). An
 * `'automatica'` request (a failed feed's) is the loop-guarded one: within
 * {@link GUARDA_REEXECUCAO_AUTOMATICA_MS} of the stored
 * `reexecucaoAutomaticaEmMs` it stamps nothing — and, with no request already
 * pending, is REFUSED: the `feed-estoque-falhou` aviso raised clocked by that
 * request read, the next daily run catches up — else stamped. Then Start,
 * which a pending request is owed even inside the guard (a first attempt that
 * wrote its request and failed before the claim meets its own stamp on retry).
 *
 * ## Start ({@link iniciarReconciliacaoEstoqueAmazon})
 *
 * The run document `reconciliacaoEstoqueAmazon/{contaId}`, read fresh and
 * decided by {@link decidirInicioReconciliacaoEstoqueAmazon}:
 *
 *  - absent ⇒ CLAIMED with `create`; a run that ended (`concluida`,
 *    `truncada`), or one in ANY other fase whose `progressoEmMs ??
 *    iniciadaEmMs` is more than {@link RECLAMACAO_RECONCILIACAO_MS} (2 h) old
 *    (a crashed page, decide or close) ⇒ CLAIMED with `update(…, {
 *    lastUpdateTime })`; a lost precondition re-reads and re-decides;
 *  - a live run more than {@link RETOMADA_RECONCILIACAO_MS} (15 min) without
 *    progress has lost its next task (a crash between the claim and page 0's
 *    enqueue, a page whose next-page enqueue spent its attempts): its page
 *    `proximaPagina` is RE-KICKED, named by the stall
 *    (`nomeRetomadaReconciliacao`: one re-kick per stall). The tick calls the
 *    same re-kick ({@link retomarReconciliacaoEstoqueAmazon}) every five
 *    minutes, so a stall heals with no request;
 *  - any other live run ⇒ nothing (a pending request is read by its close).
 *
 * A claim reads the conta RAW and uncached: gone, not Amazon or inactive ⇒ no
 * run; its depósito through the storable parse
 * (`depositoIdGravavelDaContaEstoqueAmazon`, the run stores it) — none ⇒ no
 * run. The claim writes a fresh run (a new `execucaoId`, `iniciadaEmMs`, the
 * canonical depósito ref, page 0 next), then clears the request's `pendente`
 * (tier 1), then enqueues page 0 NAMED (`nomePaginaReconciliacao`). A crash
 * before that enqueue is the re-kick's to heal.
 *
 * ## Page ({@link processarPaginaReconciliacaoEstoqueAmazon}, `tipo: 'reconciliacao'`)
 *
 * On the jobs queue (concurrency 1). In order, under a work budget of
 * {@link ORCAMENTO_PAGINA_RECONCILIACAO_MS} (400 s) read before every Firestore
 * page, every batch of link queries and every Amazon call:
 *
 *  - the stock valve, read and logged FIRST (`off` ⇒ zero Firestore
 *    operations), then the context (the read switch first; a switch, conta or
 *    credential refusal ⇒ one line, the end);
 *  - **0** — the run check, from a FRESH read of the run: another `execucaoId`
 *    or a page past `proximaPagina` ⇒ stop; THIS run already ended ⇒ the
 *    close's tail again (the request read, Start when `pendente`: a close that
 *    died between its end and that read leaves nothing else to re-run it), stop;
 *    a page behind it ⇒ page `proximaPagina` re-enqueued under its name
 *    (idempotent), stop; equal ⇒ on. A run already `decidindo` goes to Decide,
 *    one already `enviando` to Close (a re-kick past the last page heals a
 *    stuck decide or close);
 *  - **1** — the conta's depósito (the context's conta, the ONE parse) must be
 *    the run's — a mismatch re-read RAW first, since the context's conta is the
 *    conta cache's and the claim's was raw: else the run is closed `truncada`
 *    (a walk never mixes depósitos), after a request for a fresh run that the
 *    close then starts;
 *  - **2** and **3** — the walk (one page of the conta's link docs,
 *    {@link PAGINA_VARREDURA_ESTOQUE_AMAZON} at most, projected to
 *    {@link CAMPOS_VARREDURA_VINCULOS_ESTOQUE_AMAZON}) and its dedupe (`ja-visto`):
 *    the listings flows' shared page core (`listings/varreduraVinculos.ts`, step
 *    13, PR 13-b; its header holds the query, its index and the dedupe rule),
 *    bound here to the stock masks ({@link CAMPOS_RESOLVER_ESTOQUE_AMAZON}). The
 *    links its dedupe read go on to step 4, never read twice. A walk that cannot
 *    go on (the budget, or a full page whose last doc cannot be a cursor) closes
 *    the run `truncada`;
 *  - **4** — the evaluator (`avaliarSkusEstoqueAmazon`, no GET cap), with the
 *    docs step 3 read, at the run's depósito. A 429 ⇒ the run's `progressoEmMs`
 *    stamped (tier 1 on step 0's read, this page still the run's next; lost ⇒
 *    stop), then the SAME page re-enqueued UNNAMED {@link ESPERA_LIMITE_PAGINA_S}
 *    later, no block, no attempt spent: the stamp keeps the re-kick from taking
 *    a throttled page for a lost one and starting a second chain of it, each
 *    of which would re-read a whole page of Firestore every minute. Any other
 *    failure is thrown for the queue's retry. The budget reached ⇒ the page
 *    gives up: the run is closed `truncada`;
 *  - **5** — the drift: enviável SKUs whose Amazon quantity differs from the
 *    ERP's (an absent Amazon quantity differs). ONE block written, an OVERWRITE
 *    (`divergenciasFirestore.ts`), BEFORE the state update, so the block always
 *    equals what the update counts;
 *  - **6** — the state update, tier 1 on step 0's read: the cursors, the
 *    counters summed, `paginas`, `proximaPagina`, `progressoEmMs`, and on page 0
 *    `relogioInicio` = step 0's `readTime` (the clock of every aviso of the
 *    run). A lost precondition re-reads: still this run and this page ⇒ retried
 *    (at most three attempts), else stop;
 *  - **7** — the next page enqueued NAMED by its number; past the last page,
 *    Decide and Close in the same dispatch.
 *
 * ## Decide (`fase: 'decidindo'`)
 *
 * D = the drift counted over the walk:
 *
 *  - 0 ⇒ `feed-estoque-falhou` resolved ONLY when the stock lease (one by-id
 *    read) shows fewer than `MAX_FALHAS_SEGUIDAS_FEED` failed feeds in a row
 *    and no uncertain `enviando`: while the breaker is open or a feed is
 *    uncertain, patches keep Amazon converged, so a zero drift says nothing
 *    about the feed path;
 *  - the SYSTEMIC guard, catalogue-scale and NOT the switch: `zeroSemLinha` at
 *    least `LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON`, or more than half the
 *    enviável SKUs ⇒ nothing sent, `estoque-deposito-sem-linhas` raised;
 *  - D ≤ 30 ⇒ per drift SKU (`decidirAlvo`): `on` ⇒ one patch task NAMED by
 *    the run (`origem: 'reconciliacao'`, the walk's depósito id), delayed
 *    {@link ATRASO_ENVIO_RECONCILIACAO_S}; `dry-run` ⇒ no task, the line
 *    carries the count and up to {@link MAX_AMOSTRA_DRY_RUN} sample SKUs;
 *  - D ≥ 31 ⇒ `decidirLote`: `feed` and `dry-run` ⇒ the pages walked
 *    PARTITIONED into ⌈pages ÷ {@link MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON}⌉
 *    BLOCK batches ({@link lotesDeBlocosEstoqueAmazon}): batch `k` reads the
 *    run's blocks `[k × cap, min((k + 1) × cap, pages))` — the run's id, the
 *    first block and the count carried IN the payload, so a later run's
 *    reclaim cannot change what a send reads — with its OWN `execucaoId`
 *    (`execucaoIdDoLoteBlocosFeed(conta, run, k)`, its lease holder), one
 *    `feed-enviar` each, named `nomeEnvioFeed(conta, <that id>)`, all delayed
 *    the same 20 minutes and waiting up to {@link ESPERA_LOTE_BLOCOS_MS}
 *    behind a held lease. They serialize through the lease (each waits behind
 *    the one sending); a batch still turned away when its wait ends expires
 *    (`lote-expirado`), and the next daily run re-sends what still differs.
 *    Each extra batch is a feed of its own (its record, poll ladder, report
 *    and write-back), and its end reopens the tick's 15-minute `feed-recente`
 *    lag; each waiting one re-enqueues itself, unnamed, every 300 s with a
 *    lease read (at most 72 times in 6 h) on the jobs queue all feed work
 *    shares at concurrency 1; under an open breaker every batch takes the
 *    lease as a probe (`feeds/vezFeed.ts`). The waiters keep roughly the order
 *    of their first dispatch, so when K feeds outlast the 6-h wait the ranges
 *    that expire can be the same every day (the same `parteInicial` on each
 *    run's `lote-expirado` send lines, the walk's pages being in key order):
 *    re-sending does not converge those, and only a movement the tick sees
 *    corrects their SKUs. A walk of at most the cap's pages is ONE batch,
 *    `parteInicial: 0`. The
 *    canary list ⇒ patch tasks for the canary hits only, delayed the same;
 *    `off` ⇒ nothing. The line's `lotes` counts the batches named,
 *    `lotesJaEnfileirados` those Cloud Tasks already held (a decide run again
 *    after a crash before `enviando` meets every name it enqueued), and `feed`
 *    is `ja-enfileirada` exactly when all of them were already held, else
 *    `enfileirada`.
 *
 * Every send is delayed: an Amazon order counted in Amazon's read but not yet
 * imported would otherwise raise those units back on Amazon; 20 minutes later
 * the order is imported and the recompute at dispatch sees it. Then `fase:
 * 'enviando'` (tier 1), so a re-kicked close does not decide twice.
 *
 * ## Close (`concluida` or `truncada`)
 *
 * The avisos FIRST, EVERY one clocked by `relogioInicio` (the run's first read,
 * so a raise made during the walk — a patch's `INVALID` — is newer and survives
 * the close): `estoque-vinculos-recusados` raised for ≥ 1 refusal a person must
 * fix, resolved by a COMPLETED run that counted none; `estoque-recusado-pela-amazon`
 * raised by a completed run counting ≥ 1 in-drift stored `recusado`, resolved
 * when it counted none (a `recusado` on an in-sync SKU is stale and never
 * counted); `estoque-deposito-sem-linhas` resolved by a completed run under the
 * guard. A TRUNCATED run resolves nothing. Then the end written (tier 1), then
 * a FRESH read of the request document: `pendente` ⇒ Start the next run.
 *
 * ## Units and rule 7
 *
 * Every stamp is MILLISECONDS except `relogioInicio`, a Firestore `Timestamp`
 * stored as read; aviso clocks are converted only in `avisos/avisos.ts`; delays
 * are WHOLE seconds. Every write is ONE document under a native precondition
 * ({@link gravarComPrecondicao}) or the block's overwrite by the page that holds the run; every enqueue
 * is named except the 429 re-enqueue. No transaction, no batch.
 *
 * D11: nothing here calls Amazon but through the evaluator over the context,
 * which refuses while the read switch is off; no write leaves for Amazon here.
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import {
  integracaoCollection,
  pedidoReconciliacaoEstoqueAmazonCollection,
  reconciliacaoEstoqueAmazonCollection,
} from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isGrpcStatusError,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import { AmazonThrottleError } from '@delfrance/integrations-amazon-sp-api';
import {
  CONTA_ID_AMAZON_REGEX,
  type ContagensReconciliacaoEstoqueAmazon,
  ESTADO_VEZ_FEED_AMAZON,
  FASE_RECONCILIACAO_ESTOQUE_AMAZON,
  ID_LOTE_FEED_AMAZON_REGEX,
  INTEGRACAO_TIPO,
  type ItemDivergenciaEstoqueAmazon,
  LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON,
  MOTIVO_CONTA_AMAZON,
  type PedidoReconciliacaoEstoqueAmazon,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  type ReconciliacaoEstoqueAmazon,
  TIPO_LOTE_FEED_AMAZON,
  type TimestampLike,
  pedidoReconciliacaoEstoqueAmazonSchema,
  reconciliacaoEstoqueAmazonSchema,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_ESTOQUE_AMAZON,
  type AcaoAvisoContaEstoqueAmazon,
  type MotivoContaEstoqueAmazon,
  sincronizarAvisoContaEstoqueAmazon,
} from '../avisos/avisos';
import { idDeContaValido, listarContasAmazon } from '../core/contas';
import { type ContextoAmazon, loadAmazonContext } from '../core/contexto';
import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';
import {
  type CampoLogAmazon,
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import {
  FLUXO_AMAZON,
  MODO_AMAZON,
  type ValvulaAmazon,
  decidirAlvo,
  decidirLote,
  lerChaveDeChamadasAmazon,
  lerValvula,
  registrarValvulaAmazon,
} from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import {
  type AgendadorLotesAmazon,
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
  type ResultadoEnfileiramentoLoteAmazon,
} from '../feeds/agendadorLotes';
import type { RegistroLoteAmazon } from '../feeds/incertoFeed';
import { MAX_FALHAS_SEGUIDAS_FEED } from '../feeds/provedorLote';
import {
  ACAO_ADOCAO_FEED,
  type AcaoAdocaoFeedAmazon,
  AmazonRegistroFeedInvalidoError,
  type ResultadoAdocaoFeedAmazon,
  adotarFeedParadoAmazon,
} from '../feeds/resultadoFeed';
import {
  MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaEnviarFeedAmazon,
  type TarefaPaginaReconciliacaoAmazon,
  VERSAO_TAREFA_LOTE_AMAZON,
  execucaoIdDoLoteBlocosFeed,
  nomeEnvioFeed,
  nomePaginaReconciliacao,
  nomeRetomadaReconciliacao,
} from '../feeds/tarefaLote';
import { faseDaVez } from '../feeds/vezFeed';
import { AmazonVezFeedInvalidaError, lerVezFeed } from '../feeds/vezFeedFirestore';
import {
  CAMPOS_VARREDURA_VINCULOS_AMAZON,
  CONTADOR_VARREDURA_VINCULOS_AMAZON,
  PAGINA_VARREDURA_VINCULOS_AMAZON,
  paginaVarreduraVinculosAmazon,
  varreduraVinculosConcluida,
} from '../listings/varreduraVinculos';
import {
  FALHA_LEITURA_AMAZON,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import {
  type AvaliacaoSkuEstoqueAmazon,
  DESFECHO_AVALIACAO_ESTOQUE_AMAZON,
  avaliarSkusEstoqueAmazon,
} from './avaliacaoLoteEstoque';
import {
  gravarBlocoDivergenciaEstoqueAmazon,
  lerBlocosDivergenciaEstoqueAmazon,
} from './divergenciasFirestore';
import {
  depositoIdDaContaEstoqueAmazon,
  depositoIdGravavelDaContaEstoqueAmazon,
  formasRefDepositoEstoqueAmazon,
} from './familiaEstoque';
import { MOTIVO_ESTOQUE_AMAZON } from './motivosEstoque';
import { CAMINHO_LOTE_ESTOQUE_AMAZON, caminhoDoLote } from './planoEstoque';
import type { ProdutorEstoqueAmazon } from './produtorEstoque';
import { CAMPOS_RESOLVER_ESTOQUE_AMAZON } from './resolverEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  VERSAO_TAREFA_ESTOQUE_AMAZON,
} from './tarefaEstoque';

/* -------------------------------------------------------------------------- */
/*                                 The numbers                                */
/* -------------------------------------------------------------------------- */

/** A live run this long without progress has lost its next task: re-kicked (15 min). */
export const RETOMADA_RECONCILIACAO_MS = 900_000;

/** A run in any fase this long without progress is reclaimable by the next Start (2 h). */
export const RECLAMACAO_RECONCILIACAO_MS = 7_200_000;

/** One page's work budget (400 s), inside the jobs queue's 540-s timeout. */
export const ORCAMENTO_PAGINA_RECONCILIACAO_MS = 400_000;

/** The link docs one page reads, over both ref forms: one drift block's bound (the shared walk's). */
export const PAGINA_VARREDURA_ESTOQUE_AMAZON = PAGINA_VARREDURA_VINCULOS_AMAZON;

/** Every reconcile send is delayed 20 minutes after the walk (module header, Decide). */
export const ATRASO_ENVIO_RECONCILIACAO_S = 1_200;

/** How long a block batch turned away by a held lease keeps re-enqueuing itself (6 h). */
export const ESPERA_LOTE_BLOCOS_MS = 21_600_000;

/** The loop guard of the automatic request: one per conta per 24 h. */
export const GUARDA_REEXECUCAO_AUTOMATICA_MS = 86_400_000;

/** A 429 re-enqueues the same page this many WHOLE seconds later. */
export const ESPERA_LIMITE_PAGINA_S = 60;

/** The most SKUs a dry-run decide names in its line. */
export const MAX_AMOSTRA_DRY_RUN = 20;

/** Every write here retries a lost precondition at most this many times in all. */
export const MAX_TENTATIVAS_RECONCILIACAO = 3;

/** The walk's projection (module header, step 2): the SKU is all the walk reads off a doc. */
export const CAMPOS_VARREDURA_VINCULOS_ESTOQUE_AMAZON = CAMPOS_VARREDURA_VINCULOS_AMAZON;

/** The producer label of a reconcile's block batches, on each `feed-enviar`. */
export const ORIGEM_LOTE_RECONCILIACAO_ESTOQUE_AMAZON = 'reconciliacao';

/** One block batch's range of the run's drift blocks: `[parteInicial, parteInicial + partes)`. */
export interface IntervaloLoteBlocosEstoqueAmazon {
  readonly parteInicial: number;
  readonly partes: number;
}

/**
 * The partition of a walk's `paginas` drift blocks into block batches (module
 * header, Decide): ⌈paginas ÷ {@link MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON}⌉
 * consecutive ranges, batch `k` from `k × cap` to `min((k + 1) × cap,
 * paginas)` — no gap, no overlap, every one but the last exactly the cap.
 *
 * @throws {RangeError} `paginas` that is not a positive safe integer (a decide
 *   of 31+ drift SKUs walked at least one page).
 */
export function lotesDeBlocosEstoqueAmazon(
  paginas: number,
): readonly IntervaloLoteBlocosEstoqueAmazon[] {
  if (!Number.isSafeInteger(paginas) || paginas < 1) {
    throw new RangeError('reconciliacaoEstoque.ts: paginas deve ser um inteiro seguro >= 1');
  }
  const cap = MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON;
  const lotes = Math.ceil(paginas / cap);
  return Array.from({ length: lotes }, (_v, k) => ({
    parteInicial: k * cap,
    partes: Math.min((k + 1) * cap, paginas) - k * cap,
  }));
}

/** The `fase` of every line here. */
export const FASE_RECONCILIACAO_LOG = 'reconciliacao';

/** Who asked for a run. */
export const ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON = {
  /** The tick: a window too large or truncated to send as a delta, or one it could not map. */
  tick: 'tick',
  /** A recovery delta whose window is too large, after a completed feed. */
  recuperacao: 'recuperacao',
  /** A window feed's re-derivation that found its window too large. */
  feed: 'feed',
  /** A failed feed's drift: the loop-guarded request. */
  automatica: 'automatica',
  /** The conta's depósito changed while a run walked. */
  depositoMudou: 'deposito-mudou',
} as const;
export type OrigemPedidoReconciliacaoEstoqueAmazon =
  (typeof ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON)[keyof typeof ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON];

/** The walk's own counter keys, besides the stock vocabulary's (the shared page core's). */
export const CONTADOR_VARREDURA_ESTOQUE_AMAZON = {
  /** A link doc whose `sku` is not a non-empty string: nothing to evaluate. */
  semSku: CONTADOR_VARREDURA_VINCULOS_AMAZON.semSku,
  /** A link doc that is not `produtos/<id>/prodAmazon/<id>`: no produto owns it. */
  foraDeProduto: CONTADOR_VARREDURA_VINCULOS_AMAZON.foraDeProduto,
} as const;

/* -------------------------------------------------------------------------- */
/*                                  Contract                                  */
/* -------------------------------------------------------------------------- */

/** What Request and Start need — bound by each caller's root, doubles in the tests. */
export interface DepsReconciliacaoEstoqueAmazon {
  /** Now, in MILLISECONDS. Read per decision, never captured. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** The jobs queue's producer — built only when a page is enqueued. */
  readonly agendador: () => AgendadorLotesAmazon;
  /** A fresh run id (the id grammar of the stock documents). */
  readonly gerarExecucaoId: () => string;
}

/** What one page needs besides — bound by the jobs root. */
export interface DepsPaginaReconciliacaoEstoqueAmazon extends DepsReconciliacaoEstoqueAmazon {
  /** The process environment: the read switch, the LWA pair, the stock valve and canary. */
  readonly ambiente: AmbienteAmazon;
  /** The stock queue's producer — built only when a patch task is enqueued. */
  readonly produtorEstoque: () => ProdutorEstoqueAmazon;
  readonly registro: RegistroLoteAmazon;
  /** REQUIRED, never the global: the context's client and its refresh take it. */
  readonly fetch: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
  /** A sleep of `ms` milliseconds: the evaluator's pacing between two Amazon calls. */
  readonly esperar: (ms: number) => Promise<void>;
}

/**
 * A stored run or request no longer parses: only a hand edit makes one (every
 * write here goes through the schema). Nothing is written for that conta until
 * a person fixes it; its caller contains it per conta.
 */
export class ReconciliacaoEstoqueDocumentoInvalidoError extends Error {
  readonly contaId: string;
  readonly documento: 'reconciliacao' | 'pedido';
  /** The top-level field names Zod blamed — never a value. */
  readonly campos: readonly string[];

  constructor(contaId: string, documento: 'reconciliacao' | 'pedido', campos: readonly string[]) {
    super(
      `O documento de ${documento} da reconciliação de estoque da conta ${contaId} não é válido (campos: ${campos.join(', ')}).`,
    );
    this.name = 'ReconciliacaoEstoqueDocumentoInvalidoError';
    this.contaId = contaId;
    this.documento = documento;
    this.campos = campos;
  }
}

/** A write kept losing its precondition (module header): the caller's retry re-derives. */
export class ReconciliacaoEstoqueEmConflitoError extends Error {
  readonly contaId: string;

  constructor(contaId: string) {
    super(
      `A reconciliação de estoque da conta ${contaId} perdeu a precondição ${String(MAX_TENTATIVAS_RECONCILIACAO)} vezes.`,
    );
    this.name = 'ReconciliacaoEstoqueEmConflitoError';
    this.contaId = contaId;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  The reads                                 */
/* -------------------------------------------------------------------------- */

/** One read of a document of this module: its state, its commit and the read's time. */
export interface LeituraReconciliacaoEstoqueAmazon<T> {
  /** The parsed document; `null` when it does not exist. */
  readonly estado: T | null;
  /** The commit stamp: the precondition of a write decided on this read. */
  readonly updateTime: Timestamp | null;
  /** The read's own time. */
  readonly readTime: Timestamp;
}

/** An existing snapshot's commit stamp (the Admin SDK sets it on every existing document). */
function commitDe(snap: DocumentSnapshot): Timestamp {
  const { updateTime } = snap;
  if (updateTime === undefined) {
    throw new TypeError('reconciliacaoEstoque.ts: documento existente sem updateTime');
  }
  return updateTime;
}

/** The top-level fields a failed parse blamed, sorted: never a value. */
function camposDoErro(issues: readonly { readonly path: readonly PropertyKey[] }[]): string[] {
  return [...new Set(issues.map((i) => String(i.path[0] ?? '(raiz)')))].sort();
}

/**
 * A snapshot of `reconciliacaoEstoqueAmazon/{contaId}`, strictly parsed — for
 * this module, and for the tick, which reads the run in its own `getAll`.
 *
 * @throws {ReconciliacaoEstoqueDocumentoInvalidoError} a run that no longer parses.
 */
export function lerReconciliacaoDoSnapshot(
  snap: DocumentSnapshot,
  contaId: string,
): LeituraReconciliacaoEstoqueAmazon<ReconciliacaoEstoqueAmazon> {
  if (!snap.exists) return { estado: null, updateTime: null, readTime: snap.readTime };
  const lido = reconciliacaoEstoqueAmazonSchema.safeParse(snap.data());
  if (!lido.success) {
    throw new ReconciliacaoEstoqueDocumentoInvalidoError(
      contaId,
      'reconciliacao',
      camposDoErro(lido.error.issues),
    );
  }
  return { estado: lido.data, updateTime: commitDe(snap), readTime: snap.readTime };
}

/**
 * The run document's reference — for this module, and for the tick, which reads
 * the run in its own `getAll` (parsed by {@link lerReconciliacaoDoSnapshot});
 * every write of the run stays here.
 */
export function refReconciliacaoEstoqueAmazon(db: Firestore, contaId: string): DocumentReference {
  return reconciliacaoEstoqueAmazonCollection.docRef(db, {}, contaId);
}

function refDoPedido(db: Firestore, contaId: string): DocumentReference {
  return pedidoReconciliacaoEstoqueAmazonCollection.docRef(db, {}, contaId);
}

async function lerRun(
  db: Firestore,
  contaId: string,
): Promise<LeituraReconciliacaoEstoqueAmazon<ReconciliacaoEstoqueAmazon>> {
  return lerReconciliacaoDoSnapshot(
    await refReconciliacaoEstoqueAmazon(db, contaId).get(),
    contaId,
  );
}

async function lerPedido(
  db: Firestore,
  contaId: string,
): Promise<LeituraReconciliacaoEstoqueAmazon<PedidoReconciliacaoEstoqueAmazon>> {
  const snap = await refDoPedido(db, contaId).get();
  if (!snap.exists) return { estado: null, updateTime: null, readTime: snap.readTime };
  const lido = pedidoReconciliacaoEstoqueAmazonSchema.safeParse(snap.data());
  if (!lido.success) {
    throw new ReconciliacaoEstoqueDocumentoInvalidoError(
      contaId,
      'pedido',
      camposDoErro(lido.error.issues),
    );
  }
  return { estado: lido.data, updateTime: commitDe(snap), readTime: snap.readTime };
}

/**
 * THE write of this module (rule 7 tier 1): `create` when the read found no
 * document, else `update(dados, { lastUpdateTime })` on the read's commit. The
 * new commit, or `null` when the precondition was lost (ALREADY_EXISTS,
 * FAILED_PRECONDITION or NOT_FOUND): the caller re-reads and re-decides.
 */
async function gravarComPrecondicao(
  ref: DocumentReference,
  updateTime: Timestamp | null,
  dados: Record<string, unknown>,
): Promise<Timestamp | null> {
  try {
    const { writeTime } =
      updateTime === null
        ? await ref.create(dados)
        : await ref.update(dados, { lastUpdateTime: updateTime });
    return writeTime;
  } catch (err) {
    if (isAlreadyExists(err) || isFailedPrecondition(err) || isNotFound(err)) return null;
    throw err;
  }
}

/** A run as this module holds it after a write: its state and its commit. */
interface RunEscrito {
  readonly estado: ReconciliacaoEstoqueAmazon;
  readonly updateTime: Timestamp;
}

/**
 * A field patch of THIS run, tier 1 on `inicial`, re-derived from a fresh read on
 * a lost precondition while `dono` still holds (module header): the patch is a
 * function of the state it lands on, never a captured value.
 *
 * @returns the run after the write, or `null` once `dono` no longer holds.
 * @throws {ReconciliacaoEstoqueEmConflitoError} after three lost preconditions.
 */
async function atualizarRun(
  db: Firestore,
  contaId: string,
  inicial: RunEscrito,
  dono: (estado: ReconciliacaoEstoqueAmazon) => boolean,
  patch: (estado: ReconciliacaoEstoqueAmazon) => Record<string, unknown>,
): Promise<RunEscrito | null> {
  let atual: {
    readonly estado: ReconciliacaoEstoqueAmazon | null;
    readonly updateTime: Timestamp | null;
  } = inicial;
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_RECONCILIACAO; tentativa += 1) {
    if (atual.estado === null || atual.updateTime === null || !dono(atual.estado)) return null;
    const dados = reconciliacaoEstoqueAmazonCollection.parseMerge(patch(atual.estado));
    const escrito = await gravarComPrecondicao(
      refReconciliacaoEstoqueAmazon(db, contaId),
      atual.updateTime,
      dados,
    );
    if (escrito !== null) return { estado: { ...atual.estado, ...dados }, updateTime: escrito };
    atual = await lerRun(db, contaId);
  }
  throw new ReconciliacaoEstoqueEmConflitoError(contaId);
}

/* -------------------------------------------------------------------------- */
/*                                   Logging                                  */
/* -------------------------------------------------------------------------- */

function registrar(
  logger: LoggerAmazon,
  contaId: string,
  severidade: SeveridadeAmazon,
  mensagem: string,
  campos: CamposLogAmazon,
  registro: RegistroLoteAmazon | null = null,
): void {
  registrarEventoAmazon(
    logger,
    'estoque',
    severidade,
    mensagem,
    { fase: FASE_RECONCILIACAO_LOG, ...campos },
    {
      conta: contaId,
      fluxo: FLUXO_AMAZON.estoque,
      ...(registro === null ? {} : { tentativa: registro.tentativa, idTarefa: registro.idTarefa }),
    },
  );
}

/** A conta id under its grammar, or a `RangeError` naming the rule (never the value). */
function exigirConta(contaId: string): void {
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('reconciliacaoEstoque.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
}

/** Whether a fase ends the run. */
function terminal(fase: ReconciliacaoEstoqueAmazon['fase']): boolean {
  return (
    fase === FASE_RECONCILIACAO_ESTOQUE_AMAZON.concluida ||
    fase === FASE_RECONCILIACAO_ESTOQUE_AMAZON.truncada
  );
}

/** The run's last progress stamp (ms): the page's, else the claim's. */
function marcoDoRun(run: ReconciliacaoEstoqueAmazon): number {
  return run.progressoEmMs ?? run.iniciadaEmMs;
}

/** A page's payload. */
function tarefaDaPagina(
  contaId: string,
  execucaoId: string,
  pagina: number,
): TarefaPaginaReconciliacaoAmazon {
  return {
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.reconciliacao,
    contaId,
    execucaoId,
    pagina,
  };
}

/* -------------------------------------------------------------------------- */
/*                         The re-kick and Start's decision                    */
/* -------------------------------------------------------------------------- */

/** Where a live run that lost its next task resumes: its page, and the stall's stamp. */
export interface RetomadaReconciliacaoEstoqueAmazon {
  readonly pagina: number;
  /** ms — the run's last progress: the stall's identity in the re-kick's name. */
  readonly marcoMs: number;
}

/**
 * Whether a run needs its re-kick at `agoraMs` (module header, Start): a LIVE
 * run more than {@link RETOMADA_RECONCILIACAO_MS} without progress. Pure.
 */
export function decidirRetomadaReconciliacaoEstoqueAmazon(
  run: ReconciliacaoEstoqueAmazon | null,
  agoraMs: number,
): RetomadaReconciliacaoEstoqueAmazon | null {
  if (run === null || terminal(run.fase)) return null;
  const marcoMs = marcoDoRun(run);
  if (agoraMs - marcoMs <= RETOMADA_RECONCILIACAO_MS) return null;
  return { pagina: run.proximaPagina, marcoMs };
}

/** What Start does with the run it read (module header). */
export type DecisaoInicioReconciliacaoEstoqueAmazon =
  | { readonly tipo: 'criar' }
  | { readonly tipo: 'reclamar' }
  | ({ readonly tipo: 'retomar' } & RetomadaReconciliacaoEstoqueAmazon)
  | { readonly tipo: 'em-execucao' };

/** Start's decision (module header). Pure. */
export function decidirInicioReconciliacaoEstoqueAmazon(
  run: ReconciliacaoEstoqueAmazon | null,
  agoraMs: number,
): DecisaoInicioReconciliacaoEstoqueAmazon {
  if (run === null) return { tipo: 'criar' };
  if (terminal(run.fase)) return { tipo: 'reclamar' };
  if (agoraMs - marcoDoRun(run) > RECLAMACAO_RECONCILIACAO_MS) return { tipo: 'reclamar' };
  const retomada = decidirRetomadaReconciliacaoEstoqueAmazon(run, agoraMs);
  return retomada === null ? { tipo: 'em-execucao' } : { tipo: 'retomar', ...retomada };
}

/** What the re-kick did. */
export type ResultadoRetomadaReconciliacaoEstoqueAmazon = 'retomada' | 'ja-retomada' | null;

/**
 * The re-kick (module header, Start), for a run its caller ALREADY read (the
 * tick reads it in its own `getAll`): page `proximaPagina` enqueued NAMED by
 * the stall, or `null` when the run needs none.
 */
export async function retomarReconciliacaoEstoqueAmazon(
  contaId: string,
  run: ReconciliacaoEstoqueAmazon | null,
  deps: Pick<DepsReconciliacaoEstoqueAmazon, 'agora' | 'agendador'>,
): Promise<ResultadoRetomadaReconciliacaoEstoqueAmazon> {
  exigirConta(contaId);
  const retomada = decidirRetomadaReconciliacaoEstoqueAmazon(run, deps.agora());
  if (run === null || retomada === null) return null;
  return enfileirarRetomada(contaId, run.execucaoId, retomada, deps);
}

/** The re-kick's ONE enqueue: page `pagina`, NAMED by the stall. */
async function enfileirarRetomada(
  contaId: string,
  execucaoId: string,
  retomada: RetomadaReconciliacaoEstoqueAmazon,
  deps: Pick<DepsReconciliacaoEstoqueAmazon, 'agendador'>,
): Promise<'retomada' | 'ja-retomada'> {
  const r = await deps
    .agendador()
    .enfileirarLote(tarefaDaPagina(contaId, execucaoId, retomada.pagina), {
      nome: nomeRetomadaReconciliacao(contaId, execucaoId, retomada.pagina, retomada.marcoMs),
    });
  return r === 'ja-enfileirada' ? 'ja-retomada' : 'retomada';
}

/* -------------------------------------------------------------------------- */
/*                                    Start                                   */
/* -------------------------------------------------------------------------- */

/** What one Start did. */
export type ResultadoInicioReconciliacaoEstoqueAmazon =
  | { readonly acao: 'iniciada'; readonly execucaoId: string }
  | {
      readonly acao: 'retomada' | 'ja-retomada';
      readonly execucaoId: string;
      readonly pagina: number;
    }
  | { readonly acao: 'em-execucao'; readonly execucaoId: string }
  | { readonly acao: 'conta-indisponivel' | 'sem-deposito' };

/**
 * Start (module header): claim a run, re-kick a stalled one, or leave a live
 * one alone. Its caller gates the read switch and the stock valve.
 *
 * @throws {ReconciliacaoEstoqueDocumentoInvalidoError} a stored run or request
 *   that no longer parses (nothing written).
 * @throws {ReconciliacaoEstoqueEmConflitoError} three lost claims in a row.
 * @throws the jobs producer's and Firestore's own failures, untouched.
 */
export async function iniciarReconciliacaoEstoqueAmazon(
  db: Firestore,
  contaId: string,
  deps: DepsReconciliacaoEstoqueAmazon,
): Promise<ResultadoInicioReconciliacaoEstoqueAmazon> {
  exigirConta(contaId);
  const r = await iniciar(db, contaId, deps);
  registrar(
    deps.logger,
    contaId,
    r.acao === 'conta-indisponivel' || r.acao === 'sem-deposito' ? 'WARNING' : 'INFO',
    `[amazon/estoque] reconciliação: início (${r.acao})`,
    {
      etapa: 'inicio',
      acao: r.acao,
      execucaoId: 'execucaoId' in r ? r.execucaoId : null,
      pagina: 'pagina' in r ? r.pagina : null,
    },
  );
  return r;
}

async function iniciar(
  db: Firestore,
  contaId: string,
  deps: DepsReconciliacaoEstoqueAmazon,
): Promise<ResultadoInicioReconciliacaoEstoqueAmazon> {
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_RECONCILIACAO; tentativa += 1) {
    const lida = await lerRun(db, contaId);
    const agoraMs = deps.agora();
    const decisao = decidirInicioReconciliacaoEstoqueAmazon(lida.estado, agoraMs);
    if (decisao.tipo === 'em-execucao' && lida.estado !== null) {
      return { acao: 'em-execucao', execucaoId: lida.estado.execucaoId };
    }
    if (decisao.tipo === 'retomar' && lida.estado !== null) {
      const r = await enfileirarRetomada(contaId, lida.estado.execucaoId, decisao, deps);
      return { acao: r, execucaoId: lida.estado.execucaoId, pagina: decisao.pagina };
    }

    // A claim: the conta, RAW and uncached, and its depósito through the storable parse.
    const snapConta = await integracaoCollection.docRef(db, {}, contaId).get();
    const conta = snapConta.exists ? ((snapConta.data() ?? {}) as Record<string, unknown>) : null;
    if (conta === null || conta.tipo !== INTEGRACAO_TIPO.amazon || conta.ativo === false) {
      return { acao: 'conta-indisponivel' };
    }
    const depositoId = depositoIdGravavelDaContaEstoqueAmazon(conta.depositoOuterRef);
    if (depositoId === null) return { acao: 'sem-deposito' };
    const execucaoId = deps.gerarExecucaoId();
    if (!ID_LOTE_FEED_AMAZON_REGEX.test(execucaoId)) {
      throw new RangeError('reconciliacaoEstoque.ts: execucaoId gerado fora da gramática');
    }
    const [depositoOuterRef] = formasRefDepositoEstoqueAmazon(depositoId);
    const novo = reconciliacaoEstoqueAmazonCollection.parse({
      execucaoId,
      fase: FASE_RECONCILIACAO_ESTOQUE_AMAZON.varrendo,
      depositoOuterRef,
      iniciadaEmMs: agoraMs,
    });
    // `update` of EVERY field replaces the ended run whole (the maps included).
    const escrito = await gravarComPrecondicao(
      refReconciliacaoEstoqueAmazon(db, contaId),
      lida.updateTime,
      novo,
    );
    if (escrito === null) continue;
    await limparPendente(db, contaId);
    await deps.agendador().enfileirarLote(tarefaDaPagina(contaId, execucaoId, 0), {
      nome: nomePaginaReconciliacao(contaId, execucaoId, 0),
    });
    return { acao: 'iniciada', execucaoId };
  }
  throw new ReconciliacaoEstoqueEmConflitoError(contaId);
}

/** The request's `pendente` cleared after a claim (tier 1, re-derived on a lost precondition). */
async function limparPendente(db: Firestore, contaId: string): Promise<void> {
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_RECONCILIACAO; tentativa += 1) {
    const lido = await lerPedido(db, contaId);
    if (lido.estado === null || lido.updateTime === null || !lido.estado.pendente) return;
    const dados = pedidoReconciliacaoEstoqueAmazonCollection.parseMerge({ pendente: false });
    if ((await gravarComPrecondicao(refDoPedido(db, contaId), lido.updateTime, dados)) !== null) {
      return;
    }
  }
  throw new ReconciliacaoEstoqueEmConflitoError(contaId);
}

/* -------------------------------------------------------------------------- */
/*                                   Request                                  */
/* -------------------------------------------------------------------------- */

/** What one request did. */
export type ResultadoPedidoReconciliacaoEstoqueAmazon =
  | { readonly acao: 'pedido'; readonly inicio: ResultadoInicioReconciliacaoEstoqueAmazon }
  | { readonly acao: 'automatica-recusada' };

/**
 * What {@link registrarPedido} did: the request written; an automatic one the
 * guard kept from stamping while a request is ALREADY pending (its Start is
 * still owed); or the automatic one refused.
 */
type PedidoRegistrado = 'registrado' | 'ja-pendente' | 'automatica-recusada';

/**
 * The request alone (module header, Request): written, or — for an automatic
 * one inside its 24-h guard — no new stamp. The guard refuses a new automatic
 * RE-RUN, never the Start a pending request is owed: a first attempt that wrote
 * its request and failed before Start's claim meets its own stamp on the
 * queue's retry, and must still start (`ja-pendente`). With nothing pending it
 * is refused, the `feed-estoque-falhou` aviso raised, clocked by the request
 * read.
 */
async function registrarPedido(
  db: Firestore,
  contaId: string,
  origem: OrigemPedidoReconciliacaoEstoqueAmazon,
  deps: DepsReconciliacaoEstoqueAmazon,
): Promise<PedidoRegistrado> {
  const automatica = origem === ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.automatica;
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_RECONCILIACAO; tentativa += 1) {
    const lido = await lerPedido(db, contaId);
    const agoraMs = deps.agora();
    const ultima = lido.estado?.reexecucaoAutomaticaEmMs ?? null;
    if (automatica && ultima !== null && agoraMs - ultima < GUARDA_REEXECUCAO_AUTOMATICA_MS) {
      if (lido.estado?.pendente === true) return 'ja-pendente';
      await avisar(
        db,
        deps,
        contaId,
        MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
        ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
        lido.readTime,
      );
      return 'automatica-recusada';
    }
    const patch: Record<string, unknown> = {
      pendente: true,
      pedidoEmMs: agoraMs,
      ...(automatica ? { reexecucaoAutomaticaEmMs: agoraMs } : {}),
    };
    const dados =
      lido.updateTime === null
        ? pedidoReconciliacaoEstoqueAmazonCollection.parse(patch)
        : pedidoReconciliacaoEstoqueAmazonCollection.parseMerge(patch);
    if ((await gravarComPrecondicao(refDoPedido(db, contaId), lido.updateTime, dados)) !== null) {
      return 'registrado';
    }
  }
  throw new ReconciliacaoEstoqueEmConflitoError(contaId);
}

/**
 * Request (module header): the request written on its own document, then
 * Start. Its caller gates the read switch and the stock valve.
 *
 * @throws {ReconciliacaoEstoqueDocumentoInvalidoError} a stored request or run
 *   that no longer parses.
 * @throws {ReconciliacaoEstoqueEmConflitoError} three lost preconditions.
 * @throws Firestore's, the avisos' and the jobs producer's own failures.
 */
export async function solicitarReconciliacaoEstoqueAmazon(
  db: Firestore,
  contaId: string,
  origem: OrigemPedidoReconciliacaoEstoqueAmazon,
  deps: DepsReconciliacaoEstoqueAmazon,
): Promise<ResultadoPedidoReconciliacaoEstoqueAmazon> {
  exigirConta(contaId);
  const registrado = await registrarPedido(db, contaId, origem, deps);
  if (registrado === 'automatica-recusada') {
    registrar(
      deps.logger,
      contaId,
      'WARNING',
      '[amazon/estoque] reconciliação: pedido automático recusado (uma por dia)',
      { etapa: 'pedido', origem, acao: registrado },
    );
    return { acao: 'automatica-recusada' };
  }
  const inicio = await iniciarReconciliacaoEstoqueAmazon(db, contaId, deps);
  registrar(deps.logger, contaId, 'INFO', '[amazon/estoque] reconciliação: pedido registrado', {
    etapa: 'pedido',
    origem,
    acao: 'pedido',
    pedido: registrado,
    inicio: inicio.acao,
  });
  return { acao: 'pedido', inicio };
}

/* -------------------------------------------------------------------------- */
/*                        The daily run (the scheduler)                        */
/* -------------------------------------------------------------------------- */

/**
 * A rejection of the JOBS producer a caller CONTAINS, by class (root rule 6),
 * named as its line names it: the queue valve, a malformed or missing queue
 * region, a named transient, a raw Cloud Tasks failure. `null` for anything
 * else, which the caller rethrows. Shared by the daily run and the tick.
 */
export function falhaDeEnfileiramentoLoteContida(err: unknown): string | null {
  if (
    err instanceof AmazonLotesTarefasDesligadasError ||
    err instanceof AmazonLotesRegiaoDaFilaInvalidaError ||
    err instanceof AmazonTarefasTransitoriasError ||
    err instanceof MissingRegionError
  ) {
    return err.name;
  }
  if (ehFalhaDoSdkDeTarefasAmazon(err)) return descreverFalhaDoSdkDeTarefasAmazon(err);
  return null;
}

/** Why a whole daily run did nothing: the read switch, or the stock valve. */
export const PORTAO_RECONCILIACAO_DIARIA = {
  chamadasDesligadas: 'chamadas-desligadas',
  valvulaDesligada: 'valvula-desligada',
} as const;
export type PortaoReconciliacaoDiaria =
  (typeof PORTAO_RECONCILIACAO_DIARIA)[keyof typeof PORTAO_RECONCILIACAO_DIARIA];

/** How one conta's daily run ended (closed). */
export const DESFECHO_RECONCILIACAO_DIARIA = {
  /** The feed backstop and Start ran (each answer on the line). */
  feito: 'feito',
  /** The conta id is outside the conta id grammar: nothing read. */
  idDeContaInvalido: 'id-de-conta-invalido',
  /** A Firestore status error, contained for this conta. */
  erroFirestore: 'erro-firestore',
  /** A stored run, request, lease or feed record no longer parses: nothing written. */
  documentoInvalido: 'documento-invalido',
  /** A tier-1 write kept losing its precondition: the next daily run re-derives. */
  conflito: 'conflito',
  /** The jobs producer refused an enqueue (a named class). */
  enfileiramentoFalhou: 'enfileiramento-falhou',
} as const;
export type DesfechoReconciliacaoDiaria =
  (typeof DESFECHO_RECONCILIACAO_DIARIA)[keyof typeof DESFECHO_RECONCILIACAO_DIARIA];

/** What the daily scheduler needs — bound by `functions/src/reconciliacaoEstoque.ts`. */
export interface DepsReconciliacaoDiariaEstoqueAmazon extends DepsReconciliacaoEstoqueAmazon {
  readonly db: Firestore;
  /** The process environment: the read switch and the stock valve, read before any Firestore read. */
  readonly ambiente: AmbienteAmazon;
}

/** The feed backstop failed with a contained class: Start still runs. */
export const ADOCAO_FALHOU = 'falhou';

/** One conta's daily run (logged ONCE). */
export interface ResultadoContaReconciliacaoDiaria {
  readonly contaId: string;
  /** Start's outcome: the backstop's own failure never decides it (`adocao`). */
  readonly desfecho: DesfechoReconciliacaoDiaria;
  /** The feed backstop's answer, when it ran; {@link ADOCAO_FALHOU} when it failed contained. */
  readonly adocao: AcaoAdocaoFeedAmazon | typeof ADOCAO_FALHOU | null;
  /** The backstop's contained failure: its CLASS and gRPC code — never its message. */
  readonly erroAdocao: string | null;
  readonly codigoGrpcAdocao: number | null;
  /** The feed record the backstop re-created from the lease, if it did. */
  readonly registro: ResultadoAdocaoFeedAmazon['registro'];
  /** Start's answer, when it ran. */
  readonly inicio: ResultadoInicioReconciliacaoEstoqueAmazon['acao'] | null;
  /** A contained failure's CLASS — never its message. */
  readonly erro: string | null;
  readonly codigoGrpc: number | null;
}

export interface ResultadoReconciliacaoDiaria {
  /** Why the run did nothing at all; `null` when it walked the contas. */
  readonly portao: PortaoReconciliacaoDiaria | null;
  readonly contas: readonly ResultadoContaReconciliacaoDiaria[];
}

/**
 * A failure of one conta's daily run that is CONTAINED (root rule 6), as its
 * line names it; `null` for anything else (a bug), which fails the run.
 */
function falhaDiariaContida(
  err: unknown,
): Pick<ResultadoContaReconciliacaoDiaria, 'desfecho' | 'erro' | 'codigoGrpc'> | null {
  if (isGrpcStatusError(err)) {
    return {
      desfecho: DESFECHO_RECONCILIACAO_DIARIA.erroFirestore,
      erro: err.name,
      codigoGrpc: err.code,
    };
  }
  if (
    err instanceof ReconciliacaoEstoqueDocumentoInvalidoError ||
    err instanceof AmazonVezFeedInvalidaError ||
    err instanceof AmazonRegistroFeedInvalidoError
  ) {
    return {
      desfecho: DESFECHO_RECONCILIACAO_DIARIA.documentoInvalido,
      erro: err.name,
      codigoGrpc: null,
    };
  }
  if (err instanceof ReconciliacaoEstoqueEmConflitoError) {
    return { desfecho: DESFECHO_RECONCILIACAO_DIARIA.conflito, erro: err.name, codigoGrpc: null };
  }
  const classe = falhaDeEnfileiramentoLoteContida(err);
  if (classe === null) return null;
  return {
    desfecho: DESFECHO_RECONCILIACAO_DIARIA.enfileiramentoFalhou,
    erro: classe,
    codigoGrpc: null,
  };
}

/**
 * One conta of the daily run: the feed backstop, then Start, each contained ON
 * ITS OWN — the two share nothing, so a backstop that cannot read its lease or
 * its record (a hand-edited one fails every day) never costs the conta its
 * reconcile.
 */
async function contaDaReconciliacaoDiaria(
  contaId: string,
  deps: DepsReconciliacaoDiariaEstoqueAmazon,
): Promise<ResultadoContaReconciliacaoDiaria> {
  let adocao: Pick<ResultadoContaReconciliacaoDiaria, 'adocao' | 'registro'> = {
    adocao: null,
    registro: null,
  };
  let falhaAdocao: {
    readonly erroAdocao: string | null;
    readonly codigoGrpcAdocao: number | null;
  } = { erroAdocao: null, codigoGrpcAdocao: null };
  try {
    const r = await adotarFeedParadoAmazon(
      deps.db,
      { fluxo: FLUXO_AMAZON.estoque, contaId },
      { agora: deps.agora, agendador: deps.agendador },
    );
    adocao = { adocao: r.acao, registro: r.registro };
  } catch (err) {
    const contida = falhaDiariaContida(err);
    if (contida === null) throw err;
    adocao = { adocao: ADOCAO_FALHOU, registro: null };
    falhaAdocao = { erroAdocao: contida.erro, codigoGrpcAdocao: contida.codigoGrpc };
  }
  try {
    const inicio = await iniciarReconciliacaoEstoqueAmazon(deps.db, contaId, deps);
    return {
      contaId,
      desfecho: DESFECHO_RECONCILIACAO_DIARIA.feito,
      ...adocao,
      ...falhaAdocao,
      inicio: inicio.acao,
      erro: null,
      codigoGrpc: null,
    };
  } catch (err) {
    const contida = falhaDiariaContida(err);
    if (contida === null) throw err;
    return { contaId, ...contida, ...adocao, ...falhaAdocao, inicio: null };
  }
}

/**
 * The DAILY run (`reconcileAmazonStock`, 03:44): the read switch not exactly
 * `on`, or the stock valve `off` ⇒ ONE INFO line and ZERO Firestore
 * operations. Otherwise the Amazon contas, listed UNCACHED; per active conta
 * (one after another), the stock feed's daily backstop
 * (`adotarFeedParadoAmazon`: a submitted feed whose record has not moved for
 * six hours is re-adopted) and then Start ({@link iniciarReconciliacaoEstoqueAmazon}:
 * claim a run, re-kick a stalled one, or leave a live one alone). ONE line per
 * conta (`etapa: 'agenda'`); Start writes its own. A Firestore status error, a
 * stored document that no longer parses, a write that kept losing its
 * precondition and a named failure of the jobs producer are contained PER
 * CONTA, and per STEP: a failed backstop (`adocao: 'falhou'`, WARNING) still
 * leaves Start to run; anything else fails the run. Running the scheduler job by hand is the
 * operator's "send all": the walk re-reads every SKU and sends what drifted.
 */
export async function executarReconciliacaoDiariaEstoqueAmazon(
  deps: DepsReconciliacaoDiariaEstoqueAmazon,
): Promise<ResultadoReconciliacaoDiaria> {
  const chamadas = lerChaveDeChamadasAmazon(deps.ambiente);
  const valvula = lerValvula(FLUXO_AMAZON.estoque, deps.ambiente);
  const portao = !chamadas
    ? PORTAO_RECONCILIACAO_DIARIA.chamadasDesligadas
    : valvula.modo === MODO_AMAZON.off
      ? PORTAO_RECONCILIACAO_DIARIA.valvulaDesligada
      : null;
  if (portao !== null) {
    registrarEventoAmazon(
      deps.logger,
      'estoque',
      'INFO',
      `[amazon/estoque] reconciliação diária: ${portao} — nada lido`,
      { fase: FASE_RECONCILIACAO_LOG, etapa: 'agenda', portao, valvula: valvula.modo },
      { conta: null, fluxo: FLUXO_AMAZON.estoque },
    );
    return { portao, contas: [] };
  }

  const { contas } = await listarContasAmazon(deps.db);
  const resultados: ResultadoContaReconciliacaoDiaria[] = [];
  for (const conta of contas) {
    if (!conta.ativo) continue;
    const contaId = conta.integracaoId;
    const r = idDeContaValido(contaId)
      ? await contaDaReconciliacaoDiaria(contaId, deps)
      : {
          contaId,
          desfecho: DESFECHO_RECONCILIACAO_DIARIA.idDeContaInvalido,
          adocao: null,
          erroAdocao: null,
          codigoGrpcAdocao: null,
          registro: null,
          inicio: null,
          erro: null,
          codigoGrpc: null,
        };
    resultados.push(r);
    registrar(
      deps.logger,
      contaId,
      r.desfecho === DESFECHO_RECONCILIACAO_DIARIA.feito && r.adocao !== ADOCAO_FALHOU
        ? 'INFO'
        : 'WARNING',
      `[amazon/estoque] reconciliação diária da conta: ${r.desfecho}`,
      {
        etapa: 'agenda',
        desfecho: r.desfecho,
        adocao: r.adocao,
        erroAdocao: r.erroAdocao,
        codigoGrpcAdocao: r.codigoGrpcAdocao,
        registro: r.registro,
        inicio: r.inicio,
        erro: r.erro,
        codigoGrpc: r.codigoGrpc,
      },
    );
  }
  return { portao: null, contas: resultados };
}

/**
 * The daily run's counters, FLAT, for the root's summary line: the contas by
 * outcome (`desfecho_<nome>`), the runs started and the feeds adopted.
 */
export function resumirReconciliacaoDiariaEstoqueAmazon(
  r: ResultadoReconciliacaoDiaria,
): Readonly<Record<string, CampoLogAmazon>> {
  const saida: Record<string, CampoLogAmazon> = {
    fase: FASE_RECONCILIACAO_LOG,
    etapa: 'agenda',
    portao: r.portao,
    contas: r.contas.length,
  };
  let iniciadas = 0;
  let adotadas = 0;
  for (const c of r.contas) {
    const chave = `desfecho_${c.desfecho}`;
    const atual = saida[chave];
    saida[chave] = (typeof atual === 'number' ? atual : 0) + 1;
    if (c.inicio === 'iniciada') iniciadas += 1;
    if (c.adocao === ACAO_ADOCAO_FEED.adotada) adotadas += 1;
  }
  saida.iniciadas = iniciadas;
  saida.adotadas = adotadas;
  return saida;
}

/* -------------------------------------------------------------------------- */
/*                                   Avisos                                   */
/* -------------------------------------------------------------------------- */

/** One stock aviso of the conta, clocked by `relogio` (a Firestore read time). */
async function avisar(
  db: Firestore,
  deps: Pick<DepsReconciliacaoEstoqueAmazon, 'agora' | 'increment' | 'logger'>,
  contaId: string,
  motivo: MotivoContaEstoqueAmazon,
  acao: AcaoAvisoContaEstoqueAmazon,
  relogio: TimestampLike,
): Promise<void> {
  await sincronizarAvisoContaEstoqueAmazon(
    db,
    { increment: deps.increment, nowMs: deps.agora(), logger: deps.logger },
    { integracaoId: contaId, motivo, acao, relogio },
  );
}

/**
 * The systemic guard (module header, Decide): a depósito whose rowless zeros
 * look catalogue-scale — at least {@link LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON},
 * or MORE than half the enviável SKUs. Pure.
 */
export function guardaSistemicaEstoqueAmazon(
  c: Pick<ContagensReconciliacaoEstoqueAmazon, 'zeroSemLinha' | 'enviaveis'>,
): boolean {
  return c.zeroSemLinha >= LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON || c.zeroSemLinha * 2 > c.enviaveis;
}

/* -------------------------------------------------------------------------- */
/*                                  The page                                  */
/* -------------------------------------------------------------------------- */

/** How one page dispatch ended (closed). */
export const ACAO_PAGINA_RECONCILIACAO = {
  valvulaDesligada: 'valvula-desligada',
  contextoRecusado: 'contexto-recusado',
  /** Step 0: another run, an ended run, or a page past the next one. */
  naoEDono: 'nao-e-dono',
  /** Step 0: a page behind the next one — the next re-enqueued under its name. */
  adiantada: 'adiantada',
  /** A 429: the same page re-enqueued unnamed. */
  limitada: 'limitada',
  /** Step 6 lost the run to another dispatch. */
  vezPerdida: 'vez-perdida',
  /** Steps 0–7: the page walked, the next page enqueued. */
  paginaConcluida: 'pagina-concluida',
  /** The run closed `concluida` (after its decide). */
  concluida: 'concluida',
  /** The run closed `truncada`. */
  truncada: 'truncada',
} as const;
export type AcaoPaginaReconciliacaoEstoqueAmazon =
  (typeof ACAO_PAGINA_RECONCILIACAO)[keyof typeof ACAO_PAGINA_RECONCILIACAO];

/** Why a run was truncated. */
export const MOTIVO_TRUNCAMENTO_RECONCILIACAO = {
  depositoMudou: 'deposito-mudou',
  prazo: 'prazo',
  cursorIlegivel: 'cursor-ilegivel',
} as const;
export type MotivoTruncamentoReconciliacao =
  (typeof MOTIVO_TRUNCAMENTO_RECONCILIACAO)[keyof typeof MOTIVO_TRUNCAMENTO_RECONCILIACAO];

/** What Decide chose (closed). */
export const DECISAO_RECONCILIACAO = {
  semDivergencia: 'sem-divergencia',
  depositoSemLinhas: 'deposito-sem-linhas',
  patches: 'patches',
  feed: 'feed',
  dryRunFeed: 'dry-run-feed',
  canario: 'canario',
  desligado: 'desligado',
} as const;
export type DecisaoReconciliacao =
  (typeof DECISAO_RECONCILIACAO)[keyof typeof DECISAO_RECONCILIACAO];

/** What one page dispatch did (logged ONCE). */
export interface ResultadoPaginaReconciliacaoEstoqueAmazon {
  readonly acao: AcaoPaginaReconciliacaoEstoqueAmazon;
  readonly motivo: string | null;
  /** This page's own counts (null when it walked nothing). */
  readonly pagina: ContagemPaginaReconciliacao | null;
  readonly decisao: DecisaoReconciliacao | null;
  /** Patch tasks enqueued (or already held), and the drift SKUs a dry-run only counted. */
  readonly tarefas: number;
  readonly jaEnfileiradas: number;
  readonly simulados: number;
  /** Up to {@link MAX_AMOSTRA_DRY_RUN} SKUs of a dry-run decide, joined with `,`. */
  readonly amostra: string | null;
  /**
   * The block feeds this decide enqueued (module header, Decide): `ja-enfileirada`
   * when Cloud Tasks already held EVERY one of them, else `enfileirada`; `null`
   * when it sent no feed.
   */
  readonly feed: ResultadoEnfileiramentoLoteAmazon | null;
  /** The block batches this decide named (enqueued now or already held). */
  readonly lotes: number;
  /** Of {@link lotes}, those Cloud Tasks already held. */
  readonly lotesJaEnfileirados: number;
  /** Avisos written: `<motivo>:<acao>` joined with `,`. */
  readonly avisos: string | null;
  /** The next run's Start, when the close found a request. */
  readonly proximo: string | null;
}

/** One page's own counts. */
export interface ContagemPaginaReconciliacao {
  readonly vinculos: number;
  readonly skus: number;
  readonly avaliados: number;
  readonly jaVistos: number;
  readonly enviaveis: number;
  readonly divergencias: number;
}

function resultadoPagina(
  acao: AcaoPaginaReconciliacaoEstoqueAmazon,
  extra: Partial<Omit<ResultadoPaginaReconciliacaoEstoqueAmazon, 'acao'>> = {},
): ResultadoPaginaReconciliacaoEstoqueAmazon {
  return {
    acao,
    motivo: null,
    pagina: null,
    decisao: null,
    tarefas: 0,
    jaEnfileiradas: 0,
    simulados: 0,
    amostra: null,
    feed: null,
    lotes: 0,
    lotesJaEnfileirados: 0,
    avisos: null,
    proximo: null,
    ...extra,
  };
}

const ACOES_EM_WARNING: ReadonlySet<AcaoPaginaReconciliacaoEstoqueAmazon> = new Set([
  ACAO_PAGINA_RECONCILIACAO.contextoRecusado,
  ACAO_PAGINA_RECONCILIACAO.limitada,
  ACAO_PAGINA_RECONCILIACAO.vezPerdida,
  ACAO_PAGINA_RECONCILIACAO.truncada,
]);

/** The ONE line per page dispatch: counts, closed codes and ids — a SKU only in a dry-run's sample. */
function registrarPagina(
  deps: DepsPaginaReconciliacaoEstoqueAmazon,
  t: TarefaPaginaReconciliacaoAmazon,
  r: ResultadoPaginaReconciliacaoEstoqueAmazon,
): void {
  registrar(
    deps.logger,
    t.contaId,
    ACOES_EM_WARNING.has(r.acao) || r.decisao === DECISAO_RECONCILIACAO.depositoSemLinhas
      ? 'WARNING'
      : 'INFO',
    `[amazon/estoque] reconciliação: página (${r.acao})`,
    {
      etapa: 'pagina',
      acao: r.acao,
      motivo: r.motivo,
      execucaoId: t.execucaoId,
      pagina: t.pagina,
      vinculos: r.pagina?.vinculos ?? null,
      skus: r.pagina?.skus ?? null,
      avaliados: r.pagina?.avaliados ?? null,
      jaVistos: r.pagina?.jaVistos ?? null,
      enviaveis: r.pagina?.enviaveis ?? null,
      divergencias: r.pagina?.divergencias ?? null,
      decisao: r.decisao,
      tarefas: r.tarefas,
      jaEnfileiradas: r.jaEnfileiradas,
      simulados: r.simulados,
      amostra: r.amostra,
      feed: r.feed,
      lotes: r.lotes,
      lotesJaEnfileirados: r.lotesJaEnfileirados,
      avisos: r.avisos,
      proximo: r.proximo,
    },
    deps.registro,
  );
}

/** One page dispatch, bound. */
interface Execucao {
  readonly db: Firestore;
  readonly t: TarefaPaginaReconciliacaoAmazon;
  readonly deps: DepsPaginaReconciliacaoEstoqueAmazon;
  readonly valvula: ValvulaAmazon<typeof FLUXO_AMAZON.estoque>;
  readonly contexto: ContextoAmazon;
  /** ms — the instant past which the page starts no more reads. */
  readonly prazoMs: number;
}

/**
 * ONE page dispatch (module header): its own line, written for every end it
 * decides. A throw (Firestore, the producers, a non-429 Amazon failure) leaves
 * for the jobs queue's retry, through the jobs root's sanitizing boundary.
 */
export async function processarPaginaReconciliacaoEstoqueAmazon(
  db: Firestore,
  t: TarefaPaginaReconciliacaoAmazon,
  deps: DepsPaginaReconciliacaoEstoqueAmazon,
): Promise<ResultadoPaginaReconciliacaoEstoqueAmazon> {
  const r = await executarPagina(db, t, deps);
  registrarPagina(deps, t, r);
  return r;
}

async function executarPagina(
  db: Firestore,
  t: TarefaPaginaReconciliacaoAmazon,
  deps: DepsPaginaReconciliacaoEstoqueAmazon,
): Promise<ResultadoPaginaReconciliacaoEstoqueAmazon> {
  const prazoMs = deps.agora() + ORCAMENTO_PAGINA_RECONCILIACAO_MS;
  // The valve FIRST, read once and logged: `off` reads nothing at all.
  const valvula = lerValvula(FLUXO_AMAZON.estoque, deps.ambiente);
  registrarValvulaAmazon(deps.logger, valvula, {
    conta: t.contaId,
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  });
  if (valvula.modo === MODO_AMAZON.off) {
    return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.valvulaDesligada);
  }

  // The context — the read switch first.
  let contexto: ContextoAmazon;
  try {
    contexto = await loadAmazonContext(db, t.contaId, {
      ambiente: deps.ambiente,
      agora: deps.agora,
      logger: deps.logger,
      registro: {
        fluxo: FLUXO_AMAZON.estoque,
        tentativa: deps.registro.tentativa,
        idTarefa: deps.registro.idTarefa,
      },
      fetch: deps.fetch,
      gerarCorrelationId: deps.gerarCorrelationId,
    });
  } catch (err) {
    const token = classificarFalhaDeLeituraAmazon(err);
    if (
      token !== FALHA_LEITURA_AMAZON.chamadasDesligadas &&
      token !== FALHA_LEITURA_AMAZON.contaInativa &&
      token !== FALHA_LEITURA_AMAZON.contaIndisponivel
    ) {
      throw err;
    }
    return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.contextoRecusado, { motivo: token });
  }
  const e: Execucao = { db, t, deps, valvula, contexto, prazoMs };

  // ---- 0: the run check, from a FRESH read. ----
  const lida = await lerRun(db, t.contaId);
  const run = lida.estado;
  if (run === null || run.execucaoId !== t.execucaoId) {
    return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.naoEDono);
  }
  if (terminal(run.fase)) {
    // THIS run already ended: its close may have died after the end and before
    // its request read, which nothing else re-runs — the close's tail, again
    // (Start claims only an ended run, so a late copy starts nothing twice).
    return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.naoEDono, {
      proximo: await iniciarSePendente(db, t.contaId, deps),
    });
  }
  if (t.pagina < run.proximaPagina) {
    await deps
      .agendador()
      .enfileirarLote(tarefaDaPagina(t.contaId, t.execucaoId, run.proximaPagina), {
        nome: nomePaginaReconciliacao(t.contaId, t.execucaoId, run.proximaPagina),
      });
    return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.adiantada);
  }
  if (t.pagina > run.proximaPagina) return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.naoEDono);
  if (lida.updateTime === null) throw new TypeError('reconciliacaoEstoque.ts: run sem updateTime');
  const escrito: RunEscrito = { estado: run, updateTime: lida.updateTime };
  if (run.fase === FASE_RECONCILIACAO_ESTOQUE_AMAZON.enviando) {
    return fechar(e, escrito, FASE_RECONCILIACAO_ESTOQUE_AMAZON.concluida, null, {});
  }
  if (run.fase === FASE_RECONCILIACAO_ESTOQUE_AMAZON.decidindo) return decidir(e, escrito, null);

  // ---- 1: the depósito, the run's (both read through the ONE parse). ----
  const depositoDoRun = depositoIdDaContaEstoqueAmazon(run.depositoOuterRef);
  let depositoDaConta = depositoIdDaContaEstoqueAmazon(contexto.conta.depositoOuterRef);
  if (depositoDoRun !== null && depositoDaConta !== depositoDoRun) {
    // The context's conta is the conta cache's (up to 15 min old), while the
    // claim read it RAW: a mismatch is re-read raw before it truncates the run,
    // or a cached old depósito would truncate every fresh run the close starts.
    depositoDaConta = await depositoDaContaSemCache(db, t.contaId);
  }
  if (depositoDoRun === null || depositoDaConta !== depositoDoRun) {
    await registrarPedido(
      db,
      t.contaId,
      ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.depositoMudou,
      deps,
    );
    return fechar(
      e,
      escrito,
      FASE_RECONCILIACAO_ESTOQUE_AMAZON.truncada,
      MOTIVO_TRUNCAMENTO_RECONCILIACAO.depositoMudou,
      {},
    );
  }

  return caminhar(e, lida, depositoDoRun);
}

/** The conta's depósito id from a RAW, uncached read (the ONE parse); `null` for none or no conta. */
async function depositoDaContaSemCache(db: Firestore, contaId: string): Promise<string | null> {
  const snap = await integracaoCollection.docRef(db, {}, contaId).get();
  const conta = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  return conta === null ? null : depositoIdDaContaEstoqueAmazon(conta.depositoOuterRef);
}

/* ------------------------------ steps 2 to 7 ------------------------------- */

/** The counters of nothing. */
function contagensVazias(): ContagensReconciliacaoEstoqueAmazon {
  return {
    vinculosLidos: 0,
    skusAvaliados: 0,
    enviaveis: 0,
    divergencias: 0,
    zeroSemLinha: 0,
    recusasHumanas: 0,
    recusadosEmDivergencia: 0,
    porChave: {},
  };
}

/** Two counter sets summed (the stored run's and one page's). */
function somarContagens(
  a: ContagensReconciliacaoEstoqueAmazon,
  b: ContagensReconciliacaoEstoqueAmazon,
): ContagensReconciliacaoEstoqueAmazon {
  const porChave: Record<string, number> = { ...a.porChave };
  for (const [chave, n] of Object.entries(b.porChave)) porChave[chave] = (porChave[chave] ?? 0) + n;
  return {
    vinculosLidos: a.vinculosLidos + b.vinculosLidos,
    skusAvaliados: a.skusAvaliados + b.skusAvaliados,
    enviaveis: a.enviaveis + b.enviaveis,
    divergencias: a.divergencias + b.divergencias,
    zeroSemLinha: a.zeroSemLinha + b.zeroSemLinha,
    recusasHumanas: a.recusasHumanas + b.recusasHumanas,
    recusadosEmDivergencia: a.recusadosEmDivergencia + b.recusadosEmDivergencia,
    porChave,
  };
}

/** Whether a SKU is in drift: enviável, and Amazon's quantity is not the ERP's. */
function emDivergencia(
  s: AvaliacaoSkuEstoqueAmazon,
): s is Extract<AvaliacaoSkuEstoqueAmazon, { readonly enviavel: true }> {
  return s.enviavel && s.quantidadeAmazon !== s.quantidadeErp;
}

/** Whether the run still waits for THIS page of its walk (step 6's check, and the 429's stamp). */
function donoDaPagina(
  t: TarefaPaginaReconciliacaoAmazon,
): (estado: ReconciliacaoEstoqueAmazon) => boolean {
  return (estado) =>
    estado.execucaoId === t.execucaoId &&
    estado.proximaPagina === t.pagina &&
    estado.fase === FASE_RECONCILIACAO_ESTOQUE_AMAZON.varrendo;
}

/** Steps 2–7 for the page step 0 confirmed, at the run's depósito. */
async function caminhar(
  e: Execucao,
  lida: LeituraReconciliacaoEstoqueAmazon<ReconciliacaoEstoqueAmazon>,
  depositoId: string,
): Promise<ResultadoPaginaReconciliacaoEstoqueAmazon> {
  const { db, t, deps } = e;
  const run = lida.estado;
  if (run === null || lida.updateTime === null) {
    throw new TypeError('reconciliacaoEstoque.ts: a página caminha sem o run lido');
  }
  const escrito: RunEscrito = { estado: run, updateTime: lida.updateTime };

  // ---- 2–3: the walk, its grouping and the dedupe (the shared page core). ----
  const pagina = await paginaVarreduraVinculosAmazon(db, t.contaId, run.cursores, {
    campos: CAMPOS_RESOLVER_ESTOQUE_AMAZON,
    prazo: { agora: deps.agora, prazoMs: e.prazoMs },
  });
  if (pagina.tipo === 'truncada') {
    return fechar(e, escrito, FASE_RECONCILIACAO_ESTOQUE_AMAZON.truncada, pagina.motivo, {});
  }
  const contagem = contagensVazias();
  const porChave: Record<string, number> = { ...pagina.porChave };
  const somar = (chave: string, n = 1) => {
    porChave[chave] = (porChave[chave] ?? 0) + n;
  };
  contagem.vinculosLidos = pagina.vinculos;
  const { skus, aAvaliar } = pagina;
  const leituras = pagina.vinculosLidos;

  // ---- 4: the evaluator. ----
  let avaliados: readonly AvaliacaoSkuEstoqueAmazon[] = [];
  if (aAvaliar.length > 0) {
    const sellerId = e.contexto.conta.selling_partner_id;
    if (typeof sellerId !== 'string' || sellerId === '') {
      // The context loader refuses a conta with no seller: only a bug reaches this.
      throw new TypeError('reconciliacaoEstoque.ts: o contexto não nomeia o vendedor');
    }
    let avaliacao: Awaited<ReturnType<typeof avaliarSkusEstoqueAmazon>>;
    try {
      avaliacao = await avaliarSkusEstoqueAmazon(
        {
          contexto: e.contexto,
          db,
          logger: deps.logger,
          agora: deps.agora,
          sellerId,
          esperar: deps.esperar,
        },
        aAvaliar,
        { depositoId, prazoMs: e.prazoMs, maxGets: null, vinculosLidos: leituras },
      );
    } catch (err) {
      if (!(err instanceof AmazonThrottleError)) throw err;
      // Amazon throttled: no attempt spent. The run's progress is stamped FIRST
      // (tier 1 on step 0's read, still this page), so the re-kick never takes a
      // throttled page for a lost one and starts a second chain of it; then the
      // SAME page, unnamed, a minute later.
      const vivo = await atualizarRun(db, t.contaId, escrito, donoDaPagina(t), () => ({
        progressoEmMs: deps.agora(),
      }));
      if (vivo === null) return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.vezPerdida);
      await deps.agendador().enfileirarLote(t, { atrasoS: ESPERA_LIMITE_PAGINA_S });
      return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.limitada);
    }
    if (avaliacao.tipo === DESFECHO_AVALIACAO_ESTOQUE_AMAZON.prazo) {
      return fechar(
        e,
        escrito,
        FASE_RECONCILIACAO_ESTOQUE_AMAZON.truncada,
        MOTIVO_TRUNCAMENTO_RECONCILIACAO.prazo,
        {},
      );
    }
    avaliados = avaliacao.skus;
    contagem.enviaveis = avaliacao.contagem.enviaveis;
    contagem.zeroSemLinha = avaliacao.contagem.zeroSemLinha;
    contagem.recusasHumanas = avaliacao.contagem.recusasHumanas;
    for (const [chave, n] of Object.entries(avaliacao.contagem.porChave)) somar(chave, n);
  }
  contagem.skusAvaliados = aAvaliar.length;

  // ---- 5: the drift, ONE block written BEFORE the state update. ----
  const itens: ItemDivergenciaEstoqueAmazon[] = [];
  for (const s of avaliados) {
    if (!emDivergencia(s)) continue;
    itens.push({
      sku: s.sku,
      unidadeId: s.vinculo.unidadeId,
      quantidadeAmazon: s.quantidadeAmazon,
      quantidadeErp: s.quantidadeErp,
    });
    // A stored `recusado` counts only while its SKU is still in drift.
    if (s.vinculo.envioRecente?.resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado) {
      contagem.recusadosEmDivergencia += s.vinculo.linkIds.length;
    }
  }
  contagem.divergencias = itens.length;
  contagem.porChave = porChave;
  const depositoGravavel = depositoIdGravavelDaContaEstoqueAmazon(run.depositoOuterRef);
  if (depositoGravavel === null) {
    throw new TypeError('reconciliacaoEstoque.ts: o depósito do run não é gravável');
  }
  await gravarBlocoDivergenciaEstoqueAmazon(db, {
    contaId: t.contaId,
    execucaoId: t.execucaoId,
    pagina: t.pagina,
    depositoId: depositoGravavel,
    itens,
    agoraMs: deps.agora(),
  });

  // ---- 6: the state update, tier 1 on step 0's read. ----
  const concluiu = varreduraVinculosConcluida(pagina.cursores);
  const relogioInicio = lida.readTime;
  const depois = await atualizarRun(db, t.contaId, escrito, donoDaPagina(t), (estado) => ({
    cursores: pagina.cursores,
    contagens: somarContagens(estado.contagens, contagem),
    paginas: t.pagina + 1,
    proximaPagina: t.pagina + 1,
    progressoEmMs: deps.agora(),
    fase: concluiu
      ? FASE_RECONCILIACAO_ESTOQUE_AMAZON.decidindo
      : FASE_RECONCILIACAO_ESTOQUE_AMAZON.varrendo,
    ...(t.pagina === 0 ? { relogioInicio } : {}),
  }));
  const contagemPagina: ContagemPaginaReconciliacao = {
    vinculos: contagem.vinculosLidos,
    skus: skus.length,
    avaliados: aAvaliar.length,
    jaVistos: porChave[MOTIVO_ESTOQUE_AMAZON.jaVisto] ?? 0,
    enviaveis: contagem.enviaveis,
    divergencias: contagem.divergencias,
  };
  if (depois === null) {
    return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.vezPerdida, { pagina: contagemPagina });
  }

  // ---- 7: the next page, or the decide. ----
  if (concluiu) return decidir(e, depois, contagemPagina);
  await deps.agendador().enfileirarLote(tarefaDaPagina(t.contaId, t.execucaoId, t.pagina + 1), {
    nome: nomePaginaReconciliacao(t.contaId, t.execucaoId, t.pagina + 1),
  });
  return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.paginaConcluida, { pagina: contagemPagina });
}

/* --------------------------------- Decide ---------------------------------- */

/** Whether the stock feed path is healthy enough for a zero drift to close its aviso. */
function feedSaudavel(
  vez: Awaited<ReturnType<typeof lerVezFeed>>['vez'],
  agoraMs: number,
): boolean {
  if (vez === null) return true;
  if (vez.falhasSeguidas >= MAX_FALHAS_SEGUIDAS_FEED) return false;
  // An `enviando` past its expiry is a feed whose answer was lost: uncertain.
  const incerta = faseDaVez(vez) === ESTADO_VEZ_FEED_AMAZON.enviando && agoraMs >= vez.ateMs;
  return !incerta;
}

/** One patch task of the run's drift: named by the run, pinned to the walk's depósito. */
function tarefaDeDivergencia(
  contaId: string,
  execucaoId: string,
  depositoId: string,
  sku: string,
): TarefaEstoqueAmazon {
  return {
    v: VERSAO_TAREFA_ESTOQUE_AMAZON,
    contaId,
    sku,
    origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao,
    referencia: execucaoId,
    depositoId,
  };
}

/** Decide (module header), then Close. */
async function decidir(
  e: Execucao,
  base: RunEscrito,
  contagemPagina: ContagemPaginaReconciliacao | null,
): Promise<ResultadoPaginaReconciliacaoEstoqueAmazon> {
  const { db, t, deps } = e;
  const run = base.estado;
  const c = run.contagens;
  const relogio = run.relogioInicio;
  const avisos: string[] = [];
  const avisarDoRun = async (
    motivo: MotivoContaEstoqueAmazon,
    acao: AcaoAvisoContaEstoqueAmazon,
  ) => {
    if (relogio === null) return;
    await avisar(db, deps, t.contaId, motivo, acao, relogio);
    avisos.push(`${motivo}:${acao}`);
  };
  const depositoId = depositoIdGravavelDaContaEstoqueAmazon(run.depositoOuterRef);
  if (depositoId === null)
    throw new TypeError('reconciliacaoEstoque.ts: o depósito do run não é gravável');
  let extra: Partial<ResultadoPaginaReconciliacaoEstoqueAmazon> = { pagina: contagemPagina };

  const D = c.divergencias;
  if (D === 0) {
    const lease = await lerVezFeed(db, { fluxo: FLUXO_AMAZON.estoque, contaId: t.contaId });
    if (feedSaudavel(lease.vez, deps.agora())) {
      await avisarDoRun(
        MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
        ACAO_AVISO_CONTA_ESTOQUE_AMAZON.resolver,
      );
    }
    extra = { ...extra, decisao: DECISAO_RECONCILIACAO.semDivergencia };
  } else if (guardaSistemicaEstoqueAmazon(c)) {
    await avisarDoRun(
      MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas,
      ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
    );
    extra = { ...extra, decisao: DECISAO_RECONCILIACAO.depositoSemLinhas };
  } else if (caminhoDoLote(D) === CAMINHO_LOTE_ESTOQUE_AMAZON.patches) {
    extra = { ...extra, ...(await enviarComoPatches(e, run, depositoId, false)) };
  } else {
    const lote = decidirLote(e.valvula);
    if (lote.modo === 'feed' || lote.modo === MODO_AMAZON.dryRun) {
      extra = {
        ...extra,
        decisao:
          lote.modo === 'feed' ? DECISAO_RECONCILIACAO.feed : DECISAO_RECONCILIACAO.dryRunFeed,
        ...(await enviarComoBlocos(e, run)),
      };
    } else if (lote.modo === 'so-patches-do-canario') {
      extra = { ...extra, ...(await enviarComoPatches(e, run, depositoId, true)) };
    } else {
      extra = { ...extra, decisao: DECISAO_RECONCILIACAO.desligado };
    }
  }

  // Decided: `enviando`, so a re-kicked close never decides twice.
  const enviando = await atualizarRun(
    db,
    t.contaId,
    base,
    (estado) =>
      estado.execucaoId === t.execucaoId &&
      estado.fase === FASE_RECONCILIACAO_ESTOQUE_AMAZON.decidindo,
    () => ({ fase: FASE_RECONCILIACAO_ESTOQUE_AMAZON.enviando, progressoEmMs: deps.agora() }),
  );
  if (enviando === null) {
    return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.vezPerdida, {
      ...extra,
      avisos: juntar(avisos),
    });
  }
  return fechar(e, enviando, FASE_RECONCILIACAO_ESTOQUE_AMAZON.concluida, null, extra, avisos);
}

/** A list for a line: joined with `,`, or `null` when empty. */
function juntar(lista: readonly string[]): string | null {
  return lista.length === 0 ? null : lista.join(',');
}

/**
 * The drift as block feeds (module header, Decide): the walk's blocks
 * partitioned ({@link lotesDeBlocosEstoqueAmazon}), one `feed-enviar` per
 * batch, in batch order, each with its own `execucaoId` and name, all with the
 * same delay and wait. A failed enqueue rethrows (the page's retry decides
 * again; the names already enqueued answer `ja-enfileirada`).
 */
async function enviarComoBlocos(
  e: Execucao,
  run: ReconciliacaoEstoqueAmazon,
): Promise<
  Pick<ResultadoPaginaReconciliacaoEstoqueAmazon, 'feed' | 'lotes' | 'lotesJaEnfileirados'>
> {
  const { t, deps } = e;
  const intervalos = lotesDeBlocosEstoqueAmazon(run.paginas);
  const esperaAteMs = deps.agora() + ATRASO_ENVIO_RECONCILIACAO_S * 1000 + ESPERA_LOTE_BLOCOS_MS;
  let jaEnfileirados = 0;
  for (const [k, intervalo] of intervalos.entries()) {
    const execucaoId = execucaoIdDoLoteBlocosFeed(t.contaId, run.execucaoId, k);
    const tarefa: TarefaEnviarFeedAmazon = {
      v: VERSAO_TAREFA_LOTE_AMAZON,
      tipo: TIPO_TAREFA_LOTE_AMAZON.enviar,
      fluxo: FLUXO_AMAZON.estoque,
      contaId: t.contaId,
      execucaoId,
      origem: ORIGEM_LOTE_RECONCILIACAO_ESTOQUE_AMAZON,
      lote: {
        tipo: TIPO_LOTE_FEED_AMAZON.blocos,
        execucaoIdRun: run.execucaoId,
        parteInicial: intervalo.parteInicial,
        partes: intervalo.partes,
        esperaAteMs,
      },
    };
    const r = await deps.agendador().enfileirarLote(tarefa, {
      nome: nomeEnvioFeed(t.contaId, execucaoId),
      atrasoS: ATRASO_ENVIO_RECONCILIACAO_S,
    });
    if (r === 'ja-enfileirada') jaEnfileirados += 1;
  }
  return {
    feed: jaEnfileirados === intervalos.length ? 'ja-enfileirada' : 'enfileirada',
    lotes: intervalos.length,
    lotesJaEnfileirados: jaEnfileirados,
  };
}

/**
 * The drift as patch tasks (module header, Decide): every drift SKU through
 * `decidirAlvo` — `on` ⇒ one task, delayed; `dry-run` ⇒ counted and sampled.
 * `canario` marks the D ≥ 31 canary branch.
 */
async function enviarComoPatches(
  e: Execucao,
  run: ReconciliacaoEstoqueAmazon,
  depositoId: string,
  canario: boolean,
): Promise<Partial<ResultadoPaginaReconciliacaoEstoqueAmazon>> {
  const { db, t, deps } = e;
  // Every block of the run: patch tasks carry no document, so no feed cap applies.
  const blocos = await lerBlocosDivergenciaEstoqueAmazon(db, {
    contaId: t.contaId,
    execucaoId: run.execucaoId,
    parteInicial: 0,
    partes: run.paginas,
  });
  const tarefas: TarefaEstoqueAmazon[] = [];
  const simulados: string[] = [];
  for (const bloco of blocos) {
    for (const item of bloco.itens) {
      const alvo = decidirAlvo(e.valvula, t.contaId, item.sku);
      if (alvo.modo === MODO_AMAZON.on) {
        tarefas.push(tarefaDeDivergencia(t.contaId, run.execucaoId, depositoId, item.sku));
      } else if (alvo.modo === MODO_AMAZON.dryRun) {
        simulados.push(item.sku);
      }
    }
  }
  let enfileiradas = 0;
  let jaEnfileiradas = 0;
  if (tarefas.length > 0) {
    const r = await deps.produtorEstoque().enfileirarLote(tarefas, {
      atrasoS: ATRASO_ENVIO_RECONCILIACAO_S,
    });
    enfileiradas = r.enfileiradas;
    jaEnfileiradas = r.jaEnfileiradas;
  }
  return {
    decisao: canario ? DECISAO_RECONCILIACAO.canario : DECISAO_RECONCILIACAO.patches,
    tarefas: enfileiradas,
    jaEnfileiradas,
    simulados: simulados.length,
    amostra:
      e.valvula.modo === MODO_AMAZON.dryRun
        ? juntar(simulados.slice(0, MAX_AMOSTRA_DRY_RUN))
        : null,
  };
}

/* ---------------------------------- Close ---------------------------------- */

/**
 * The close's tail: a FRESH read of the request, and Start when it is
 * `pendente`. Run by the close after the end it wrote, and again by step 0 for
 * a dispatch of a run that already ended (its close may have died here).
 */
async function iniciarSePendente(
  db: Firestore,
  contaId: string,
  deps: DepsReconciliacaoEstoqueAmazon,
): Promise<ResultadoInicioReconciliacaoEstoqueAmazon['acao'] | null> {
  const pedido = await lerPedido(db, contaId);
  if (pedido.estado?.pendente !== true) return null;
  return (await iniciarReconciliacaoEstoqueAmazon(db, contaId, deps)).acao;
}

/**
 * Close (module header): the avisos clocked by `relogioInicio` FIRST, then the
 * end written, then a fresh read of the request: `pendente` ⇒ Start.
 */
async function fechar(
  e: Execucao,
  base: RunEscrito,
  fim:
    | typeof FASE_RECONCILIACAO_ESTOQUE_AMAZON.concluida
    | typeof FASE_RECONCILIACAO_ESTOQUE_AMAZON.truncada,
  motivo: MotivoTruncamentoReconciliacao | null,
  extra: Partial<ResultadoPaginaReconciliacaoEstoqueAmazon>,
  avisosDoDecide: readonly string[] = [],
): Promise<ResultadoPaginaReconciliacaoEstoqueAmazon> {
  const { db, t, deps } = e;
  const run = base.estado;
  const c = run.contagens;
  const relogio = run.relogioInicio;
  const concluida = fim === FASE_RECONCILIACAO_ESTOQUE_AMAZON.concluida;
  const avisos = [...avisosDoDecide];
  if (relogio !== null) {
    const fazer = async (
      motivoAviso: MotivoContaEstoqueAmazon,
      acao: AcaoAvisoContaEstoqueAmazon,
    ) => {
      await avisar(db, deps, t.contaId, motivoAviso, acao, relogio);
      avisos.push(`${motivoAviso}:${acao}`);
    };
    if (c.recusasHumanas > 0) {
      await fazer(
        MOTIVO_CONTA_AMAZON.estoqueVinculosRecusados,
        ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
      );
    } else if (concluida) {
      await fazer(
        MOTIVO_CONTA_AMAZON.estoqueVinculosRecusados,
        ACAO_AVISO_CONTA_ESTOQUE_AMAZON.resolver,
      );
    }
    if (concluida) {
      await fazer(
        MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon,
        c.recusadosEmDivergencia > 0
          ? ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar
          : ACAO_AVISO_CONTA_ESTOQUE_AMAZON.resolver,
      );
      if (!guardaSistemicaEstoqueAmazon(c)) {
        await fazer(
          MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas,
          ACAO_AVISO_CONTA_ESTOQUE_AMAZON.resolver,
        );
      }
    }
  }
  const agoraMs = deps.agora();
  const fechado = await atualizarRun(
    db,
    t.contaId,
    base,
    (estado) => estado.execucaoId === t.execucaoId && !terminal(estado.fase),
    () => ({ fase: fim, concluidaEmMs: agoraMs, progressoEmMs: agoraMs }),
  );
  if (fechado === null) {
    return resultadoPagina(ACAO_PAGINA_RECONCILIACAO.vezPerdida, {
      ...extra,
      motivo,
      avisos: juntar(avisos),
    });
  }
  const proximo = await iniciarSePendente(db, t.contaId, deps);
  return resultadoPagina(
    concluida ? ACAO_PAGINA_RECONCILIACAO.concluida : ACAO_PAGINA_RECONCILIACAO.truncada,
    {
      ...extra,
      motivo,
      avisos: juntar(avisos),
      proximo,
    },
  );
}
