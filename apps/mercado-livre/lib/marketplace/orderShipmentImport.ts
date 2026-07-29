/**
 * Mercado Livre SHIPMENTS webhook-topic handler (Step 9, PR 3 — "A2").
 * Refreshes a pedido's `freteInicial` block from a single `shipments`
 * notification's `resource` (a shipment id) — the lighter, single-shipment
 * counterpart to `orderImport.ts`'s own frete step, which runs the same kind
 * of merge as part of a FULL order import.
 *
 * Ports `_cadastrarAtualizarShipment`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:1264-1325`).
 * Quoted decision tree (verbatim, elided to the shape that matters here):
 *
 * ```dart
 * final data = await api.get_shipment(shipment_id);
 * final shipment = MercadoLivreShipping.fromMercadoLivre(data);
 * final shipping_payments = await api.get_shipment_payments(shipment.id);
 *
 * final OrderML? order = await OrderML.documents.pack_id__isEqualTo(shipment.order_id).first().then((value){
 *   if (value == null){ return OrderML.documents.id__isEqualTo(shipment.order_id).first(); }
 *   return value;
 * });
 *
 * if (order != null){
 *   final pedido = await order.reference.parent!.get().then((value) => value!);
 *   final integracaoFrete = await MercadoEnvios.documents.contaMercadoLivreMercadoEnviosOuterRef__isEqualTo(api.conta_ml).first();
 *   final prazoDespacho = await _getPrazoDespacho(api, shipment);
 *   final FreteDoPedido novoFrete = shipment.toFrete(... enderecoDeEntregaPath: pedido.endereco_path);
 *
 *   final transaction = Transaction(safeTransaction: (transaction) async {
 *     final pedido = await order.reference.parent!.get(transaction).then((value) => value!);
 *     final oldFrete = pedido.freteInicial;
 *     if (oldFrete != null){ assert (oldFrete.externalId?.toString() == shipment.id.toString()); }
 *     if (oldFrete != null && (oldFrete.ultimaModificacao?.isAfter(novoFrete.ultimaModificacao!) ?? true)){ return; }
 *     if (oldFrete != null && (oldFrete.ultimaModificacao?.isBefore(novoFrete.ultimaModificacao!) ?? true)){
 *       // ...estado-preserving merge + save (see mergeEstadoFretePreservando)
 *     }
 *   });
 *   await transaction.commit();
 * }
 * ```
 *
 * `order == null` (no `orderML` match) and `oldFrete == null` (no prior
 * `freteInicial`) both fall through to NO WRITE in legacy — the first because
 * the whole `if (order != null)` block is skipped, the second because BOTH
 * guard conditions above short-circuit false on a null `oldFrete` (`oldFrete
 * != null && ...` is false either way), so neither the early-return nor the
 * merge branch ever runs. This port names both as explicit `skipped` outcomes
 * instead of silently doing nothing (approved deviation — logged, not silent;
 * `sem-frete-inicial` is a marked seam: frete is only ever CREATED by the
 * order-import path, never by this handler).
 *
 * ⚠️ STALENESS GATE ASYMMETRY vs the payments-topic handler
 * (`orderPaymentImport.ts`): here a null STORED `oldFrete.ultimaModificacao`
 * reads as `?? true` on the `isAfter` check (tasks.dart:1301-1304) — i.e. "the
 * old frete counts as AFTER the new one", so the function returns immediately
 * and WRITES NOTHING. That is the *opposite* of the payments gate, where a
 * null stored timestamp reads as "definitely older" and PROCEEDS. Both are
 * faithfully ported per their own legacy source; this is not a bug in either
 * handler, just two different `?? true` defaults on two different Dart
 * comparisons (`isAfter` vs `isBefore`) in two different files. Deviation: a
 * null MAPPED `ultimaModificacao` (an unparseable/absent `shipment.last_updated`)
 * also SKIPS here — legacy's `novoFrete.ultimaModificacao!` non-null assertion
 * would throw uncaught in that case; this port treats it as "nothing to
 * compare against yet" instead of crashing.
 *
 * ---- This port's adaptations ----
 *  - Legacy reads `pedido` TWICE — once OUTSIDE the transaction just to seed
 *    `novoFrete.enderecoDeEntregaPath`, and again INSIDE the transaction for
 *    the real staleness/merge decision. This port reads the pedido doc
 *    exactly ONCE, INSIDE the (only) transaction, and derives the mapper's
 *    `enderecoOuterRef` from that same tx-fresh read — the Admin SDK
 *    transaction contract this app follows (every read before the first
 *    write) makes a single read both simpler and race-free.
 *  - `resolvePrazoDespacho` is called with `fallbackUs: null` — legacy's
 *    `_getPrazoDespacho(api, shipment)` call on THIS path passes no previous
 *    value at all (unlike `orderImport.ts`'s frete step, which threads
 *    `oldFrete?.prazoDespacho` through as the fallback) — a faithfully ported
 *    per-path difference, not an oversight.
 *  - `mergeFreteInicial` (`./orderImport`, this PR's extension of deviation
 *    #3) replaces legacy's `oldFrete.update(novoFrete)`
 *    (`FreteDoPedido.update`, `.old/packages/pedido/lib/src/models.dart:672-708`)
 *    — the `estado` resolution still goes through the dedicated
 *    `mergeEstadoFretePreservando` state machine (`orderShipmentMapping.ts`),
 *    which additionally FIXES the legacy dangling-`if` regression documented
 *    in that function's own docblock, rather than reproducing it.
 *  - `resolveMercadoEnviosIntFreteOuterRef` (`./orderImport`) replaces
 *    legacy's unfiltered, force-unwrapped `MercadoEnvios` lookup with an
 *    ativo-filtered, newest-first, null-tolerant one (already an approved
 *    deviation for the order-import path; reused verbatim here).
 *  - No `orderML` match, or `shipment.order_id == null` → skip + log (a
 *    marked seam, NOT an import fallback — this handler only ever refreshes a
 *    pedido that already exists).
 *  - `lastMarketplaceUpdate: nowUs` is stamped alongside `freteInicial` on
 *    every write (new-app observability convention, additive — see PR 2).
 *
 * THROW-ON-TRANSIENT discipline: every error EXCEPT a 404 on the primary
 * `getShipment` call propagates (the calling notification queue retries);
 * `getShipment` 404 alone means the resource is permanently gone and must not
 * retry forever.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlShipment,
} from '@delfrance/integrations-mercado-livre';
import { orderMLCollection, pedidoCollection } from '@delfrance/data/admin/collections';

import {
  loadContaBag,
  mergeFreteInicial,
  resolveMercadoEnviosIntFreteOuterRef,
} from './orderImport';
import { mlShipmentToFreteInicial } from './orderShipmentMapping';
import { resolvePrazoDespacho } from './orderPrazoDespacho';

/* -------------------------------------------------------------------------- */
/*                                  Contract                                  */
/* -------------------------------------------------------------------------- */

export interface ShipmentImportDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  nowUs: number;
}

export interface ShipmentImportResult {
  pedidoId: string | null;
  skipped:
    | 'shipment-404'
    | 'sem-order-id'
    | 'pedido-nao-encontrado'
    | 'sem-frete-inicial'
    | 'stale'
    | null;
}

/* -------------------------------------------------------------------------- */
/*                          orderML → pedido resolution                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the pedido owning a Mercado Livre order id via its `orderML`
 * mirror — pack_id first, then plain id (the same two-step collection-group
 * resolve `orderPaymentImport.ts` and legacy both use; the pack-first order
 * is a faithful legacy quirk, tasks.dart:1266-1270). Returns `null` when
 * neither key matches any `orderML` doc.
 */
async function resolvePedidoIdByOrderId(db: Firestore, orderId: number): Promise<string | null> {
  const byPack = await orderMLCollection
    .groupQuery(db)
    .where('pack_id', '==', orderId)
    .limit(1)
    .get();
  const packDoc = byPack.docs[0];
  if (packDoc) return packDoc.ref.parent?.parent?.id ?? null;

  const byId = await orderMLCollection.groupQuery(db).where('id', '==', orderId).limit(1).get();
  const idDoc = byId.docs[0];
  return idDoc ? (idDoc.ref.parent?.parent?.id ?? null) : null;
}

/* -------------------------------------------------------------------------- */
/*                                Orchestrator                                */
/* -------------------------------------------------------------------------- */

/**
 * Imports (refreshes) the `freteInicial` block for one Mercado Livre shipment
 * notification. See the file docstring for the full legacy mapping + every
 * deviation.
 */
export async function importShipmentMercadoLivre(
  deps: ShipmentImportDeps,
  shipmentId: number,
): Promise<ShipmentImportResult> {
  const { db, api, integracaoId, nowUs } = deps;

  let shipment: MlShipment;
  try {
    shipment = await api.getShipment(shipmentId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      return { pedidoId: null, skipped: 'shipment-404' };
    }
    throw err;
  }

  // Unconditional, right after the primary fetch — legacy order
  // (tasks.dart:1268-1270), BEFORE the order/orderML resolution below.
  const shippingPayments = await api.getShipmentPayments(shipmentId);

  const orderId = shipment.order_id ?? null;
  if (orderId == null) {
    console.warn('[mercado-livre] shipment sem order_id — nada a vincular', { shipmentId });
    return { pedidoId: null, skipped: 'sem-order-id' };
  }

  const pedidoId = await resolvePedidoIdByOrderId(db, orderId);
  if (pedidoId == null) {
    console.warn('[mercado-livre] shipment: nenhum pedido encontrado para a order', {
      shipmentId,
      orderId,
    });
    return { pedidoId: null, skipped: 'pedido-nao-encontrado' };
  }

  const contaBag = await loadContaBag(db, integracaoId);
  const integracaoFreteOuterRef = await resolveMercadoEnviosIntFreteOuterRef(db, integracaoId);
  const prazoDespachoUs = await resolvePrazoDespacho({
    api,
    shipment,
    sellerId: contaBag.sellerUserId ?? 0,
    // Legacy passes NO previous value on this path — see file docstring.
    fallbackUs: null,
  });

  return db.runTransaction(async (tx: Transaction) => {
    /* ============================= READ (only one) ============================= */
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    const pedido = pedidoCollection.parseRead(
      pedidoSnap.data() ?? {},
      pedidoCollection.docPath({}, pedidoId),
    );

    /* ============================ GUARDS + WRITE =============================== */
    const oldFrete = pedido.freteInicial;
    if (oldFrete == null) {
      // Frete is only ever CREATED by the order-import path — this handler
      // never creates one from scratch (legacy: both guards below short-
      // circuit false on a null oldFrete, so nothing runs; see file docstring).
      return { pedidoId, skipped: 'sem-frete-inicial' };
    }

    if (String(oldFrete.externalId) !== String(shipment.id)) {
      // Legacy debug `assert` (tasks.dart:1299) — logged instead of crashing;
      // does not block the merge.
      console.warn('[mercado-livre] shipment: externalId divergente do freteInicial armazenado', {
        shipmentId,
        storedExternalId: oldFrete.externalId,
      });
    }

    const mapped = mlShipmentToFreteInicial({
      shipment,
      shippingPayments,
      integracaoFreteOuterRef,
      enderecoOuterRef: pedido.enderecoFiscalOuterRef,
      prazoDespachoUs,
      modalidadeOverride: contaBag.modalidadeFreteImportacao,
    });

    const oldUltimaModificacao = oldFrete.ultimaModificacao;
    const isFresh =
      oldUltimaModificacao != null &&
      mapped.ultimaModificacao != null &&
      oldUltimaModificacao < mapped.ultimaModificacao;
    if (!isFresh) {
      return { pedidoId, skipped: 'stale' };
    }

    const targetFrete = mergeFreteInicial(oldFrete, mapped);
    tx.update(
      pedidoRef,
      pedidoCollection.parseMerge({
        freteInicial: targetFrete,
        lastMarketplaceUpdate: nowUs,
      }),
    );

    return { pedidoId, skipped: null };
  });
}
