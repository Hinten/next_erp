/**
 * Transactional pedido writer for the Mercado Livre order import (Step 9,
 * PR 2 — the "discover or create the target pedido" core). Ports
 * `_discoverPedidoMercadoLivre`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:145-361`)
 * onto our schema, folding legacy's PER-ORDER sequence of separately-committed
 * transactions into ONE `db.runTransaction` covering every order of the pack
 * (Admin SDK requires every read before the first write — see the module's
 * read/write phase split below).
 *
 * ---- Verified against `.old` (quoted verbatim, tasks.dart:145-361):
 *
 * (a) Existing-pedido update — staleness gates + written fields. TWO nested
 * gates, both keyed off `orderInstance.last_updated ?? DateTime.now()`:
 *
 *   ```dart
 *   if (orderMlJaCadastrada == null || orderMlJaCadastrada.last_updated!.compareTo(orderInstance.last_updated ?? DateTime.now()) < 0){
 *     if (
 *     orderMlJaCadastrada == null ||
 *         criouNovaOrder ||
 *         targetPedido.ultimaModificacao == null ||
 *         targetPedido.ultimaModificacao!.compareTo(orderInstance.last_updated ?? DateTime.now()) < 0){
 *       // ...item merge + payments + save...
 *     } else {
 *       pedidoResult = targetPedido;
 *     }
 *     if (orderMlJaCadastrada == null){
 *       await orderInstance.copyWithParent(parent: pedidoResult, docIdString: orderInstance.id.toString()).save(transaction: transaction, safe: true);
 *     } else if (orderMlJaCadastrada.last_updated!.compareTo(orderInstance.last_updated ?? DateTime.now()) < 0){
 *       await orderMlJaCadastrada.update(orderInstance).save(transaction: transaction, safe: true);
 *     }
 *   }
 *   else{
 *     pedidoResult = targetPedido;
 *   }
 *   ```
 *   OUTER gate (per order): the order's own `orderML` mirror child doesn't
 *   exist yet, OR its stored `last_updated` is OLDER than the incoming order —
 *   otherwise this order is a fully-stale redelivery and NOTHING is written
 *   for it (no orderML refresh, no item/payment merge). INNER gate (only
 *   reached when the outer gate passes): the pedido-level item/payment merge
 *   + save runs when the orderML child is brand new, OR this is the very
 *   first order of a freshly-created pedido (`criouNovaOrder`), OR the
 *   pedido's own `ultimaModificacao` is null/older than the incoming order —
 *   otherwise a DIFFERENT (fresher) order already advanced the pedido past
 *   this one, so only the orderML mirror gets refreshed, the pedido itself is
 *   left untouched. `save()` on the merge path writes `itens` (full
 *   `replaceItensFromList`) + `ultimaModificacao` ONLY —
 *   `.copyWith(ultimaModificacao: orderInstance.last_updated)` is the entire
 *   call, no other field rides along.
 *
 * (b) Estado on an existing-pedido update: UNCHANGED. The merge-path
 *   `.copyWith(...)` call touches only `ultimaModificacao` (+ itens via
 *   `replaceItensFromList`) — `estado` is never part of it. An ML order/item
 *   change alone never flips `estado`; that is the separate "pago advance" /
 *   "downgrade" logic (tasks.dart:660-774, outside this module's scope — A3).
 *
 * (c) Embedded-payments upsert (233-242, 310-322) — read gated on
 *   `!criouNovaOrder` (a brand-new pedido has no prior pagamentos to look up,
 *   so every embedded payment is created fresh by construction):
 *   ```dart
 *   if (!criouNovaOrder) {
 *     for (var pagamento in pagamentos) {
 *       pagamentosInstances[pagamento.id!] = await targetPedido.reference.pagamento.documents
 *           .doc(pagamento.generatePagamentoUid(api.conta_ml.docId!.path!), transaction: transaction)
 *           .then((value) => value, onError: ...);
 *     }
 *   }
 *   ...
 *   for (var pagamento in pagamentos){
 *     if (pagamentosInstances[pagamento.id!] == null){
 *       // CREATE at the deterministic id
 *     } else if ((pagamentosInstances[pagamento.id!]?.ultimaModificacao?.compareTo(pagamento.ultimaModificacao!) ?? -1) < 0){
 *       // UPDATE — stored ultimaModificacao is OLDER than incoming → overwrite
 *     }
 *     // else: stored ultimaModificacao >= incoming → skip, no write
 *   }
 *   ```
 *   This whole loop sits INSIDE the same inner gate as the item merge — a
 *   pedido that skips its own item merge (a fresher sibling order already won)
 *   also skips this order's payment upserts.
 *
 *   ⚠️ Parity fix (approved deviation, NOT byte parity with the excerpt
 *   above): legacy's own `pagamentosInstances[...].update(pagamento)` call on
 *   the UPDATE branch is `Pagamento.update` (`models.odm.g.dart:11786-11813`)
 *   — a field-level merge, not the full-object overwrite the pseudocode above
 *   implies. This port matches that merge exactly via
 *   `mergePagamentoUpdate` (`orderPaymentMapping.ts`, shared with the
 *   `payments`-topic handler, `orderPaymentImport.ts` — Step 9 PR 3): the
 *   CREATE branch still writes the mapped doc fresh, but the UPDATE branch
 *   merges onto the stored doc instead of clobbering it, so a stored field the
 *   mapper never touches (`metodoPagamentoOuterRef`, `cheque`, `juros`, `nFat`,
 *   `vencimento`, `dataCancelamento`, …) survives an order-import-driven
 *   payment refresh.
 *
 * (d) Pack absorption (341-353), verbatim:
 *   ```dart
 *   if (uidPack != null) {
 *     if (pedidoOldOrder != null && (pedidoOldOrder.estado.temMovimentacaoDeEstoque || pedidoOldOrder.estado.temReserva)){
 *       await pedidoOldOrder.copyWith(estado: ESTADOS_PEDIDO.cancelado).save(transaction: transaction);
 *       final inc = Incidente(
 *         tipo: tipoDeIncidente.troca,
 *         motivoDoIncidente: 'Pedido cancelado por ter sido incluído no pacote $pack_id',
 *         origem: OrigemIncidente.outros,
 *       );
 *       await inc.save(transaction: transaction, parent: pedidoOldOrder);
 *     }
 *   }
 *   ```
 *   `pedidoOldOrder` here is THIS order's own standalone-keyed pedido (id =
 *   `makePedidoIdMercadoLivre(contaId, order.id)`, no pack), re-read fresh
 *   every iteration — `estado.temMovimentacaoDeEstoque`/`temReserva` are
 *   ESTADO-membership predicates (our `ESTADOS_PEDIDO_MOVIMENTACAO`/
 *   `ESTADOS_PEDIDO_RESERVA` sets, `packages/schemas/src/pedido/pureLogic/estoque.ts`
 *   — NOT the `dataRemocaoEstoque`/`dataIndisponivelEstoque` marker fields,
 *   which gate the (out-of-scope, approved-deviation #1) inline stock block
 *   at tasks.dart:256-306).
 *
 *   ⚠️ Deliberate fix, NOT a legacy behavior we ported: legacy re-evaluates
 *   this check on EVERY iteration unconditionally, including the iteration
 *   whose OWN `pedidoOldOrder` was just chosen as `targetPedido` (no
 *   pack-pedido existed yet, so the standalone doc became the working
 *   pedido). In that narrow case deployed legacy would save the item merge
 *   onto `pedidoOldOrder`, then immediately overwrite it back to
 *   `estado: cancelado` via a SEPARATE local copy of the same doc reference
 *   (Dart's `copyWith` starts from the ORIGINAL pre-merge read, not the
 *   just-saved one), silently discarding the merge. This port never cancels
 *   the doc that WAS chosen as the target (compared by id below) — every
 *   other pack member's own stale standalone doc is still cancelled exactly
 *   as legacy intends.
 *
 * ---- Adaptations for the single-transaction contract (all reads BEFORE any
 * write — the Admin SDK throws on an interleaved read):
 *  - `criouNovaOrder`'s bypass of the pedido-ultimaModificacao check is
 *    subsumed by "this order's own orderML child doesn't exist yet" — true
 *    for EVERY order the first time a pedido is created (a fresh pedido has
 *    no orderML children at all), so it never needs separate tracking.
 *  - The pedido doc is written ONCE at the end (create, or a single targeted
 *    `tx.update`) with the fully-accumulated `itens`/`ultimaModificacao`
 *    state, instead of legacy's N separately-committed per-order saves to the
 *    same doc. Since every field this module touches is monotonic (items
 *    only grow; `ultimaModificacao` only advances when a fresher order wins
 *    the inner gate) the FINAL state is identical either way — this only
 *    changes how many physical writes land, not what they converge to.
 *  - `dataUltimoPagamento` (tasks.dart:164, 318-321) is local-scope dead
 *    output within this excerpt (never read before `_discoverPedidoMercadoLivre`
 *    returns) — the "pago advance" logic that name hints at lives entirely in
 *    the OUTER `importarPedidoMercadoLivre` (tasks.dart:660-774), out of this
 *    module's contract (A3's job, done with a fresh read AFTER this
 *    transaction commits).
 *
 * Dual-run wire rule: the pedido doc itself NEVER goes through a full
 * `pedidoSchema.parse` on an UPDATE — only `itens`/`itensIds`/
 * `ultimaModificacao`/`lastMarketplaceUpdate` (this module's whole write
 * surface for an existing pedido) go through `pedidoCollection.parseMerge` +
 * a targeted `tx.update`. A brand-new pedido gets the full doc (this module's
 * own CREATE shape, mirroring `mlOrderToPedidoCoreFields` +
 * `tools/test-fixtures/src/seed-pedidos-dev.ts`'s `writePedido`).
 *
 * `orderML`/`pagamento` are independent leaf subcollection docs (not "the
 * pedido doc" the dual-run rule restricts), and BOTH follow legacy's
 * create-fresh / merge-on-refresh split rather than a full rewrite:
 *  - `pagamento` — `mergePagamentoUpdate` (see the ⚠️ under (c) above);
 *  - `orderML`  — replaced wholesale whenever ML spoke in FULL (a fresh create,
 *    or a refresh whose `GET /orders/{id}` answered a complete `200`, reported
 *    through `completeOrderIds`), so the doc stays a true mirror: the wire is
 *    byte-faithful to Flutter's `OrderML.toJson()`, and a field ML cleared is
 *    cleared here. Anything we cannot call complete goes through
 *    `mergeOrderMLWire` (`orderMLWire.ts`) instead, which is keyed on what the
 *    payload CARRIED — ML's value wins wherever it named a field (explicit
 *    `null` included), and only the keys it stayed silent about are preserved.
 *
 *    Why the merge exists at all: a `206 Partial Content` body omits fields, and
 *    `buildOrderMLWire` turns an omitted `pack_id` into an explicit `null`. That
 *    is load-bearing, since `resolvePedidoIdByOrderId` matches `pack_id` FIRST —
 *    losing it strands every later payments/shipments/claims notification for
 *    that cart on `pedido-nao-encontrado` (#793). Note this is deliberately
 *    stricter than legacy's `OrderML.update`
 *    (`tasks.dart:328-329` → `models.odm.g.dart:27642-27672`), a blanket
 *    `other.field ?? this.field` that never cleared anything and so let the
 *    mirror drift. A `pack_id: null` on a COMPLETE payload is not a loss —
 *    Mercado Livre documents `pack_id` as present only "se estiver associado a
 *    um pacote", the every-order-gets-a-pack rollout being gradual, and such an
 *    order resolves through the `id ==` fallback.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { coerceToMicros, coerceToMillis, microsToMillis } from '@delfrance/core/datetime';
import type { MlOrder, MlPayment } from '@delfrance/integrations-mercado-livre';
import {
  ESTADOS_PEDIDO_MOVIMENTACAO,
  ESTADOS_PEDIDO_RESERVA,
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  flattenPedidoItens,
  type EstadoPedido,
  type ItemDoPedido,
  type Pedido,
} from '@delfrance/schemas';
import {
  incidenteCollection,
  orderMLCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';

import { makePagamentoIdMercadoLivre, makePedidoIdMercadoLivre } from './orderIds';
import { mlOrderToPedidoCoreFields } from './orderMapping';
import { buildOrderMLWire, mergeOrderMLWire, orderMLKeysCarriedBy } from './orderMLWire';
import { mergePagamentoUpdate, mlPaymentToPagamento } from './orderPaymentMapping';

export interface DiscoverPedidoArgs {
  db: Firestore;
  contaId: string;
  contaOuterRef: string;
  contaCpfCnpj: string | null;
  integracaoOuterRef: string;
  operacaoOuterRef: string | null;
  listaDePrecosOuterRef: string | null;
  /** Every ML order feeding this call — `[initiatingOrder, ...restOfPack]` when `packId` is set. */
  orders: MlOrder[];
  /**
   * Ids of the orders whose `GET /orders/{id}` answered a COMPLETE `200` (as
   * opposed to a `206 Partial Content`). Their mirror doc is replaced wholesale
   * — ML spoke in full, so the doc should say exactly what ML says. Every other
   * order falls back to the presence-keyed merge. Deliberately fail-safe: an id
   * absent here (or the whole set omitted) means "not known to be complete", so
   * a caller that can't tell never triggers a destructive replace.
   */
  completeOrderIds?: ReadonlySet<number>;
  packId: number | null;
  itensByOrderId: ReadonlyMap<number, readonly ItemDoPedido[]>;
  /** One timestamp for the whole operation (µs since epoch) — never `Date.now()` inside this module. */
  nowUs: number;
}

export interface DiscoverPedidoResult {
  pedidoId: string;
  created: boolean;
}

/** `order.payments[]` embedded on a raw ML order — carries the same rich shape
 * `MlPayment` types (confirmed by `orderMLWire.ts`'s `buildPaymentWire`, which
 * reads `card`/`charge_details`/`fee_details`/etc. straight off these entries).
 * Not yet promoted to a named field on `MlOrder` — same passthrough-cast
 * pattern `orderMapping.ts`/`orderMLWire.ts` already use for this exact field. */
interface MlOrderWithEmbeddedPayments {
  payments?: MlPayment[] | null;
}

function embeddedPayments(order: MlOrder): MlPayment[] {
  return (order as unknown as MlOrderWithEmbeddedPayments).payments ?? [];
}

interface PaymentReadBundle {
  payment: MlPayment;
  ref: FirebaseFirestore.DocumentReference;
  exists: boolean;
  /** The stored doc's raw fields (default `{}` when absent) — the merge base
   * for `mergePagamentoUpdate` on the UPDATE branch below. */
  existingRaw: Record<string, unknown>;
  existingUltimaModificacao: number | null;
}

interface OrderReadBundle {
  order: MlOrder;
  orderMlRef: FirebaseFirestore.DocumentReference;
  orderMlExists: boolean;
  /** The stored mirror doc's raw fields (`null` when absent) — the merge base
   * for `mergeOrderMLWire` on the refresh path below. */
  orderMlRaw: Record<string, unknown> | null;
  orderMlStoredLastUpdatedMs: number | null;
  payments: PaymentReadBundle[];
}

/**
 * Read a stored epoch field and normalize it to MICROSECONDS.
 *
 * Never compare a raw stored value: legacy Flutter wrote pedido/frete datetimes
 * as millisecond ints and pagamento datetimes as ISO-8601 strings, so a raw
 * comparison against a µs payload either always passes (ms ≪ µs) or reads the
 * string as `null` and passes anyway — a guard that never rejects anything
 * (root `CLAUDE.md` rule 7 / ADR 0011, and issue #791/O3). `coerceToMicros`
 * classifies by magnitude and yields the same instant in either unit, so the
 * guards below are correct with or without the pending µs backfill.
 */
function readMicrosField(raw: Record<string, unknown> | null, key: string): number | null {
  return raw == null ? null : coerceToMicros(raw[key]);
}

/** Same, for the `orderML` mirror, whose schema is declared in MILLISECONDS. */
function readMillisField(raw: Record<string, unknown> | null, key: string): number | null {
  return raw == null ? null : coerceToMillis(raw[key]);
}

/** The larger of two µs watermarks (either may be absent). */
function maiorUs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}

/** The item fields Mercado Livre owns — the ones a re-read could disagree on. */
const CAMPOS_ITEM_DO_ML = [
  'quantidade',
  'precoDeVenda',
  'descontoUnitario',
  'nomeDeVenda',
  'sku',
] as const satisfies ReadonlyArray<keyof ItemDoPedido>;

/**
 * OBSERVABILITY ONLY — changes nothing.
 *
 * `ensureUniqueId` is `sha256(orderId, mktplaceId, index)` (`orderIds.ts`,
 * inherited from legacy `ItemDoPedido.generateUid`): it does NOT include
 * quantity or price. So the merge is append-only — a line already stored is
 * never updated, and if ML ever changed one, the pedido would keep the old
 * values forever.
 *
 * Lucas has never observed ML mutating `order_items` on an existing order,
 * which is consistent with how ML models orders (changes arrive as a new order
 * in the pack, a claim, or a refund), so #791 deliberately does NOT change the
 * merge. This log exists to turn that assumption into data: if it never fires
 * in production, the append-only merge is provably correct; if it does, the
 * follow-up issue has its evidence and its exact field list.
 */
function reportarDivergenciaItem(
  orderId: number,
  armazenado: ItemDoPedido | undefined,
  recebido: ItemDoPedido,
): void {
  if (armazenado == null) return;
  const divergentes = CAMPOS_ITEM_DO_ML.filter((c) => armazenado[c] !== recebido[c]);
  if (divergentes.length === 0) return;
  console.warn('[mercado-livre] item já importado difere do payload atual — merge é append-only', {
    orderId,
    ensureUniqueId: recebido.ensureUniqueId,
    campos: divergentes,
    armazenado: Object.fromEntries(divergentes.map((c) => [c, armazenado[c]])),
    recebido: Object.fromEntries(divergentes.map((c) => [c, recebido[c]])),
  });
}

/**
 * Discover (or create) the pedido this batch of Mercado Livre orders belongs
 * to, folding every order's item/payment/orderML-mirror update into ONE
 * transaction. See the module doc for the full legacy-parity writeup.
 */
export async function discoverPedidoMercadoLivre(
  args: DiscoverPedidoArgs,
): Promise<DiscoverPedidoResult> {
  const { db, contaId, packId, nowUs } = args;
  const firstOrder = args.orders[0];
  if (!firstOrder) {
    throw new Error('discoverPedidoMercadoLivre: nenhuma order recebida');
  }
  const nowMs = microsToMillis(nowUs);

  return db.runTransaction(async (tx: Transaction) => {
    /* ======================= READ PHASE (no writes yet) ======================= */

    const packRef =
      packId != null
        ? pedidoCollection.docRef(db, {}, makePedidoIdMercadoLivre(contaId, firstOrder.id, packId))
        : null;
    const packSnap = packRef ? await tx.get(packRef) : null;

    // Every order's OWN standalone-keyed pedido — used both as the target
    // fallback (firstOrder only) and as the pack-absorption candidate set
    // (every order, (d) above).
    const standaloneEntries: Array<{
      order: MlOrder;
      ref: FirebaseFirestore.DocumentReference;
      exists: boolean;
      raw: Record<string, unknown> | null;
    }> = [];
    for (const order of args.orders) {
      const ref = pedidoCollection.docRef(db, {}, makePedidoIdMercadoLivre(contaId, order.id));
      const snap = await tx.get(ref);
      standaloneEntries.push({
        order,
        ref,
        exists: snap.exists,
        raw: snap.exists ? (snap.data() as Record<string, unknown>) : null,
      });
    }

    // Target choice: existing pack-pedido > existing order-pedido (firstOrder) > new.
    let targetRef: FirebaseFirestore.DocumentReference;
    let existingRaw: Record<string, unknown> | null = null;
    let created = false;
    if (packSnap?.exists) {
      targetRef = packRef!;
      existingRaw = packSnap.data() as Record<string, unknown>;
    } else if (standaloneEntries[0]!.exists) {
      targetRef = standaloneEntries[0]!.ref;
      existingRaw = standaloneEntries[0]!.raw;
    } else {
      const newId = makePedidoIdMercadoLivre(contaId, firstOrder.id, packId);
      targetRef = pedidoCollection.docRef(db, {}, newId);
      created = true;
    }
    const targetId = targetRef.id;

    // orderML mirror child + embedded-payment docs, per order, under the TARGET.
    const orderBundles: OrderReadBundle[] = [];
    for (const order of args.orders) {
      const orderMlRef = orderMLCollection.docRef(db, { pedidoId: targetId }, String(order.id));
      const orderMlSnap = await tx.get(orderMlRef);
      const orderMlRaw = orderMlSnap.exists
        ? (orderMlSnap.data() as Record<string, unknown>)
        : null;

      const payments: PaymentReadBundle[] = [];
      for (const payment of embeddedPayments(order)) {
        const pagId = makePagamentoIdMercadoLivre(contaId, payment.id);
        const pagRef = pagamentoCollection.docRef(db, { pedidoId: targetId }, pagId);
        const pagSnap = await tx.get(pagRef);
        const pagRaw = pagSnap.exists ? (pagSnap.data() as Record<string, unknown>) : null;
        payments.push({
          payment,
          ref: pagRef,
          exists: pagSnap.exists,
          existingRaw: pagRaw ?? {},
          existingUltimaModificacao: readMicrosField(pagRaw, 'ultimaModificacao'),
        });
      }

      orderBundles.push({
        order,
        orderMlRef,
        orderMlExists: orderMlSnap.exists,
        orderMlRaw,
        // `readMillisField`, not a raw read: the mirror's schema declares
        // MILLISECONDS and the incoming side is coerced too, so the comparison
        // below is unit-safe (#791/O3).
        orderMlStoredLastUpdatedMs: readMillisField(orderMlRaw, 'last_updated'),
        payments,
      });
    }

    /* ======================= COMPUTE + WRITE PHASE ======================= */

    const existingItens = (existingRaw?.itens as Pedido['itens'] | undefined) ?? {};
    const workingItensFlat: ItemDoPedido[] = existingRaw ? flattenPedidoItens(existingItens) : [];
    // The ML ORDER-clock watermark, accumulated across the pack as a MAX (never
    // an assignment — two orders of one pack are two independent ML resources,
    // so "the last one processed" is not "the newest").
    let relogioOrdemUs: number | null = existingRaw
      ? readMicrosField(existingRaw, 'lastMarketplaceUpdate')
      : null;
    const seenUniqueIds = new Set(
      workingItensFlat.map((i) => i.ensureUniqueId).filter((id): id is string => id != null),
    );
    const armazenadosPorUid = new Map<string, ItemDoPedido>(
      workingItensFlat
        .filter((i) => i.ensureUniqueId != null)
        .map((i) => [i.ensureUniqueId as string, i]),
    );
    let itensMudaram = false;

    for (const bundle of orderBundles) {
      const { order } = bundle;
      const incomingMs = coerceToMillis(order.last_updated) ?? nowMs;
      const incomingUs = coerceToMicros(order.last_updated) ?? nowUs;

      // The `orderML` mirror keeps its update-if-newer semantics (a): it is
      // meant to hold the LATEST known state of THIS order, so a stale
      // redelivery must not write older data over newer.
      //
      // NOTE: `contaOuterRef` (the ML account's own outer-ref, threaded straight
      // into `buildOrderMLWire`) is a DIFFERENT arg from `integracaoOuterRef`
      // (stamped onto `pedido.integracaoPedidoOuterRef` below) — both usually
      // resolve to the same `integracao` doc in this ML-only flow, but the
      // contract keeps them separate fields, so each is used for its own field.
      //
      // The doc is REPLACED whenever ML spoke in full — a fresh create, or a
      // refresh whose fetch answered a complete `200`. That keeps the mirror a
      // mirror: the byte-faithful `includeIfNull: true` wire is exactly what
      // Flutter's `OrderML.toJson()` would write, and a field ML cleared is
      // cleared here too. Only a payload we cannot call complete goes through
      // the presence-keyed merge, which preserves the keys ML stayed silent
      // about (`pack_id` above all — #793) while still honouring every value it
      // did send. See the module doc's orderML paragraph.
      // `orderMlRaw` comes from THIS transaction's own `tx.get` above, so an
      // OCC retry re-reads and re-merges (root CLAUDE.md rule 7, tier 1) — do
      // not hoist that read out of the `runTransaction` callback.
      if (
        !bundle.orderMlExists ||
        bundle.orderMlStoredLastUpdatedMs == null ||
        bundle.orderMlStoredLastUpdatedMs < incomingMs
      ) {
        const wire = buildOrderMLWire({ order, contaOuterRef: args.contaOuterRef });
        const armazenado = bundle.orderMlRaw;
        const replaceWholesale =
          armazenado == null || (args.completeOrderIds?.has(order.id) ?? false);
        const orderMlDoc = replaceWholesale
          ? wire
          : mergeOrderMLWire(armazenado, wire, orderMLKeysCarriedBy(order));
        tx.set(bundle.orderMlRef, orderMLCollection.parse(orderMlDoc));
      }

      // ---- #791: the item merge and the payment upsert are NO LONGER gated on
      // an order clock, and this is the change that makes the pedido converge.
      //
      // Legacy needed those gates because it committed one transaction PER
      // ORDER and each `save()` rewrote the whole item list, so a stale order
      // could clobber a fresher sibling. This port folds the entire pack into
      // ONE transaction and appends, so there is no cross-commit clobber left to
      // guard against — and both gates actively LOST data instead:
      //
      //  - the inner gate compared order A's clock against order B's (they are
      //    independent ML resources, so "older" says nothing about whether we
      //    already applied it), silently dropping a pack sibling's lines and its
      //    payment upserts;
      //  - it seeded from `pedido.ultimaModificacao`, a wall-clock stamp with
      //    half a dozen writers (every human save via `saveRecord`, the Mercado
      //    Pago reconcile, the Flutter app), so one operator edit could stall the
      //    ML item sync;
      //  - and because `pedidoTouched` was set only inside it, a gate that
      //    rejected every order wrote NO pedido at all.
      //
      // Both operations are idempotent by construction: the merge appends only
      // lines whose `ensureUniqueId` is absent (c), and each embedded payment
      // carries its own per-document watermark below. Re-running them is free.
      const items = args.itensByOrderId.get(order.id) ?? [];
      for (const item of items) {
        if (item.ensureUniqueId != null && seenUniqueIds.has(item.ensureUniqueId)) {
          reportarDivergenciaItem(order.id, armazenadosPorUid.get(item.ensureUniqueId), item);
          continue;
        }
        if (item.ensureUniqueId != null) {
          seenUniqueIds.add(item.ensureUniqueId);
          armazenadosPorUid.set(item.ensureUniqueId, item);
        }
        workingItensFlat.push(item);
        itensMudaram = true;
      }
      relogioOrdemUs = maiorUs(relogioOrdemUs, incomingUs);

      // Embedded-payments upsert (c) — create when absent, overwrite only
      // when the incoming payment is strictly newer than what's stored. The
      // UPDATE branch merges onto the stored doc via `mergePagamentoUpdate`
      // (parity fix, see the module doc's ⚠️ note above) instead of
      // overwriting it wholesale; CREATE still writes the mapped doc fresh.
      for (const p of bundle.payments) {
        const mapped = mlPaymentToPagamento({
          payment: p.payment,
          contaCpfCnpj: args.contaCpfCnpj,
          nowUs,
        });
        const shouldWrite =
          !p.exists ||
          p.existingUltimaModificacao == null ||
          p.existingUltimaModificacao < mapped.ultimaModificacao;
        if (shouldWrite) {
          const toWrite = p.exists ? mergePagamentoUpdate(p.existingRaw, mapped) : mapped;
          tx.set(p.ref, pagamentoCollection.parse(toWrite));
        }
      }
    }

    // Rebuild the record<produtoUid, item[]> + itensIds projection —
    // `itensIds = Object.keys(itens)` (mirrors `PedidoForm.tsx`/`devolucao.ts`).
    const itensRecord: Pedido['itens'] = {};
    for (const item of workingItensFlat) {
      const key = item.produtoUid ?? 'NONE';
      (itensRecord[key] ??= []).push(item);
    }
    const itensIds = Object.keys(itensRecord);

    if (created) {
      const core = mlOrderToPedidoCoreFields({ order: firstOrder, packId });
      // `estado`/`numero`/money fields come from `firstOrder` ONLY (legacy's
      // `toPedido()` runs once, on the very first iteration that creates the
      // doc). The two stamps carry DIFFERENT clocks and must not be conflated
      // (#791/O15):
      //  - `lastMarketplaceUpdate` is the ML ORDER clock — the max across every
      //    order folded into this pedido. It is the field the estado downgrade
      //    compares an incoming payload against.
      //  - `ultimaModificacao` is the wall-clock "last modified" stamp that
      //    `saveRecord`, the Mercado Pago reconcile, the Flutter app and the
      //    `TableView` update-monitor all already treat it as. Stamping it with
      //    a payload clock would let a pedido row jump BACKWARDS in the recency
      //    sort and let the monitor miss the change entirely.
      const relogioFinal = relogioOrdemUs ?? core.ultimaModificacao;
      const fullDoc = {
        ehSaida: true,
        estado: core.estado,
        numero: core.numero,
        vendedorPedidoOuterRef: null,
        integracaoPedidoOuterRef: args.integracaoOuterRef,
        operacaoPedidoOuterRef: args.operacaoOuterRef,
        clientePedidoOuterRef: null,
        enderecoFiscalOuterRef: null,
        listaDePrecosOuterRef: args.listaDePrecosOuterRef,
        itens: itensRecord,
        itensIds,
        freteInicial: null,
        descontoTotal: core.descontoTotal,
        valorCobrado: core.valorCobrado,
        timestamp: core.timestamp,
        ultimaModificacao: nowUs,
        lastMarketplaceUpdate: relogioFinal,
        observacoesInternas: core.observacoesInternas,
      };
      // `estoqueAplicado` intentionally absent — server-owned (schema default `null`).
      tx.create(targetRef, pedidoCollection.parse(fullDoc));
    } else {
      // Write only what actually moved. Without this, retiring the clock gates
      // above would turn every byte-identical redelivery into a pedido write.
      const armazenadoUs = readMicrosField(existingRaw, 'lastMarketplaceUpdate');
      const relogioAvancou =
        relogioOrdemUs != null && (armazenadoUs == null || armazenadoUs < relogioOrdemUs);
      if (itensMudaram || relogioAvancou) {
        const patch: Record<string, unknown> = {
          // Wall clock, monotonic: this is the display/recency stamp, and other
          // writers (a human save, the Flutter app) may already have set it
          // ahead of us.
          ultimaModificacao: maiorUs(readMicrosField(existingRaw, 'ultimaModificacao'), nowUs),
        };
        if (itensMudaram) {
          patch.itens = itensRecord;
          patch.itensIds = itensIds;
        }
        if (relogioAvancou) patch.lastMarketplaceUpdate = relogioOrdemUs;
        tx.update(targetRef, pedidoCollection.parseMerge(patch));
      }
    }

    // Pack absorption (d) — every OTHER order's own stale standalone pedido
    // (never the one chosen as the target — see the module doc's deviation note).
    if (packId != null) {
      for (const entry of standaloneEntries) {
        if (!entry.exists || entry.raw == null) continue;
        if (entry.ref.id === targetId) continue;
        const estado = entry.raw.estado as EstadoPedido | undefined;
        if (!estado) continue;
        const hasMovimentacaoOuReserva =
          ESTADOS_PEDIDO_MOVIMENTACAO.has(estado) || ESTADOS_PEDIDO_RESERVA.has(estado);
        if (!hasMovimentacaoOuReserva) continue;

        tx.update(
          entry.ref,
          pedidoCollection.parseMerge({
            estado: 'cancelado',
            // Wall clock, monotonic — this is a real modification of a doc that
            // other writers also stamp, and it is NOT the ML order watermark
            // (that belongs to the pack pedido, not to the absorbed one).
            ultimaModificacao: maiorUs(readMicrosField(entry.raw, 'ultimaModificacao'), nowUs),
          }),
        );
        const incidenteId = incidenteCollection.newDocId(db, { pedidoId: entry.ref.id });
        const incidenteRef = incidenteCollection.docRef(
          db,
          { pedidoId: entry.ref.id },
          incidenteId,
        );
        tx.set(
          incidenteRef,
          incidenteCollection.parse({
            origem: ORIGEM_INCIDENTE.outros,
            tipo: TIPO_INCIDENTE.troca,
            motivoDoIncidente: `Pedido cancelado por ter sido incluído no pacote ${packId}`,
            timestamp: nowUs,
            ultimaModificacao: nowUs,
          }),
        );
      }
    }

    return { pedidoId: targetId, created };
  });
}
