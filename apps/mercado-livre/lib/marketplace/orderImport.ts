/**
 * Mercado Livre order → ERP `pedido` import orchestrator (Step 9, PR 2 — "A3").
 * Composes the pieces owned by the rest of the Step 9 slice:
 *  - the pedido create/patch transaction (`orderPedidoTx.ts`, A2),
 *  - cliente/endereço resolution (`orderCliente.ts`, A1),
 *  - the dispatch-deadline resolver (`orderPrazoDespacho.ts`, A4),
 *  - PR 1's pure mappers (`orderMapping.ts`, `orderPaymentMapping.ts`,
 *    `orderShipmentMapping.ts`, `orderStatusMaps.ts`, `orderIds.ts`),
 *  - the produto-link lookup already used by product import (`import.ts`'s
 *    `resolveExistingProduto`, exported for this reuse).
 *
 * Ports `importarPedidoMercadoLivre` — the parts NOT already owned by
 * `orderPedidoTx.ts`'s transaction (`_discoverPedidoMercadoLivre`) —
 * `.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:363-787`.
 * Every legacy quote referenced below is line-numbered against that file;
 * the full verbatim quotes live in this PR's task notes.
 *
 * THROW-ON-TRANSIENT discipline: every ML API / Firestore error PROPAGATES
 * (the calling notification queue retries); only the two explicitly-legacy
 * skip cases (`seller-mismatch`, `no-buyer`) return a result instead of
 * throwing.
 *
 * ---- Deviations from legacy (see the call site for the full rationale) ----
 *  1. No inline estoque movement — `onPedidoEstoqueSync` owns stock
 *     (pre-approved Step 9 deviation, tasks.dart:256-306 not ported).
 *  2. The shipment/pedido item-quantity CROSS-CHECK (tasks.dart:536-568 — the
 *     `shipping_itens` reconciliation that can flip `error`) is NOT ported:
 *     the plugin has no `getShipmentItems` (only the endpoints this Step 9
 *     contract lists), so `totalItens` is ALWAYS the pedido's own item
 *     subtotal — the legacy `hasUserInteraction == true` branch
 *     (tasks.dart:570), applied unconditionally. FORCED deviation (missing
 *     plugin surface, out of this file's ownership) — tracked as a follow-up
 *     to add `get_shipment_items` + port the mismatch guard faithfully.
 *  3. The order-import's own inline frete-merge (tasks.dart:592-607) and the
 *     shipments-topic merge (tasks.dart:1306-1315, PR 1's
 *     `mergeEstadoFretePreservando`) are UNIFIED onto one shared helper,
 *     `mergeFreteInicial` (this file, exported for `orderShipmentImport.ts`'s
 *     reuse in PR 3) — matching this port's established pattern of
 *     collapsing inconsistent legacy variants into one (see
 *     `orderShipmentMapping.ts`'s own `estadoFreteFromShipment` precedent).
 *     `mergeFreteInicial` itself further extends legacy's `FreteDoPedido.update`
 *     (`.old/packages/pedido/lib/src/models.dart:672-708`, `other.field ?? this.field`
 *     on every field) into a per-field nullable-vs-non-nullable merge keyed
 *     off `MappedFreteInicialFields`' own nullability — see that function's
 *     docblock for the full rationale.
 *  4. Legacy's `else if (instance.estado == pago)` downgrade branch INSIDE the
 *     secondary shipping-payments tx (tasks.dart:727-735) is dead code — it
 *     sits behind an outer `instance.estado == emProcessamento` guard that
 *     makes `instance.estado == pago` impossible in the same read; not ported.
 *  5. `getAllOrderMessagesMercadoLivre` (tasks.dart:776-781 — ML Q&A/message
 *     sync) is OUT OF SCOPE for Step 9 (pedido import) and never called here.
 *  6. The `MercadoEnvios` (`int_frete`, tipo `'mercadoLivre'`) config lookup
 *     (tasks.dart:515-517/623-625) force-unwraps in Dart (crashes if absent);
 *     here a missing config degrades to `integracaoFreteOuterRef: null`
 *     instead of throwing — an unconfigured account shouldn't crash import.
 *  7. `MlBillingInfoUnsupportedError` (an identification `type` outside
 *     CPF/CNPJ) SKIPS the cliente step and continues, per this Step 9 task's
 *     explicit contract — legacy's `BillingInfoResponse.toCliente` THROWS
 *     `UnimplementedError` for the same case (uncaught — aborts the whole
 *     import); this port is deliberately more tolerant.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlBillingInfo,
  type MlOrder,
  type MlPack,
  type MlPayment,
  type MlShipment,
  type MlShipmentPayment,
} from '@delfrance/integrations-mercado-livre';
import {
  ESTADO_PEDIDO,
  STATUS_PAGAMENTO,
  flattenPedidoItens,
  itemSubtotal,
  toOuterRef,
  idFromRef,
  type EstadoPedido,
  type FreteDoPedido,
  type ItemDoPedido,
  type Pedido,
} from '@delfrance/schemas';
import { roundReais } from '@delfrance/core/money';
import { coerceToMicros } from '@delfrance/core/datetime';
import {
  clienteCollection,
  integracaoCollection,
  intFreteCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';

import { resolveExistingProduto } from './import';
import { buscarIntFreteDaConta } from './intFreteSync';
import { assertOrderItemsComplete, mlOrderItemToItemDoPedido } from './orderMapping';
import { estadoPedidoFromOrderStatus } from './orderStatusMaps';
import { makePagamentoIdMercadoLivre } from './orderIds';
import { mlPaymentToPagamento } from './orderPaymentMapping';
import {
  POLITICA_FRESCOR_IMPORT_PEDIDO,
  freteRecebidoEhMaisNovo,
  mergeFreteInicial,
  mlShipmentToFreteInicial,
  type MappedFreteInicialFields,
} from './orderShipmentMapping';

import {
  MlBillingInfoUnsupportedError,
  billingInfoToClienteFields,
  billingInfoToEnderecoFields,
  ensureEndereco,
  findOrCreateCliente,
  shipmentToEnderecoFields,
} from './orderCliente';
import { discoverPedidoMercadoLivre, type DiscoverPedidoArgs } from './orderPedidoTx';
import { resolvePrazoDespacho } from './orderPrazoDespacho';

/**
 * Re-exported for the callers that already import them from here
 * (`orderShipmentImport.ts`, this module's tests). They now LIVE in
 * `orderShipmentMapping.ts`, alongside the freshness predicate the merge must be
 * paired with — both are pure, and had no reason to sit in the orchestrator.
 */
export { mergeFreteInicial, mergeFreteInicialSeMaisNovo } from './orderShipmentMapping';

/* -------------------------------------------------------------------------- */
/*                                  Contract                                  */
/* -------------------------------------------------------------------------- */

export interface OrderImportDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  /** One timestamp for the whole run (µs since epoch) — pedido/pagamento/frete standard. */
  nowUs: number;
  /** Same instant, milliseconds — cliente/endereço standard. */
  nowMs: number;
}

export interface OrderImportResult {
  pedidoId: string | null;
  created: boolean;
  skipped: 'seller-mismatch' | 'no-buyer' | null;
}

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

/**
 * `ESTADOS_PEDIDO.estadosConferirPagamento`
 * (`.old/packages/pedido/lib/src/models.dart:2489-2495`) — the pedido states
 * still "early" enough that a fresh shipment read should re-run the full
 * money conference (tasks.dart:512-514).
 */
const ESTADOS_CONFERIR_PAGAMENTO: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.iniciado,
  ESTADO_PEDIDO.carrinho,
  ESTADO_PEDIDO.escolhendoFormaDePagamento,
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.pagamentoNaoRealizado,
]);

/** ML order `status` values that downgrade a `pago` pedido (tasks.dart:746). */
const DOWNGRADE_TRIGGER_STATUSES: ReadonlySet<string> = new Set([
  'partially_refunded',
  'pending_cancel',
  'cancelled',
  'invalid',
]);

/**
 * The prerequisites a pedido must satisfy before ANY Mercado Livre path may
 * advance it to `pago` (tasks.dart:660-664). ONE definition, because `pago`
 * authorizes dispatch and NF-e emission and the two ML paths that can trigger
 * it — this module's order import and the `payments`-topic handler — must not
 * disagree about what it means (#791).
 *
 * MUST be evaluated against a TRANSACTION-FRESH read: every field here is
 * written by a different step of the same import, so a value captured before
 * the transaction is a decision made on stale data (root `CLAUDE.md` rule 7).
 */
export function podeAvancarParaPago(pedido: {
  estado: EstadoPedido;
  clientePedidoOuterRef: string | null;
  enderecoFiscalOuterRef: string | null;
  freteInicial: unknown;
}): boolean {
  return (
    pedido.estado === ESTADO_PEDIDO.emProcessamento &&
    pedido.clientePedidoOuterRef != null &&
    pedido.enderecoFiscalOuterRef != null &&
    pedido.freteInicial != null
  );
}

/* -------------------------------------------------------------------------- */
/*                             Small pure helpers                             */
/* -------------------------------------------------------------------------- */

/** `order.seller` — not yet a named `MlOrder` field (same passthrough-cast pattern the rest of Step 9 uses). */
interface MlOrderSellerPassthrough {
  seller?: { id?: number | string | null } | null;
}
function orderSellerId(order: MlOrder): number | string | null {
  return (order as unknown as MlOrderSellerPassthrough).seller?.id ?? null;
}

/** One `shipment/payments[]` entry's `payment_id` — not a named `MlShipmentPayment` field (plugin `types.ts`). */
interface MlShipmentPaymentIdPassthrough {
  payment_id?: number | string | null;
}

/**
 * Strict `status_pagamento === aprovado` sum (tasks.dart:721-722/756-762) —
 * deliberately NOT `sumPagamentosPagos` (which also treats a null status as
 * paying).
 *
 * This is now the ONLY paid-sum rule on this path. Legacy's primary advance
 * summed every pagamento regardless of status (tasks.dart:665-666), which let a
 * REJECTED payment push a pedido to `pago` — and `pago` authorizes dispatch and
 * NF-e emission. That per-path inconsistency is NOT kept for parity (#791/O13):
 * money correctness outranks byte parity.
 */
function sumApprovedOnly(
  pagamentos: ReadonlyArray<{ valor: number; status_pagamento?: number | null }>,
): number {
  return roundReais(
    pagamentos
      .filter((p) => p.status_pagamento === STATUS_PAGAMENTO.aprovado)
      .reduce((sum, p) => sum + p.valor, 0),
  );
}

/**
 * The new value for a monotonic watermark, or `null` when the stored one is
 * already at least as fresh (so the caller omits the key from its patch).
 *
 * Both arguments are MICROSECONDS; read the stored side through
 * `coerceToMicros` before calling, because legacy Flutter wrote these fields in
 * milliseconds and a cross-unit comparison is a guard that never fires (root
 * `CLAUDE.md` rule 7).
 *
 * Plain `Math.max` rather than `FieldValue.maximum`: every caller here already
 * sits inside a transaction that `tx.get`s the same document, so the two are
 * equivalent — and the sentinel cannot survive `parseMerge` anyway, since
 * `microsSinceEpoch`'s preprocess coerces it to `NaN` and Zod then throws.
 */
function avancarWatermark(armazenadoUs: number | null, candidatoUs: number | null): number | null {
  if (candidatoUs == null) return null;
  if (armazenadoUs == null) return candidatoUs;
  return candidatoUs > armazenadoUs ? candidatoUs : null;
}

async function readPedido(db: Firestore, pedidoId: string): Promise<Pedido> {
  const snap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  return pedidoCollection.parseRead(snap.data() ?? {}, pedidoCollection.docPath({}, pedidoId));
}

/* -------------------------------------------------------------------------- */
/*                        Conta bag (integração account)                      */
/* -------------------------------------------------------------------------- */

export interface ContaBag {
  contaOuterRef: string;
  contaCpfCnpj: string | null;
  operacaoOuterRef: string | null;
  /** `conta.tabelanormal_path` (tasks.dart:3078: `listaDePrecosPath: conta.tabelanormal_path`). */
  listaDePrecosOuterRef: string | null;
  modalidadeFreteImportacao: string | null;
  sellerUserId: number | null;
}

/**
 * Exported for reuse by the shipments-topic handler (`orderShipmentImport.ts`,
 * Step 9 PR 3), which needs the same account bag (`sellerUserId` for
 * `resolvePrazoDespacho`, `modalidadeFreteImportacao` for the frete mapper) —
 * no behavior change, still module-private in spirit (this file owns it).
 */
export async function loadContaBag(db: Firestore, integracaoId: string): Promise<ContaBag> {
  const snap = await integracaoCollection.docRef(db, {}, integracaoId).get();
  const conta = integracaoCollection.parseRead(
    snap.data() ?? {},
    integracaoCollection.docPath({}, integracaoId),
  );
  const contaOuterRef = toOuterRef(integracaoCollection.docPath({}, integracaoId));
  return {
    contaOuterRef,
    contaCpfCnpj: conta.cpf_cnpj ?? null,
    operacaoOuterRef: conta.operacaoOuterRef ?? null,
    listaDePrecosOuterRef: conta.tabelaNormalOuterRef ?? null,
    modalidadeFreteImportacao: conta.modalidadeFreteImportacao ?? null,
    sellerUserId: conta.user_id ?? null,
  };
}

/**
 * Resolves the `int_frete` doc for this account's Mercado Envios freight
 * integration — legacy `MercadoEnvios.documents
 * .contaMercadoLivreMercadoEnviosOuterRef__isEqualTo(api.instance)
 * .ativo__isEqualTo(true).orderBy__dataCadastro(false).first()`
 * (tasks.dart:515-517/623-625). Deviation #6 (see file docstring): null instead
 * of legacy's force-unwrap crash when no such doc exists.
 *
 * Since #782 the doc is a server-owned companion of the conta (the
 * `onIntegracaoMercadoLivreChanged` trigger writes it) and
 * `contaMercadoLivreMercadoEnviosOuterRef` is a **typed** `intFreteSchema` field
 * with a declared index, so this is now an index-bound equality instead of the
 * full scan it used to be — the shared `buscarIntFreteDaConta` also keeps the old
 * tolerant client-side match as a fallback for a doc whose ref was never
 * normalized. `apenasAtivo` is what makes this the IMPORTER's variant: it wants a
 * live config, whereas the sync must see inactive docs too (or re-enabling a conta
 * would duplicate the doc).
 *
 * Exported for reuse by the shipments-topic handler (`orderShipmentImport.ts`,
 * Step 9 PR 3) — same lookup, same account, no behavior change.
 */
export async function resolveMercadoEnviosIntFreteOuterRef(
  db: Firestore,
  integracaoId: string,
): Promise<string | null> {
  const encontrado = await buscarIntFreteDaConta(db, integracaoId, { apenasAtivo: true });
  return encontrado != null ? toOuterRef(intFreteCollection.docPath({}, encontrado.id)) : null;
}

/* -------------------------------------------------------------------------- */
/*                       Order fetch + pack fan-out                           */
/* -------------------------------------------------------------------------- */

/** `try { get_order } on MLError catch(e) { if (e.code=='404') {...} }` (tasks.dart:385-394). */
async function fetchOrderWithPackFallback(
  api: MercadoLivreApi,
  orderIdOrPackId: number,
): Promise<{ initialOrder: MlOrder; packInfo: MlPack | null }> {
  try {
    const initialOrder = await api.getOrder(orderIdOrPackId);
    return { initialOrder, packInfo: null };
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      const packInfo = await api.getPack(orderIdOrPackId);
      const firstOrderId = packInfo.orders[0]?.id;
      if (firstOrderId == null) {
        throw new Error(`Pacote Mercado Livre ${orderIdOrPackId} sem nenhuma order.`);
      }
      const initialOrder = await api.getOrder(firstOrderId);
      return { initialOrder, packInfo };
    }
    throw err;
  }
}

/**
 * `_discoverPedidoMercadoLivre`'s pack fan-out (tasks.dart:152-168): every
 * sibling order of the pack, excluding the one already fetched.
 */
async function resolvePackOrders(
  api: MercadoLivreApi,
  initialOrder: MlOrder,
  packInfoIn: MlPack | null,
): Promise<{ orders: MlOrder[]; packId: number | null }> {
  const packId = initialOrder.pack_id ?? null;
  if (packId == null) return { orders: [initialOrder], packId: null };

  const packInfo = packInfoIn ?? (await api.getPack(packId));
  const siblingIds = packInfo.orders.map((o) => o.id).filter((id) => id !== initialOrder.id);
  const siblingOrders = await Promise.all(siblingIds.map((id) => api.getOrder(id)));
  return { orders: [initialOrder, ...siblingOrders], packId };
}

/**
 * Produto resolution per order line ("ML item.id → produtoUid", outside any
 * transaction) — reuses `import.ts`'s `resolveExistingProduto` (link →
 * `id == item.id` → sku), the SAME cascade the product-import flow uses,
 * rather than a copy. Deliberately simplified vs. legacy's
 * `_makeItemDoPedido` (models.dart:3179-3211), which additionally matches on
 * `variation_id` via the `marketplace` denorm array — this port resolves at
 * the PARENT item level only; a variation-aware resolution is a follow-up
 * (see the PR notes).
 */
async function buildItensByOrderId(
  db: Firestore,
  integracaoId: string,
  orders: readonly MlOrder[],
  nowUs: number,
): Promise<Map<number, ItemDoPedido[]>> {
  const out = new Map<number, ItemDoPedido[]>();
  for (const order of orders) {
    const lines = order.order_items ?? [];
    const itens: ItemDoPedido[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const itemId = line.item?.id ?? '';
      const sku = line.item?.seller_sku ?? null;
      const resolved = itemId ? await resolveExistingProduto(db, itemId, sku, integracaoId) : null;
      itens.push(
        mlOrderItemToItemDoPedido({
          orderId: order.id,
          orderItem: line,
          index,
          produtoUid: resolved?.produtoId ?? null,
          timestampUs: nowUs,
        }),
      );
    }
    out.set(order.id, itens);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                              Cliente / endereço                            */
/* -------------------------------------------------------------------------- */

/**
 * `if (pedido.cliente_id == null) { ... }` (tasks.dart:419-437) — only-if-null
 * guard, re-verified inside the tx (429). Deviation #7: `MlBillingInfoUnsupportedError`
 * skips (pt-BR log) instead of the legacy uncaught throw.
 */
async function applyClienteStep(args: {
  db: Firestore;
  pedidoId: string;
  pedido: Pedido;
  orderId: number;
  nowMs: number;
  nowUs: number;
  getBillingInfo: () => Promise<MlBillingInfo>;
}): Promise<Pedido> {
  const { db, pedidoId, pedido, orderId, nowMs, nowUs, getBillingInfo } = args;
  if (pedido.clientePedidoOuterRef != null) return pedido;

  let clienteFields;
  try {
    const billingInfo = await getBillingInfo();
    clienteFields = billingInfoToClienteFields(billingInfo);
  } catch (err) {
    if (err instanceof MlBillingInfoUnsupportedError) {
      console.warn('[mercado-livre] cliente não vinculado — tipo de identificação não suportado', {
        orderId,
        message: err.message,
      });
      return pedido;
    }
    throw err;
  }

  const { clienteId } = await findOrCreateCliente(db, clienteFields, nowMs);
  const clienteOuterRef = toOuterRef(clienteCollection.docPath({}, clienteId));

  await db.runTransaction(async (tx) => {
    const ref = pedidoCollection.docRef(db, {}, pedidoId);
    const snap = await tx.get(ref);
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    if (raw.clientePedidoOuterRef != null) return; // guard, tasks.dart:429
    tx.update(
      ref,
      pedidoCollection.parseMerge({
        clientePedidoOuterRef: clienteOuterRef,
        ultimaModificacao: avancarWatermark(coerceToMicros(raw.ultimaModificacao), nowUs),
      }) as DocumentData,
    );
  });

  return readPedido(db, pedidoId);
}

/**
 * `if (pedido.cliente_id != null && pedido.endereco_id == null) { ... }`
 * (tasks.dart:448-492) — billing-address-first, shipment-receiver fallback.
 */
async function applyEnderecoStep(args: {
  db: Firestore;
  pedidoId: string;
  pedido: Pedido;
  shippingInstance: MlShipment | null;
  nowUs: number;
  getBillingInfo: () => Promise<MlBillingInfo>;
}): Promise<Pedido> {
  const { db, pedidoId, pedido, shippingInstance, nowUs, getBillingInfo } = args;
  if (pedido.clientePedidoOuterRef == null || pedido.enderecoFiscalOuterRef != null) {
    return pedido;
  }

  const billingInfo = await getBillingInfo();
  let enderecoFields = billingInfoToEnderecoFields(billingInfo);
  if (!enderecoFields && shippingInstance) {
    enderecoFields = shipmentToEnderecoFields(shippingInstance);
  }
  if (!enderecoFields) return pedido;

  const clienteId = idFromRef(pedido.clientePedidoOuterRef);
  const enderecoId = await ensureEndereco(db, clienteId, enderecoFields);
  const enderecoOuterRef = toOuterRef(`clientes/${clienteId}/enderecos/${enderecoId}`);

  await db.runTransaction(async (tx) => {
    const ref = pedidoCollection.docRef(db, {}, pedidoId);
    const snap = await tx.get(ref);
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    if (raw.enderecoFiscalOuterRef != null) return; // guard, tasks.dart:461/481
    tx.update(
      ref,
      pedidoCollection.parseMerge({
        enderecoFiscalOuterRef: enderecoOuterRef,
        ultimaModificacao: avancarWatermark(coerceToMicros(raw.ultimaModificacao), nowUs),
      }) as DocumentData,
    );
  });

  return readPedido(db, pedidoId);
}

/* -------------------------------------------------------------------------- */
/*                                   Frete                                    */
/* -------------------------------------------------------------------------- */

async function fetchFullShippingPayments(
  api: MercadoLivreApi,
  shippingPayments: readonly MlShipmentPayment[],
): Promise<MlPayment[]> {
  // `payment_id` rides in the plugin schema's passthrough (only `status`/
  // `amount` are promoted) — same local-cast pattern as `orderMapping.ts`.
  const ids = shippingPayments
    .map((p) => (p as MlShipmentPaymentIdPassthrough).payment_id)
    .filter((id): id is number | string => id != null);
  return Promise.all(ids.map((id) => api.getPayment(id)));
}

/** Writes every `fullPayments` entry not already present in `alreadyRegisteredExternalIds`; returns the newly-written summaries (for the caller's own paid-sum). MUST be called AFTER every tx read (it only writes). */
function registerMissingPagamentos(
  tx: FirebaseFirestore.Transaction,
  db: Firestore,
  pedidoId: string,
  integracaoId: string,
  contaCpfCnpj: string | null,
  nowUs: number,
  fullPayments: readonly MlPayment[],
  alreadyRegisteredExternalIds: ReadonlySet<string>,
): Array<{ valor: number; status_pagamento: number | null }> {
  const registered: Array<{ valor: number; status_pagamento: number | null }> = [];
  for (const payment of fullPayments) {
    const externalId = String(payment.id);
    if (alreadyRegisteredExternalIds.has(externalId)) continue;
    const mapped = mlPaymentToPagamento({ payment, contaCpfCnpj, nowUs });
    const pagamentoId = makePagamentoIdMercadoLivre(integracaoId, payment.id);
    tx.set(
      pagamentoCollection.docRef(db, { pedidoId }, pagamentoId),
      pagamentoCollection.parse(mapped) as DocumentData,
    );
    registered.push({ valor: mapped.valor, status_pagamento: mapped.status_pagamento });
  }
  return registered;
}

/**
 * `if (shippingInstance != null && (staleness...)) { ... }` (tasks.dart:497-658).
 * Runs the "full conference" branch (522-620) when the pedido has a fiscal
 * address AND (no prazoDespacho yet OR no oldFrete OR the pedido is still in
 * an early conferir-pagamento state); else the simple tracking-only merge
 * (621-657) when a prior frete exists; else (no address, no prior frete)
 * nothing happens, matching legacy.
 *
 * ---- #791 restructure (O12) ----
 * Every predicate that decides WHAT to write is now re-derived from the
 * tx-fresh pedido: the staleness verdict, the full-conference/tracking-only
 * selector, and `mappedFrete.enderecoFreteOuterReference`. The pre-transaction
 * read survives ONLY as a network early-out (it saves three ML round-trips on a
 * redelivery) and decides nothing — root `CLAUDE.md` rule 7: re-checking a
 * predicate against a binding read outside the transaction is not a guard.
 * `mappedFrete` is built outside and re-applied verbatim on an OCC retry, which
 * is exactly why the verdict has to be recomputed inside.
 *
 * The shipping-PAYMENT registration that used to ride along here
 * (`registerMissingPagamentos`) now belongs exclusively to
 * `applyPagoAdvanceOrDowngrade`, which runs immediately after in the same
 * import: one owner per resource (this step owns `freteInicial` +
 * `valorCobrado`; that step owns `pagamentos` + `estado`), one fewer
 * subcollection read here, and no need for `fullShippingPayments` on this path.
 */
async function applyFreteStep(args: {
  db: Firestore;
  api: MercadoLivreApi;
  pedidoId: string;
  /** Pre-transaction read — a network early-out ONLY. Never a guard. */
  pedido: Pedido;
  shippingInstance: MlShipment;
  integracaoId: string;
  contaBag: ContaBag;
  /** The initial order's `last_updated` in µs — legacy stamps the pedido's
   * `ultimaModificacao` with the ORDER's timestamp on the full-conference
   * write (tasks.dart:609-613), not the current clock. */
  orderLastUpdatedUs: number | null;
  nowUs: number;
  /** Run-scoped memo, shared with `applyPagoAdvanceOrDowngrade`. */
  loadShipmentPayments: () => Promise<MlShipmentPayment[]>;
}): Promise<void> {
  const {
    db,
    api,
    pedidoId,
    pedido,
    shippingInstance,
    integracaoId,
    contaBag,
    orderLastUpdatedUs,
    nowUs,
    loadShipmentPayments,
  } = args;

  // Early-out (cheap, NON-authoritative). Mirrors legacy's own pre-read gate at
  // tasks.dart:497: skip three ML round-trips for a shipment version we have
  // already applied AND whose prazoDespacho we already resolved.
  const freteAntigo = pedido.freteInicial;
  const talvezMaisNovo = freteRecebidoEhMaisNovo({
    semFreteArmazenado: freteAntigo == null,
    armazenadoUs: coerceToMicros(freteAntigo?.ultimaModificacao ?? null),
    recebidoUs: coerceToMicros(shippingInstance.last_updated ?? null),
    ...POLITICA_FRESCOR_IMPORT_PEDIDO,
  });
  if (!talvezMaisNovo && freteAntigo?.prazoDespacho != null) return;

  const shippingPayments = await loadShipmentPayments();
  const integracaoFreteOuterRef = await resolveMercadoEnviosIntFreteOuterRef(db, integracaoId);
  const prazoDespachoUs = await resolvePrazoDespacho({
    api,
    shipment: shippingInstance,
    sellerId: contaBag.sellerUserId ?? 0,
    fallbackUs: freteAntigo?.prazoDespacho ?? null,
  });

  // `enderecoOuterRef` is deliberately NULL here: it is the ONE mapper input
  // that comes from OUR document rather than ML's payload, so it must not ride
  // in from the stale read (nor be re-applied verbatim on an OCC retry). It is
  // substituted from the tx-fresh pedido inside the transaction below.
  const mappedBase = mlShipmentToFreteInicial({
    shipment: shippingInstance,
    shippingPayments,
    integracaoFreteOuterRef,
    enderecoOuterRef: null,
    prazoDespachoUs,
    modalidadeOverride: contaBag.modalidadeFreteImportacao,
  });

  await db.runTransaction(async (tx) => {
    /* ======================= READ PHASE (no writes yet) ======================= */
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) return;
    const freshPedido = pedidoCollection.parseRead(
      pedidoSnap.data() ?? {},
      pedidoCollection.docPath({}, pedidoId),
    );

    /* ==================== DECIDE (tx-fresh inputs only) ====================== */
    const freshFrete = freshPedido.freteInicial;
    const maisNovo = freteRecebidoEhMaisNovo({
      semFreteArmazenado: freshFrete == null,
      armazenadoUs: coerceToMicros(freshFrete?.ultimaModificacao ?? null),
      recebidoUs: coerceToMicros(mappedBase.ultimaModificacao),
      ...POLITICA_FRESCOR_IMPORT_PEDIDO,
    });

    if (!maisNovo) {
      // A concurrent handler already applied a NEWER shipment payload — never
      // overlay this (older) one's fields, and never touch the watermark.
      //
      // `prazoDespachoUs` is the one exception: it comes from a FRESH SLA read
      // performed by THIS run (`resolvePrazoDespacho`), not from the shipment
      // payload, so it is not subject to that payload's watermark. Filling it
      // is also REQUIRED for convergence — a null `prazoDespacho` is one of the
      // conditions that FORCES the full conference below, so leaving it null
      // would make every future import pay three ML round-trips and write
      // nothing, forever.
      const patchParado: Record<string, unknown> = {};
      if (freshFrete != null && freshFrete.prazoDespacho == null && prazoDespachoUs != null) {
        patchParado.freteInicial = { ...freshFrete, prazoDespacho: prazoDespachoUs };
      }
      // Repair an under-counted total (#791). The conference computes
      // `valorCobrado` from the items it can see; a pack sibling merged AFTER it
      // leaves the total permanently low, and the pedido then reaches `pago` on
      // a partial payment via a perfectly correct comparison against a wrong
      // threshold. Nothing else recomputes it: once the shipment stops changing,
      // the conference never runs again.
      //
      // Only where the conference already OWNS the field (a frete block and a
      // fiscal address both present) — otherwise `valorCobrado` still holds
      // `mlOrderToPedidoCoreFields`' order-derived value and is not ours to
      // overwrite. Uses the STORED frete's own `valorCobrado`, never this
      // (older) payload's, so it carries no staleness.
      if (freshFrete != null && freshPedido.enderecoFiscalOuterRef != null) {
        const totalItens = roundReais(
          flattenPedidoItens(freshPedido.itens).reduce((sum, item) => sum + itemSubtotal(item), 0),
        );
        const alvo = roundReais(totalItens + (freshFrete.valorCobrado ?? 0));
        if (freshPedido.valorCobrado !== alvo) patchParado.valorCobrado = alvo;
      }
      if (Object.keys(patchParado).length > 0) {
        patchParado.ultimaModificacao = avancarWatermark(
          coerceToMicros(freshPedido.ultimaModificacao),
          nowUs,
        );
        tx.update(pedidoRef, pedidoCollection.parseMerge(patchParado) as DocumentData);
      }
      return;
    }

    const mappedFrete: MappedFreteInicialFields = {
      ...mappedBase,
      enderecoFreteOuterReference: freshPedido.enderecoFiscalOuterRef,
    };
    const targetFrete = mergeFreteInicial(freshFrete, mappedFrete);

    // Branch selector, re-derived from the tx-fresh doc (was tasks.dart:512-514
    // off the STALE pedido). `enderecoFiscalOuterRef` is the one axis on which
    // the tx-fresh answer can be MORE permissive than the pre-read one, and
    // that upgrade is fully serviceable here now that the conference no longer
    // registers pagamentos and so needs no prefetch.
    const conferenciaCompleta =
      freshPedido.enderecoFiscalOuterRef != null &&
      (freshFrete == null ||
        freshFrete.prazoDespacho == null ||
        ESTADOS_CONFERIR_PAGAMENTO.has(freshPedido.estado));

    if (!conferenciaCompleta) {
      // Legacy fallthrough preserved: no fiscal address AND no prior frete →
      // nothing is written at all (tasks.dart:497-658 — both branch conditions
      // evaluate false). Creating a frete block for an address-less pedido is a
      // separate decision, not this fix.
      if (freshFrete == null) return;
      // Simple tracking-only merge (tasks.dart:621-657).
      tx.update(
        pedidoRef,
        pedidoCollection.parseMerge({
          freteInicial: targetFrete,
          ultimaModificacao: avancarWatermark(coerceToMicros(freshPedido.ultimaModificacao), nowUs),
        }) as DocumentData,
      );
      return;
    }

    // Full conference (tasks.dart:522-620) — see the file docstring's deviation
    // #2 for why the shipment-item quantity cross-check is still not ported.
    const totalItens = roundReais(
      flattenPedidoItens(freshPedido.itens).reduce((sum, item) => sum + itemSubtotal(item), 0),
    );
    const patch: Record<string, unknown> = {
      freteInicial: targetFrete,
      valorCobrado: roundReais(totalItens + (mappedFrete.valorCobrado ?? 0)),
    };

    // Wall clock, monotonic. Legacy stamped the ORDER's own timestamp here
    // (tasks.dart:613), but this field is the display / recency-sort / TableView
    // update-monitor stamp that `saveRecord`, the Mercado Pago reconcile and the
    // Flutter app all write with a wall clock; a payload-derived value would let
    // the row jump BACKWARDS in the list and let the monitor miss the change.
    // The ML ORDER clock lives in `lastMarketplaceUpdate` instead (#791/O15),
    // written by `discoverPedidoMercadoLivre` alone.
    const avancado = avancarWatermark(coerceToMicros(freshPedido.ultimaModificacao), nowUs);
    if (avancado != null) patch.ultimaModificacao = avancado;

    tx.update(pedidoRef, pedidoCollection.parseMerge(patch) as DocumentData);
  });
}

/* -------------------------------------------------------------------------- */
/*                       Pago advance / downgrade                             */
/* -------------------------------------------------------------------------- */

/**
 * `if (pedido.estado == emProcessamento && refs set) {...} else if (pedido.estado == pago && status in downgrade-set) {...}`
 * (tasks.dart:660-774). The two branches are mutually exclusive, mirroring
 * legacy's `if / else if`.
 *
 * ---- #791 restructure (O13 + O14) ----
 * Legacy's three separately-committed decisions (primary advance, secondary
 * shipping-payment advance, downgrade) collapse into ONE transaction. Every
 * input to the estado decision — `estado`, the four presence fields, the whole
 * `pagamentos` set and `valorCobrado` — is read with `tx.get` in that same
 * transaction, so the decision and the write are isolated together:
 *
 *  - **O13.** `sumApprovedOnly` everywhere. A REJECTED pagamento no longer
 *    pushes a pedido to `pago`, which authorizes dispatch and NF-e emission.
 *  - **O14.** `valorCobrado` comes from the tx-fresh doc. `applyFreteStep`
 *    writes that field, and both transactions read AND write the same pedido
 *    document, so Firestore OCC serializes them: a conference that raises the
 *    total forces this callback to re-run against the new one.
 *  - The `else if` no longer hangs off a STALE `estado`. If a concurrent
 *    handler advanced the pedido to `pago` between our pre-read and this
 *    transaction, the downgrade is still evaluated — previously NEITHER branch
 *    ran, so a cancelled order stayed `pago` with no later event able to
 *    repair it.
 *
 * Two guards are deliberately TIGHTER than legacy: the advance now requires a
 * non-null `valorCobrado` (a null total used to read as a threshold of 0, so
 * any pagamento advanced a never-conferred pedido) — matching
 * `orderPaymentImport.ts` — and still requires at least one pagamento.
 *
 * Admin tx invariant: both reads happen before `registerMissingPagamentos`,
 * which is the first write.
 */
async function applyPagoAdvanceOrDowngrade(args: {
  db: Firestore;
  pedidoId: string;
  initialOrder: MlOrder;
  integracaoId: string;
  contaCpfCnpj: string | null;
  nowUs: number;
  /** Run-scoped memo — resolves to `[]` when the order has no shipment. */
  loadFullShipmentPayments: () => Promise<MlPayment[]>;
}): Promise<void> {
  const {
    db,
    pedidoId,
    initialOrder,
    integracaoId,
    contaCpfCnpj,
    nowUs,
    loadFullShipmentPayments,
  } = args;

  // PLANNING fetch (tasks.dart:681-745): it decides which `getPayment` calls to
  // spend, never what gets written. The transaction re-derives the
  // actually-missing set from its own `tx.get`, so this pool may safely be a
  // superset — the stored pagamento set only ever grows, so "missing now" is a
  // superset of "missing at commit".
  const candidatos = await loadFullShipmentPayments();
  const orderLastUpdatedUs = coerceToMicros(initialOrder.last_updated ?? null);

  await db.runTransaction(async (tx) => {
    /* ======================= READ PHASE (no writes yet) ======================= */
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));
    if (!pedidoSnap.exists) return;

    const freshPedido = pedidoCollection.parseRead(
      pedidoSnap.data() ?? {},
      pedidoCollection.docPath({}, pedidoId),
    );
    const armazenados = pagamentosSnap.docs.map((d) => d.data() as Record<string, unknown>);
    const idsArmazenados = new Set(
      armazenados.map((p) => p.id).filter((id): id is string => typeof id === 'string'),
    );

    /* ======================= COMPUTE + WRITE PHASE ======================= */
    // Register FIRST, decide SECOND (legacy's own ordering, tasks.dart:681-745):
    // a downgrade computed over an INCOMPLETE pagamento set under-counts and
    // therefore fires spuriously on a pedido that is in fact paid in full.
    const novos = registerMissingPagamentos(
      tx,
      db,
      pedidoId,
      integracaoId,
      contaCpfCnpj,
      nowUs,
      candidatos,
      idsArmazenados,
    );

    const totalAprovado = roundReais(
      sumApprovedOnly(
        armazenados.map((p) => ({
          valor: typeof p.valor === 'number' ? p.valor : 0,
          status_pagamento: typeof p.status_pagamento === 'number' ? p.status_pagamento : null,
        })),
      ) + sumApprovedOnly(novos),
    );
    const valorCobrado = freshPedido.valorCobrado;
    const temPagamento = armazenados.length + novos.length > 0;

    if (podeAvancarParaPago(freshPedido)) {
      if (valorCobrado != null && temPagamento && totalAprovado >= roundReais(valorCobrado)) {
        tx.update(
          pedidoRef,
          pedidoCollection.parseMerge({
            estado: ESTADO_PEDIDO.pago,
            ultimaModificacao: avancarWatermark(
              coerceToMicros(freshPedido.ultimaModificacao),
              nowUs,
            ),
          }) as DocumentData,
        );
      }
      return;
    }

    // The ONE place the ML order clock decides something (#791). A stale-but-true
    // payment set can never wrongly ADVANCE — the money has to be there either
    // way — so the advance above is deliberately ungated. A late-delivered
    // `cancelled`/`refunded` payload CAN wrongly downgrade a pedido that a newer
    // event has since moved past, so the downgrade is gated on the payload not
    // being older than what we have already applied.
    //
    // `>=`, not `>`: this transaction is separate from the one that advanced the
    // watermark (`discoverPedidoMercadoLivre`, earlier in this same import), so a
    // crash or retry between the two leaves the watermark already at this
    // payload's value. A strict comparison would make the retry unable to ever
    // converge. Units: both sides µs, and the stored side is coerced, so a
    // legacy Flutter MILLISECOND value still compares as the same instant.
    const relogioArmazenadoUs = coerceToMicros(freshPedido.lastMarketplaceUpdate);
    const payloadEhAtual =
      orderLastUpdatedUs == null ||
      relogioArmazenadoUs == null ||
      orderLastUpdatedUs >= relogioArmazenadoUs;

    // tasks.dart:746-774 — reachable now even when a concurrent handler advanced
    // the pedido to `pago` between our pre-read and this transaction.
    if (
      payloadEhAtual &&
      freshPedido.estado === ESTADO_PEDIDO.pago &&
      DOWNGRADE_TRIGGER_STATUSES.has(initialOrder.status ?? '') &&
      totalAprovado < roundReais(valorCobrado ?? 0)
    ) {
      const patch: Record<string, unknown> = {
        estado: estadoPedidoFromOrderStatus(initialOrder.status ?? ''),
      };
      // Wall clock, monotonic — see the frete conference above for why this
      // field is not the event clock. Legacy stamped `nowUs` here too, but
      // unguarded, so a replay could pull it backwards.
      const avancado = avancarWatermark(coerceToMicros(freshPedido.ultimaModificacao), nowUs);
      if (avancado != null) patch.ultimaModificacao = avancado;
      tx.update(pedidoRef, pedidoCollection.parseMerge(patch) as DocumentData);
    }
  });
}

/* -------------------------------------------------------------------------- */
/*                                Orchestrator                                */
/* -------------------------------------------------------------------------- */

/**
 * Imports (or refreshes) the pedido for one Mercado Livre order/pack. See the
 * file docstring for the full legacy mapping + every deviation.
 */
export async function importPedidoMercadoLivre(
  deps: OrderImportDeps,
  orderIdOrPackId: number,
): Promise<OrderImportResult> {
  const { db, api, integracaoId, nowUs, nowMs } = deps;

  const { initialOrder, packInfo } = await fetchOrderWithPackFallback(api, orderIdOrPackId);

  // Buyer guard FIRST, then seller — tasks.dart:396-406 (that exact order).
  if (initialOrder.buyer == null) {
    return { pedidoId: null, created: false, skipped: 'no-buyer' };
  }

  const contaBag = await loadContaBag(db, integracaoId);
  const sellerId = orderSellerId(initialOrder);
  if (sellerId == null || String(sellerId) !== String(contaBag.sellerUserId ?? '')) {
    console.warn('[mercado-livre] order import: seller id inconsistente', {
      orderIdOrPackId,
      orderSellerId: sellerId,
      contaSellerUserId: contaBag.sellerUserId,
    });
    return { pedidoId: null, created: false, skipped: 'seller-mismatch' };
  }

  const { orders, packId } = await resolvePackOrders(api, initialOrder, packInfo);
  for (const order of orders) assertOrderItemsComplete(order);

  const itensByOrderId = await buildItensByOrderId(db, integracaoId, orders, nowUs);

  const discoverArgs: DiscoverPedidoArgs = {
    db,
    contaId: integracaoId,
    contaOuterRef: contaBag.contaOuterRef,
    contaCpfCnpj: contaBag.contaCpfCnpj,
    integracaoOuterRef: contaBag.contaOuterRef,
    operacaoOuterRef: contaBag.operacaoOuterRef,
    listaDePrecosOuterRef: contaBag.listaDePrecosOuterRef,
    orders,
    packId,
    itensByOrderId,
    nowUs,
  };
  const { pedidoId, created } = await discoverPedidoMercadoLivre(discoverArgs);

  let pedido = await readPedido(db, pedidoId);

  let billingInfoCache: MlBillingInfo | null = null;
  const getBillingInfo = async (): Promise<MlBillingInfo> => {
    if (!billingInfoCache) {
      billingInfoCache = await api.getOrderBillingInfo(initialOrder.id);
    }
    return billingInfoCache;
  };

  pedido = await applyClienteStep({
    db,
    pedidoId,
    pedido,
    orderId: initialOrder.id,
    nowMs,
    nowUs,
    getBillingInfo,
  });

  // Shipment fetched unconditionally once `shipping.id` is known — feeds both
  // the endereço fallback and the frete block (tasks.dart:442-446).
  const shippingId = initialOrder.shipping?.id ?? null;
  const shippingInstance = shippingId != null ? await api.getShipment(shippingId) : null;

  // Run-scoped memos, same pattern as `getBillingInfo` above. The frete step and
  // the pago step both need the shipment's payments; before #791 each fetched
  // its own copy, so on the conferring path this REMOVES a duplicate
  // `getShipmentPayments` + N duplicate `getPayment` rather than adding any.
  let shipmentPaymentsCache: MlShipmentPayment[] | null = null;
  const loadShipmentPayments = async (): Promise<MlShipmentPayment[]> => {
    if (shippingInstance == null) return [];
    shipmentPaymentsCache ??= await api.getShipmentPayments(shippingInstance.id);
    return shipmentPaymentsCache;
  };

  let fullShipmentPaymentsCache: MlPayment[] | null = null;
  const loadFullShipmentPayments = async (): Promise<MlPayment[]> => {
    if (shippingInstance == null) return [];
    if (fullShipmentPaymentsCache == null) {
      const resumos = await loadShipmentPayments();
      // Planning diff: spend a `getPayment` only on ids the pedido has not
      // registered yet. Non-transactional ON PURPOSE — it bounds the ML call
      // count, it does not decide what is written (the pago transaction
      // re-derives the missing set from its own `tx.get`). The stored set only
      // ever grows, so this can over-fetch but never under-write.
      const jaRegistrados = await pagamentoCollection.ref(db, { pedidoId }).get();
      const ids = new Set(
        jaRegistrados.docs
          .map((d) => (d.data() as Record<string, unknown>).id)
          .filter((id): id is string => typeof id === 'string'),
      );
      const faltantes = resumos.filter((p) => {
        const id = (p as MlShipmentPaymentIdPassthrough).payment_id;
        return id != null && !ids.has(String(id));
      });
      fullShipmentPaymentsCache = await fetchFullShippingPayments(api, faltantes);
    }
    return fullShipmentPaymentsCache;
  };

  pedido = await applyEnderecoStep({
    db,
    pedidoId,
    pedido,
    shippingInstance,
    nowUs,
    getBillingInfo,
  });

  if (shippingInstance) {
    // No longer returns a pedido — the pago step re-reads everything it needs
    // inside its own transaction, so the trailing `readPedido` is gone.
    await applyFreteStep({
      db,
      api,
      pedidoId,
      pedido,
      shippingInstance,
      integracaoId,
      contaBag,
      orderLastUpdatedUs: coerceToMicros(initialOrder.last_updated ?? null),
      nowUs,
      loadShipmentPayments,
    });
  }

  await applyPagoAdvanceOrDowngrade({
    db,
    pedidoId,
    initialOrder,
    integracaoId,
    contaCpfCnpj: contaBag.contaCpfCnpj,
    nowUs,
    loadFullShipmentPayments,
  });

  // `getAllOrderMessagesMercadoLivre` (tasks.dart:776-781) — OUT OF SCOPE, see
  // file docstring deviation #5.

  return { pedidoId, created, skipped: null };
}
