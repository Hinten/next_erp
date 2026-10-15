/**
 * Step 15b's automatic-arrange SWEEP (#1744) — the five-minute poll that finds
 * the Entrega Turbo packages nothing has announced yet, and hands each one to
 * the push path's arrange.
 *
 * Announcement 1573 makes the seller's system call `ship_order` on its own for
 * the channels in `CANAIS_ARRANJO_AUTOMATICO`. The push arm already does it
 * whenever a push names such a package (`pedidos/arranjoAutomatico.ts`). This
 * sweep exists for the moment no push documents: Shopee clearing
 * `invoice_pending` after the NF-e is validated. ⚠️ So it is NOT a pure
 * backstop — for a late NF-e (the normal BR case) it is the PRIMARY signal
 * (reconcile R-o: "no push is DOCUMENTED", which is not "no push exists").
 *
 * ## It arranges NOTHING and writes NOTHING
 *
 * Every eligible package becomes ONE synthetic code-30 notification on the
 * existing `processShopeeNotification` queue (`notificacaoSinteticaDePacote`),
 * so the arrange stays in ONE place — the arm's hook, which re-reads the
 * package itself. The only Firestore operations here are READS: the conta
 * enumeration, the conta's credential document (the dead-grant skip), one
 * pedido-existence read per order and — on the absent-pedido path only — one
 * read of that order's code-3 failure row. There is no write, no cursor
 * document and no multi-document atomic block anywhere in this module (rule 7
 * tier 0: nothing to race). ⚠️ That last API is deliberately not NAMED in this
 * file, comments included — the transaction-inventory guard greps raw text.
 * ⚠️ "Writes nothing" is this module's own code: a conta whose access token is
 * due for renewal pays the token store's lease inside its first Shopee call
 * (`core/tokenStore.ts`), as every shop-signed caller does.
 *
 * Every tick restarts at page 1, most urgent first (ShipByDate ascending): a
 * tail cut by a cap is re-read five minutes later. ⚠️ Unless the head never
 * clears — a package the hook refuses stays READY and unarranged, so it sorts
 * first and spends its share of the 100-enqueue cap on every tick; with 100 or
 * more of them on one conta, a newer eligible package is never enqueued (R-m's
 * residual, implausible at today's volume).
 *
 * ## The tick
 *
 * 1. Three gates, in order, each answering `enabled: false` having read
 *    NOTHING — not Firestore, not Shopee: this sweep's own valve, the
 *    arrange's valve (`arranjoAutomaticoDesligado`, the hook's ONE reader —
 *    with the arrange off every task this sweep enqueues would only re-run the
 *    frete merge), and the queue's valve (`shopeeTasksDesabilitado`, read
 *    BEFORE deciding — `ShopeeTasksDisabledError` is inside
 *    `erroContidoPorConta`, so learning it by a catch would read as N contained
 *    conta failures).
 * 2. `listarContasShopeeAtivas`. A conta without `shop_id` is counted in
 *    `semShopId` and costs nothing. Before STARTING each other conta:
 *    - the tick's own budget ({@link PRAZO_DO_TICK_ARRANJO_MS}, on the injected
 *      ELAPSED clock): once spent, no further conta is started and the tick
 *      reports `interrompidoPorPrazo`;
 *    - the conta's credential document, read RAW: a refresh the token store
 *      stamped TERMINAL (`falhaRefreshOf`, the store's own reader) means only a
 *      re-consent can revive the grant, so the conta is counted in
 *      `reconexaoPendente` and costs no Shopee call. Without it a dead grant
 *      paid a lease, a refresh POST and a release on every tick — 288 a day —
 *      until a human reconnected. A re-consent or a successful refresh clears
 *      the stamp, and the next tick walks the conta again.
 * 3. Per conta, ONE `search_package_list` per page (≤
 *    {@link MAX_PAGINAS_ARRANJO_POR_CONTA}), terminating on `more` — never on a
 *    row count, never on the cursor (`next_cursor` is `""` when `more` is
 *    false, Appendix B).
 * 4. Free triage of each row, no call: an unreadable row or a number that is no
 *    package (`-`, blank, a comma — the detail guard would refuse it with a
 *    tick-killing `ShopeeConfigError`), a repeated package,
 *    `is_shipment_arranged === true` (a HINT, but a `true` costs nothing to
 *    believe: the hook would answer `ja-programado`), and a KNOWN channel off
 *    the set (`foraDoCanal` — Shopee ignored the server-side filter, register
 *    224's instrument). An unknown (`null`) channel is kept: the detail decides.
 * 5. ONE `get_package_detail` per ≤ 50 survivors, reconciled BY
 *    `package_number`, never by position — and EXACTLY, the way the handler the
 *    code 30 feeds finds its row (`rastrearPedido.ts`): a detail row that spells
 *    the number differently (padded) leaves the package `ausentesNoDetalhe`,
 *    never a task the arm would only park. Each fresh row goes through
 *    `elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(row))` — the
 *    hook's own first rungs, never a second copy of them (R-d). Only a
 *    `candidato` is enqueued: an invoice-pending package (whatever
 *    `invoice_pending: false` means, register 222) and a PICKUP_RETRY one
 *    (ToProcess, but arranged) cost a count, never a task every five minutes.
 * 6. Per `candidato`, the pedido-existence read (`makePedidoIdShopee`):
 *    present ⇒ the code 30; absent ⇒ ONE code 3 per `order_sn`, so the step-5
 *    import creates the pedido and the next tick enqueues the package. (A code
 *    30 for an absent pedido would only defer one row per package and enqueue
 *    the same code 3 one hop later.) ⚠️ That code 3 is stamped with the START
 *    of the UTC day, never `nowMs`, so its doc id `3:<shop>:<order>:<day>` is
 *    stable for the day — and before enqueuing it the sweep reads that ONE
 *    `notificacoesShopee` document: present means today's import already
 *    failed (failed, deferred or parked), and the order is skipped and counted
 *    in `pedidosComFalhaHoje`. A deterministically failing import therefore
 *    costs at most one attempt and one row per order per UTC day, where a
 *    per-tick stamp minted a fresh parked row every five minutes (no TTL keeps
 *    that collection) and re-paid `get_order_detail` each time. Flooring the
 *    stamp is safe: the code-3 arm imports with the pipeline's own clock and
 *    the order's `update_time` watermark, never the envelope stamp — and the
 *    pedido is absent, so there is no watermark to compare. The code 30 for a
 *    PRESENT pedido gets the same bound (PR #1758's review): the day's stamp,
 *    one read of `30:<shop>:<package>:<day>`, and a skip counted in
 *    `pacotesComFalhaHoje` while that row stands — the store DELETES a row
 *    once it resolves, so a standing row means today's delivery is still
 *    failing; the frete arm never reads the envelope stamp. At most
 *    {@link MAX_ENFILEIRADOS_ARRANJO_POR_CONTA} enqueues per conta.
 *
 * ## Containment (per conta), with the rate limit FIRST
 *
 * `ShopeeRateLimitError` extends `ShopeeApiError`, so the shared boundary would
 * swallow it: it is tested FIRST and ABORTS THE WHOLE TICK. The quota is per
 * APP (registers 97/155) and FAQ 570 asks for no frequent retries; the next
 * tick is the retry. Everything `erroContidoPorConta` names is recorded on the
 * conta and the walk moves on; anything else — `ShopeeConfigError` above all,
 * our own misconfiguration — rethrows and fails the tick loudly.
 *
 * ⚠️ A Cloud Tasks enqueue failure is NOT a gRPC-coded error:
 * `TaskQueue.enqueue` is a REST client and throws `FirebaseFunctionsError` /
 * `FirebaseAppError` with STRING codes. This module does not classify them —
 * it calls `scheduler.enqueue` directly, and the real scheduler
 * (`../shopeeTasks.ts`, `enfileirarNomeandoFalhaTransitoria`) names a
 * transient one `ShopeeTasksTransientError`, which the shared boundary
 * contains per conta like any outage. A permission, a missing queue or a bad
 * argument reaches the boundary as the raw SDK class — a broken deploy — and
 * still rethrows (#778).
 *
 * ## Idempotence across ticks is Shopee's, not ours
 *
 * Two ticks, or a tick and a push, can hand the hook the same package. The only
 * guard between arrangers is Shopee's own state — the hook's fresh
 * `is_shipment_arranged` read and a duplicate ship absorbed as
 * `package_already_shipped` — exactly step 15's accepted residual. Ticks are
 * BOUNDED, not exclusive: the Scheduler's attempt deadline is the function's
 * `timeoutSeconds` (240 s) and it never retries, and this module stops
 * starting contas once {@link PRAZO_DO_TICK_ARRANJO_MS} is spent. But a conta
 * already started — or a Shopee call that hangs, bounded only by #1094 — can
 * run past both, and Cloud Run does not promise to stop a handler at its
 * request timeout, so a tick may still overlap the next one.
 *
 * ## Logs: ids and counts ONLY
 *
 * No `order_sn`, no package number, no tracking number reaches a log argument
 * or the result — a test serialises every one of them. ⚠️ That is why a
 * contained `ShopeeApiError` is described by its class and Shopee `error` code
 * only: its message carries Shopee's own `message` VERBATIM, which may quote
 * the package it refused. A transient enqueue failure is described by the
 * shared class's own message — class, code and HTTP status, never the SDK's
 * message, which may quote the response body.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  credenciaisIntegracaoCollection,
  notificacaoShopeeCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  SHOPEE_FULFILLMENT_TYPE_FILTRO,
  SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES,
  SHOPEE_PACKAGE_SORT,
  SHOPEE_PACKAGE_STATUS_FILTRO,
  SHOPEE_SEARCH_PACKAGE_LIST_MAX_PAGE_SIZE,
  ShopeeApiError,
  ShopeeRateLimitError,
  type SearchPackageListParams,
  type ShopeeClient,
  type ShopeePackageDetailRow,
} from '@delfrance/integrations-shopee';

import type { SweepLogger } from '../conta/expiracaoSweep';
import { erroContidoPorConta } from '../core/containment';
import { listarContasShopeeAtivas } from '../core/contas';
import { falhaRefreshOf, SHOPEE_CREDENCIAL_DOC_ID } from '../core/credentialStore';
import { loadShopeeContext } from '../core/shopee';
import {
  arranjadoNaBusca,
  CANAIS_ARRANJO_AUTOMATICO,
  ehCanalDeArranjoAutomatico,
  elegibilidadeDoArranjoAutomatico,
  observacaoDoPacoteShopee,
  type FasePacote,
} from '../etiqueta/faseEtiqueta';
import { docIdOf } from '../notificacoes/notificacao';
import {
  carimboDoDiaUtcMs,
  notificacaoSinteticaDePacote,
  notificacaoSinteticaDePedido,
} from '../notificacoes/notificacaoSintetica';
import { shopeeTasksDesabilitado, type ShopeeTaskScheduler } from '../shopeeTasks';
import { arranjoAutomaticoDesligado } from './arranjoAutomatico';
import { makePedidoIdShopee } from './orderIds';
import { textoShopeeUtilizavel } from './orderMapping';

/* -------------------------------------------------------------------------- */
/*                                  the valve                                  */
/* -------------------------------------------------------------------------- */

/**
 * This sweep's kill switch. `'1'` and NOTHING else turns it off — `'true'`,
 * `' 1'`, `'0'`, a blank and an unset value all leave it ON — the polarity of
 * `SHOPEE_ARRANJO_AUTOMATICO_DISABLED`, so a missing value can never leave a
 * late-NF-e Turbo package un-arranged until Shopee cancels the order. Read only
 * by the nested functions codebase: its home is `functions/.env.deploy`, never
 * `apphosting.yaml`.
 *
 * ⚠️ Residual with it on: a package whose NF-e clears after its last push is
 * arranged by nobody — no push is documented for that moment.
 */
export const SHOPEE_ARRANJO_SWEEP_DISABLED_ENV = 'SHOPEE_ARRANJO_SWEEP_DISABLED';

/** Whether this sweep is switched off — `=== '1'`, read per call. */
export function arranjoSweepDesligado(): boolean {
  return process.env[SHOPEE_ARRANJO_SWEEP_DISABLED_ENV] === '1';
}

/* -------------------------------------------------------------------------- */
/*                                  the bounds                                 */
/* -------------------------------------------------------------------------- */

/**
 * Search pages per conta per tick: × 100 rows = 500 packages awaiting shipment
 * on 1573's channels, most urgent first. More than 100 at once on a BR shop is
 * implausible, so a truncation is the anomaly the result names, and the tail is
 * re-read on the next tick.
 */
export const MAX_PAGINAS_ARRANJO_POR_CONTA = 5;

/**
 * Enqueues per conta per tick — code 30 and code 3 TOGETHER. Once reached, no
 * further detail read is spent on the conta this tick (it could enqueue
 * nothing), and the survivors left unread are counted in
 * `naoConsultadosPeloLimite`.
 */
export const MAX_ENFILEIRADOS_ARRANJO_POR_CONTA = 100;

/**
 * The tick's own budget, on the ELAPSED clock: once this much has passed since
 * the tick began, no further conta is STARTED (the one in flight finishes). 40 s
 * below the function's `timeoutSeconds` (240), so the summary line still gets
 * written and the contas left over are NAMED as such instead of dying with the
 * instance. ⚠️ It bounds the start of a conta, never its end: a conta begun at
 * 199 s, or a hung Shopee call (#1094), can still run into the platform's kill.
 */
export const PRAZO_DO_TICK_ARRANJO_MS = 200_000;

export const MOTIVO_SWEEP_DESLIGADO = 'sweep-desligado';
export const MOTIVO_ARRANJO_DESLIGADO = 'arranjo-desligado';
export const MOTIVO_TASKS_DESABILITADO = 'tasks-desabilitado';

/** Why a conta's walk stopped short of the whole list. */
export const TRUNCAGEM_ARRANJO = {
  /** {@link MAX_PAGINAS_ARRANJO_POR_CONTA} pages read and Shopee still said `more`. */
  paginas: 'limite-de-paginas',
  /** `more: true` with no usable `next_cursor` — a provider contradiction. */
  moreSemCursor: 'more-sem-cursor',
  /** Rows with no `pagination` at all: nothing says the list ended. */
  paginacaoAusente: 'paginacao-ausente',
  /** {@link MAX_ENFILEIRADOS_ARRANJO_POR_CONTA} reached. */
  enfileirados: 'limite-de-enfileirados',
} as const;
export type TruncagemArranjo = (typeof TRUNCAGEM_ARRANJO)[keyof typeof TRUNCAGEM_ARRANJO];

/* -------------------------------------------------------------------------- */
/*                                  contract                                   */
/* -------------------------------------------------------------------------- */

export interface ArranjoAutomaticoSweepDeps {
  readonly scheduler: ShopeeTaskScheduler;
  /** ONE clock read for the whole tick, MILLISECONDS — the synthetic stamp. */
  readonly nowMs: number;
  /**
   * The ELAPSED clock (ms) behind {@link PRAZO_DO_TICK_ARRANJO_MS} — read when
   * the tick begins and before each conta is started. ⚠️ Never measured
   * against {@link nowMs}: that is a STAMP and may be any injected instant, so
   * `nowMs + budget` would trip on the first conta of a test (the
   * `estoque/enviarEstoqueManual.ts` trap). Default `Date.now`.
   */
  readonly agoraMs?: () => number;
  readonly logger?: SweepLogger;
  /** Default: `loadShopeeContext(db, id).createShopClient()`. */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
}

/**
 * One conta's tick. ⚠️ The counters PARTITION, and a test pins both sums:
 *
 *     linhas = ilegiveisNaBusca + duplicadas + jaArranjadosNaBusca + foraDoCanal
 *            + consultadosNoDetalhe + naoConsultadosPeloLimite
 *     consultadosNoDetalhe = ausentesNoDetalhe + foraDoCanalNoDetalhe
 *                          + canalDesconhecidoNoDetalhe + Σ fases
 *
 * `ilegiveisNoDetalhe` (the unreadable rows of the detail answer) is NOT in the
 * second sum: such a row names no package, so the package it hid is counted as
 * `ausentesNoDetalhe` — the honest attribution.
 */
export interface ArranjoAutomaticoContaResult {
  readonly integracaoId: string;
  readonly paginasLidas: number;
  /** The first page's `total_count` — a DIAGNOSTIC; `0` when Shopee sent none. */
  readonly totalInformado: number;
  /** Rows the search answered, unreadable ones included. */
  readonly linhas: number;
  /** The schema's `null` sentinel, or a `package_number` that is no package (`-`, blank, a comma). */
  readonly ilegiveisNaBusca: number;
  /** A `package_number` already seen this tick (across pages). */
  readonly duplicadas: number;
  readonly jaArranjadosNaBusca: number;
  /** A KNOWN channel off the set on a SEARCH row — register 224's instrument. */
  readonly foraDoCanal: number;
  readonly consultadosNoDetalhe: number;
  /** Asked for, and no readable row came back under EXACTLY that number. */
  readonly ausentesNoDetalhe: number;
  /** Detail rows that name no package: the `null` sentinel, or an unusable number / `order_sn`. */
  readonly ilegiveisNoDetalhe: number;
  /** The FRESH row names a KNOWN channel off 1573's set — register 224's instrument too. */
  readonly foraDoCanalNoDetalhe: number;
  /**
   * The FRESH row's channel is `null` (absent or unreadable) — UNKNOWN, not off
   * the set: never enqueued (the eligibility refuses it), and kept out of the
   * register-224 warn, which it would otherwise fire on a schema drift.
   */
  readonly canalDesconhecidoNoDetalhe: number;
  /** Survivors left unread because the enqueue cap was reached. */
  readonly naoConsultadosPeloLimite: number;
  /** Every {@link FasePacote} key, zeros present. `programar` = the candidates. */
  readonly fases: Readonly<Record<FasePacote, number>>;
  /**
   * `fases['nfe-pendente']`, named as register 222's instrument: a package the
   * `invoice_pending: false` filter RETURNED whose fresh detail says pending.
   * `> 0` proves `false` means "no filter"; `0` proves nothing (R-o).
   */
  readonly nfePendenteNaBusca: number;
  readonly enfileiradosPacote: number;
  readonly enfileiradosPedido: number;
  /**
   * Absent-pedido orders NOT re-enqueued: today's code-3 failure row already
   * exists, so today's import already failed (step 6 of the header).
   */
  readonly pedidosComFalhaHoje: number;
  /**
   * Present-pedido packages NOT re-enqueued: today's code-30 failure row
   * already exists, so today's delivery is still failing (step 6 of the
   * header — PR #1758's review applied the code-3 bound to the code 30).
   */
  readonly pacotesComFalhaHoje: number;
  readonly truncada: boolean;
  readonly truncadaPor: TruncagemArranjo | null;
  /** `<class>: <detail>` of a contained failure (never Shopee's own text). */
  readonly error: string | null;
}

export interface ArranjoAutomaticoSweepResult {
  readonly enabled: boolean;
  /** Why the tick read nothing (`null` when it ran). */
  readonly motivo:
    | typeof MOTIVO_SWEEP_DESLIGADO
    | typeof MOTIVO_ARRANJO_DESLIGADO
    | typeof MOTIVO_TASKS_DESABILITADO
    | null;
  /**
   * Active contas with no `shop_id` (consent by main account) — counted, never
   * called, and NOT in {@link ArranjoAutomaticoSweepResult.contas}.
   */
  readonly semShopId: number;
  /**
   * Active contas whose stored refresh failed TERMINALLY — a dead grant only a
   * re-consent revives. Counted, never called, and NOT in `contas`.
   */
  readonly reconexaoPendente: number;
  /** A rate limit aborted the tick; the contas after it were not walked. */
  readonly interrompidoPorLimite: 'burst' | 'daily' | null;
  /**
   * {@link PRAZO_DO_TICK_ARRANJO_MS} was spent: the contas after the last one
   * started were not walked (the next tick starts again from the first).
   */
  readonly interrompidoPorPrazo: boolean;
  /** One entry per conta WALKED (a shop id, whatever the outcome), in order. */
  readonly contas: readonly ArranjoAutomaticoContaResult[];
}

/* -------------------------------------------------------------------------- */
/*                                  internals                                  */
/* -------------------------------------------------------------------------- */

/**
 * The ONE request, every page, every conta (D1 §1.2, R-i). The three filters
 * Shopee defaults are SENT: `invoice_pending`'s polarity is register 222, and
 * only a request we wrote down can be read against the counters.
 * `logistics_channel_ids` is the tuple itself, so the filter and the predicate
 * can never name different channels.
 */
const BUSCA_DE_ARRANJO = {
  pageSize: SHOPEE_SEARCH_PACKAGE_LIST_MAX_PAGE_SIZE,
  filtro: {
    packageStatus: SHOPEE_PACKAGE_STATUS_FILTRO.aProcessar,
    fulfillmentType: SHOPEE_FULFILLMENT_TYPE_FILTRO.vendedor,
    invoicePending: false,
    logisticsChannelIds: CANAIS_ARRANJO_AUTOMATICO,
  },
  ordenacao: { sortType: SHOPEE_PACKAGE_SORT.prazoDeEnvio, ascending: true },
} as const satisfies SearchPackageListParams;

/**
 * Zero for EVERY phase. `satisfies` makes the set total at compile time: a new
 * `FasePacote` member is an error here until it is counted, and an absent key
 * would be indistinguishable from an arm that never existed (step 8's rule).
 */
const FASES_ZERADAS = {
  'nfe-pendente': 0,
  'nao-pronto': 0,
  retido: 0,
  programar: 0,
  arranjado: 0,
  'janela-fechada': 0,
  inelegivel: 0,
  desconhecido: 0,
} as const satisfies Record<FasePacote, number>;

/** A fresh detail row, with the `order_sn` the string reader accepted. */
interface LinhaReconciliada {
  readonly linha: ShopeePackageDetailRow;
  readonly orderSn: string;
}

/** The mutable accumulator — so a failure mid-conta still reports what ran. */
interface Contagem {
  paginasLidas: number;
  totalInformado: number;
  linhas: number;
  ilegiveisNaBusca: number;
  duplicadas: number;
  jaArranjadosNaBusca: number;
  foraDoCanal: number;
  consultadosNoDetalhe: number;
  ausentesNoDetalhe: number;
  ilegiveisNoDetalhe: number;
  foraDoCanalNoDetalhe: number;
  canalDesconhecidoNoDetalhe: number;
  naoConsultadosPeloLimite: number;
  fases: Record<FasePacote, number>;
  enfileiradosPacote: number;
  enfileiradosPedido: number;
  pedidosComFalhaHoje: number;
  pacotesComFalhaHoje: number;
  truncadaPor: TruncagemArranjo | null;
}

function contagemVazia(): Contagem {
  return {
    paginasLidas: 0,
    totalInformado: 0,
    linhas: 0,
    ilegiveisNaBusca: 0,
    duplicadas: 0,
    jaArranjadosNaBusca: 0,
    foraDoCanal: 0,
    consultadosNoDetalhe: 0,
    ausentesNoDetalhe: 0,
    ilegiveisNoDetalhe: 0,
    foraDoCanalNoDetalhe: 0,
    canalDesconhecidoNoDetalhe: 0,
    naoConsultadosPeloLimite: 0,
    fases: { ...FASES_ZERADAS },
    enfileiradosPacote: 0,
    enfileiradosPedido: 0,
    pedidosComFalhaHoje: 0,
    pacotesComFalhaHoje: 0,
    truncadaPor: null,
  };
}

function resultadoDaConta(
  integracaoId: string,
  c: Contagem,
  error: string | null,
): ArranjoAutomaticoContaResult {
  return {
    integracaoId,
    paginasLidas: c.paginasLidas,
    totalInformado: c.totalInformado,
    linhas: c.linhas,
    ilegiveisNaBusca: c.ilegiveisNaBusca,
    duplicadas: c.duplicadas,
    jaArranjadosNaBusca: c.jaArranjadosNaBusca,
    foraDoCanal: c.foraDoCanal,
    consultadosNoDetalhe: c.consultadosNoDetalhe,
    ausentesNoDetalhe: c.ausentesNoDetalhe,
    ilegiveisNoDetalhe: c.ilegiveisNoDetalhe,
    foraDoCanalNoDetalhe: c.foraDoCanalNoDetalhe,
    canalDesconhecidoNoDetalhe: c.canalDesconhecidoNoDetalhe,
    naoConsultadosPeloLimite: c.naoConsultadosPeloLimite,
    fases: { ...c.fases },
    nfePendenteNaBusca: c.fases['nfe-pendente'],
    enfileiradosPacote: c.enfileiradosPacote,
    enfileiradosPedido: c.enfileiradosPedido,
    pedidosComFalhaHoje: c.pedidosComFalhaHoje,
    pacotesComFalhaHoje: c.pacotesComFalhaHoje,
    truncada: c.truncadaPor !== null,
    truncadaPor: c.truncadaPor,
    error,
  };
}

/**
 * A contained failure as text — ⚠️ never Shopee's own `message`: a
 * `ShopeeApiError`'s message carries it verbatim (`shopeeErrorFromEnvelope`),
 * and a refusal may quote the package or order it refused. Its `error` code
 * is the classification and is enough. Every other contained class builds its
 * message from our own text (a path, a status, an integração id, or — for a
 * transient enqueue, `ShopeeTasksTransientError` — a class, a code and an HTTP
 * status).
 */
function descreverErro(err: Error): string {
  if (err instanceof ShopeeApiError) return `${err.name}: ${err.code}`;
  return `${err.name}: ${err.message}`;
}

function loggerDe(deps: ArranjoAutomaticoSweepDeps): SweepLogger {
  return (
    deps.logger ?? {
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

async function clienteDaConta(
  db: Firestore,
  deps: ArranjoAutomaticoSweepDeps,
  integracaoId: string,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/**
 * Whether the conta's stored refresh failed TERMINALLY (step 2 of the header).
 *
 * The SAME fixed `current` document the token store reads, through the same
 * collection handle — read RAW rather than through the store's soft
 * `parseRead`, which would warn every tick on a legacy partial document (the
 * `core/contas.ts` reasoning: only one field is needed). The verdict is the
 * store's own reader, `falhaRefreshOf`, never a second spelling of the stamp:
 * a malformed stamp reads as NO failure, so the doubtful case is walked.
 */
async function aguardaReconexao(db: Firestore, integracaoId: string): Promise<boolean> {
  const snap = await credenciaisIntegracaoCollection
    .docRef(db, { integracaoId }, SHOPEE_CREDENCIAL_DOC_ID)
    .get();
  return snap.exists && falhaRefreshOf(snap.data() ?? {})?.terminal === true;
}

function emLotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

/**
 * Pages 1…{@link MAX_PAGINAS_ARRANJO_POR_CONTA} → the package numbers worth a
 * detail read, in Shopee's order (most urgent first), after the free triage.
 */
async function listarSobreviventes(
  client: ShopeeClient,
  c: Contagem,
  logger: SweepLogger,
  integracaoId: string,
): Promise<string[]> {
  const vistos = new Set<string>();
  const sobreviventes: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const pagina = await client.searchPackageList({
      ...BUSCA_DE_ARRANJO,
      // ⚠️ Spread-or-nothing: page 1 sends NO `cursor` key (Appendix B — accepted
      // on the SG wire), and the package refuses a `''` rather than sending it.
      ...(cursor === undefined ? {} : { cursor }),
    });
    c.paginasLidas += 1;
    if (c.paginasLidas === 1) c.totalInformado = pagina.pagination?.total_count ?? 0;

    for (const row of pagina.packages_list) {
      c.linhas += 1;
      // ⚠️ Through step 7's string reader — trimmed, and a blank or `"-"` (this
      // wire's absence sentinel) is NO package; a comma is refused too, because
      // the detail request joins the numbers by comma. Each of those, handed to
      // `getPackageDetail`, is a `ShopeeConfigError` — which RETHROWS, so one
      // odd row would fail every tick for every conta.
      const numero = row === null ? null : textoShopeeUtilizavel(row.package_number);
      if (row === null || numero === null || numero.includes(',')) {
        c.ilegiveisNaBusca += 1;
        continue;
      }
      if (vistos.has(numero)) {
        c.duplicadas += 1;
        continue;
      }
      vistos.add(numero);
      // ⚠️ `true` only: a `null` flag is NOT arranged (`faseEtiqueta.ts`, S22) —
      // the detail decides.
      if (arranjadoNaBusca(row)) {
        c.jaArranjadosNaBusca += 1;
        continue;
      }
      // ⚠️ Only a KNOWN channel is judged here; `null` (absent, unreadable) is
      // kept for the fresh row, which re-checks the channel anyway.
      if (
        row.logistics_channel_id !== null &&
        !ehCanalDeArranjoAutomatico(row.logistics_channel_id)
      ) {
        c.foraDoCanal += 1;
        continue;
      }
      sobreviventes.push(numero);
    }

    const paginacao = pagina.pagination;
    if (paginacao === null) {
      // The page never said the list ended. No rows ⇒ drained (the empty answer
      // is the common case); rows ⇒ a tail may exist that we cannot ask for.
      if (pagina.packages_list.length > 0) {
        c.truncadaPor = TRUNCAGEM_ARRANJO.paginacaoAusente;
        logger.warn('[shopee/arranjo-automatico] página sem paginação — conta truncada', {
          integracaoId,
          paginasLidas: c.paginasLidas,
        });
      }
      break;
    }
    // ⚠️ `more` is the ONLY terminator (strict boolean in the schema). Never the
    // row count, and never the cursor: Shopee answers `""` when `more` is false.
    if (!paginacao.more) break;
    const proximo = paginacao.next_cursor;
    if (proximo === null || proximo.trim() === '') {
      c.truncadaPor = TRUNCAGEM_ARRANJO.moreSemCursor;
      logger.warn('[shopee/arranjo-automatico] more=true sem next_cursor — conta truncada', {
        integracaoId,
        paginasLidas: c.paginasLidas,
      });
      break;
    }
    if (c.paginasLidas >= MAX_PAGINAS_ARRANJO_POR_CONTA) {
      c.truncadaPor = TRUNCAGEM_ARRANJO.paginas;
      break;
    }
    // VERBATIM and opaque — never trimmed, parsed or rebuilt.
    cursor = proximo;
  }

  return sobreviventes;
}

/**
 * One conta's walk: the list, the detail pre-filter, the enqueue. Counts into
 * `c` as it goes, so a contained failure mid-walk still reports what ran.
 */
async function varrerConta(
  db: Firestore,
  deps: ArranjoAutomaticoSweepDeps,
  logger: SweepLogger,
  client: ShopeeClient,
  integracaoId: string,
  shopId: number,
  c: Contagem,
): Promise<void> {
  const sobreviventes = await listarSobreviventes(client, c, logger, integracaoId);

  /** Pedido existence per `order_sn` — two packages of one order cost ONE read. */
  const existePedido = new Map<string, boolean>();
  /** Orders already given their ONE code 3 this tick (or found failed today). */
  const pedidosEnfileirados = new Set<string>();
  const lotes = emLotes(sobreviventes, SHOPEE_PACKAGE_DETAIL_MAX_PACKAGES);

  for (const [indice, lote] of lotes.entries()) {
    if (c.enfileiradosPacote + c.enfileiradosPedido >= MAX_ENFILEIRADOS_ARRANJO_POR_CONTA) {
      // Nothing more can be enqueued this tick: a detail read would buy only a
      // count. The rest waits for the next tick, most urgent first. (`??=`: a
      // page cap that already cut the list stays the reported cause.)
      c.truncadaPor ??= TRUNCAGEM_ARRANJO.enfileirados;
      c.naoConsultadosPeloLimite += lotes.slice(indice).reduce((t, l) => t + l.length, 0);
      break;
    }

    const detalhe = await client.getPackageDetail({ packageNumbers: lote });
    c.consultadosNoDetalhe += lote.length;
    // ⚠️ BY `package_number`, never by position: the answer may be shorter,
    // reordered, or carry a `null` sentinel in place of an unreadable row.
    // ⚠️ And by the RAW spelling, EXACTLY: the handler the code 30 feeds finds
    // its row with `r.package_number === packageNumber` (`rastrearPedido.ts`),
    // so a padded detail row is one it would never find — it would park the
    // task, every tick. Here the package stays `ausentesNoDetalhe` instead.
    // The usability check only decides what counts as ILLEGIBLE; a row without
    // a usable `order_sn` names nothing either (no pedido id derives from it).
    // First row wins, as the handler's `.find` does.
    const porNumero = new Map<string, LinhaReconciliada>();
    for (const row of detalhe.package_list) {
      const orderSn = row === null ? null : textoShopeeUtilizavel(row.order_sn);
      if (row === null || textoShopeeUtilizavel(row.package_number) === null || orderSn === null) {
        c.ilegiveisNoDetalhe += 1;
        continue;
      }
      if (!porNumero.has(row.package_number)) {
        porNumero.set(row.package_number, { linha: row, orderSn });
      }
    }

    for (const numero of lote) {
      const achada = porNumero.get(numero);
      if (achada === undefined) {
        c.ausentesNoDetalhe += 1;
        continue;
      }
      const { linha, orderSn } = achada;
      // ⚠️ THE eligibility — the hook's own first rungs (channel, then the
      // phase), never re-derived here (R-d; mutant 99's raw-text pin).
      const elegibilidade = elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(linha));
      if (elegibilidade.tipo === 'fora-do-canal') {
        // The verdict is the shared one; only the COUNTER is split. A `null`
        // channel is UNKNOWN, not off the set — register 224 asks the second.
        if (linha.logistics_channel_id === null) c.canalDesconhecidoNoDetalhe += 1;
        else c.foraDoCanalNoDetalhe += 1;
        continue;
      }
      if (elegibilidade.tipo === 'fase') {
        c.fases[elegibilidade.fase] += 1;
        continue;
      }
      c.fases.programar += 1;

      if (c.enfileiradosPacote + c.enfileiradosPedido >= MAX_ENFILEIRADOS_ARRANJO_POR_CONTA) {
        c.truncadaPor ??= TRUNCAGEM_ARRANJO.enfileirados;
        continue;
      }
      // Both identities as the readers returned them: the `order_sn` keys the
      // pedido id, and the package number — the search spelling, which the
      // detail row matched EXACTLY — makes the code 30's identity
      // (`30:<shop>:<package>`) the very string the handler will ask for.
      let existe = existePedido.get(orderSn);
      if (existe === undefined) {
        // A SKIP, not a guard (the `rastrearPedido.ts` precedent): the hook
        // re-reads everything it acts on.
        const pedidoId = makePedidoIdShopee(integracaoId, orderSn);
        existe = (await pedidoCollection.docRef(db, {}, pedidoId).get()).exists;
        existePedido.set(orderSn, existe);
      }
      if (existe) {
        // ⚠️ The DAY's stamp here too (PR #1758's review): a per-tick stamp gave
        // every tick a fresh doc id `30:<shop>:<package>:<nowMs>`, so a code-30
        // delivery that fails the same way every time (a frete merge the
        // pipeline parks, a transient that exhausts the queue) minted a new
        // failure row every five minutes and re-paid `get_package_detail`. With
        // the day's stamp the id is stable for the day, and ONE read says
        // whether today's delivery is still failing — the store DELETES a row
        // once it resolves, so a standing row means failed, deferred or parked.
        // Flooring is safe: the frete arm (codes 4/30/47) never reads the
        // envelope stamp — its clock is the pipeline's, its watermark the
        // package's own `update_time`.
        const sintetico = notificacaoSinteticaDePacote({
          shopId,
          orderSn,
          packageNumber: numero,
          nowMs: carimboDoDiaUtcMs(deps.nowMs),
          origem: 'arranjo-automatico',
        });
        const docId = docIdOf(sintetico);
        if (
          docId !== null &&
          (await notificacaoShopeeCollection.docRef(db, {}, docId).get()).exists
        ) {
          c.pacotesComFalhaHoje += 1;
          continue;
        }
        await deps.scheduler.enqueue(sintetico);
        c.enfileiradosPacote += 1;
      } else if (!pedidosEnfileirados.has(orderSn)) {
        // ONE per order, never per package: the import creates the pedido with
        // all its packages, and the next tick enqueues each of them.
        pedidosEnfileirados.add(orderSn);
        // ⚠️ The DAY's stamp, never `nowMs` (step 6 of the header): the doc id
        // is stable for the day, so ONE read says whether today's import
        // already failed — and a failure row standing means it did.
        const sintetico = notificacaoSinteticaDePedido({
          shopId,
          orderSn,
          nowMs: carimboDoDiaUtcMs(deps.nowMs),
          origem: 'arranjo-automatico',
        });
        const docId = docIdOf(sintetico);
        if (
          docId !== null &&
          (await notificacaoShopeeCollection.docRef(db, {}, docId).get()).exists
        ) {
          c.pedidosComFalhaHoje += 1;
          continue;
        }
        await deps.scheduler.enqueue(sintetico);
        c.enfileiradosPedido += 1;
      }
    }
  }

  if (c.foraDoCanal + c.foraDoCanalNoDetalhe > 0) {
    // Evidence that Shopee answered outside the channel filter (register 224) —
    // counts only, never which package.
    logger.warn('[shopee/arranjo-automatico] linhas FORA do filtro de canal', {
      integracaoId,
      foraDoCanal: c.foraDoCanal,
      foraDoCanalNoDetalhe: c.foraDoCanalNoDetalhe,
    });
  }
  if (
    c.ilegiveisNaBusca + c.ilegiveisNoDetalhe + c.ausentesNoDetalhe + c.canalDesconhecidoNoDetalhe >
    0
  ) {
    // ⚠️ A schema drift must not turn the PRIMARY signal into a silent no-op:
    // one type drift in ANY optional field nulls a whole detail row, so a Turbo
    // package Shopee will auto-cancel would simply never be enqueued. Counts
    // only — never which package.
    logger.warn(
      '[shopee/arranjo-automatico] linhas ilegíveis ou ausentes — pacotes não avaliados',
      {
        integracaoId,
        ilegiveisNaBusca: c.ilegiveisNaBusca,
        ilegiveisNoDetalhe: c.ilegiveisNoDetalhe,
        ausentesNoDetalhe: c.ausentesNoDetalhe,
        canalDesconhecidoNoDetalhe: c.canalDesconhecidoNoDetalhe,
      },
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                  the tick                                   */
/* -------------------------------------------------------------------------- */

/**
 * One tick: the three gates, then every ACTIVE Shopee conta, contained per
 * conta — except a rate limit, which ends the tick, and the tick's own budget,
 * which stops it starting another.
 */
export async function runShopeeArranjoAutomaticoSweep(
  db: Firestore,
  deps: ArranjoAutomaticoSweepDeps,
): Promise<ArranjoAutomaticoSweepResult> {
  // The gates, FIRST, in this order — off ⇒ nothing is read at all.
  const motivo = arranjoSweepDesligado()
    ? MOTIVO_SWEEP_DESLIGADO
    : arranjoAutomaticoDesligado()
      ? MOTIVO_ARRANJO_DESLIGADO
      : shopeeTasksDesabilitado()
        ? MOTIVO_TASKS_DESABILITADO
        : null;
  if (motivo !== null) {
    return {
      enabled: false,
      motivo,
      semShopId: 0,
      reconexaoPendente: 0,
      interrompidoPorLimite: null,
      interrompidoPorPrazo: false,
      contas: [],
    };
  }

  const logger = loggerDe(deps);
  // ⚠️ ELAPSED wall clock, from HERE, through the injected reader.
  const agora = deps.agoraMs ?? Date.now;
  const inicioMs = agora();
  // The ONE `(tipo, ativo)` enumeration (`core/contas.ts` — its index exists).
  const ativas = await listarContasShopeeAtivas(db);

  const contas: ArranjoAutomaticoContaResult[] = [];
  let semShopId = 0;
  let reconexaoPendente = 0;
  let interrompidoPorLimite: 'burst' | 'daily' | null = null;
  let interrompidoPorPrazo = false;

  for (const [indice, { integracaoId, shopId }] of ativas.entries()) {
    if (shopId === null) {
      // Main-account consent: nothing shop-signed can run. A documented state,
      // not a failure — counted, never called.
      semShopId += 1;
      continue;
    }

    const decorridoMs = agora() - inicioMs;
    if (decorridoMs >= PRAZO_DO_TICK_ARRANJO_MS) {
      // Stop STARTING contas: the summary still gets written, and what was left
      // is named rather than lost with the instance.
      interrompidoPorPrazo = true;
      logger.warn(
        '[shopee/arranjo-automatico] prazo do tick esgotado — contas restantes não varridas',
        {
          decorridoMs,
          contasNaoVarridas: ativas.length - indice,
        },
      );
      break;
    }

    const c = contagemVazia();
    try {
      // ⚠️ BEFORE the client: a dead grant costs this one read, never a lease,
      // a refresh POST and a release.
      if (await aguardaReconexao(db, integracaoId)) {
        reconexaoPendente += 1;
        continue;
      }
      const client = await clienteDaConta(db, deps, integracaoId);
      await varrerConta(db, deps, logger, client, integracaoId, shopId, c);
      contas.push(resultadoDaConta(integracaoId, c, null));
    } catch (err) {
      // ⚠️ FIRST: it extends `ShopeeApiError`, so the shared boundary below
      // would contain it and walk on into the same per-APP quota.
      if (err instanceof ShopeeRateLimitError) {
        contas.push(resultadoDaConta(integracaoId, c, descreverErro(err)));
        interrompidoPorLimite = err.kind;
        logger.warn('[shopee/arranjo-automatico] limite da Shopee — tick interrompido', {
          integracaoId,
          limite: err.kind,
          contasNaoVarridas: ativas.length - indice - 1,
        });
        break;
      }
      // `ShopeeConfigError` is NOT in the boundary: ours, so the tick fails. A
      // transient enqueue failure is, as the real scheduler's
      // `ShopeeTasksTransientError`; the raw SDK classes are not.
      if (!erroContidoPorConta(err)) throw err;
      const descricao = descreverErro(err);
      logger.warn('[shopee/arranjo-automatico] conta contida após falha', {
        integracaoId,
        erro: descricao,
      });
      contas.push(resultadoDaConta(integracaoId, c, descricao));
    }
  }

  return {
    enabled: true,
    motivo: null,
    semShopId,
    reconexaoPendente,
    interrompidoPorLimite,
    interrompidoPorPrazo,
    contas,
  };
}
