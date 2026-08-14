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
 *  - `ultimaModificacao` (wall clock, monotonic) is stamped alongside
 *    `freteInicial` on every write. `lastMarketplaceUpdate` deliberately is
 *    NOT: it is the ML ORDER-clock watermark whose single writer is the order
 *    import (#791/O15). This path carries the SHIPMENT clock, which already
 *    lives inside the frete block.
 *  - `valorFreteInicial` rides every write too (#796/O9). It is not an
 *    independent field anywhere in this app — `derivePedidoTotals`
 *    (`packages/schemas/src/pedido/pureLogic/totals.ts`) DEFINES it as
 *    `freteInicial.valorCobrado`, and `packages/data/src/pedido/usecases.ts`
 *    lists it in `DERIVED_CACHES` — so a write of the frete block that leaves
 *    it behind is a write that puts the document out of agreement with itself.
 *    Legacy never wrote it on any ML path (the constructor arg is commented out
 *    at `.old/.../mercado_livre/lib/src/models.dart:3084`), which is why the
 *    drift had no legacy counterpart to port. `valorCobrado`, by contrast, is
 *    NOT written here — see the comment at the write.
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
import { coerceToMicros } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import { pedidoCollection } from '@delfrance/data/admin/collections';

import { loadContaBag, resolveMercadoEnviosIntFreteOuterRef } from './orderImport';
import { resolvePedidoIdByOrderId } from './orderPedidoResolve';
import { resolveShipmentOrderId } from './shipmentOrderId';
import {
  POLITICA_FRESCOR_TOPICO_SHIPMENTS,
  mergeFreteInicialSeMaisNovo,
  mlShipmentToFreteInicial,
} from './orderShipmentMapping';
import { resolvePrazoDespacho } from './orderPrazoDespacho';

/* -------------------------------------------------------------------------- */
/*                                  Contract                                  */
/* -------------------------------------------------------------------------- */

/** The larger of two µs watermarks (either may be absent). */
function maiorUs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}

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

  // `shipment.order_id` was discontinued by ML (#957); `resolveShipmentOrderId`
  // falls back to `GET /shipments/{id}/orders`, the documented replacement.
  const orderId = await resolveShipmentOrderId(api, shipment);
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

    // The freshness verdict and the overlay are ONE call (#791): a `null` here
    // means "write nothing at all" — neither the fields nor the watermark — so
    // this call site cannot produce a document whose watermark advertises data
    // it does not contain. The policy constant names the null cases, which this
    // path answers the OPPOSITE way from the order import (see the docstring).
    // Units: the predicate coerces both sides to µs, so a legacy Flutter
    // MILLISECOND `ultimaModificacao` still compares as the same instant.
    const targetFrete = mergeFreteInicialSeMaisNovo(
      oldFrete,
      mapped,
      POLITICA_FRESCOR_TOPICO_SHIPMENTS,
    );
    if (targetFrete == null) {
      return { pedidoId, skipped: 'stale' };
    }

    tx.update(
      pedidoRef,
      pedidoCollection.parseMerge({
        freteInicial: targetFrete,
        // The derived cache of the block above (#796/O9) — `valorFreteInicial`
        // is DEFINED as `freteInicial.valorCobrado` everywhere else in the repo
        // (`derivePedidoTotals`, `packages/schemas/src/pedido/pureLogic/totals.ts`),
        // so it travels with every write of that block or it drifts. Read off
        // `mapped`, which `mergeFreteInicial` copies VERBATIM into
        // `valorCobrado` (no `?? existing`), so it is typed and is exactly what
        // lands in the doc.
        //
        // ⚠️ `valorCobrado` is deliberately NOT written here. Legacy's
        // `_cadastrarAtualizarShipment` writes only `freteInicial` on this path
        // (tasks.dart:1295-1319) — recomputing the pedido total belongs to the
        // order import's conference, which owns the item list this path never
        // reads. Its staleness has its own analysis in `orderImport.ts`.
        valorFreteInicial: roundReais(mapped.valorCobrado ?? 0),
        // Wall clock, monotonic. `lastMarketplaceUpdate` is NOT written here:
        // it is the ML ORDER-clock watermark, and its single writer is the
        // order import (#791). This path carries the SHIPMENT clock, which
        // already lives in `freteInicial.ultimaModificacao`.
        ultimaModificacao: maiorUs(coerceToMicros(pedido.ultimaModificacao), nowUs),
      }),
    );

    return { pedidoId, skipped: null };
  });
}
