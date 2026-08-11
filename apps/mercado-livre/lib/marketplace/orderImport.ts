/**
 * Mercado Livre order → ERP `pedido` import orchestrator (Step 9, PR 2 — "A3").
 * Composes the pieces owned by the rest of the Step 9 slice:
 *  - the pedido create/patch transaction (`orderPedidoTx.ts`, A2),
 *  - cliente/endereço resolution (`orderCliente.ts`, A1),
 *  - the dispatch-deadline resolver (`orderPrazoDespacho.ts`, A4),
 *  - PR 1's pure mappers (`orderMapping.ts`, `orderPaymentMapping.ts`,
 *    `orderShipmentMapping.ts`, `orderStatusMaps.ts`, `orderIds.ts`),
 *  - the order-line produto resolution (`orderProdutoResolve.ts`, #792), which
 *    itself reuses `import.ts`'s `resolveExistingProduto` for its link step.
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
 *  2. The shipment/pedido item-quantity CROSS-CHECK (tasks.dart:536-568) is now
 *     PORTED (#669) — see `orderShipmentConference.ts` and the conference block
 *     in `applyFreteStep`. Three deliberate departures from legacy, each argued
 *     at its site:
 *      a. It reads `GET /shipments/{id}/orders`, not legacy's
 *         `get_shipment_items`. That resource reports `requested_quantity` (the
 *         units BOUGHT, which is what `ItemDoPedido.quantidade` holds) instead
 *         of the units in this shipment, and types `variation_id` as a nullable
 *         Long instead of using `0` as a sentinel the order side never uses.
 *      b. The match is a per-`mktplaceId` TOTAL, not legacy's per-line float
 *         equality inside an O(n·m) no-break loop, and it looks BOTH ways —
 *         legacy's `seen.length != itensPedido.length` could only ever see a
 *         pedido with a surplus, never one missing a line.
 *      c. A blocking divergence PERSISTS `estado: error` and then throws;
 *         legacy only threw (tasks.dart:616), and its local `bool error` never
 *         touched the document. A throw alone rolls the transaction back, so
 *         nothing is written — and `podeAvancarParaPago` needs `freteInicial`,
 *         so the pedido would strand at `emProcessamento` with no
 *         operator-visible sign of why.
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
  type MlShipmentOrder,
  type MlShipmentPayment,
} from '@delfrance/integrations-mercado-livre';
import {
  ESTADO_PEDIDO,
  ORIGEM_INCIDENTE,
  STATUS_PAGAMENTO,
  TIPO_INCIDENTE,
  TIPO_RESOLUCAO,
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
  incidenteCollection,
  integracaoCollection,
  intFreteCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { isAlreadyExists } from '@delfrance/data/admin';

import { buscarIntFreteDaConta } from './intFreteSync';
import {
  conferirItensDoEnvio,
  descreverDivergencia,
  type ResultadoConferencia,
} from './orderShipmentConference';
import { assertOrderItemsComplete, mlOrderItemToItemDoPedido } from './orderMapping';
import { resolveOrderLineProduto } from './orderProdutoResolve';
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
  shipmentToEnderecoFields,
} from './orderCliente';
import { findOrCreateCliente } from '@delfrance/data/admin/clientes';
import { type ViaCepClient, createViaCepClient } from '@delfrance/core/cep';
import { recoverEnderecoFromCep, type EnderecoBuildOutcome } from '@delfrance/schemas';
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
 * The value a monotonic watermark should hold after this write: the candidate,
 * or the stored one when that is already fresher. Never lower than either.
 *
 * ⚠️ It returns the VALUE TO WRITE, never a "nothing to do" sentinel, and that
 * is deliberate. An earlier revision returned `null` to mean "omit this key",
 * which is a footgun on a nullable field: `parseMergePatch` strips `undefined`
 * but deliberately KEEPS `null` (`packages/data/src/zodParse.ts` — "null is
 * kept, it stores fine"), so inlining the result into a patch object wrote
 * `ultimaModificacao: null` and ERASED the stamp. It bit hardest on the very
 * first import, where `discoverPedidoMercadoLivre` had just stamped `nowUs` and
 * the next step compared that same `nowUs` against itself.
 *
 * Writing a value equal to the stored one is a no-op in effect, so callers can
 * inline this unconditionally — which is the whole point.
 *
 * `armazenadoUs` is MICROSECONDS and must be read through `coerceToMicros`:
 * legacy Flutter wrote these fields in milliseconds, and a cross-unit
 * comparison is a guard that never fires (root `CLAUDE.md` rule 7).
 *
 * Plain arithmetic rather than `FieldValue.maximum`: every caller already sits
 * inside a transaction that `tx.get`s the same document, so the two are
 * equivalent — and the sentinel could not survive `parseMerge` anyway, since
 * `microsSinceEpoch`'s preprocess coerces it to `NaN` and Zod then throws.
 */
function avancarWatermark(armazenadoUs: number | null, candidatoUs: number): number {
  return armazenadoUs != null && armazenadoUs > candidatoUs ? armazenadoUs : candidatoUs;
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

/** `try { get_order } on MLError catch(e) { if (e.code=='404') {...} }` (tasks.dart:385-394).
 *
 * Goes through `getOrderResponse` rather than `getOrder` so the order-mirror
 * write downstream can tell a complete `200` from a `206 Partial Content` — see
 * `orderPedidoTx.ts`'s `completeOrderIds` and #793. */
async function fetchOrderWithPackFallback(
  api: MercadoLivreApi,
  orderIdOrPackId: number,
): Promise<{ initialOrder: MlOrder; initialComplete: boolean; packInfo: MlPack | null }> {
  try {
    const res = await api.getOrderResponse(orderIdOrPackId);
    return { initialOrder: res.order, initialComplete: res.complete, packInfo: null };
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      const packInfo = await api.getPack(orderIdOrPackId);
      const firstOrderId = packInfo.orders[0]?.id;
      if (firstOrderId == null) {
        throw new Error(`Pacote Mercado Livre ${orderIdOrPackId} sem nenhuma order.`);
      }
      const res = await api.getOrderResponse(firstOrderId);
      return { initialOrder: res.order, initialComplete: res.complete, packInfo };
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
  initialComplete: boolean,
  packInfoIn: MlPack | null,
): Promise<{ orders: MlOrder[]; packId: number | null; completeOrderIds: ReadonlySet<number> }> {
  // Each sibling is its OWN `GET /orders/{id}`, so each carries its own
  // completeness — a partial answer for one must not license replacing the
  // others' mirrors (#793).
  const completeOrderIds = new Set<number>();
  if (initialComplete) completeOrderIds.add(initialOrder.id);

  const packId = initialOrder.pack_id ?? null;
  if (packId == null) return { orders: [initialOrder], packId: null, completeOrderIds };

  const packInfo = packInfoIn ?? (await api.getPack(packId));
  const siblingIds = packInfo.orders.map((o) => o.id).filter((id) => id !== initialOrder.id);
  const siblings = await Promise.all(siblingIds.map((id) => api.getOrderResponse(id)));
  for (const s of siblings) {
    if (s.complete) completeOrderIds.add(s.order.id);
  }
  return {
    orders: [initialOrder, ...siblings.map((s) => s.order)],
    packId,
    completeOrderIds,
  };
}

/**
 * Produto resolution per order line ("ML (item.id, variation_id) → produtoUid",
 * outside any transaction) — delegates to `orderProdutoResolve.ts`'s
 * `resolveOrderLineProduto` (#792), whose child-first cascade restores legacy
 * `_makeItemDoPedido`'s variation-level match (models.dart:3179-3211) without
 * reading the deprecated `marketplace` denorm array. A variation sale binds to
 * the CHILD produto (which owns the stock and the SKU); a simple listing is
 * unchanged and still costs exactly one query.
 *
 * Memoized per `(itemId, variationId)`: a pack's sibling orders routinely repeat
 * the same listing, and the resolution is a pure read.
 *
 * Also returns the ML ids per line, keyed by `ensureUniqueId`: the stored
 * `ItemDoPedido` keeps only `mktplaceId` (= `variation_id ?? item.id`), so the
 * LISTING id is otherwise unrecoverable downstream — and it is the id an operator
 * needs to open the anúncio on ML (`recordItensSemProduto`).
 */
interface OrderLineMlIds {
  itemId: string;
  variationId: string | null;
}

async function buildItensByOrderId(
  db: Firestore,
  integracaoId: string,
  orders: readonly MlOrder[],
  nowUs: number,
): Promise<{
  itensByOrderId: Map<number, ItemDoPedido[]>;
  mlIdsByUniqueId: Map<string, OrderLineMlIds>;
}> {
  const out = new Map<number, ItemDoPedido[]>();
  const mlIdsByUniqueId = new Map<string, OrderLineMlIds>();
  const memo = new Map<string, string | null>();
  for (const order of orders) {
    const lines = order.order_items ?? [];
    const itens: ItemDoPedido[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const itemId = line.item?.id ?? '';
      const variationIdRaw = line.item?.variation_id ?? null;
      const variationId = variationIdRaw != null ? String(variationIdRaw) : null;
      const sku = line.item?.seller_sku ?? null;

      let produtoUid: string | null = null;
      if (itemId) {
        const memoKey = `${itemId}|${variationId ?? ''}`;
        if (memo.has(memoKey)) {
          produtoUid = memo.get(memoKey) ?? null;
        } else {
          const resolved = await resolveOrderLineProduto(db, {
            itemId,
            variationId,
            sku,
            integracaoId,
          });
          produtoUid = resolved?.produtoId ?? null;
          memo.set(memoKey, produtoUid);
        }
      }

      const item = mlOrderItemToItemDoPedido({
        orderId: order.id,
        orderItem: line,
        index,
        produtoUid,
        timestampUs: nowUs,
      });
      itens.push(item);
      if (item.ensureUniqueId != null) {
        mlIdsByUniqueId.set(item.ensureUniqueId, { itemId, variationId });
      }
    }
    out.set(order.id, itens);
  }
  return { itensByOrderId: out, mlIdsByUniqueId };
}

/**
 * One `incidente` per order line that resolved to NO produto (#792), so an
 * unbound line is visible to the operator in the pedido's Incidentes tab
 * (`PedidoForm.tsx:488`) instead of silently sitting under the `'NONE'` key.
 *
 * `produtoUid: null` is deliberately kept rather than falling back to the parent
 * produto: `calcularAlteracoesEstoque` skips null/'NONE'
 * (`packages/data/src/pedido/estoquePlan.ts:67`), whereas a parent binding would
 * make `sincronizarEstoquePedido` CREATE a negative-quantity estoque doc on a
 * produto that owns none (`sincronizarEstoquePedido.ts:364-377`) — which then
 * feeds the ML stock sweep's `maxOwn` and can be pushed back to ML.
 *
 * Race tier 0 (root CLAUDE.md rule 7): the doc id is derived from the line's
 * already-deterministic `ensureUniqueId` (`sha256(orderId-mktplaceId-index)`),
 * so a notification redelivery or the reprocess sweep re-drives the same payload
 * onto the SAME doc. `.create()` + swallow ONLY `ALREADY_EXISTS` keeps the first
 * row's `timestamp` instead of re-dating it on every replay.
 */
async function recordItensSemProduto(
  db: Firestore,
  pedidoId: string,
  itensByOrderId: Map<number, ItemDoPedido[]>,
  mlIdsByUniqueId: Map<string, OrderLineMlIds>,
  pedidoGravado: Pedido,
  nowUs: number,
): Promise<void> {
  // A line already STORED with a produto is not a problem, whoever bound it —
  // during the dual-run the Flutter app may have imported this same order and
  // resolved it via its own `marketplace` denorm probe. `orderPedidoTx` dedups by
  // `ensureUniqueId` and keeps the stored line, so raising an incidente for it
  // would be a false positive.
  // `?? {}` — `readPedido` soft-parses, so a pedido written by another actor
  // without `itens` (or one this run only just created) reads back undefined.
  const jaVinculados = new Set(
    flattenPedidoItens(pedidoGravado.itens ?? {})
      .filter((item) => item.produtoUid != null && item.ensureUniqueId != null)
      .map((item) => item.ensureUniqueId!),
  );

  for (const itens of itensByOrderId.values()) {
    for (const item of itens) {
      if (item.produtoUid != null || item.ensureUniqueId == null) continue;
      if (jaVinculados.has(item.ensureUniqueId)) continue;
      // Name the ANÚNCIO and the VARIAÇÃO separately. `mktplaceId` alone would be
      // ambiguous — it is `variation_id ?? item.id`, so labelling it "anúncio"
      // is wrong for exactly the variation sale this incidente exists for, and
      // the listing id is what the operator needs to open the anúncio on ML.
      const mlIds = mlIdsByUniqueId.get(item.ensureUniqueId);
      const anuncio = mlIds?.itemId ?? item.mktplaceId ?? '?';
      const variacao = mlIds?.variationId ?? null;
      const motivo =
        `[Mercado Livre] Item "${item.nomeDeVenda ?? anuncio}" ` +
        `(anúncio ${anuncio}${variacao != null ? `, variação ${variacao}` : ''}, ` +
        `SKU ${item.sku ?? '—'}) não foi vinculado a nenhum produto do ERP. ` +
        `O item ficou sem produto: nenhum estoque foi movimentado. ` +
        `Vincule o produto manualmente no pedido.`;
      try {
        await incidenteCollection.docRef(db, { pedidoId }, `ml-prod-${item.ensureUniqueId}`).create(
          incidenteCollection.parse({
            origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
            tipo: TIPO_INCIDENTE.outros,
            subtipo: 'ml-produto-nao-vinculado',
            motivoDoIncidente: motivo,
            comentarios: null,
            timestamp: nowUs,
            ultimaModificacao: nowUs,
            externalId: item.mktplaceId,
            resolucao: null,
          }),
        );
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
    }
  }
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

  const { clienteId, rejected, dropped } = await findOrCreateCliente(db, {
    fields: clienteFields,
    nowMs,
  });
  if (rejected.length > 0) {
    // A telefone/e-mail hit whose document contradicts the buyer's. Before #786
    // this merged silently and overwrote the other person's cpf_cnpj; now it is
    // a near-miss worth seeing rather than a duplicate to explain later.
    console.warn('[mercado-livre] candidatos a cliente rejeitados por documento divergente', {
      orderId,
      rejected,
    });
  }
  if (dropped.length > 0) {
    console.warn('[mercado-livre] campos do cliente descartados por valor inválido', {
      orderId,
      dropped,
    });
  }
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

/* -------------------------------------------------------------------------- */
/*                  Shipment ↔ pedido item conference (#669)                   */
/* -------------------------------------------------------------------------- */

/** A divergence plus the shipment it was found against. */
interface DivergenciaDeEnvio {
  readonly conferencia: Extract<ResultadoConferencia, { tipo: 'divergente' }>;
  readonly shipmentId: number | string;
}

/**
 * Thrown when the pedido holds items — or quantities — the shipment is not
 * selling (legacy's `Exception('Erro ao atualizar frete …')`, tasks.dart:616).
 *
 * 🔒 Carries IDENTIFIERS AND COUNTS ONLY. The legacy exception interpolated the
 * entire pedido (`$pedido`), whose `toString()` dumps buyer name, CPF/CNPJ,
 * delivery address, phone and every item price — and the sweep then rethrew it
 * out of the Cloud Run handler, putting customer PII in the function logs and in
 * a 500 body. `descreverDivergencia` is built to be safe to print; nothing else
 * about the pedido may join it.
 */
export class MlEnvioItensDivergentesError extends Error {
  constructor(
    readonly pedidoId: string,
    readonly divergencia: DivergenciaDeEnvio,
  ) {
    super(
      `Conteúdo do pedido ${pedidoId} diverge do envio ${divergencia.shipmentId}: ` +
        descreverDivergencia(divergencia.conferencia, divergencia.shipmentId),
    );
    this.name = 'MlEnvioItensDivergentesError';
  }
}

/**
 * Deterministic incidente id, one per shipment. Makes the write idempotent
 * across the retries this path is guaranteed to see, and — because the id is
 * derivable — lets the recovery branch look the incidente up with a plain `get`
 * instead of a query. An OPEN one at this id is how `applyFreteStep` knows the
 * `error` it is looking at is one IT set.
 */
function incidenteDivergenciaId(shipmentId: number | string): string {
  return `ml-envio-div-${shipmentId}`;
}

/**
 * `GET /shipments/{id}/orders`, degrading a 404 to "no data".
 *
 * A 404 here means ML has no order rows for this shipment — an answer about the
 * shipment, not a failure of ours — and it must not park an import that is
 * otherwise fine; same narrow degrade `orderShipmentImport.ts` already applies
 * to `getShipment`. Everything else (5xx, 401, a validation failure) PROPAGATES,
 * per this file's THROW-ON-TRANSIENT discipline: a conference skipped because ML
 * was briefly down would silently price the pedido unchecked, which is the exact
 * outcome this check exists to prevent.
 */
async function fetchLinhasDoEnvio(
  api: MercadoLivreApi,
  shipmentId: number | string,
): Promise<MlShipmentOrder[] | null> {
  try {
    return await api.getShipmentOrders(shipmentId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) {
      console.warn('[mercado-livre] conferência de itens: envio sem orders (404)', { shipmentId });
      return null;
    }
    throw err;
  }
}

/**
 * One incidente per divergent shipment, so the block is visible where the
 * operator works (the pedido's Incidentes tab) rather than only in a parked
 * notification. Mirrors `recordItensSemProduto`'s idempotency contract:
 * `.create()` at a deterministic id, swallowing ONLY `ALREADY_EXISTS`, so a
 * replay keeps the first row's `timestamp` instead of re-dating it.
 */
async function registrarIncidenteDeDivergencia(
  db: Firestore,
  pedidoId: string,
  divergencia: DivergenciaDeEnvio,
  nowUs: number,
): Promise<void> {
  try {
    await incidenteCollection
      .docRef(db, { pedidoId }, incidenteDivergenciaId(divergencia.shipmentId))
      .create(
        incidenteCollection.parse({
          origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
          tipo: TIPO_INCIDENTE.outros,
          subtipo: 'ml-envio-itens-divergentes',
          motivoDoIncidente: descreverDivergencia(divergencia.conferencia, divergencia.shipmentId),
          comentarios: null,
          timestamp: nowUs,
          ultimaModificacao: nowUs,
          externalId: String(divergencia.shipmentId),
          resolucao: null,
        }),
      );
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
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
  /**
   * The initial order's raw ML `status`. Used ONLY to re-derive `estado` when a
   * pedido this step previously put into `error` re-validates — see the
   * conference block below.
   */
  orderStatus: string | null;
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
    orderStatus,
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

  // Shipment↔pedido item conference (#669). Fetched HERE, never inside the
  // transaction: an ML round-trip in the OCC window would hold a document the
  // Flutter app, `applyPagoAdvanceOrDowngrade` and the shipments handler all
  // contend for, and every other step in this file already fetches first.
  //
  // The predicate below is a NETWORK EARLY-OUT and decides nothing (root
  // `CLAUDE.md` rule 7, same role as the `talvezMaisNovo` gate above): it only
  // says whether spending the call is worth it. The authoritative verdict is
  // re-derived from the tx-fresh document, and when we skipped the fetch the
  // transaction simply falls through to the behaviour it had before this check
  // existed. Do NOT "tighten" this into a guard.
  //
  // `hasUserInteraction` appears here for ONE reason: it is MONOTONIC (`null →
  // true`, nothing ever writes it back), so a pre-read `true` guarantees the
  // tx-fresh value is `true` too and the call would be wasted. That argument
  // runs in one direction only — a pre-read `false` says nothing about the
  // tx-fresh value, because an operator can save the pedido during the ML
  // round-trips above. The override is therefore RE-CHECKED inside the
  // transaction; this gate only decides whether to spend the call.
  const podeConferir =
    pedido.enderecoFiscalOuterRef != null &&
    pedido.hasUserInteraction !== true &&
    (freteAntigo == null ||
      freteAntigo.prazoDespacho == null ||
      ESTADOS_CONFERIR_PAGAMENTO.has(pedido.estado));
  const linhasDoEnvio = podeConferir ? await fetchLinhasDoEnvio(api, shippingInstance.id) : null;

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

  // Set by the FINAL (committed) attempt. Held in a record rather than a bare
  // `let` so the reset below is unmistakable: legacy declared the equivalent
  // flag OUTSIDE its transaction closure (`bool error`, tasks.dart:511) and
  // wrote it inside, so on an ODM retry a divergence found by a first attempt
  // poisoned every subsequent one. Firestore re-runs this callback verbatim.
  const veredito: { divergencia: DivergenciaDeEnvio | null } = { divergencia: null };

  await db.runTransaction(async (tx) => {
    veredito.divergencia = null; // ⚠️ per-attempt reset — see above.

    /* ======================= READ PHASE (no writes yet) ======================= */
    const pedidoRef = pedidoCollection.docRef(db, {}, pedidoId);
    const pedidoSnap = await tx.get(pedidoRef);
    if (!pedidoSnap.exists) return;
    const freshPedido = pedidoCollection.parseRead(
      pedidoSnap.data() ?? {},
      pedidoCollection.docPath({}, pedidoId),
    );
    // Only when the pedido is sitting in `error` can this step have anything to
    // undo, so the extra read is paid only there. An OPEN divergence incidente
    // at our own deterministic id is the proof that WE set that `error` — the
    // one thing that makes the restore below safe.
    const incidenteRef = incidenteCollection.docRef(
      db,
      { pedidoId },
      incidenteDivergenciaId(shippingInstance.id),
    );
    const incidenteAberto =
      freshPedido.estado === ESTADO_PEDIDO.error
        ? await tx.get(incidenteRef).then((s) => s.exists && s.data()?.resolucao == null)
        : false;

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

    // Full conference (tasks.dart:522-620).
    const itensDoPedido = flattenPedidoItens(freshPedido.itens);

    // ---- Shipment↔pedido item cross-check (tasks.dart:536-568, #669) ----
    // `linhasDoEnvio == null` means the pre-tx gate skipped the fetch, so there
    // is nothing to judge: fall through to exactly the behaviour this branch had
    // before the check existed. Same for `indeterminado`, which the conference
    // returns when ML sent nothing (a documented 204) or sent a row we cannot key
    // or count — refusing to judge beats judging on data we cannot read.
    //
    // The operator override is re-derived HERE, from the tx-fresh document, not
    // taken from the pre-read that decided whether to fetch (root `CLAUDE.md`
    // rule 7). A human can save the pedido — stamping `hasUserInteraction` —
    // during the ML round-trips this step makes before opening the transaction,
    // and honouring the stale `false` would flip the very pedido they just
    // repaired to `error`.
    const conferencia: ResultadoConferencia =
      linhasDoEnvio == null
        ? { tipo: 'indeterminado', motivo: 'conferência não solicitada nesta execução' }
        : freshPedido.hasUserInteraction === true
          ? { tipo: 'indeterminado', motivo: 'pedido editado por um humano (override do operador)' }
          : conferirItensDoEnvio({
              linhasDoEnvio,
              itensDoPedido,
              sellerUserId: contaBag.sellerUserId,
            });

    if (conferencia.tipo === 'divergente') {
      veredito.divergencia = { conferencia, shipmentId: shippingInstance.id };
      if (conferencia.bloqueia) {
        // The pedido holds units ML is not selling. Park it in `error` and touch
        // no other field — this patch does NOT overwrite `freteInicial` or
        // `valorCobrado`, and deliberately does not clear whatever an earlier
        // successful conference left there:
        //  - a stale `valorCobrado` cannot drive anything, because every
        //    automatic advance runs through `podeAvancarParaPago`, which
        //    requires `emProcessamento` — including the independent payments
        //    path (`orderPaymentImport.ts`). An `error` pedido is excluded
        //    everywhere, so the number is inert until a human acts on it;
        //  - clearing `freteInicial` would destroy real data — the tracking
        //    number, `prazoDespacho` and the ML shipment mirror that the
        //    etiqueta flow and `historicoFtIni` depend on. Losing that to
        //    signal a QUANTITY problem is a bad trade.
        //
        // This is the one place the port deliberately goes FURTHER than legacy,
        // which only threw (tasks.dart:616) and left the document untouched. A
        // throw alone rolls this transaction back, so nothing is recorded, and
        // `podeAvancarParaPago` requires `freteInicial != null` — the pedido
        // would sit at `emProcessamento` with no operator-visible sign of why.
        // Persisting `error` is what actually stops a wrong dispatch:
        //  - `podeAvancarParaPago` can never fire, so no auto-`pago`;
        //  - `ITENS_EDITAVEIS` contains `error`, so the pedido form unlocks the
        //    items for repair;
        //  - `ESTADOS_PEDIDO_MOVIMENTACAO` excludes `error`, so
        //    `onPedidoEstoqueSync` returns the reserved stock.
        // `historicoEstadoPedido` is appended by the `onPedidoEstadoChanged`
        // trigger observing this very write — never write that trail from here.
        if (freshPedido.estado !== ESTADO_PEDIDO.error) {
          tx.update(
            pedidoRef,
            pedidoCollection.parseMerge({
              estado: ESTADO_PEDIDO.error,
              ultimaModificacao: avancarWatermark(
                coerceToMicros(freshPedido.ultimaModificacao),
                nowUs,
              ),
            }) as DocumentData,
          );
        }
        return;
      }
      // Non-blocking: ML is selling units this pedido does not hold YET. Routine
      // during pack assembly (a sibling order not imported yet), self-healing,
      // and the under-counted total it produces already has its own repair in
      // the `!maisNovo` branch above — so it is logged, not raised, and the
      // write proceeds.
      console.warn(
        '[mercado-livre] conferência de itens do envio: pedido incompleto',
        descreverDivergencia(conferencia, shippingInstance.id),
      );
    }

    const totalItens = roundReais(itensDoPedido.reduce((sum, item) => sum + itemSubtotal(item), 0));
    const patch: Record<string, unknown> = {
      freteInicial: targetFrete,
      valorCobrado: roundReais(totalItens + (mappedFrete.valorCobrado ?? 0)),
    };

    // Recovery. A divergence we recorded has cleared, so undo what we did:
    // resolve the incidente and give the pedido its estado back. The estado is
    // RE-DERIVED from the live ML status rather than restored from a snapshot —
    // by the time a divergence resolves the order has usually moved on (`paid` →
    // `emProcessamento`), so the current status is the more correct answer, and
    // it needs no new field to remember the old one. Gated on the OPEN incidente
    // at our own deterministic id, so an `error` set by an operator or another
    // flow is never silently cleared and the restore fires at most once.
    //
    // Note this cannot fire once the operator override is set: a waived check
    // yields `indeterminado`, never `ok`. That is deliberate — with the
    // conference skipped we have no evidence the divergence is gone, so
    // releasing the block stays the human's call. The incidente text says so.
    if (conferencia.tipo === 'ok' && incidenteAberto) {
      tx.update(
        incidenteRef,
        incidenteCollection.parseMerge({
          resolucao: {
            data: nowUs,
            valor: 0,
            tipo: TIPO_RESOLUCAO.outro,
            comentarios:
              `Divergência resolvida automaticamente: o conteúdo do pedido voltou a ` +
              `conferir com o envio ${shippingInstance.id}.`,
          },
          ultimaModificacao: nowUs,
        }) as DocumentData,
      );
      patch.estado = estadoPedidoFromOrderStatus(orderStatus ?? '');
    }

    // Wall clock, monotonic. Legacy stamped the ORDER's own timestamp here
    // (tasks.dart:613), but this field is the display / recency-sort / TableView
    // update-monitor stamp that `saveRecord`, the Mercado Pago reconcile and the
    // Flutter app all write with a wall clock; a payload-derived value would let
    // the row jump BACKWARDS in the list and let the monitor miss the change.
    // The ML ORDER clock lives in `lastMarketplaceUpdate` instead (#791/O15),
    // written by `discoverPedidoMercadoLivre` alone.
    patch.ultimaModificacao = avancarWatermark(
      coerceToMicros(freshPedido.ultimaModificacao),
      nowUs,
    );

    tx.update(pedidoRef, pedidoCollection.parseMerge(patch) as DocumentData);
  });

  // Outside the transaction ON PURPOSE, and in this order.
  //
  // The incidente is written after the commit so it reuses `recordItensSemProduto`'s
  // create-once idiom (deterministic id + swallow ALREADY_EXISTS), which keeps the
  // FIRST occurrence's `timestamp` across the retries this path is guaranteed to
  // see. And the throw has to come after the commit or it would roll the
  // `estado: error` write back — which is the whole reason that write exists.
  const divergencia = veredito.divergencia;
  if (divergencia != null && divergencia.conferencia.bloqueia) {
    await registrarIncidenteDeDivergencia(db, pedidoId, divergencia, nowUs);
    // Transient by contract, per this file's THROW-ON-TRANSIENT discipline: the
    // notification queue retries and, if the divergence is real and permanent,
    // parks the notification after `MAX_TENTATIVAS`. The pedido is already
    // parked in `error` at that point, so nothing depends on the retry
    // succeeding — it is the operator's signal, not the recovery mechanism.
    throw new MlEnvioItensDivergentesError(pedidoId, divergencia);
  }
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
      patch.ultimaModificacao = avancarWatermark(
        coerceToMicros(freshPedido.ultimaModificacao),
        nowUs,
      );
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

  const { initialOrder, initialComplete, packInfo } = await fetchOrderWithPackFallback(
    api,
    orderIdOrPackId,
  );

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

  const { orders, packId, completeOrderIds } = await resolvePackOrders(
    api,
    initialOrder,
    initialComplete,
    packInfo,
  );
  for (const order of orders) assertOrderItemsComplete(order);

  const { itensByOrderId, mlIdsByUniqueId } = await buildItensByOrderId(
    db,
    integracaoId,
    orders,
    nowUs,
  );

  const discoverArgs: DiscoverPedidoArgs = {
    db,
    contaId: integracaoId,
    contaOuterRef: contaBag.contaOuterRef,
    contaCpfCnpj: contaBag.contaCpfCnpj,
    integracaoOuterRef: contaBag.contaOuterRef,
    operacaoOuterRef: contaBag.operacaoOuterRef,
    listaDePrecosOuterRef: contaBag.listaDePrecosOuterRef,
    orders,
    completeOrderIds,
    packId,
    itensByOrderId,
    nowUs,
  };
  const { pedidoId, created } = await discoverPedidoMercadoLivre(discoverArgs);

  let pedido = await readPedido(db, pedidoId);

  // Unbound lines get a visible incidente (#792) — after the pedido was written,
  // both so the subcollection has a parent and so a line the stored pedido
  // already has bound (Flutter, dual-run) is not falsely flagged.
  await recordItensSemProduto(db, pedidoId, itensByOrderId, mlIdsByUniqueId, pedido, nowUs);

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
    orderId: initialOrder.id,
    shippingInstance,
    nowUs,
    viaCep: deps.viaCep,
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
      orderStatus: initialOrder.status ?? null,
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
