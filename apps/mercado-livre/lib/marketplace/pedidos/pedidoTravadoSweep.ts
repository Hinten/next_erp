/**
 * Weekly sweep: release pedidos stuck awaiting a payment that never resolved.
 *
 * ## Why this exists
 *
 * #1087 made a `payments` notification BOOTSTRAP a pedido, so the stock is
 * reserved while the buyer holds the unit. Every path that RELEASES that
 * reservation is event-driven — the order-import terminal arm needs an
 * `orders_v2`, the payments release arm needs a terminal `payments` delivery.
 * There was no time-based release anywhere in the repo, so a reservation whose
 * terminal event never arrived was held **forever**. The 72h bootstrap guard
 * bounds how old a payment may be to CREATE a reservation; nothing bounded how
 * long one LIVES.
 *
 * Ways the event never arrives: the notification parks (terminal — nothing
 * re-drives a parked doc); ML never fires a terminal event for a silently
 * expired boleto; the backend is down past ML's ~1h retry window AND
 * `missed_feeds`' 48h retention. `importMercadoLivreOrders` cannot rescue it
 * either — it is a SELLER-SCOPED `/orders/search`, which filters exactly these
 * orders (never-visible ones, and cancelled ones stay filtered).
 *
 * ## What it does — mostly a RE-DRIVER, not a killer
 *
 * For a stale candidate it asks ML what actually happened, then:
 *
 *  - order moved FORWARD or DIED → enqueue a synthetic `orders_v2` and let the
 *    two arms #1087 already added decide. **No new estado logic**, and a pedido
 *    whose order was quietly paid gets SELF-HEALED rather than cancelled.
 *  - order is STILL pre-payment after the horizon → the sweep's one novel write:
 *    `pagamentoNaoRealizado`.
 *
 * `pagamentoNaoRealizado` over `cancelado` deliberately: it says WHY the sale
 * ended, and it is already grouped with `cancelado` in the NF-e emission block
 * (`emissaoNFeBloqueadaPorEstado`). Like `cancelado` it sits OUTSIDE
 * `ESTADOS_PEDIDO_RESERVA`, so `onPedidoEstoqueSync` releases the reservation on
 * the estado write alone. This module performs no estoque arithmetic.
 *
 * ⚠️ **The estado does NOT identify this sweep as the writer**, and an earlier
 * version of this comment wrongly claimed it did. `orderPaymentImport.ts`'s
 * release arm writes `statusToEstadoPedido(...)`, and a `rejected` ML payment
 * maps `recusado → pagamentoNaoRealizado` — on exactly this population, and far
 * MORE often than a notification that never arrives. `statusToEstadoPedido` also
 * backs the manual status-change UI. Agreeing with that arm on the same
 * real-world outcome is a virtue, but it means the estado is evidence of WHAT
 * happened, never of WHO did it.
 *
 * Attribution is therefore written explicitly: every release records an
 * `incidente` naming this sweep and the ML status that justified it, in the same
 * transaction as the estado. That is the only durable channel — the
 * `historicoEstadoPedido` row the `onPedidoChanged` trigger appends carries a
 * NULL usuário for any Admin-SDK writer, so it cannot tell this sweep apart from
 * the importer, and a Cloud Logging line ages out long before the pedido does.
 *
 * ⚠️ It does NOT cancel the order at ML. ML owns its own order lifecycle and an
 * unpaid order expires there anyway; this releases OUR reservation only.
 *
 * ## The safety boundary — and why the obvious gate is WRONG
 *
 * This sweep ends real sales, so it must never touch a pedido a human owns.
 *
 * ⚠️ **`integracaoPedidoOuterRef` is NOT a marketplace discriminator**, however
 * much it looks like one. A human-created pedido MUST set it — the form requires
 * it (`pedidoPageIssues`: "Selecione a integração"). Gating on it would sweep
 * manual sales. The real gates, all four required:
 *
 *  1. `lastMarketplaceUpdate != null` — the ML ORDER clock, whose SOLE writer is
 *     `discoverPedidoMercadoLivre` (#791/O15). The web create seeds it null and
 *     duplicar/devolucao strip it, so a non-null value means "the ML importer
 *     wrote this pedido". One root-document field, no extra read.
 *  2. `hasUserInteraction !== true` — stamped when a human SAVES a pedido, never
 *     by viewing. Someone who has worked a pedido can close it themselves.
 *  3. An `orderML` mirror must exist — the canonical ownership record, and the
 *     read is one we need anyway for the order id.
 *  4. No pagamento may be `aprovado`. A human reaches
 *     `aguardandoConfirmacaoDePagamento` legitimately through a PARTIAL payment
 *     (`nextPedidoEstado`), and a partially-paid pedido is a live sale.
 *
 * ## Race discipline (root `CLAUDE.md` rule 7) — class C
 *
 * An ML API call sits between the candidate query and the write, so the write
 * re-derives EVERY input inside the transaction: estado still a candidate, still
 * older than the horizon, still untouched by a human, still no approved
 * pagamento. Without that, a `payments` notification approving the sale in that
 * window would be clobbered — ending a pedido that had just been paid.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  createMercadoLivreApi,
  type MlOrder,
} from '@delfrance/integrations-mercado-livre';
import {
  ESTADO_PEDIDO,
  ORIGEM_INCIDENTE,
  STATUS_PAGAMENTO,
  TIPO_INCIDENTE,
  type EstadoPedido,
} from '@delfrance/schemas';
import { millisToMicros } from '@delfrance/core/datetime';
import {
  incidenteCollection,
  orderMLCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';

import { loadMercadoLivreContext } from '../core/mercadoLivre';
import { ESTADOS_PEDIDO_PRE_PAGAMENTO_ML } from './orderImport';
import { estadoPedidoFromOrderStatus } from './orderStatusMaps';
import { buildBootstrapOrderPayload } from './pendingOrderBootstrap';
import { MlTasksDisabledError, type MlTaskScheduler } from '../notificacoes/mlTasks';

/** The env flag gating the sweep — runs ONLY when it is exactly `'1'`. */
export const PEDIDO_TRAVADO_FLAG_ENV = 'MERCADO_LIVRE_PEDIDO_TRAVADO_SWEEP_ENABLED';

/**
 * Report-only mode. When exactly `'1'` the sweep decides and counts exactly as it
 * would, but performs **no write and no enqueue**.
 *
 * This exists because the sweep ends real sales. Run it here first, read a few
 * weeks of counters, and only then turn the real flag on.
 *
 * ⚠️ The counters really are identical, and that costs one design decision: the
 * dry run runs the transaction and its READS, skipping only the two writes. An
 * earlier version returned before the transaction, which made `mudou-durante` and
 * `pagamento-aprovado` unreachable in a rehearsal and counted each as `liberado`
 * — an upper bound biased toward over-reporting releases, in the one number an
 * operator uses to decide it is safe to go live.
 */
export const PEDIDO_TRAVADO_DRY_RUN_ENV = 'MERCADO_LIVRE_PEDIDO_TRAVADO_DRY_RUN';

/**
 * How long a pedido may sit in a pre-payment estado before the sweep acts.
 *
 * ⚠️ The EFFECTIVE age is 7–14 days, not 7: the schedule is weekly, so a pedido
 * that goes stale just after a tick waits for the next one. That is deliberate —
 * erring toward older is erring toward safer — but do not read "7" as a promise
 * that anything is released on day 7.
 */
export function pedidoTravadoMaxIdadeDias(): number {
  const raw = Number(process.env.MERCADO_LIVRE_PEDIDO_TRAVADO_MAX_IDADE_D);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

/** Documents examined per tick. Bounded so one tick cannot run away. */
export const PAGE_LIMIT = 200;

const DIA_US = 24 * 60 * 60 * 1000 * 1000;

/**
 * Estados the sweep will EXAMINE — every pre-payment estado that holds a stock
 * reservation. All three are in `ESTADOS_PEDIDO_RESERVA`, which is the whole
 * reason they can leak.
 *
 * ⚠️ `carrinho` / `iniciado` are deliberately absent: they hold no reservation,
 * so they are housekeeping rather than a leak, and sweeping them would reach
 * further into human-owned territory for no stock benefit.
 */
export const ESTADOS_PEDIDO_TRAVADO: readonly EstadoPedido[] = [
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.escolhendoFormaDePagamento,
  ESTADO_PEDIDO.emAnalise,
];

/** What the sweep decided for one candidate. Every arm is counted. */
export type PedidoTravadoVeredito =
  /** Not written by the ML importer — a human's pedido. Never touched. */
  | 'nao-marketplace'
  /** A human has SAVED this pedido; they can close it themselves. */
  | 'interacao-humana'
  /** No `orderML` mirror, or no resolvable conta — no order to ask about. */
  | 'sem-order-ml'
  /** Real money is on the pedido — still a live sale. */
  | 'pagamento-aprovado'
  /** ML could not be asked (dead grant, 5xx, conta gone). NEVER release on this. */
  | 'nao-verificavel'
  /** ML moved on — re-driven through `orders_v2` so the existing arms decide. */
  | 'redirecionado'
  /**
   * A re-drive was owed but `MERCADO_LIVRE_TASKS_DISABLED` is on, so nothing was
   * enqueued. Counted apart from `redirecionado` deliberately: folding them would
   * log 47 re-drives that never happened — the exact conflation this sweep's
   * per-verdict counters exist to prevent, in the one deployment mode where it is
   * guaranteed to be wrong.
   */
  | 'tasks-desabilitado'
  /** ML still says pre-payment after the horizon → released. */
  | 'liberado'
  /** The in-transaction re-check refused: the pedido changed under us. */
  | 'mudou-durante';

export interface PedidoTravadoDeps {
  /** The notification-queue enqueue seam (`createMlTaskScheduler()` in prod). */
  scheduler: MlTaskScheduler;
  /** ONE clock read for the whole tick (`Date.now()` in prod, never re-read here). */
  nowMs: number;
}

export interface PedidoTravadoSweepResult {
  /** `false` ⇒ the flag is off — nothing was read, decided or written. */
  enabled: boolean;
  /** `true` ⇒ decided and counted, but wrote and enqueued nothing. */
  dryRun: boolean;
  /** Candidates the indexed query returned. */
  examinados: number;
  /** Per-verdict counts. Zero-valued arms are omitted. */
  veredictos: Partial<Record<PedidoTravadoVeredito, number>>;
  /** `true` when the page cap was hit — backlog remains for next week. */
  truncado: boolean;
  /** Contained per-pedido failures (the sweep never aborts on one). */
  erros: Array<{ pedidoId: string; message: string }>;
}

function contar(
  veredictos: Partial<Record<PedidoTravadoVeredito, number>>,
  v: PedidoTravadoVeredito,
): void {
  veredictos[v] = (veredictos[v] ?? 0) + 1;
}

function readMicros(raw: Record<string, unknown>, key: string): number | null {
  const v = raw[key];
  return typeof v === 'number' ? v : null;
}

function algumAprovado(docs: ReadonlyArray<{ data: () => unknown }>): boolean {
  return docs.some(
    (d) => (d.data() as Record<string, unknown>).status_pagamento === STATUS_PAGAMENTO.aprovado,
  );
}

/** `integracaoPedidoOuterRef` → the integração doc id, or null. */
export function integracaoIdDoPedido(raw: Record<string, unknown>): string | null {
  const ref = raw.integracaoPedidoOuterRef;
  if (typeof ref !== 'string' || ref.length === 0) return null;
  const id = ref.split('/').filter(Boolean).pop() ?? null;
  return id != null && id.length > 0 ? id : null;
}

/**
 * Decide one candidate from what ML says. Pure — the caller applies the effect.
 *
 * Still on the pre-payment ladder after the horizon ⇒ the buyer never paid.
 * Anything else — moved forward, or died — is the existing arms' business, so
 * re-drive and let them decide rather than duplicating that logic here.
 *
 * ⚠️ An unrecognised ML status maps to `iniciado`, which is NOT on the ladder, so
 * it re-drives (a no-op) instead of being released. Refusing to act on a status
 * we do not understand is the safe direction.
 */
export function decidirPedidoTravado(order: MlOrder): 'liberar' | 'redirecionar' {
  const alvo = estadoPedidoFromOrderStatus(order.status ?? '');
  return ESTADOS_PEDIDO_PRE_PAGAMENTO_ML.has(alvo) ? 'liberar' : 'redirecionar';
}

/**
 * Release one pedido, re-deriving every input from the transaction's own reads.
 *
 * Returns the verdict actually applied — `'mudou-durante'` when the tx-fresh
 * pedido no longer satisfies the preconditions, which is the guard that stops a
 * concurrently-approved sale from being ended.
 */
async function liberarPedido(
  db: Firestore,
  pedidoId: string,
  cutoffUs: number,
  nowUs: number,
  statusMl: string,
  dryRun: boolean,
): Promise<'liberado' | 'mudou-durante' | 'pagamento-aprovado'> {
  return db.runTransaction(async (tx) => {
    /* ===================== READ PHASE (no writes yet) ===================== */
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));

    /* ===================== COMPUTE + WRITE PHASE ===================== */
    if (!pedidoSnap.exists) return 'mudou-durante';
    const raw = pedidoSnap.data() as Record<string, unknown>;

    // Every one of these is RE-DERIVED, not carried in from the candidate query:
    // an ML round trip happened in between and the pedido may have moved (rule 7).
    const estado = raw.estado as EstadoPedido | undefined;
    if (estado == null || !ESTADOS_PEDIDO_TRAVADO.includes(estado)) return 'mudou-durante';

    const timestamp = readMicros(raw, 'timestamp');
    if (timestamp == null || timestamp >= cutoffUs) return 'mudou-durante';

    if (raw.hasUserInteraction === true) return 'mudou-durante';
    if (readMicros(raw, 'lastMarketplaceUpdate') == null) return 'mudou-durante';

    if (algumAprovado(pagamentosSnap.docs)) return 'pagamento-aprovado';

    // ⚠️ Dry run runs the WHOLE decision, reads included, and skips only the two
    // writes. Returning early instead would make `mudou-durante` and
    // `pagamento-aprovado` unreachable in a rehearsal and report each as
    // `liberado` — an upper bound on releases, biased in the UNSAFE direction,
    // and exactly the number an operator reads before dropping the dry-run flag.
    if (dryRun) return 'liberado';

    tx.update(
      pedidoRef,
      pedidoCollection.parseMerge({
        estado: ESTADO_PEDIDO.pagamentoNaoRealizado,
        // Wall clock, monotonic — never `lastMarketplaceUpdate`, whose single
        // writer is `discoverPedidoMercadoLivre` (#791/O15).
        ultimaModificacao: Math.max(readMicros(raw, 'ultimaModificacao') ?? 0, nowUs),
      }),
    );

    // Durable attribution, in the SAME transaction as the estado — see the module
    // doc. The estado alone cannot say who wrote it, and the history row the
    // trigger appends carries a null usuário for every Admin-SDK writer. Same
    // shape the pack-absorption cancel uses (`orderPedidoTx.ts`).
    const incidenteId = incidenteCollection.newDocId(db, { pedidoId });
    tx.set(
      incidenteCollection.docRef(db, { pedidoId }, incidenteId),
      incidenteCollection.parse({
        origem: ORIGEM_INCIDENTE.outros,
        tipo: TIPO_INCIDENTE.troca,
        motivoDoIncidente:
          `Pedido liberado automaticamente: o Mercado Livre ainda reportava o ` +
          `pedido como "${statusMl}" após ${pedidoTravadoMaxIdadeDias()} dias sem ` +
          `confirmação de pagamento. A reserva de estoque foi devolvida.`,
        timestamp: nowUs,
        ultimaModificacao: nowUs,
      }),
    );
    return 'liberado';
  });
}

/**
 * Ask the `orders_v2` topic to re-import the order, so the arms #1087 added
 * decide the estado. No delay: these orders are a week old, so there is no fresh
 * `orders_v2` to lose a race with.
 */
async function redirecionar(
  deps: PedidoTravadoDeps,
  args: { orderId: number; userId: number | null; dryRun: boolean },
): Promise<'redirecionado' | 'tasks-desabilitado'> {
  if (args.dryRun) return 'redirecionado';
  try {
    await deps.scheduler.enqueue(
      buildBootstrapOrderPayload({ orderId: args.orderId, userId: args.userId }),
    );
  } catch (err) {
    // Sweep-only mode: there is no queue to enqueue onto. Next week's tick
    // retries; nothing is lost because the pedido stays a candidate. REPORTED,
    // never folded into `redirecionado` — see that verdict's note.
    if (err instanceof MlTasksDisabledError) return 'tasks-desabilitado';
    throw err;
  }
  return 'redirecionado';
}

/**
 * One weekly tick. Per-pedido failures are contained: one bad candidate never
 * aborts the batch.
 */
export async function runPedidoTravadoSweep(
  db: Firestore,
  deps: PedidoTravadoDeps,
): Promise<PedidoTravadoSweepResult> {
  const veredictos: Partial<Record<PedidoTravadoVeredito, number>> = {};
  const erros: Array<{ pedidoId: string; message: string }> = [];

  if (process.env[PEDIDO_TRAVADO_FLAG_ENV] !== '1') {
    return { enabled: false, dryRun: false, examinados: 0, veredictos, truncado: false, erros };
  }
  const dryRun = process.env[PEDIDO_TRAVADO_DRY_RUN_ENV] === '1';

  const nowUs = millisToMicros(deps.nowMs);
  const cutoffUs = nowUs - pedidoTravadoMaxIdadeDias() * DIA_US;

  // ⚠️ This exact shape rides the DECLARED `pedidos (ehSaida ASC, estado ASC,
  // timestamp DESC)` index — verified with the repo's own `indexSatisfies`.
  // Firestore Enterprise creates no index automatically and does NOT throw on an
  // unindexed query; it silently full-scans and bills data scanned. Re-run that
  // check if you add a constraint or flip the sort.
  //
  // `timestamp` (creation), never `ultimaModificacao`: the latter is churned by
  // shipment and payment writers, so a pedido abandoned a month ago can carry a
  // stamp from yesterday and would never look stale.
  //
  // ⚠️ `timestamp` is nullable, and an inequality filter excludes nulls — so
  // pre-#159 pedidos created without one are invisible here. Acceptable: this
  // sweep exists for pedidos the ML importer creates, which always stamp it (from
  // the ML order's own `date_created`).
  const snap = await pedidoCollection
    .ref(db, {})
    .where('ehSaida', '==', true)
    .where('estado', 'in', [...ESTADOS_PEDIDO_TRAVADO])
    .where('timestamp', '<', cutoffUs)
    .orderBy('timestamp', 'desc')
    .limit(PAGE_LIMIT)
    .get();

  for (const doc of snap.docs) {
    const pedidoId = doc.id;
    try {
      const raw = doc.data() as Record<string, unknown>;

      // Gate 1 — the ML order clock. NOT `integracaoPedidoOuterRef`, which a
      // human-created pedido is REQUIRED to set (see the module doc).
      if (readMicros(raw, 'lastMarketplaceUpdate') == null) {
        contar(veredictos, 'nao-marketplace');
        continue;
      }
      // Gate 2 — a human has saved this pedido; leave it to them.
      if (raw.hasUserInteraction === true) {
        contar(veredictos, 'interacao-humana');
        continue;
      }
      // Gate 3 — real money on the pedido means a live sale.
      const pagamentos = await pagamentoCollection.ref(db, { pedidoId }).get();
      if (algumAprovado(pagamentos.docs)) {
        contar(veredictos, 'pagamento-aprovado');
        continue;
      }

      // Gate 4 — the canonical ownership record, which also carries the order id
      // as its DOC ID (`orderPedidoTx.ts` writes `String(order.id)`).
      const orderMl = await orderMLCollection.ref(db, { pedidoId }).limit(1).get();
      const orderIdRaw = orderMl.docs[0]?.id;
      const orderId = orderIdRaw != null ? Number(orderIdRaw) : Number.NaN;
      const integracaoId = integracaoIdDoPedido(raw);
      if (!Number.isFinite(orderId) || integracaoId == null) {
        contar(veredictos, 'sem-order-ml');
        continue;
      }

      let order: MlOrder;
      let userId: number | null = null;
      try {
        const ctx = await loadMercadoLivreContext(db, integracaoId);
        // The seller id the synthetic notification must resolve back through.
        userId = typeof ctx.conta.user_id === 'number' ? ctx.conta.user_id : null;
        const channelCtx = await ctx.resolveChannelContext();
        const api = createMercadoLivreApi({
          getAccessToken: async () => channelCtx.accessToken,
        });
        order = await api.getOrder(orderId);
      } catch (err) {
        // A 404 means the order is gone for good — re-drive and let the import's
        // own 404/pack fallback settle it. Every OTHER ML failure is
        // UNVERIFIABLE: a dead grant, a 5xx, a conta that vanished. Never end a
        // sale on a read that did not answer.
        if (err instanceof MercadoLivreHttpError && err.status === 404) {
          // Same guard as the normal redirect arm below, and it is REACHABLE
          // here: `userId` is still null when the 404 came out of
          // `loadMercadoLivreContext`/`resolveChannelContext` before the
          // assignment ran, or when the conta carries no numeric `user_id`.
          if (userId == null) {
            contar(veredictos, 'nao-verificavel');
            continue;
          }
          contar(veredictos, await redirecionar(deps, { orderId, userId, dryRun }));
          continue;
        }
        if (err instanceof MercadoLivreError) {
          contar(veredictos, 'nao-verificavel');
          continue;
        }
        throw err;
      }

      // A synthetic notification with no `user_id` resolves to no conta and just
      // defers, so treat it as unverifiable rather than enqueuing a dud.
      if (decidirPedidoTravado(order) === 'redirecionar') {
        if (userId == null) {
          contar(veredictos, 'nao-verificavel');
          continue;
        }
        contar(veredictos, await redirecionar(deps, { orderId, userId, dryRun }));
        continue;
      }

      const aplicado = await liberarPedido(
        db,
        pedidoId,
        cutoffUs,
        nowUs,
        order.status ?? '',
        dryRun,
      );
      if (aplicado === 'liberado' && !dryRun) {
        console.warn('[mercado-livre] pedido travado liberado', {
          pedidoId,
          orderId,
          de: raw.estado,
          para: ESTADO_PEDIDO.pagamentoNaoRealizado,
          statusMl: order.status ?? null,
          idadeDias: Math.floor((nowUs - (readMicros(raw, 'timestamp') ?? nowUs)) / DIA_US),
        });
      }
      contar(veredictos, aplicado);
    } catch (err) {
      erros.push({ pedidoId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    enabled: true,
    dryRun,
    examinados: snap.docs.length,
    veredictos,
    truncado: snap.docs.length >= PAGE_LIMIT,
    erros,
  };
}
