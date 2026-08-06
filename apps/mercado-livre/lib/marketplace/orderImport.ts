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
  mergeEstadoFretePreservando,
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
import { type ViaCepClient, createViaCepClient } from '@delfrance/core/cep';
import { recoverEnderecoFromCep, type EnderecoBuildOutcome } from '@delfrance/schemas';
import { discoverPedidoMercadoLivre, type DiscoverPedidoArgs } from './orderPedidoTx';
import { resolvePrazoDespacho } from './orderPrazoDespacho';

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
  /**
   * Resolves an unmappable `estado` from the CEP (#789). Optional: production
   * shares one lazily-built process-wide client so its memo spans imports.
   *
   * ⚠️ Tests MUST pass their own — the shared client's memo would otherwise leak
   * one case's answer into the next, which is how a "ViaCEP is unreachable" test
   * passes vacuously off an earlier cached hit.
   */
  viaCep?: ViaCepClient;
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

function sumAllValores(valores: readonly number[]): number {
  return roundReais(valores.reduce((sum, v) => sum + v, 0));
}

/** Strict `status_pagamento === aprovado` sum (tasks.dart:721-722/756-762) — deliberately NOT `sumPagamentosPagos` (which also treats a null status as paying). */
function sumApprovedOnly(
  pagamentos: ReadonlyArray<{ valor: number; status_pagamento?: number | null }>,
): number {
  return roundReais(
    pagamentos
      .filter((p) => p.status_pagamento === STATUS_PAGAMENTO.aprovado)
      .reduce((sum, p) => sum + p.valor, 0),
  );
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
        lastMarketplaceUpdate: nowUs,
      }) as DocumentData,
    );
  });

  return readPedido(db, pedidoId);
}

/**
 * Process-wide ViaCEP client, built on first use so its memo (and its in-flight
 * dedup) spans every import this instance serves. Tests inject their own — see
 * `OrderImportDeps.viaCep`.
 */
let defaultViaCep: ViaCepClient | undefined;

/**
 * `if (pedido.cliente_id != null && pedido.endereco_id == null) { ... }`
 * (tasks.dart:448-492) — billing-address-first, shipment-receiver fallback.
 *
 * Only a missing or unusable CEP is fatal to the endereço now: an unmappable
 * `estado` is resolved from that CEP instead of discarding the address (#789).
 * The shipment fallback is tried when billing yields no CEP — an unmappable
 * `estado` on billing is recoverable, so it no longer falls through.
 */
async function applyEnderecoStep(args: {
  db: Firestore;
  pedidoId: string;
  pedido: Pedido;
  orderId: number | string;
  shippingInstance: MlShipment | null;
  nowUs: number;
  viaCep?: ViaCepClient;
  getBillingInfo: () => Promise<MlBillingInfo>;
}): Promise<Pedido> {
  const { db, pedidoId, pedido, orderId, shippingInstance, nowUs, getBillingInfo } = args;
  if (pedido.clientePedidoOuterRef == null || pedido.enderecoFiscalOuterRef != null) {
    return pedido;
  }

  const billingInfo = await getBillingInfo();
  const billingOutcome = billingInfoToEnderecoFields(billingInfo);
  // Kept as its own binding rather than reassigning `outcome`: the diagnostic
  // below has to say WHICH source rejected which CEP, and inferring that from
  // object identity (`outcome === billingOutcome`) would silently start lying
  // the day either mapper returns a shared constant for its `sem-cep` result.
  const shipmentOutcome: EnderecoBuildOutcome | null =
    billingOutcome.kind === 'sem-cep' && shippingInstance
      ? shipmentToEnderecoFields(shippingInstance)
      : null;
  const outcome: EnderecoBuildOutcome = shipmentOutcome ?? billingOutcome;

  if (outcome.kind === 'sem-cep') {
    // The one genuinely unbuildable case, and it is NOT harmless: without an
    // `enderecoFiscalOuterRef` the frete conference is skipped and
    // `podeAvancarPagamento` refuses, so the pedido can never reach `pago` and
    // can never be fiscalizado. It used to return here in total silence.
    console.error('[mercado-livre] endereço não construído — pedido ficará sem endereço fiscal', {
      orderId,
      pedidoId,
      motivo: 'sem-cep',
      cepBilling: billingOutcome.kind === 'sem-cep' ? billingOutcome.cepRaw : null,
      cepShipment: shipmentOutcome?.kind === 'sem-cep' ? shipmentOutcome.cepRaw : null,
    });
    return pedido;
  }

  let enderecoFields = outcome.fields;
  if (outcome.kind === 'uf-desconhecida') {
    const viaCep = args.viaCep ?? (defaultViaCep ??= createViaCepClient());
    const recuperado = await recoverEnderecoFromCep(outcome, viaCep);
    enderecoFields = recuperado.fields;
    if (!recuperado.ufResolvida) {
      // ViaCEP could not answer, so the endereço keeps `forceEndereco`'s AC. It
      // is still worth storing — a wrong UF cannot reach a signed XML (cMun is
      // null, so emission throws), whereas no endereço at all strands the
      // pedido short of `pago` forever.
      console.warn('[mercado-livre] UF não resolvida pelo CEP — endereço gravado com AC', {
        orderId,
        pedidoId,
        cep: enderecoFields.cep,
        estadoRecebido: outcome.estadoRaw,
      });
    }
  }

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
        lastMarketplaceUpdate: nowUs,
      }) as DocumentData,
    );
  });

  return readPedido(db, pedidoId);
}

/* -------------------------------------------------------------------------- */
/*                                   Frete                                    */
/* -------------------------------------------------------------------------- */

/**
 * Overlay `mapped` onto `existing` (or use `mapped` fresh when there's no
 * prior frete). Ports `FreteDoPedido.update`
 * (`.old/packages/pedido/lib/src/models.dart:672-708`) field-for-field, with
 * one deliberate extension (deviation #3): legacy's `update()` is
 * `other.field ?? this.field` for EVERY field it touches (including
 * `valorCobrado`/`custoCalculado`/`custoFinal`, which our own
 * `MappedFreteInicialFields` never sets to null anyway); this port only
 * applies the `mapped.x ?? existing.x ?? null` nullable-preserving pattern to
 * the mapped keys that are ACTUALLY typed nullable
 * (`integracaoFreteOuterRef`, `enderecoFreteOuterReference`, `codRastreio`,
 * `dataPrevisaoEntrega`, `ultimaModificacao`, `prazoDespacho`) — every other
 * mapped key is non-nullable on `MappedFreteInicialFields`, so writing it
 * unconditionally is behaviorally identical to the `?? ` form and clearer.
 * `estado` is the one field legacy's plain `other.estado` (unconditional)
 * does NOT get ported straight — it goes through the dedicated
 * `mergeEstadoFretePreservando` state machine instead (`orderShipmentMapping.ts`),
 * which additionally FIXES legacy's dangling-`if` regression bug (see that
 * function's own docblock) rather than reproducing it.
 *
 * Reused by both frete-merge call sites in this Step 9 slice: this file's own
 * `applyFreteStep` (order import) and `orderShipmentImport.ts`'s
 * shipments-topic handler (PR 3) — one merge helper for both, matching this
 * port's established pattern of collapsing legacy's per-path variants into
 * one (deviation #3's original scope, now extended to the whole merge, not
 * just `estado`).
 */
export function mergeFreteInicial(
  existing: FreteDoPedido | null | undefined,
  mapped: MappedFreteInicialFields,
): Record<string, unknown> {
  if (!existing) return { ...mapped };
  const estado = mergeEstadoFretePreservando(existing.estado, mapped.estado);
  return {
    ...existing,
    externalId: mapped.externalId,
    externalOptionIntegracao: mapped.externalOptionIntegracao,
    estado,
    integracaoFreteOuterRef:
      mapped.integracaoFreteOuterRef ?? existing.integracaoFreteOuterRef ?? null,
    enderecoFreteOuterReference:
      mapped.enderecoFreteOuterReference ?? existing.enderecoFreteOuterReference ?? null,
    modalidade: mapped.modalidade,
    codRastreio: mapped.codRastreio ?? existing.codRastreio ?? null,
    valorCobrado: mapped.valorCobrado,
    custoCalculado: mapped.custoCalculado,
    custoFinal: mapped.custoFinal,
    dataPrevisaoEntrega: mapped.dataPrevisaoEntrega ?? existing.dataPrevisaoEntrega ?? null,
    ultimaModificacao: mapped.ultimaModificacao ?? existing.ultimaModificacao ?? null,
    prazoDespacho: mapped.prazoDespacho ?? existing.prazoDespacho ?? null,
  };
}

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
 */
async function applyFreteStep(args: {
  db: Firestore;
  api: MercadoLivreApi;
  pedidoId: string;
  pedido: Pedido;
  shippingInstance: MlShipment;
  integracaoId: string;
  contaBag: ContaBag;
  /** The initial order's `last_updated` in µs — legacy stamps the pedido's
   * `ultimaModificacao` with the ORDER's timestamp on the full-conference
   * write (tasks.dart:609-613), not the current clock. */
  orderLastUpdatedUs: number | null;
  nowUs: number;
}): Promise<Pedido> {
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
  } = args;

  const oldFrete = pedido.freteInicial;
  const shipmentLastUpdatedUs = coerceToMicros(shippingInstance.last_updated ?? null);
  const oldUltimaModificacao = oldFrete?.ultimaModificacao ?? null;
  const isStale =
    oldFrete == null ||
    oldFrete.prazoDespacho == null ||
    oldUltimaModificacao == null ||
    (shipmentLastUpdatedUs != null && oldUltimaModificacao < shipmentLastUpdatedUs);
  if (!isStale) return pedido;

  const shippingPayments = await api.getShipmentPayments(shippingInstance.id);
  const integracaoFreteOuterRef = await resolveMercadoEnviosIntFreteOuterRef(db, integracaoId);
  const prazoDespachoUs = await resolvePrazoDespacho({
    api,
    shipment: shippingInstance,
    sellerId: contaBag.sellerUserId ?? 0,
    fallbackUs: oldFrete?.prazoDespacho ?? null,
  });

  const mappedFrete = mlShipmentToFreteInicial({
    shipment: shippingInstance,
    shippingPayments,
    integracaoFreteOuterRef,
    enderecoOuterRef: pedido.enderecoFiscalOuterRef,
    prazoDespachoUs,
    modalidadeOverride: contaBag.modalidadeFreteImportacao,
  });

  const podeConferirPagamento = ESTADOS_CONFERIR_PAGAMENTO.has(pedido.estado);
  const fullConference =
    pedido.enderecoFiscalOuterRef != null &&
    (oldFrete?.prazoDespacho == null || oldFrete == null || podeConferirPagamento);

  if (fullConference) {
    // Full conference (tasks.dart:522-620) — see file docstring deviation #2
    // for why the shipment-item mismatch guard is not ported.
    const fullShippingPayments = await fetchFullShippingPayments(api, shippingPayments);

    await db.runTransaction(async (tx) => {
      const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
      const pedidoSnap = await tx.get(pedidoRef);
      const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));

      const freshPedido = pedidoCollection.parseRead(
        pedidoSnap.data() ?? {},
        pedidoCollection.docPath({}, pedidoId),
      );
      const registeredExternalIds = new Set(
        pagamentosSnap.docs
          .map((d) => (d.data() as Record<string, unknown>).id)
          .filter((id): id is string => typeof id === 'string'),
      );

      const totalItens = roundReais(
        flattenPedidoItens(freshPedido.itens).reduce((sum, item) => sum + itemSubtotal(item), 0),
      );
      const valorFreteInicial = mappedFrete.valorCobrado ?? 0;
      const targetFrete = mergeFreteInicial(freshPedido.freteInicial, mappedFrete);

      tx.update(
        pedidoRef,
        pedidoCollection.parseMerge({
          freteInicial: targetFrete,
          valorCobrado: roundReais(totalItens + valorFreteInicial),
          // The ORDER's own timestamp (tasks.dart:613: `ultimaModificacao:
          // orderInstance.last_updated!`) — a repeated conference webhook must
          // not churn the pedido to run-time. nowUs only as a null fallback.
          ultimaModificacao: orderLastUpdatedUs ?? nowUs,
          lastMarketplaceUpdate: nowUs,
        }) as DocumentData,
      );

      registerMissingPagamentos(
        tx,
        db,
        pedidoId,
        integracaoId,
        contaBag.contaCpfCnpj,
        nowUs,
        fullShippingPayments,
        registeredExternalIds,
      );
    });
  } else if (oldFrete != null) {
    // Simple tracking-only merge (tasks.dart:621-657) — re-checks staleness
    // against the tx-fresh frete before writing (640-642).
    await db.runTransaction(async (tx) => {
      const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
      const pedidoSnap = await tx.get(pedidoRef);
      const raw = (pedidoSnap.data() ?? {}) as Record<string, unknown>;
      const freshFrete = (raw.freteInicial ?? null) as FreteDoPedido | null;
      const freshUltimaModificacao = freshFrete?.ultimaModificacao ?? null;
      const stillStale =
        freshFrete == null ||
        freshUltimaModificacao == null ||
        (mappedFrete.ultimaModificacao != null &&
          freshUltimaModificacao < mappedFrete.ultimaModificacao);
      if (!stillStale) return; // tasks.dart:640-642 no-op

      const targetFrete = mergeFreteInicial(freshFrete, mappedFrete);
      tx.update(
        pedidoRef,
        pedidoCollection.parseMerge({
          freteInicial: targetFrete,
          lastMarketplaceUpdate: nowUs,
        }) as DocumentData,
      );
    });
  }

  return readPedido(db, pedidoId);
}

/* -------------------------------------------------------------------------- */
/*                       Pago advance / downgrade                             */
/* -------------------------------------------------------------------------- */

/**
 * `if (pedido.estado == emProcessamento && refs set) {...} else if (pedido.estado == pago && status in downgrade-set) {...}`
 * (tasks.dart:660-774). The two branches are mutually exclusive, mirroring
 * legacy's `if / else if`.
 */
async function applyPagoAdvanceOrDowngrade(args: {
  db: Firestore;
  api: MercadoLivreApi;
  pedidoId: string;
  pedido: Pedido;
  initialOrder: MlOrder;
  shippingInstance: MlShipment | null;
  integracaoId: string;
  contaCpfCnpj: string | null;
  nowUs: number;
}): Promise<void> {
  const {
    db,
    api,
    pedidoId,
    pedido,
    initialOrder,
    shippingInstance,
    integracaoId,
    contaCpfCnpj,
    nowUs,
  } = args;

  const podeAvancarPagamento =
    pedido.estado === ESTADO_PEDIDO.emProcessamento &&
    pedido.clientePedidoOuterRef != null &&
    pedido.enderecoFiscalOuterRef != null &&
    pedido.freteInicial != null;

  if (podeAvancarPagamento) {
    const pagamentosSnap = await pagamentoCollection.ref(db, { pedidoId }).get();
    const pagamentos = pagamentosSnap.docs.map((d) => d.data() as Record<string, unknown>);
    const valores = pagamentos.map((p) => (typeof p.valor === 'number' ? p.valor : 0));
    const valorCobrado = roundReais(pedido.valorCobrado ?? 0);

    // Sums ALL pagamentos regardless of status (tasks.dart:665-666) — legacy
    // per-path inconsistency (the downgrade/secondary branches below are
    // approved-only), kept for parity.
    if (pagamentos.length > 0 && sumAllValores(valores) >= valorCobrado) {
      await db.runTransaction(async (tx) => {
        const ref = pedidoCollection.docRef(db, {}, pedidoId);
        const snap = await tx.get(ref);
        const raw = (snap.data() ?? {}) as Record<string, unknown>;
        // Re-guard on the tx-fresh doc for ALL four fields (legacy re-reads the
        // whole instance inside the tx, tasks.dart:670-673).
        const stillGuarded =
          raw.estado === 'emProcessamento' &&
          raw.clientePedidoOuterRef != null &&
          raw.enderecoFiscalOuterRef != null &&
          raw.freteInicial != null;
        if (!stillGuarded) return; // re-guard, tasks.dart:670-673
        tx.update(
          ref,
          pedidoCollection.parseMerge({
            estado: 'pago',
            lastMarketplaceUpdate: nowUs,
          }) as DocumentData,
        );
      });
      return;
    }

    // Secondary branch (tasks.dart:681-745) — register any shipping payment
    // the pedido hasn't seen yet, then re-check the paid sum (approved-only).
    if (shippingInstance) {
      const shippingPayments = await api.getShipmentPayments(shippingInstance.id);
      const fullPayments = await fetchFullShippingPayments(api, shippingPayments);
      const registeredExternalIds = new Set(
        pagamentos.map((p) => p.id).filter((id): id is string => typeof id === 'string'),
      );
      const missing = fullPayments.filter((p) => !registeredExternalIds.has(String(p.id)));

      if (missing.length > 0) {
        await db.runTransaction(async (tx) => {
          const ref = pedidoCollection.docRef(db, {}, pedidoId);
          const snap = await tx.get(ref);
          const raw = (snap.data() ?? {}) as Record<string, unknown>;
          // Same tx-fresh re-guard as the primary branch above.
          const stillGuarded =
            raw.estado === 'emProcessamento' &&
            raw.clientePedidoOuterRef != null &&
            raw.enderecoFiscalOuterRef != null &&
            raw.freteInicial != null;
          if (!stillGuarded) return;

          const oldPagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));
          const oldPagamentos = oldPagamentosSnap.docs.map(
            (d) => d.data() as Record<string, unknown>,
          );
          const oldPagamentosIds = new Set(
            oldPagamentos.map((p) => p.id).filter((id): id is string => typeof id === 'string'),
          );

          const stillMissing = missing.filter((p) => !oldPagamentosIds.has(String(p.id)));
          const novosPagamentos = registerMissingPagamentos(
            tx,
            db,
            pedidoId,
            integracaoId,
            contaCpfCnpj,
            nowUs,
            stillMissing,
            oldPagamentosIds,
          );

          const valorPagoAnteriormente = sumApprovedOnly(
            oldPagamentos.map((p) => ({
              valor: typeof p.valor === 'number' ? p.valor : 0,
              status_pagamento: typeof p.status_pagamento === 'number' ? p.status_pagamento : null,
            })),
          );
          const valorPagoAtualmente = sumApprovedOnly(novosPagamentos);
          const valorCobradoFresco = typeof raw.valorCobrado === 'number' ? raw.valorCobrado : 0;

          if (
            roundReais(valorPagoAnteriormente + valorPagoAtualmente) >=
            roundReais(valorCobradoFresco)
          ) {
            tx.update(
              ref,
              pedidoCollection.parseMerge({
                estado: 'pago',
                lastMarketplaceUpdate: nowUs,
              }) as DocumentData,
            );
          }
          // legacy's `else if (instance.estado == pago)` downgrade branch here
          // (tasks.dart:727-735) is dead code — see file docstring deviation #4.
        });
      }
    }
  } else if (
    pedido.estado === ESTADO_PEDIDO.pago &&
    DOWNGRADE_TRIGGER_STATUSES.has(initialOrder.status ?? '')
  ) {
    // tasks.dart:746-774.
    await db.runTransaction(async (tx) => {
      const ref = pedidoCollection.docRef(db, {}, pedidoId);
      const snap = await tx.get(ref);
      const raw = (snap.data() ?? {}) as Record<string, unknown>;
      if (raw.estado !== 'pago') return;

      const pagamentosSnap = await tx.get(pagamentoCollection.ref(db, { pedidoId }));
      const totalPago = sumApprovedOnly(
        pagamentosSnap.docs
          .map((d) => d.data() as Record<string, unknown>)
          .map((p) => ({
            valor: typeof p.valor === 'number' ? p.valor : 0,
            status_pagamento: typeof p.status_pagamento === 'number' ? p.status_pagamento : null,
          })),
      );
      const valorCobrado = typeof raw.valorCobrado === 'number' ? raw.valorCobrado : 0;
      if (totalPago < valorCobrado) {
        tx.update(
          ref,
          pedidoCollection.parseMerge({
            estado: estadoPedidoFromOrderStatus(initialOrder.status ?? ''),
            ultimaModificacao: nowUs,
            lastMarketplaceUpdate: nowUs,
          }) as DocumentData,
        );
      }
    });
  }
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

  pedido = await applyEnderecoStep({
    db,
    pedidoId,
    pedido,
    orderId: initialOrder.id,
    shippingInstance,
    nowUs,
    viaCep: deps.viaCep,
    getBillingInfo,
  });

  if (shippingInstance) {
    pedido = await applyFreteStep({
      db,
      api,
      pedidoId,
      pedido,
      shippingInstance,
      integracaoId,
      contaBag,
      orderLastUpdatedUs: coerceToMicros(initialOrder.last_updated ?? null),
      nowUs,
    });
  }

  await applyPagoAdvanceOrDowngrade({
    db,
    api,
    pedidoId,
    pedido,
    initialOrder,
    shippingInstance,
    integracaoId,
    contaCpfCnpj: contaBag.contaCpfCnpj,
    nowUs,
  });

  // `getAllOrderMessagesMercadoLivre` (tasks.dart:776-781) — OUT OF SCOPE, see
  // file docstring deviation #5.

  return { pedidoId, created, skipped: null };
}
