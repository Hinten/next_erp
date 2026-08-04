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
 * `orderML`/`pagamento` are independent leaf subcollection docs (not "the
 * pedido doc" the dual-run rule restricts) and are always fully rewritten —
 * mirrors legacy's own full-object `.save()` on each.
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
  orderMLSchema,
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
import { buildOrderMLWire } from './orderMLWire';
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
  orderMlStoredLastUpdatedMs: number | null;
  payments: PaymentReadBundle[];
}

function readNumberField(raw: Record<string, unknown> | null, key: string): number | null {
  if (raw == null) return null;
  const v = raw[key];
  return typeof v === 'number' ? v : null;
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
          existingUltimaModificacao: readNumberField(pagRaw, 'ultimaModificacao'),
        });
      }

      orderBundles.push({
        order,
        orderMlRef,
        orderMlExists: orderMlSnap.exists,
        orderMlStoredLastUpdatedMs: readNumberField(orderMlRaw, 'last_updated'),
        payments,
      });
    }

    /* ======================= COMPUTE + WRITE PHASE ======================= */

    const existingItens = (existingRaw?.itens as Pedido['itens'] | undefined) ?? {};
    let workingItensFlat: ItemDoPedido[] = existingRaw ? flattenPedidoItens(existingItens) : [];
    let workingUltimaModificacaoUs: number | null = existingRaw
      ? readNumberField(existingRaw, 'ultimaModificacao')
      : null;
    const seenUniqueIds = new Set(
      workingItensFlat.map((i) => i.ensureUniqueId).filter((id): id is string => id != null),
    );
    let pedidoTouched = false;

    for (const bundle of orderBundles) {
      const { order } = bundle;
      const incomingMs = coerceToMillis(order.last_updated) ?? nowMs;

      // OUTER gate (a): fully-stale redelivery of THIS order → skip entirely.
      const outerGatePasses =
        !bundle.orderMlExists ||
        bundle.orderMlStoredLastUpdatedMs == null ||
        bundle.orderMlStoredLastUpdatedMs < incomingMs;
      if (!outerGatePasses) continue;

      // orderML mirror always refreshed once the outer gate passes — both the
      // create and update-if-newer branches converge on the SAME wire write.
      // NOTE: `contaOuterRef` (the ML account's own outer-ref, threaded straight
      // into `buildOrderMLWire`) is a DIFFERENT arg from `integracaoOuterRef`
      // (stamped onto `pedido.integracaoPedidoOuterRef` below) — both usually
      // resolve to the same `integracao` doc in this ML-only flow, but the
      // contract keeps them separate fields, so each is used for its own field.
      const wire = buildOrderMLWire({ order, contaOuterRef: args.contaOuterRef });
      tx.set(bundle.orderMlRef, orderMLSchema.parse(wire));

      const incomingUs = coerceToMicros(order.last_updated) ?? nowUs;

      // INNER gate (a): a fresher sibling order in the same pack may have
      // already advanced the pedido past this one — skip the item/payment
      // merge (but the orderML refresh above still happened).
      const innerGatePasses =
        !bundle.orderMlExists ||
        workingUltimaModificacaoUs == null ||
        workingUltimaModificacaoUs < incomingUs;
      if (!innerGatePasses) continue;

      // Item merge — append ONLY lines whose ensureUniqueId is absent (c).
      const items = args.itensByOrderId.get(order.id) ?? [];
      for (const item of items) {
        if (item.ensureUniqueId != null && seenUniqueIds.has(item.ensureUniqueId)) continue;
        if (item.ensureUniqueId != null) seenUniqueIds.add(item.ensureUniqueId);
        workingItensFlat.push(item);
      }
      workingUltimaModificacaoUs = incomingUs;
      pedidoTouched = true;

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
      // doc) — but `ultimaModificacao` is unconditionally overwritten by
      // EVERY order's own `.copyWith(ultimaModificacao: orderInstance.last_updated)`
      // as the loop processes the rest of the pack (see the module doc, (a)),
      // so the create doc must carry the LAST one processed, not just
      // `firstOrder`'s — `workingUltimaModificacaoUs` already tracks that;
      // it only falls back to `core.ultimaModificacao` if, somehow, no order
      // passed its inner gate (unreachable on a fresh create, since
      // `firstOrder` always does — defensive only).
      const finalUltimaModificacao = workingUltimaModificacaoUs ?? core.ultimaModificacao;
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
        valorFreteInicial: core.valorFreteInicial,
        timestamp: core.timestamp,
        ultimaModificacao: finalUltimaModificacao,
        lastMarketplaceUpdate: finalUltimaModificacao,
        observacoesInternas: core.observacoesInternas,
      };
      // `estoqueAplicado` intentionally absent — server-owned (schema default `null`).
      tx.create(targetRef, pedidoCollection.parse(fullDoc));
    } else if (pedidoTouched) {
      const patch = pedidoCollection.parseMerge({
        itens: itensRecord,
        itensIds,
        ultimaModificacao: workingUltimaModificacaoUs,
        lastMarketplaceUpdate: workingUltimaModificacaoUs,
      });
      tx.update(targetRef, patch);
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
          pedidoCollection.parseMerge({ estado: 'cancelado', ultimaModificacao: nowUs }),
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
