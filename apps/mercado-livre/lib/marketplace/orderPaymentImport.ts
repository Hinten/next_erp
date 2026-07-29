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
 *     ⚠️ SEAM: a payment notification for an order this ERP hasn't discovered
 *     yet is DROPPED here, not used to bootstrap a pedido — the `orders_v2`/
 *     `orders` topic (`orderImport.ts`) is the ONLY pedido creator. This is
 *     Lucas's explicit decision for this Step 9 slice, not a legacy behavior
 *     (legacy's `pedidoOldOrder` lookup on this path force-unwraps and would
 *     crash the same way on a genuine miss).
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
 *     skip never reaches this), ONLY when the pedido's stored `estado` is
 *     `'emProcessamento'` AND it has a `valorCobrado`: `totalPago` = (this
 *     payment's mapped `valor` if its mapped `status_pagamento` is `aprovado`,
 *     else 0) + the sum of every OTHER stored pagamento (read in the SAME
 *     transaction, excluding this doc's id) whose `status_pagamento` is
 *     `aprovado`. `totalPago >= valorCobrado` → patch the pedido to
 *     `{ estado: 'pago', ultimaModificacao: nowUs, lastMarketplaceUpdate:
 *     nowUs }`. Deliberately NOT `reconcilePedidoFromPagamento` (that generic
 *     path is Mercado Pago's) — NO downgrade, NO `freteInicial` flip. The
 *     `historicoEstadoPedido` row is no longer this path's concern either: the
 *     `onPedidoEstadoChanged` trigger observes the pedido write and records the
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
import {
  orderMLCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';

import { loadContaBag } from './orderImport';
import { makePagamentoIdMercadoLivre } from './orderIds';
import { mergePagamentoUpdate, mlPaymentToPagamento } from './orderPaymentMapping';

export interface PaymentImportDeps {
  db: Firestore;
  api: MercadoLivreApi;
  contaId: string;
  nowUs: number;
}

export interface PaymentImportResult {
  pedidoId: string | null;
  skipped:
    | 'payment-404'
    | 'marketplace-none'
    | 'sem-order-key'
    | 'pedido-nao-encontrado'
    | 'stale'
    | null;
}

/**
 * `payment.marketplace == NONE` (tasks.dart:1172-1174) — the exact ML literal
 * for "not a marketplace-tagged payment".
 */
const MARKETPLACE_NONE = 'NONE';

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

/**
 * Resolve the pedido owning an ML order/pack id via the `orderML`
 * collection-group mirror — `pack_id == orderId` first, else `id == orderId`
 * (tasks.dart:1178-1191). Both fields are numbers on `orderMLSchema`. Not
 * transactional (a plain collection-group scan, same precedent as
 * `import.ts`'s `resolveExistingProduto` and the order-import's own pack
 * resolution) — the transaction below re-derives every write decision from
 * fresh in-tx reads, so a resolve-then-tx race only risks a benign retry on
 * the next notification delivery, never a wrong write.
 */
async function resolveOrderMlPedidoId(db: Firestore, orderId: number): Promise<string | null> {
  const byPackId = await orderMLCollection
    .groupQuery(db)
    .where('pack_id', '==', orderId)
    .limit(1)
    .get();
  const packHit = byPackId.docs[0];
  if (packHit) return packHit.ref.parent?.parent?.id ?? null;

  const byId = await orderMLCollection.groupQuery(db).where('id', '==', orderId).limit(1).get();
  const idHit = byId.docs[0];
  if (idHit) return idHit.ref.parent?.parent?.id ?? null;

  return null;
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
      return { pedidoId: null, skipped: 'payment-404' };
    }
    throw err;
  }

  // (2) tasks.dart:1172-1174 — zero Firestore ops for a non-marketplace payment.
  if (payment.marketplace === MARKETPLACE_NONE) {
    return { pedidoId: null, skipped: 'marketplace-none' };
  }

  // (3) tasks.dart:1176.
  const orderId = parsePaymentOrderKey(payment);
  if (orderId == null) {
    console.warn('[mercado-livre] payment import: sem order key parseável', {
      paymentId,
      externalReference: payment.external_reference ?? null,
      orderIdField: payment.order_id ?? null,
    });
    return { pedidoId: null, skipped: 'sem-order-key' };
  }

  // (4) tasks.dart:1178-1191.
  const pedidoId = await resolveOrderMlPedidoId(db, orderId);
  if (pedidoId == null) {
    // SEAM — see module doc point (4): no import fallback, by design.
    console.warn('[mercado-livre] payment import: pedido não encontrado para a order', {
      paymentId,
      orderId,
    });
    return { pedidoId: null, skipped: 'pedido-nao-encontrado' };
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
      ? readNumberField(existingRaw, 'ultimaModificacao')
      : null;
    const proceed =
      existingRaw == null ||
      existingUltimaModificacao == null ||
      existingUltimaModificacao < mapped.ultimaModificacao;
    if (!proceed) {
      return { pedidoId, skipped: 'stale' };
    }

    // (6) create-or-merge upsert at the deterministic id — doc id kept either way.
    const toWrite = existingRaw == null ? mapped : mergePagamentoUpdate(existingRaw, mapped);
    tx.set(pagamentoRef, pagamentoCollection.parse(toWrite));

    // (7) estado advance — only inside the write branch, only for a pedido
    // still awaiting payment confirmation.
    if (pedidoSnap.exists) {
      const pedidoRaw = pedidoSnap.data() as Record<string, unknown>;
      const valorCobrado = readNumberField(pedidoRaw, 'valorCobrado');
      if (pedidoRaw.estado === 'emProcessamento' && valorCobrado != null) {
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
              ultimaModificacao: nowUs,
              lastMarketplaceUpdate: nowUs,
            }),
          );
        }
      }
    }

    return { pedidoId, skipped: null };
  });
}
