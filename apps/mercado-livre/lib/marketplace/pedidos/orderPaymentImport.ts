/**
 * Mercado Livre `payments` notification handler (Step 9, PR 3 — "A1"). Ports
 * `_cadastrarAtualizarPayment`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:1161-1259`)
 * — the payments-topic path that upserts a SINGLE `pagamento` doc onto its
 * owning pedido and advances `estado` to `pago` when the pedido is fully paid.
 * This is a DIFFERENT code path from the order-import's own embedded-payments
 * upsert (`orderPedidoTx.ts`) and its "pago advance" logic (`orderImport.ts`'s
 * `applyPagoAdvanceOrDowngrade`) — the two are approved to disagree on the
 * paid-sum rule (this one is approved-only; the primary advance sums ALL), a
 * deliberate legacy per-path inconsistency, not a bug (see the shared task
 * notes' "Approved deviations").
 *
 * Flow (quote-verified against `.old`, tasks.dart:1161-1259):
 *  1. `get_payment = GET /collections/{id}`. A 404 here means the payment id
 *     is permanently gone — skip (`payment-404`), never retry forever.
 *  2. `if (payment.marketplace == NONE) return;` (:1172-1174) — a payment not
 *     tagged to a marketplace order isn't ours to import; skip with ZERO
 *     Firestore ops (`marketplace-none`).
 *  3. `orderKey = external_reference ?? order_id.toString()` (:1176);
 *     `int.parse` failure is a silent legacy return — this port logs it
 *     (`sem-order-key`, approved deviation: skips are logged here, legacy was
 *     silent).
 *  4. Resolve the owning pedido via the `orderML` collection-group mirror:
 *     `pack_id == orderKey` first, else `id == orderKey` (:1178-1191; same
 *     two-step precedent as the shipments handler and the order-import's own
 *     pack resolution). No match at all → `pedido-nao-encontrado`.
 *
 *     ⚠️ SEAM (revised by #1087). `orderImport.ts` is STILL the only pedido
 *     creator — this module creates none and holds no scheduler. What changed is
 *     that a miss is no longer a terminal drop: the result carries `orderId` and
 *     a verdict, and the DISPATCHER (`notificacoes/notificacao.ts` →
 *     `pendingOrderBootstrap.ts`) asks the `orders_v2` topic to import it.
 *
 *     Why it had to change: ML fires `orders_v2` only for "vendas confirmadas",
 *     so a `payment_in_process` order — which EXISTS, and whose Mercado Pago
 *     payment notifies immediately — reaches us here and nowhere else. Dropping
 *     it meant no pedido, therefore no stock reservation, while the buyer held
 *     the unit and another channel could sell it.
 *
 *     Two guards decide (`decidirBootstrapPedido`): the payment must not be
 *     older than `pedidoBootstrapMaxAgeMs()` (a sweep re-drive or `missed_feeds`
 *     replay must not reserve stock for a long-closed order), and must not be
 *     terminally dead. A refusal reports its OWN skip value so it surfaces as
 *     `dropped` rather than as work performed.
 *  5. Staleness outer guard (:1205), NULL-TOLERANT the opposite way from the
 *     shipments handler: proceed iff the stored pagamento doesn't exist yet,
 *     OR its stored `ultimaModificacao` is null, OR it's older than the
 *     incoming payment's (`mlPaymentToPagamento`'s `ultimaModificacao`, which
 *     already folds in the `last_modified ?? date_last_updated ?? nowUs`
 *     fallback chain — see `orderPaymentMapping.ts`). A stored timestamp at
 *     least as fresh as the incoming one → `stale`, zero writes.
 *  6. Upsert at the SAME deterministic id every ML payment path uses
 *     (`makePagamentoIdMercadoLivre`, `orderIds.ts`): CREATE writes the full
 *     mapped doc; an EXISTING doc goes through `mergePagamentoUpdate`
 *     (`orderPaymentMapping.ts`) — the legacy `Pagamento.update` merge, where
 *     `forma_de_pagamento`/`valor`/`parcelas`/`aVista`/`duplicata` take the
 *     new value unconditionally and every other field is null-tolerant
 *     (`other ?? this`).
 *  7. `estado` advance (:1230-1245) — ONLY inside the write branch (a stale
 *     skip never reaches this), ONLY when the pedido satisfies the SHARED
 *     `podeAvancarParaPago` predicate (`orderImport.ts`) and has a
 *     `valorCobrado`. Since #791 that predicate is the same one the order
 *     import uses — estado `emProcessamento` PLUS cliente, endereço and
 *     freteInicial — because `pago` authorizes dispatch and NF-e emission and
 *     the two ML paths that can trigger it must not disagree about what it
 *     means. `totalPago` = (this payment's mapped `valor` if its mapped
 *     `status_pagamento` is `aprovado`, else 0) + the sum of every OTHER stored
 *     pagamento (read in the SAME transaction, excluding this doc's id) whose
 *     `status_pagamento` is `aprovado`. `totalPago >= valorCobrado` → patch the
 *     pedido to `{ estado: 'pago', ultimaModificacao: <wall clock, monotonic> }`.
 *     NOT `lastMarketplaceUpdate`: that is the ML ORDER-clock watermark and the
 *     order import is its single writer (#791/O15) — this path carries a
 *     PAYMENT clock, which already lives on the pagamento doc. Deliberately NOT `reconcilePedidoFromPagamento` (that generic
 *     path is Mercado Pago's) — NO downgrade, NO `freteInicial` flip. The
 *     `historicoEstadoPedido` row is no longer this path's concern either: the
 *     `onPedidoChanged` trigger observes the pedido write and records the
 *     transition (with a null usuário — this runs on the Admin SDK).
 *
 * THROW-ON-TRANSIENT discipline: every error except a 404 on the primary
 * `getPayment` call PROPAGATES (ML API non-404, network, Firestore,
 * `MlStatusDesconhecidoError` out of `mlPaymentToPagamento`, a `ZodError` out
 * of a `.parse`) — the notification queue/sweep retries. Only the
 * deterministic legacy skip cases return a result. No generic `catch`
 * anywhere in this module.
 *
 * Admin tx invariant: every read (`pagamentoRef`, `pedidoRef`, the whole
 * `pagamentos` subcollection) happens before the first write inside the ONE
 * `db.runTransaction` call.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlPayment,
} from '@delfrance/integrations-mercado-livre';
import { STATUS_PAGAMENTO } from '@delfrance/schemas';
import { roundReais } from '@delfrance/core/money';
import { coerceToMicros } from '@delfrance/core/datetime';
import { pagamentoCollection, pedidoCollection } from '@delfrance/data/admin/collections';

import { loadContaBag, podeAvancarParaPago } from './orderImport';
import { makePagamentoIdMercadoLivre } from './orderIds';
import { resolvePedidoIdByOrderId } from './orderPedidoResolve';
import { mergePagamentoUpdate, mlPaymentToPagamento } from './orderPaymentMapping';

export interface PaymentImportDeps {
  db: Firestore;
  api: MercadoLivreApi;
  contaId: string;
  nowUs: number;
}

export interface PaymentImportResult {
  pedidoId: string | null;
  /**
   * The ML order key this payment resolved to (`external_reference ?? order_id`),
   * or null when it had none. The dispatcher needs it to address the pedido
   * bootstrap — see {@link PaymentImportResult.skipped}'s
   * `pedido-nao-encontrado` arm.
   */
  orderId: number | null;
  skipped:
    | 'payment-404'
    | 'marketplace-none'
    | 'sem-order-key'
    /**
     * No pedido owns this order YET. Since #1087 this is no longer a terminal
     * drop: the caller bootstraps one via the `orders_v2` topic. The two arms
     * below are the cases where it must NOT.
     */
    | 'pedido-nao-encontrado'
    /** No pedido, and the payment is too old (or too far in the future) to bootstrap one. */
    | 'pedido-nao-encontrado-expirado'
    /** No pedido, and the payment is terminally dead — there is no sale to reserve stock for. */
    | 'pedido-nao-encontrado-pagamento-morto'
    | 'stale'
    | null;
}

/**
 * `payment.marketplace == NONE` (tasks.dart:1172-1174) — the exact ML literal
 * for "not a marketplace-tagged payment".
 */
const MARKETPLACE_NONE = 'NONE';

/**
 * How old a payment may be and still bootstrap a pedido (#1087). Default 72h,
 * overridable with `MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H`.
 *
 * WHY a bound exists at all: the hot sweep re-drives hour-old payloads and the
 * `missed_feeds` backstop replays entries up to ML's 48h retention. Without it a
 * replayed payment would create a pedido and RESERVE STOCK for an order long
 * since closed.
 *
 * WHY 72h: ML holds a boleto up to ~3 business days, and a pending boleto is a
 * real sale whose stock should stay reserved. Anything older than that is past
 * every window ML itself keeps the payment pending in.
 *
 * ⚠️ Deliberately NOT phase-aware, unlike `toDisposition`. The bound is on the
 * PAYMENT's own creation clock, not on the notification's `sent`, so a sweep
 * re-drive or a `missed_feeds` replay of a genuinely fresh payment still passes.
 * Do not add a phase parameter here.
 */
export function pedidoBootstrapMaxAgeMs(): number {
  const raw = Number(process.env.MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H);
  const horas = Number.isFinite(raw) && raw > 0 ? raw : 72;
  return horas * 60 * 60 * 1000;
}

/**
 * Tolerance for a payment stamped slightly in the future — clock skew between ML
 * and us. Without an UPPER bound a forward-dated `date_created` would NEVER
 * expire, because `now - created` stays negative and can never exceed the max
 * age: the exact silent bug `@delfrance/data/admin/oauth-state` documents
 * (`MAX_FUTURE_SKEW_MS`), which lived in only one of two channels for months.
 */
export const PEDIDO_BOOTSTRAP_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * ML payment statuses that mean the sale is OVER — the terminal arms of
 * `statusPagamentoFromMlPaymentStatus` (`orderStatusMaps.ts`). Bootstrapping a
 * pedido for one of these would reserve stock for a purchase that will never
 * complete, and `terminate on death` is the loop guard that keeps a payment
 * whose order never appears from being retried forever.
 *
 * ⚠️ Matched against the RAW ML string, never the mapped enum:
 * `statusPagamentoFromMlPaymentStatus` THROWS on a status ML has not documented,
 * and this decision runs on a path that today returns cleanly — routing it
 * through the mapper would turn a clean skip into a thrown error. An unrecognised
 * status therefore bootstraps (conservative toward holding the stock) and logs.
 */
export const ML_PAYMENT_STATUS_TERMINAL: ReadonlySet<string> = new Set([
  'rejected',
  'cancelled',
  'refunded',
  'charged_back',
]);

/** Why {@link decidirBootstrapPedido} refused, or `'bootstrap'` when it did not. */
export type BootstrapVeredito =
  | 'bootstrap'
  | 'pedido-nao-encontrado-expirado'
  | 'pedido-nao-encontrado-pagamento-morto';

/**
 * Pure: may a payment with no owning pedido bootstrap one? Both guards, in µs.
 *
 * ⚠️ UNITS. Both sides are MICROSECONDS at the comparison — the
 * `ultimaModificacao` family, not the millisecond family the ML link docs use
 * (root `CLAUDE.md` rule 7). `criadoUs` comes from `coerceToMicros(date_created)`,
 * which parses ML's ISO-8601 string at full precision.
 *
 * ⚠️ `criadoUs == null` FAILS OPEN (bootstraps). That is the house convention for
 * an unreadable timestamp (`ack404EhSeguro`, the staleness gate above), and here
 * it is also the direction that holds stock. `coerceToMicros` returns null for
 * three distinct reasons — absent, unparseable, or a bare number in the
 * undeterminable ms/µs gap — and none of them means "age 0".
 */
export function decidirBootstrapPedido(args: {
  criadoUs: number | null;
  statusMl: string | null;
  nowUs: number;
  maxAgeMs?: number;
}): BootstrapVeredito {
  const { criadoUs, statusMl, nowUs } = args;
  if (statusMl != null && ML_PAYMENT_STATUS_TERMINAL.has(statusMl)) {
    return 'pedido-nao-encontrado-pagamento-morto';
  }
  if (criadoUs == null) return 'bootstrap';
  const idadeUs = nowUs - criadoUs;
  if (idadeUs < 0 && -idadeUs > PEDIDO_BOOTSTRAP_MAX_FUTURE_SKEW_MS * 1000) {
    return 'pedido-nao-encontrado-expirado';
  }
  const maxAgeUs = (args.maxAgeMs ?? pedidoBootstrapMaxAgeMs()) * 1000;
  return idadeUs > maxAgeUs ? 'pedido-nao-encontrado-expirado' : 'bootstrap';
}

/**
 * `orderKey = external_reference ?? order_id.toString()`, then `int.parse`
 * (tasks.dart:1176) — external_reference wins when present; either source
 * must reduce to a plain non-negative integer string, or the key is
 * unusable. Approved deviation: legacy's `int.parse` failure is a silent
 * return; this port returns null so the caller can log it.
 */
function parsePaymentOrderKey(payment: MlPayment): number | null {
  const raw =
    payment.external_reference ?? (payment.order_id != null ? String(payment.order_id) : null);
  if (raw == null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** Strict `status_pagamento === aprovado` sum — mirrors `orderImport.ts`'s own
 * private `sumApprovedOnly` (not exported; this handler keeps its own copy
 * rather than reaching into that module's internals). */
function sumApprovedOnly(
  pagamentos: ReadonlyArray<{ valor: number; status_pagamento: number | null }>,
): number {
  return roundReais(
    pagamentos
      .filter((p) => p.status_pagamento === STATUS_PAGAMENTO.aprovado)
      .reduce((sum, p) => sum + p.valor, 0),
  );
}

function readNumberField(raw: Record<string, unknown>, key: string): number | null {
  const v = raw[key];
  return typeof v === 'number' ? v : null;
}

/**
 * Read a stored epoch field and normalize it to MICROSECONDS. Legacy Flutter
 * wrote `pagamento` datetimes as ISO-8601 STRINGS, which a raw numeric read
 * returns as `null` — and `null` means "proceed" on the gate below, so the
 * guard is fail-open on every legacy-written pagamento today (#791/O3).
 * `coerceToMicros` handles the string, the legacy millisecond int and the
 * current µs int alike, so the gate is correct with or without the pending
 * backfill.
 */
function readMicrosField(raw: Record<string, unknown>, key: string): number | null {
  return coerceToMicros(raw[key]);
}

/** The larger of two µs watermarks (either may be absent). */
function maiorUs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}

/**
 * Import (upsert) one Mercado Livre `payments`-topic notification onto its
 * owning pedido. See the module doc for the full legacy mapping.
 */
export async function importPagamentoMercadoLivre(
  deps: PaymentImportDeps,
  paymentId: number,
): Promise<PaymentImportResult> {
  const { db, api, contaId, nowUs } = deps;

  let payment: MlPayment;
  try {
    payment = await api.getPayment(paymentId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      return { pedidoId: null, orderId: null, skipped: 'payment-404' };
    }
    throw err;
  }

  // (2) tasks.dart:1172-1174 — zero Firestore ops for a non-marketplace payment.
  if (payment.marketplace === MARKETPLACE_NONE) {
    return { pedidoId: null, orderId: null, skipped: 'marketplace-none' };
  }

  // (3) tasks.dart:1176.
  const orderId = parsePaymentOrderKey(payment);
  if (orderId == null) {
    console.warn('[mercado-livre] payment import: sem order key parseável', {
      paymentId,
      externalReference: payment.external_reference ?? null,
      orderIdField: payment.order_id ?? null,
    });
    return { pedidoId: null, orderId: null, skipped: 'sem-order-key' };
  }

  // (4) tasks.dart:1178-1191 — the shared pack-first resolver (`orderPedidoResolve.ts`).
  const pedidoId = await resolvePedidoIdByOrderId(db, orderId);
  if (pedidoId == null) {
    // (4b) #1087 — the seam moved. This handler still creates NO pedido; it
    // reports whether the caller may ask the `orders_v2` topic to. See the
    // module doc point (4).
    const veredito = decidirBootstrapPedido({
      criadoUs: coerceToMicros(payment.date_created ?? null),
      statusMl: payment.status ?? null,
      nowUs,
    });
    if (veredito !== 'bootstrap') {
      console.warn('[mercado-livre] payment import: bootstrap do pedido recusado', {
        paymentId,
        orderId,
        motivo: veredito,
        statusMl: payment.status ?? null,
        dateCreated: payment.date_created ?? null,
      });
      return { pedidoId: null, orderId, skipped: veredito };
    }
    // An ML status this port has not catalogued reaches here and bootstraps —
    // conservative toward holding the stock. It is not a lost signal: once the
    // pedido exists, the next delivery runs `mlPaymentToPagamento`, which throws
    // `MlStatusDesconhecidoError` on exactly that value rather than guessing.
    console.warn('[mercado-livre] payment import: pedido não encontrado para a order', {
      paymentId,
      orderId,
    });
    return { pedidoId: null, orderId, skipped: 'pedido-nao-encontrado' };
  }

  const contaBag = await loadContaBag(db, contaId);
  const mapped = mlPaymentToPagamento({ payment, contaCpfCnpj: contaBag.contaCpfCnpj, nowUs });
  const pagamentoId = makePagamentoIdMercadoLivre(contaId, payment.id);

  return db.runTransaction(async (tx: Transaction) => {
    /* ======================= READ PHASE (no writes yet) ======================= */
    const pagamentoRef = pagamentoCollection.docRef(db, { pedidoId }, pagamentoId);
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);

    const pagamentoSnap = await tx.get(pagamentoRef);
    const pedidoSnap = await tx.get(pedidoRef);
    const allPagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));

    /* ======================= COMPUTE + WRITE PHASE ======================= */

    // (5) tasks.dart:1205 — null-tolerant: no stored doc, or a null stored
    // timestamp, always proceeds.
    const existingRaw = pagamentoSnap.exists
      ? (pagamentoSnap.data() as Record<string, unknown>)
      : null;
    const existingUltimaModificacao = existingRaw
      ? readMicrosField(existingRaw, 'ultimaModificacao')
      : null;
    const proceed =
      existingRaw == null ||
      existingUltimaModificacao == null ||
      existingUltimaModificacao < mapped.ultimaModificacao;
    if (!proceed) {
      return { pedidoId, orderId, skipped: 'stale' };
    }

    // (6) create-or-merge upsert at the deterministic id — doc id kept either way.
    const toWrite = existingRaw == null ? mapped : mergePagamentoUpdate(existingRaw, mapped);
    tx.set(pagamentoRef, pagamentoCollection.parse(toWrite));

    // (7) estado advance — only inside the write branch, only for a pedido
    // still awaiting payment confirmation.
    if (pedidoSnap.exists) {
      const pedidoRaw = pedidoSnap.data() as Record<string, unknown>;
      const valorCobrado = readNumberField(pedidoRaw, 'valorCobrado');
      // ONE definition of what `pago` requires, shared with the order import
      // (#791). This path used to check only `estado` + `valorCobrado`, so the
      // payments topic could advance a pedido the order import deliberately
      // refuses (no cliente, no endereço, no frete) — and `pago` authorizes
      // dispatch and NF-e emission. Strictly more conservative than before; the
      // log below makes the delta observable rather than silent.
      const podeAvancar = podeAvancarParaPago({
        estado: pedidoRaw.estado as never,
        clientePedidoOuterRef: (pedidoRaw.clientePedidoOuterRef ?? null) as string | null,
        enderecoFiscalOuterRef: (pedidoRaw.enderecoFiscalOuterRef ?? null) as string | null,
        freteInicial: pedidoRaw.freteInicial ?? null,
      });
      if (!podeAvancar && pedidoRaw.estado === 'emProcessamento' && valorCobrado != null) {
        console.warn(
          '[mercado-livre] payment import: avanço para pago recusado por pré-requisito ausente',
          {
            pedidoId,
            temCliente: pedidoRaw.clientePedidoOuterRef != null,
            temEndereco: pedidoRaw.enderecoFiscalOuterRef != null,
            temFrete: pedidoRaw.freteInicial != null,
          },
        );
      }
      if (podeAvancar && valorCobrado != null) {
        const outrosPagamentos = allPagamentosSnap.docs
          .filter((d) => d.id !== pagamentoId)
          .map((d) => d.data() as Record<string, unknown>)
          .map((p) => ({
            valor: typeof p.valor === 'number' ? p.valor : 0,
            status_pagamento: typeof p.status_pagamento === 'number' ? p.status_pagamento : null,
          }));
        const contribuicaoAlvo =
          mapped.status_pagamento === STATUS_PAGAMENTO.aprovado ? mapped.valor : 0;
        const totalPago = roundReais(contribuicaoAlvo + sumApprovedOnly(outrosPagamentos));

        if (totalPago >= valorCobrado) {
          tx.update(
            pedidoRef,
            pedidoCollection.parseMerge({
              estado: 'pago',
              // Wall clock, monotonic. `lastMarketplaceUpdate` is NOT written
              // here: it is the ML ORDER-clock watermark and the order import is
              // its single writer (#791/O15). Stamping it from this path — with
              // a PAYMENT clock, or worse a wall clock — would push the order
              // watermark past every order payload currently in flight.
              ultimaModificacao: maiorUs(readMicrosField(pedidoRaw, 'ultimaModificacao'), nowUs),
            }),
          );
        }
      }
    }

    return { pedidoId, orderId, skipped: null };
  });
}
