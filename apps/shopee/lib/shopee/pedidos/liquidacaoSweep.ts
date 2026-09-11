/**
 * The WEEKLY Shopee **settlement sweep** (master-plan step 6, #1514) — the only
 * thing in this channel that ever learns what the marketplace actually paid.
 *
 * Shopee ships **no payment push and no payment resource**. The order import
 * writes the pagamento from `get_order_detail` + `get_escrow_detail` on the
 * code-3 task, but `escrow_amount` is documented to MOVE until the order
 * completes, and `escrow_release_time` — the one field that says the money
 * really left — is exposed by exactly ONE endpoint, `get_escrow_list`. So the
 * final figure cannot arrive by event; it has to be fetched, and this is the
 * schedule that fetches it.
 *
 * Per ACTIVE conta, per tick: page `get_escrow_list` over a release-time window
 * from a durable cursor (`liquidacaoShopee/{integracaoId}`, MILLISECONDS), read
 * the fresh escrow of every row whose pagamento exists, and hand it to
 * {@link liquidarPagamentoShopee}. A row whose pagamento is not here yet is
 * PARKED and re-driven through the normal import path with a synthetic code 3.
 *
 * ## The window, and why the cursor advances the way it does
 *
 *     deMs  = janela?.deMs  ?? pendingFrom ?? (cursorMs != null ? cursorMs − OVERLAP : now − LOOKBACK)
 *     ateMs = janela?.ateMs ?? pendingTo   ?? min(deMs + MAX_WINDOW, now)
 *
 * ⚠️ `ateMs` is measured from `deMs`, **never from the cursor** — the
 * `orderBackfill.ts` rule, for the same reason (`cursor + MAX` plus the overlap
 * is a wider window than the one we mean). Both bounds are floored to seconds
 * once, at the package boundary.
 *
 * ⚠️ A DEGENERATE window (`timeToS < timeFromS` after flooring) skips the conta
 * and makes no call. The test is `<` and not `<=`: a ZERO-WIDTH window is legal
 * on this page — `get_escrow_list` refuses only "start date cannot be later than
 * the end date", unlike `get_order_list` — and a conta already drained up to
 * `now` must be able to ask for it rather than being told it made a caller
 * error.
 *
 *  - **drained** (`more === false`) ⇒ `cursorMs = max(stored, ateMs)` and the
 *    pending triple is cleared. The cursor advances to the WINDOW's upper bound,
 *    never to `nowMs`: the band above it was never queried.
 *  - **truncated** (the page cap or the per-tick liquidation budget) ⇒ NOTHING
 *    advances and `{ deMs, ateMs, próximaPágina }` is persisted. This page has no
 *    cursor — paging is by `page_no` — so the resume key is a page NUMBER, and a
 *    page number is meaningless against a recomputed window. The three are
 *    written and cleared together.
 *  - **page-repeat guard** ⇒ a NON-EMPTY page that contributes ZERO new
 *    `order_sn` while `more === true` means `page_no` is being ignored. The tick
 *    stops, names it in `lastError`, CLEARS `pendingPageNo` (so the next tick
 *    restarts the window from page 1) and keeps the window. An EMPTY page with
 *    `more: true` keeps paging — that is the documented behaviour of Shopee's
 *    list pages and the explicit opposite of ML's `missedFeedsSweep` rule.
 *  - **contained conta error** ⇒ `{ lastSweepAtMs, lastError }` only. A
 *    30-second outage must not skip 300 orders and then advance past them.
 *
 * ⚠️ `orderBackfill.ts`'s "resuming + `ShopeeApiError` ⇒ clear the pending
 * cursor" exception is deliberately NOT ported. There the resume key is an
 * OPAQUE cursor Shopee issued and can refuse; here it is a page number we
 * computed ourselves, and clearing it would restart a truncated window from
 * page 1 on every tick of an outage.
 *
 * ## Writes and races (root rule 7 — tier 0 on the cursor)
 *
 * Exactly ONE `merge` per conta per tick onto `liquidacaoShopee/{id}`, and this
 * sweep is that document's only writer — so there is nothing to lose a race
 * against and this module runs no Firestore transaction of its own. (Said
 * WITHOUT the API's identifier on purpose: the transaction inventory greps every
 * source file for the literal, and a comment-only mention would demand an
 * inventory line for a module that has none. The settlement WRITE lives in
 * `liquidarPagamento.ts` and carries its own entry.)
 *
 * ## `pendentes` — the replay list, and why it is READ as well as written
 *
 * A released row is visible only in the windows that COVER its
 * `escrow_release_time`, so once the cursor moves past it the row never comes
 * back. That is why a pendente stores the whole row rather than an id, and it is
 * why every tick REPLAYS the stored list before it pages anything: the pedido an
 * earlier tick asked for by synthetic code 3 has usually arrived by now, and the
 * list is the only place its payout still exists. A row that settles leaves the
 * list; one whose pagamento is still absent gets one more attempt and one more
 * synthetic push, and past {@link MAX_TENTATIVAS} it is DROPPED with a warning —
 * four weeks of a pedido that never arrives is a human question, not a retry.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  liquidacaoShopeeCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  MOTIVO_PENDENTE_SHOPEE,
  type LiquidacaoPendente,
  type MotivoPendenteShopee,
} from '@delfrance/schemas';
import {
  ShopeeApiError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  type ShopeeClient,
  type ShopeeEscrowDetail,
  type ShopeeEscrowListRow,
} from '@delfrance/integrations-shopee';

import { listarContasShopeeAtivas } from '../core/contas';
import { erroContidoPorConta } from '../core/containment';
import { loadShopeeContext } from '../core/shopee';
import { notificacaoSinteticaDePedido } from '../notificacoes/notificacaoSintetica';
import type { ShopeeTaskScheduler } from '../shopeeTasks';
import { SHOPEE_ERRO_ORDER_NOT_FOUND } from './importarPedido';
import { makePagamentoIdShopee, makePedidoIdShopee } from './orderIds';
import {
  liquidarPagamentoShopee,
  preverLiquidacaoShopee,
  type PrevisaoLiquidacaoShopee,
} from './liquidarPagamento';

const MS_POR_SEGUNDO = 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * How far BEFORE the stored cursor each window starts.
 *
 * ONE DAY, an order of magnitude above `orderBackfill.ts`'s five minutes,
 * because the clock being overlapped is different: `escrow_release_time` has
 * second resolution but Shopee decides WHEN it stamps it, a weekly tick can slip
 * by hours, and a row missed here is money that never comes back into any
 * window. The band costs nothing — a re-covered row settles to
 * `ignorado-sem-mudanca`, which writes no document at all.
 */
export const OVERLAP_MS = DIA_MS;

/**
 * The first window of a conta that has never drained one.
 *
 * 30 days, not the backfill's 24 hours: escrow releases lag delivery by roughly
 * 7–15 days, so a one-day first window would see nothing at all and the conta
 * would spend a month crawling forward a week at a time.
 */
export const INITIAL_LOOKBACK_MS = 30 * DIA_MS;

/**
 * The widest window this sweep will ask for.
 *
 * ⚠️ **Self-imposed, and a LITERAL on purpose.** `get_escrow_list` documents no
 * maximum window at all, so there is no package constant to derive this from and
 * `packages/integrations/shopee` deliberately declares none — a bound invented
 * here must not be able to masquerade as Shopee's. It exists so a conta that has
 * been off for a year walks forward in bounded steps instead of asking for a
 * year of releases in one call.
 */
export const MAX_WINDOW_MS = 15 * DIA_MS;

/** Rows per `get_escrow_list` call — the documented maximum, fewest calls. */
export const PAGE_SIZE = 100;

/** 20 pages ⇒ 2 000 LIST rows per conta per tick. */
export const MAX_PAGES_PER_TICK = 20;

/**
 * Settlement attempts per TICK, shared across contas.
 *
 * ⚠️ This, not the page cap, is the real budget. Each attempt is one
 * `get_escrow_detail` plus one transaction — roughly 1.2 s — so 20 × 100 rows
 * could never fit the trigger's 540 s ceiling, and a tick that timed out
 * mid-window would advance nothing and repeat itself for ever. 300 attempts plus
 * 20 list pages is ≈ 370 s, which leaves real margin.
 */
export const MAX_LIQUIDACOES_POR_TICK = 300;

/**
 * Synthetic code-3 pushes per TICK, shared across contas — the only
 * pedido-CREATING side effect this sweep has, so it is the one that is capped
 * hardest. A first tick on a fresh conta can legitimately see hundreds of
 * released orders it has never imported; importing 50 a week is recovery,
 * importing 2 000 at once is an incident.
 */
export const MAX_SINTETICAS_POR_TICK = 50;

/**
 * Parked rows kept per conta. An unbounded array inside a document is a 1 MiB
 * cliff, and the schema deliberately does not declare this cap so a document
 * that already exceeds it still parses and can be trimmed.
 */
export const MAX_PENDENTES = 200;

/** Four weekly attempts. Past this a parked row is dropped with a warning. */
export const MAX_TENTATIVAS = 4;

/**
 * Detailed per-order log lines per PROCESS INSTANCE. Past it only the anomalous
 * ratios still print — see {@link razaoPayoutSobreEscrow}.
 */
export const LOG_LIQUIDACAO_DETALHADA_MAX = 20;

export const MOTIVO_SEM_SHOP_ID =
  'conta conectada por conta principal (sem shop_id) — nada a assinar';
export const MOTIVO_JANELA_DEGENERADA = 'janela negativa após o floor — nada a consultar';
export const MOTIVO_PAGINA_REPETIDA = 'more=true com página repetida — page_no ignorado';

export interface EscrowSettlementLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface EscrowSettlementDeps {
  /** ONE clock read for the whole tick, MILLISECONDS. Never re-read in here. */
  readonly nowMs: number;
  readonly scheduler: ShopeeTaskScheduler;
  readonly logger?: EscrowSettlementLogger;
  /**
   * The client seam — ONE thing, because one thing is all the sweep needs from a
   * conta's context. Default: `loadShopeeContext(db, id).createShopClient()`.
   */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /** CLI scope: run only these integrações (mirrors `ExpiracaoSweepDeps.apenasShopIds`). */
  readonly apenasIntegracoes?: readonly string[];
  /**
   * An explicit window, in MS. ⚠️ It OVERRIDES the stored cursor and the pending
   * triple, and a drained run under it advances `cursorMs` by NOTHING: an
   * operator-chosen window says nothing about the ground between the cursor and
   * that window, and `max(stored, ateMs)` would claim it.
   */
  readonly janela?: { readonly deMs: number; readonly ateMs: number };
  /** `false` ⇒ the cursor document is NOT written at all. Default `true`. */
  readonly persistirCursor?: boolean;
}

export interface LiquidacaoContaResult {
  readonly integracaoId: string;
  readonly shopId: number | null;
  /** `null` ⇒ processed; a named reason ⇒ skipped without any Shopee call. */
  readonly pulada: string | null;
  readonly janela: { deMs: number; ateMs: number } | null;
  readonly paginas: number;
  /** LIST rows seen, `null` sentinels included. */
  readonly linhas: number;
  readonly liquidados: number;
  readonly semMudanca: number;
  readonly obsoletos: number;
  /** Rows parked (or re-parked) on the cursor document this tick. */
  readonly pendentes: number;
  /** Parked rows removed this tick — past {@link MAX_TENTATIVAS}, or evicted by {@link MAX_PENDENTES}. */
  readonly pendentesDescartados: number;
  readonly sinteticas: number;
  /** Rows skipped at the escrow read: `order_not_found`, or an unreadable body. */
  readonly puladas: number;
  /** `null` rows — the per-element schema sentinel. */
  readonly ilegiveis: number;
  readonly duplicadas: number;
  readonly retomada: boolean;
  readonly drenada: boolean;
  readonly truncada: boolean;
  readonly error: string | null;
}

export interface EscrowSettlementResult {
  /** Active contas skipped for having no `shop_id` — counted, never written. */
  readonly semShopId: number;
  readonly contas: readonly LiquidacaoContaResult[];
}

/* -------------------------------------------------------------------------- */
/*                             per-instance log memo                           */
/* -------------------------------------------------------------------------- */

let linhasDetalhadas = 0;

/**
 * Forget how many detailed per-order lines this instance has printed.
 *
 * ⚠️ Exists for the SUITES, and for a real hazard rather than tidiness: the
 * counter is module state, so a test asserting "this order printed a detail
 * line" would silently assert nothing once an earlier test in the same file had
 * spent the budget. `beforeEach` calls it. (`esquecerLogsDePagamentoShopee` is
 * the sibling precedent.)
 */
export function esquecerLogsDeLiquidacaoShopee(): void {
  linhasDetalhadas = 0;
}

/**
 * `payout_amount ÷ escrow` — the instrument for settle-live register item 21.
 *
 * Shopee's own page contradicts itself about the unit of `payout_amount`: the
 * parameter table prints a float (`"5733.04"`) and the rendered sample on the
 * same page prints `57334`. Nothing converts it anywhere, so this ratio is what
 * answers it from real data: **~1 means units, ~100 means cents.**
 */
export function razaoPayoutSobreEscrow(
  payoutAmount: number | null,
  escrow: ShopeeEscrowDetail,
): number | null {
  const oi = escrow.order_income;
  const base = oi == null ? null : (oi.escrow_amount_after_adjustment ?? oi.escrow_amount);
  if (payoutAmount == null || base == null || base === 0) return null;
  return Number((payoutAmount / base).toFixed(4));
}

/* -------------------------------------------------------------------------- */
/*                                  plumbing                                   */
/* -------------------------------------------------------------------------- */

function loggerDe(deps: EscrowSettlementDeps): EscrowSettlementLogger {
  return (
    deps.logger ?? {
      info: (msg: string, meta?: Record<string, unknown>): void => {
        // eslint-disable-next-line no-console -- one aggregate line per conta per tick
        if (meta === undefined) console.info(msg);
        // eslint-disable-next-line no-console -- one aggregate line per conta per tick
        else console.info(msg, meta);
      },
      warn: (msg: string, meta?: Record<string, unknown>): void => {
        if (meta === undefined) console.warn(msg);
        else console.warn(msg, meta);
      },
    }
  );
}

function numericField(data: Record<string, unknown> | undefined, key: string): number | null {
  const v = data?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function clienteDaConta(
  db: Firestore,
  deps: EscrowSettlementDeps,
  integracaoId: string,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/** The cursor document, read once per conta per tick. */
async function lerEstado(
  db: Firestore,
  integracaoId: string,
): Promise<Record<string, unknown> | undefined> {
  const snap = await liquidacaoShopeeCollection.docRef(db, {}, integracaoId).get();
  return snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined;
}

/** A stored pending window is only usable with BOTH of its bounds. */
interface Pendencia {
  readonly deMs: number;
  readonly ateMs: number;
  readonly pageNo: number | null;
}

function pendenciaValida(st: Record<string, unknown> | undefined): Pendencia | null {
  const deMs = numericField(st, 'pendingWindowFromMs');
  const ateMs = numericField(st, 'pendingWindowToMs');
  if (deMs == null || ateMs == null) return null;
  return { deMs, ateMs, pageNo: numericField(st, 'pendingPageNo') };
}

/**
 * The parked rows, read DEFENSIVELY off the raw document: a row that does not
 * carry a usable `orderSn` is dropped on sight rather than replayed against a
 * pagamento id derived from nothing.
 */
function pendentesArmazenados(st: Record<string, unknown> | undefined): LiquidacaoPendente[] {
  const bruto = st?.pendentes;
  if (!Array.isArray(bruto)) return [];
  const linhas: LiquidacaoPendente[] = [];
  for (const item of bruto) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const orderSn = typeof row.orderSn === 'string' && row.orderSn.length > 0 ? row.orderSn : null;
    if (orderSn === null) continue;
    const motivo =
      row.motivo === MOTIVO_PENDENTE_SHOPEE.semPagamento
        ? MOTIVO_PENDENTE_SHOPEE.semPagamento
        : MOTIVO_PENDENTE_SHOPEE.semPedido;
    linhas.push({
      orderSn,
      payoutAmount: numericField(row, 'payoutAmount'),
      escrowReleaseTimeS: numericField(row, 'escrowReleaseTimeS'),
      motivo,
      tentativas: numericField(row, 'tentativas') ?? 0,
    });
  }
  return linhas;
}

/**
 * The window this conta asks for, and where inside it to resume.
 *
 * ONE implementation, shared by the real tick and by the rehearsal CLI's dry
 * run — the alternative is two window derivations that agree in a comment.
 *
 * ⚠️ `override` (the CLI's `--de/--ate`) REPLACES both the cursor and the
 * pending triple: a hand-picked window is not a resume.
 */
export function janelaDeLiquidacao(
  st: Record<string, unknown> | undefined,
  nowMs: number,
  override?: { readonly deMs: number; readonly ateMs: number },
): { deMs: number; ateMs: number; pageNo: number; retomada: boolean } {
  const cursorMs = numericField(st, 'cursorMs');
  const pendencia = override === undefined ? pendenciaValida(st) : null;
  const deMs =
    override?.deMs ??
    pendencia?.deMs ??
    (cursorMs != null ? cursorMs - OVERLAP_MS : nowMs - INITIAL_LOOKBACK_MS);
  const ateMs = override?.ateMs ?? pendencia?.ateMs ?? Math.min(deMs + MAX_WINDOW_MS, nowMs);
  return { deMs, ateMs, pageNo: pendencia?.pageNo ?? 1, retomada: pendencia != null };
}

/* -------------------------------------------------------------------------- */
/*                              one conta, one tick                            */
/* -------------------------------------------------------------------------- */

/** Budgets shared by every conta of ONE tick. */
interface OrcamentoDoTick {
  liquidacoes: number;
  sinteticas: number;
}

interface VarreduraDaConta {
  readonly janela: { deMs: number; ateMs: number } | null;
  readonly pulada: string | null;
  readonly paginas: number;
  readonly linhas: number;
  readonly liquidados: number;
  readonly semMudanca: number;
  readonly obsoletos: number;
  readonly pendentes: number;
  readonly pendentesDescartados: number;
  readonly sinteticas: number;
  readonly puladas: number;
  readonly ilegiveis: number;
  readonly duplicadas: number;
  readonly retomada: boolean;
  readonly drenada: boolean;
  readonly truncada: boolean;
}

async function varrerConta(
  db: Firestore,
  deps: EscrowSettlementDeps,
  logger: EscrowSettlementLogger,
  orcamento: OrcamentoDoTick,
  integracaoId: string,
  shopId: number,
  st: Record<string, unknown> | undefined,
): Promise<VarreduraDaConta> {
  const cursorMs = numericField(st, 'cursorMs');
  const {
    deMs,
    ateMs,
    pageNo: primeiraPagina,
    retomada,
  } = janelaDeLiquidacao(st, deps.nowMs, deps.janela);

  // ms → s ONCE, floored on BOTH sides.
  const timeFromS = Math.floor(deMs / MS_POR_SEGUNDO);
  const timeToS = Math.floor(ateMs / MS_POR_SEGUNDO);

  let liquidados = 0;
  let semMudanca = 0;
  let obsoletos = 0;
  let sinteticas = 0;
  let puladas = 0;
  let ilegiveis = 0;
  let duplicadas = 0;
  let paginas = 0;
  let linhas = 0;
  let drenada = false;
  let truncada = false;
  let motivoTruncagem: string | null = null;
  let proximaPagina: number | null = null;
  let listaMudou = false;

  const pendentes = pendentesArmazenados(st);
  let descartados = 0;
  // In-tick dedup, shared by the replay and the paging: the same order twice in
  // one tick is one settlement. STRICT `===` on the raw `order_sn`, no fold.
  const vistos = new Set<string>();

  /** Park (or re-park) one row; `true` when it stayed on the list. */
  const registrarPendente = (
    orderSn: string,
    payoutAmount: number | null,
    escrowReleaseTimeS: number | null,
    motivo: MotivoPendenteShopee,
  ): void => {
    listaMudou = true;
    const i = pendentes.findIndex((p) => p.orderSn === orderSn);
    const tentativas = (i === -1 ? 0 : pendentes[i]!.tentativas) + 1;
    if (tentativas > MAX_TENTATIVAS) {
      if (i !== -1) pendentes.splice(i, 1);
      descartados += 1;
      // ⚠️ NO payout value on this line: it is the one warn an operator reads
      // out of context, and a settlement figure is not theirs to paste around.
      logger.warn('[shopee/liquidacao] pendente descartado após o máximo de tentativas', {
        integracaoId,
        orderSn,
        tentativas,
        motivo,
      });
      return;
    }
    const linha: LiquidacaoPendente = {
      orderSn,
      payoutAmount,
      escrowReleaseTimeS,
      motivo,
      tentativas,
    };
    if (i === -1) pendentes.push(linha);
    else pendentes[i] = linha;
  };

  const enfileirarSintetica = async (orderSn: string): Promise<void> => {
    if (orcamento.sinteticas >= MAX_SINTETICAS_POR_TICK) return;
    orcamento.sinteticas += 1;
    sinteticas += 1;
    await deps.scheduler.enqueue(
      notificacaoSinteticaDePedido({
        shopId,
        orderSn,
        nowMs: deps.nowMs,
        origem: 'liquidacao',
      }),
    );
  };

  /**
   * One row, from the list or from the replay list.
   *
   * `'orcamento'` means the per-tick liquidation budget was spent BEFORE this
   * row was attempted — the caller truncates on it.
   */
  const processarLinha = async (
    client: ShopeeClient,
    orderSn: string,
    payoutAmount: number | null,
    escrowReleaseTimeS: number | null,
  ): Promise<'feita' | 'duplicada' | 'orcamento'> => {
    if (vistos.has(orderSn)) return 'duplicada';

    const pedidoId = makePedidoIdShopee(integracaoId, orderSn);
    const pagamentoId = makePagamentoIdShopee(integracaoId, orderSn);

    // ⚠️ The PAGAMENTO is read first and the PEDIDO only on the absent branch,
    // where it is the only thing that tells `sem-pedido` from `sem-pagamento`.
    // The settled steady state is "the pagamento is there", and that state must
    // cost ONE read.
    const pagSnap = await pagamentoCollection.docRef(db, { pedidoId }, pagamentoId).get();
    if (!pagSnap.exists) {
      vistos.add(orderSn);
      const pedSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
      const motivo = pedSnap.exists
        ? MOTIVO_PENDENTE_SHOPEE.semPagamento
        : MOTIVO_PENDENTE_SHOPEE.semPedido;
      registrarPendente(orderSn, payoutAmount, escrowReleaseTimeS, motivo);
      await enfileirarSintetica(orderSn);
      return 'feita';
    }

    if (orcamento.liquidacoes >= MAX_LIQUIDACOES_POR_TICK) return 'orcamento';
    vistos.add(orderSn);
    orcamento.liquidacoes += 1;

    let escrow: ShopeeEscrowDetail;
    try {
      escrow = await client.getEscrowDetail({ orderSn });
    } catch (err) {
      // ⚠️ The two subclasses that must NEVER be skipped per row are tested
      // FIRST — both extend `ShopeeApiError`, so the `order_not_found` arm below
      // would otherwise decide their fate by a string comparison. Rethrown to
      // the conta boundary, which contains them and leaves the cursor alone.
      if (err instanceof ShopeeReauthRequiredError) throw err;
      if (err instanceof ShopeeRateLimitError) throw err;
      if (err instanceof ShopeeApiError && err.code === SHOPEE_ERRO_ORDER_NOT_FOUND) {
        // A permanent provider fact about ONE order, and never retried: the
        // remedy is the CLI's `--order-sn`, not another week of the same answer.
        puladas += 1;
        logger.warn('[shopee/liquidacao] escrow negado — order_not_found', {
          integracaoId,
          orderSn,
        });
        return 'feita';
      }
      if (err instanceof ShopeeSchemaError) {
        // Field PATHS only — an escrow body is money, and this line is read by
        // operators.
        puladas += 1;
        logger.warn('[shopee/liquidacao] escrow ilegível — linha pulada', {
          integracaoId,
          orderSn,
          campos: err.campos,
        });
        return 'feita';
      }
      // Anything else is the conta's problem, not this row's: it rethrows, the
      // conta is contained and the cursor does NOT advance. A 30-second outage
      // must not skip 300 orders and then declare the window drained.
      throw err;
    }

    const r = await liquidarPagamentoShopee(db, {
      pedidoId,
      contaId: integracaoId,
      orderSn,
      escrow,
      escrowReleaseTimeS,
      payoutAmount,
      nowMs: deps.nowMs,
    });

    if (r.acao === 'liquidado') {
      liquidados += 1;
      const razao = razaoPayoutSobreEscrow(payoutAmount, escrow);
      const dentroDaFaixa = razao != null && razao >= 0.5 && razao <= 2;
      if (linhasDetalhadas < LOG_LIQUIDACAO_DETALHADA_MAX || !dentroDaFaixa) {
        linhasDetalhadas += 1;
        logger.info('[shopee/liquidacao] pedido liquidado', {
          integracaoId,
          orderSn,
          // RAW — nothing converts `payout_amount`, and the ratio beside it is
          // what answers the unit question (register item 21).
          payoutAmount,
          escrowAmount: escrow.order_income?.escrow_amount ?? null,
          escrowAmountAfterAdjustment: escrow.order_income?.escrow_amount_after_adjustment ?? null,
          tarifas: r.campos.includes('tarifas'),
          razaoPayoutSobreEscrow: razao,
        });
      }
    } else if (r.acao === 'ignorado-obsoleto') {
      obsoletos += 1;
    } else if (r.acao === 'ignorado-sem-mudanca') {
      semMudanca += 1;
    } else {
      // The pagamento vanished between the read above and the transaction — an
      // operator delete, racing this tick. Park it like any absent one.
      registrarPendente(
        orderSn,
        payoutAmount,
        escrowReleaseTimeS,
        MOTIVO_PENDENTE_SHOPEE.semPagamento,
      );
      await enfileirarSintetica(orderSn);
    }

    // A row that settled (or was definitively ignored) leaves the replay list.
    const i = pendentes.findIndex((p) => p.orderSn === orderSn);
    if (i !== -1 && r.acao !== 'ignorado-sem-pagamento') {
      pendentes.splice(i, 1);
      listaMudou = true;
    }
    return 'feita';
  };

  const gravarEstado = async (): Promise<void> => {
    if (deps.persistirCursor === false) return;
    const patch: Record<string, unknown> = {
      lastSweepAtMs: deps.nowMs,
      lastError: motivoTruncagem,
    };
    if (drenada && deps.janela === undefined) {
      // Monotone by construction: two overlapping ticks can only re-cover.
      // ⚠️ Skipped entirely under an explicit `janela`: an operator-chosen
      // window says nothing about the ground between the cursor and it.
      patch.cursorMs = cursorMs == null ? ateMs : Math.max(cursorMs, ateMs);
    }
    if (drenada) {
      patch.pendingWindowFromMs = null;
      patch.pendingWindowToMs = null;
      patch.pendingPageNo = null;
    } else if (truncada) {
      patch.pendingWindowFromMs = deMs;
      patch.pendingWindowToMs = ateMs;
      // `null` on the page-repeat guard: the next tick restarts from page 1,
      // because a `page_no` Shopee is ignoring is not a resume key.
      patch.pendingPageNo = proximaPagina;
    }
    if (listaMudou || pendentes.length > MAX_PENDENTES) {
      if (pendentes.length > MAX_PENDENTES) {
        // Oldest-first: the front of the array is the row that has been waiting
        // longest, and a row that old is the least likely to ever settle.
        descartados += pendentes.length - MAX_PENDENTES;
        pendentes.splice(0, pendentes.length - MAX_PENDENTES);
      }
      patch.pendentes = pendentes;
    }
    await liquidacaoShopeeCollection.merge(db, {}, integracaoId, patch);
  };

  if (timeToS < timeFromS) {
    // Reachable only with a clock that moved backwards or a cursor from the
    // future. Named here rather than handed to the package, whose
    // `ShopeeConfigError` would be a rethrow — and would read like a Shopee
    // problem if it were not.
    logger.warn('[shopee/liquidacao] janela degenerada — conta pulada', {
      integracaoId,
      deMs,
      ateMs,
    });
    return {
      janela: null,
      pulada: MOTIVO_JANELA_DEGENERADA,
      paginas: 0,
      linhas: 0,
      liquidados: 0,
      semMudanca: 0,
      obsoletos: 0,
      pendentes: 0,
      pendentesDescartados: 0,
      sinteticas: 0,
      puladas: 0,
      ilegiveis: 0,
      duplicadas: 0,
      retomada,
      drenada: false,
      truncada: false,
    };
  }

  const client = await clienteDaConta(db, deps, integracaoId);

  /* ------------------------- (1) replay what is parked ---------------------- */

  let orcamentoEstourado = false;
  for (const parado of [...pendentes]) {
    const r = await processarLinha(
      client,
      parado.orderSn,
      parado.payoutAmount,
      parado.escrowReleaseTimeS,
    );
    if (r === 'orcamento') {
      orcamentoEstourado = true;
      break;
    }
  }

  /* ------------------------------ (2) the window ---------------------------- */

  let pageNo = primeiraPagina;
  if (orcamentoEstourado) {
    truncada = true;
    proximaPagina = pageNo;
  }

  while (!truncada) {
    const page = await client.getEscrowList({
      releaseTimeFromS: timeFromS,
      releaseTimeToS: timeToS,
      pageSize: PAGE_SIZE,
      pageNo,
    });
    paginas += 1;

    const linhasDaPagina = page.escrow_list.length;
    let novos = 0;
    for (const bruto of page.escrow_list as readonly (ShopeeEscrowListRow | null)[]) {
      linhas += 1;
      if (bruto === null) {
        // The per-element schema sentinel: ONE unreadable row must not
        // head-of-line-block a week of money for every other order.
        ilegiveis += 1;
        continue;
      }
      const r = await processarLinha(
        client,
        bruto.order_sn,
        bruto.payout_amount,
        bruto.escrow_release_time,
      );
      if (r === 'duplicada') {
        duplicadas += 1;
        continue;
      }
      if (r === 'orcamento') {
        truncada = true;
        proximaPagina = pageNo;
        break;
      }
      novos += 1;
    }
    if (truncada) break;

    if (!page.more) {
      drenada = true;
      break;
    }

    // ⚠️ The page-repeat guard. A NON-EMPTY page that contributed zero new
    // `order_sn` while `more` is still true means `page_no` is being ignored and
    // the loop would otherwise re-read page 1 until the page cap. An EMPTY page
    // with `more: true` is a different fact and keeps paging.
    if (linhasDaPagina > 0 && novos === 0) {
      truncada = true;
      motivoTruncagem = MOTIVO_PAGINA_REPETIDA;
      proximaPagina = null;
      logger.warn('[shopee/liquidacao] more=true com página repetida — janela será relida', {
        integracaoId,
        pageNo,
        linhas: linhasDaPagina,
      });
      break;
    }

    if (paginas >= MAX_PAGES_PER_TICK) {
      truncada = true;
      proximaPagina = pageNo + 1;
      break;
    }
    pageNo += 1;
  }

  await gravarEstado();

  return {
    janela: { deMs, ateMs },
    pulada: null,
    paginas,
    linhas,
    liquidados,
    semMudanca,
    obsoletos,
    pendentes: pendentes.length,
    pendentesDescartados: descartados,
    sinteticas,
    puladas,
    ilegiveis,
    duplicadas,
    retomada,
    drenada,
    truncada,
  };
}

/**
 * Record a contained per-conta failure: `lastSweepAtMs` + `lastError`, and
 * NEITHER the cursor nor the pending triple.
 *
 * ⚠️ `orderBackfill.ts`'s one exception (a RESUMING conta that failed with a
 * `ShopeeApiError` clears its pending cursor) is NOT ported — see the module
 * header.
 */
async function registrarErro(
  db: Firestore,
  deps: EscrowSettlementDeps,
  logger: EscrowSettlementLogger,
  integracaoId: string,
  err: Error,
): Promise<void> {
  logger.warn('[shopee/liquidacao] conta contida após falha — cursor NÃO avançado', {
    integracaoId,
    erro: err.message,
  });
  if (deps.persistirCursor === false) return;
  await liquidacaoShopeeCollection.merge(db, {}, integracaoId, {
    lastSweepAtMs: deps.nowMs,
    lastError: err.message,
  });
}

/** One tick: every ACTIVE Shopee integração, failure-isolated per conta. */
export async function runShopeeEscrowSettlement(
  db: Firestore,
  deps: EscrowSettlementDeps,
): Promise<EscrowSettlementResult> {
  const logger = loggerDe(deps);
  const orcamento: OrcamentoDoTick = { liquidacoes: 0, sinteticas: 0 };
  const escopo = deps.apenasIntegracoes === undefined ? null : new Set(deps.apenasIntegracoes);

  const ativas = await listarContasShopeeAtivas(db);

  const contas: LiquidacaoContaResult[] = [];
  let semShopId = 0;

  for (const { integracaoId, shopId } of ativas) {
    if (escopo !== null && !escopo.has(integracaoId)) continue;

    if (shopId == null) {
      // A main-account-only conta cannot sign a shop call and has no `shop_id`
      // to put on a synthetic push. Counted and named, and NOTHING is written.
      semShopId += 1;
      contas.push({
        integracaoId,
        shopId: null,
        pulada: MOTIVO_SEM_SHOP_ID,
        janela: null,
        paginas: 0,
        linhas: 0,
        liquidados: 0,
        semMudanca: 0,
        obsoletos: 0,
        pendentes: 0,
        pendentesDescartados: 0,
        sinteticas: 0,
        puladas: 0,
        ilegiveis: 0,
        duplicadas: 0,
        retomada: false,
        drenada: false,
        truncada: false,
        error: null,
      });
      continue;
    }

    try {
      const st = await lerEstado(db, integracaoId);
      const r = await varrerConta(db, deps, logger, orcamento, integracaoId, shopId, st);
      contas.push({ integracaoId, shopId, ...r, error: null });
      logger.info('[shopee/liquidacao] conta varrida', {
        integracaoId,
        janela: r.janela,
        paginas: r.paginas,
        linhas: r.linhas,
        liquidados: r.liquidados,
        semMudanca: r.semMudanca,
        obsoletos: r.obsoletos,
        pendentes: r.pendentes,
        pendentesDescartados: r.pendentesDescartados,
        sinteticas: r.sinteticas,
        puladas: r.puladas,
        ilegiveis: r.ilegiveis,
        duplicadas: r.duplicadas,
        // ⚠️ No `order_sn` on the aggregate line: the per-order lines carry it,
        // and an aggregate that named one order would read as "this one failed".
        erros: 0,
      });
    } catch (err) {
      // The per-conta containment boundary (see `core/containment.ts`): one
      // conta's Shopee or Firestore failure must not cost every other conta its
      // tick; anything unclassifiable is a coding bug and fails the tick loudly.
      if (!erroContidoPorConta(err)) throw err;
      await registrarErro(db, deps, logger, integracaoId, err);
      contas.push({
        integracaoId,
        shopId,
        pulada: null,
        janela: null,
        paginas: 0,
        linhas: 0,
        liquidados: 0,
        semMudanca: 0,
        obsoletos: 0,
        pendentes: 0,
        pendentesDescartados: 0,
        sinteticas: 0,
        puladas: 0,
        ilegiveis: 0,
        duplicadas: 0,
        retomada: false,
        drenada: false,
        truncada: false,
        error: err.message,
      });
    }
  }

  return { semShopId, contas };
}

/* -------------------------------------------------------------------------- */
/*                     the DRY-RUN path (the rehearsal CLI)                    */
/* -------------------------------------------------------------------------- */

/** What a live tick WOULD do with one row. */
export interface LinhaSimuladaShopee {
  readonly orderSn: string;
  readonly pedidoId: string;
  readonly pagamentoId: string;
  readonly existePedido: boolean;
  readonly existePagamento: boolean;
  readonly payoutAmount: number | null;
  readonly escrowReleaseTimeS: number | null;
  /** `null` when the escrow could not be read — `motivo` says why. */
  readonly escrow: ShopeeEscrowDetail | null;
  readonly motivo: string | null;
  /** `null` when there was no escrow to decide from. */
  readonly previsao: PrevisaoLiquidacaoShopee | null;
}

export interface SimulacaoLiquidacaoShopeeResult {
  readonly janela: { readonly deMs: number; readonly ateMs: number } | null;
  readonly paginas: number;
  readonly linhas: readonly LinhaSimuladaShopee[];
  readonly ilegiveis: number;
  readonly drenada: boolean;
}

export interface SimularLiquidacaoShopeeArgs {
  readonly integracaoId: string;
  readonly client: ShopeeClient;
  /** ONE clock read, MILLISECONDS. */
  readonly nowMs: number;
  /** An explicit window; omitted ⇒ the one the next tick would use. */
  readonly janela?: { readonly deMs: number; readonly ateMs: number };
  /**
   * ONE order, read straight from `get_escrow_detail` with NO list paging.
   *
   * ⚠️ The listing is queried BY release-time window and has no by-id form, so
   * this mode cannot learn `payout_amount` or `escrow_release_time` — both come
   * back `null` and the settlement it predicts would therefore ERASE a stored
   * release stamp. That is exactly why the CLI refuses `--order-sn` together
   * with `--live`, and why this mode exists only to inspect.
   */
  readonly orderSn?: string;
}

/**
 * What a tick WOULD change, without changing anything.
 *
 * ⚠️ **There is no writer in this function's body**, and that is the guarantee
 * the rehearsal rests on — structural, not a promise in a comment. It calls the
 * SAME `preverLiquidacaoShopee` the transaction calls, on the same shape of
 * input, so a dry run cannot disagree with the live run it rehearses.
 *
 * It reads: the cursor document (for the window), one `get_escrow_list` page at
 * a time, and per row the pagamento plus — only when the pagamento is absent —
 * the pedido.
 */
export async function simularLiquidacaoShopee(
  db: Firestore,
  args: SimularLiquidacaoShopeeArgs,
): Promise<SimulacaoLiquidacaoShopeeResult> {
  const { integracaoId, client, nowMs, janela, orderSn } = args;

  const lerLinha = async (
    sn: string,
    payoutAmount: number | null,
    escrowReleaseTimeS: number | null,
  ): Promise<LinhaSimuladaShopee> => {
    const pedidoId = makePedidoIdShopee(integracaoId, sn);
    const pagamentoId = makePagamentoIdShopee(integracaoId, sn);
    const pagSnap = await pagamentoCollection.docRef(db, { pedidoId }, pagamentoId).get();
    const existePagamento = pagSnap.exists;
    const pedSnap = existePagamento ? null : await pedidoCollection.docRef(db, {}, pedidoId).get();
    const existePedido = existePagamento || (pedSnap?.exists ?? false);

    const base = {
      orderSn: sn,
      pedidoId,
      pagamentoId,
      existePedido,
      existePagamento,
      payoutAmount,
      escrowReleaseTimeS,
    };

    let escrow: ShopeeEscrowDetail;
    try {
      escrow = await client.getEscrowDetail({ orderSn: sn });
    } catch (err) {
      // Same order as the live row machine: the two subclasses first, then the
      // permanent provider fact, then an unreadable body. Anything else is the
      // caller's problem and rethrows — a dry run that swallowed a reauth would
      // report "nothing to do" for every order of a dead grant.
      if (err instanceof ShopeeReauthRequiredError) throw err;
      if (err instanceof ShopeeRateLimitError) throw err;
      if (err instanceof ShopeeApiError && err.code === SHOPEE_ERRO_ORDER_NOT_FOUND) {
        return { ...base, escrow: null, motivo: SHOPEE_ERRO_ORDER_NOT_FOUND, previsao: null };
      }
      if (err instanceof ShopeeSchemaError) {
        // PATHS only — an escrow body is money.
        return {
          ...base,
          escrow: null,
          motivo: `escrow-ilegivel:${err.campos.join(',')}`,
          previsao: null,
        };
      }
      throw err;
    }

    const raw = existePagamento ? ((pagSnap.data() ?? {}) as Record<string, unknown>) : null;
    return {
      ...base,
      escrow,
      motivo: null,
      previsao: preverLiquidacaoShopee(raw, {
        orderSn: sn,
        escrow,
        escrowReleaseTimeS,
        payoutAmount,
        nowMs,
      }),
    };
  };

  if (orderSn !== undefined) {
    return {
      janela: null,
      paginas: 0,
      linhas: [await lerLinha(orderSn, null, null)],
      ilegiveis: 0,
      drenada: true,
    };
  }

  const st = await lerEstado(db, integracaoId);
  const { deMs, ateMs, pageNo: primeiraPagina } = janelaDeLiquidacao(st, nowMs, janela);
  const timeFromS = Math.floor(deMs / MS_POR_SEGUNDO);
  const timeToS = Math.floor(ateMs / MS_POR_SEGUNDO);
  if (timeToS < timeFromS) {
    return { janela: { deMs, ateMs }, paginas: 0, linhas: [], ilegiveis: 0, drenada: false };
  }

  const linhas: LinhaSimuladaShopee[] = [];
  const vistos = new Set<string>();
  let ilegiveis = 0;
  let paginas = 0;
  let drenada = false;
  let pageNo = primeiraPagina;

  for (;;) {
    const page = await client.getEscrowList({
      releaseTimeFromS: timeFromS,
      releaseTimeToS: timeToS,
      pageSize: PAGE_SIZE,
      pageNo,
    });
    paginas += 1;
    let novos = 0;
    for (const bruto of page.escrow_list as readonly (ShopeeEscrowListRow | null)[]) {
      if (bruto === null) {
        ilegiveis += 1;
        continue;
      }
      if (vistos.has(bruto.order_sn)) continue;
      vistos.add(bruto.order_sn);
      novos += 1;
      linhas.push(await lerLinha(bruto.order_sn, bruto.payout_amount, bruto.escrow_release_time));
      if (linhas.length >= MAX_LIQUIDACOES_POR_TICK) break;
    }
    if (linhas.length >= MAX_LIQUIDACOES_POR_TICK) break;
    if (!page.more) {
      drenada = true;
      break;
    }
    // The same page-repeat guard the live tick carries, for the same reason.
    if (page.escrow_list.length > 0 && novos === 0) break;
    if (paginas >= MAX_PAGES_PER_TICK) break;
    pageNo += 1;
  }

  return { janela: { deMs, ateMs }, paginas, linhas, ilegiveis, drenada };
}
