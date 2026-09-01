/**
 * Marketplace channel MODEL — normalized, provider-agnostic data shapes.
 *
 * ⚠️ There is deliberately **no `MarketplaceChannel` interface here**, and adding
 * one back is the mistake this module exists to prevent. `packages/core` is
 * storage- and secret-agnostic by design, so a contract living here can only
 * describe provider-facing operations — while every real marketplace operation
 * (publish a produto, import an order, sweep stock) is an ERP-side orchestration
 * needing Firestore, Storage and a token refresher. The `MarketplaceChannel`
 * interface removed in #815 declared the second kind at the altitude of the
 * first, so Mercado Livre — the channel that was supposed to validate it — could
 * not implement three of its four required members and routed around the rest.
 * The same lesson had already been paid for once by `FreightProvider` (#262).
 *
 * What replaces it:
 *  - **capability declaration** → `MARKETPLACE_TIPO_CAPS` (`@delfrance/schemas`),
 *    a `Record` keyed on the tipo, so a channel without a row is a compile error.
 *  - **orchestration** → one App Hosting backend per channel (`apps/<channel>`),
 *    built on the shared seams: `@delfrance/data/admin/{notifications,oauth-state,
 *    cache,clientes}`, `@delfrance/storage/admin`, `@delfrance/core/wire`.
 *  - **procedure** → the `marketplace-integration` skill.
 *
 * See ADR 0015. This module holds only the DATA that crosses between them.
 *
 * ⚠️ Money is **reais**, rounded through `roundReais` (`@delfrance/core/money`) —
 * never integer centavos. The removed contract's `MinorUnits` was unimplementable
 * against the reais floats the produto price tables store and every Brazilian
 * marketplace speaks on the wire, and it is why `pushPrice`/`pushStock` were
 * bypassed for the whole ML port.
 */

/* -------------------------------------------------------------------------- */
/*                          Channel execution context                         */
/* -------------------------------------------------------------------------- */

/**
 * Server-resolved auth + account context for one connected marketplace account.
 * The consumer never reads Firestore or env: the channel backend resolves the
 * `integracao` doc plus its credential store and passes live values in.
 *
 * ⚠️ Prefer `getAccessToken()` over `accessToken` in new code. The plain field is
 * a SNAPSHOT taken when the context was built, which is wrong for anything
 * long-running — a sweep page, a mass-import dispatch, a resumable job can all
 * outlive a grant. The thunk re-reads (and refreshes) per call. `accessToken`
 * remains because ~25 Mercado Livre call sites read it and the field costs
 * nothing to keep; it is not the shape to reach for.
 *
 * `account` carries the per-channel singularities the ERP has already parsed off
 * the `integracao` doc (ML `user_id`, Shopee `shop_id`, Amazon
 * `selling_partner_id`, Magalu `tenant_id`).
 */
export interface ChannelContext {
  integracaoId: string;
  /** Snapshot taken when the context was built. See the ⚠️ above. */
  accessToken: string;
  /** Live, non-expired token — refreshes when near expiry. Prefer this. */
  getAccessToken(): Promise<string>;
  account: Readonly<Record<string, unknown>>;
}

/** Forward sync cursor: an opaque provider token OR a since-timestamp (epoch ms). */
export interface SyncCursor {
  token?: string;
  sinceMs?: number;
}

/** A page of synced items. An absent `nextCursor` means the stream is exhausted. */
export interface SyncPage<T> {
  items: ReadonlyArray<T>;
  nextCursor?: SyncCursor;
}

/* -------------------------------------------------------------------------- */
/*        Incident model — returns / claims / mediations / cancellations       */
/* -------------------------------------------------------------------------- */

/**
 * IMPLEMENTED TODAY by `@delfrance/integrations-mercado-livre`
 * (`incidents.ts`, `incidentRespond.ts`) and reached from
 * `apps/mercado-livre/lib/marketplace/claims/claimResolve.ts`.
 *
 * Mirrors the wire vocabulary of `TIPO_INCIDENTE` / `TIPO_RESOLUCAO`
 * (`packages/schemas/src/pedido/collection/incidente.ts`) WITHOUT importing the
 * Zod schema — core stays browser- and schema-free. The `custom` action and the
 * `channelSpecific` bags absorb the per-channel long tail (Shopee's three
 * substate tracks, ML `available_actions`/`expected_resolutions`, Amazon
 * A-to-z/SAFE-T), which persists through the passthrough `Incidente` schema.
 */
export type IncidentKind =
  | 'mediation' // ML claim→dispute, Shopee SELLER_DISPUTE, Amazon A-to-z
  | 'claim' // generic complaint (Magalu, Amazon A-to-z pre-decision)
  | 'return' // devolução
  | 'cancellation' // cancel_purchase OR cancel_sale (direction in status/channelSpecific)
  | 'exchange' // troca ('t')
  | 'other'; // SAFE-T, late delivery, unmapped ('o')

export type IncidentParty = 'buyer' | 'seller' | 'marketplace';

export interface ImportedIncidentMessage {
  externalId?: string;
  author: IncidentParty;
  text: string;
  attachments?: ReadonlyArray<string>;
  timestampMs: number;
}

export interface ImportedIncident {
  externalId: string; // claim_id / return_sn / returnId / order.numero — the dedup key
  kind: IncidentKind;
  orderExternalId: string; // resolves to the local pedido
  status: string; // raw provider status
  reason?: string; // → Incidente.motivoDoIncidente
  openedMs: number;
  lastUpdatedMs: number;
  messages?: ReadonlyArray<ImportedIncidentMessage>;
  channelSpecific?: Record<string, unknown>; // escape hatch → passthrough Incidente fields
}

/**
 * Seller action against an incident. Discriminated on `type`; `custom` is the
 * escape hatch so new per-channel verbs need no change here.
 *
 * ⚠️ `refundAmount` is **reais**, not centavos. A channel that accepts only
 * discrete offers (Mercado Livre takes percentages off an allow-list and
 * silently defaults a MISSING percentage to 50%) must REFUSE an amount with no
 * exact offer and name the real ones — never round to the nearest. A refund is
 * not a value worth approximating.
 */
export type IncidentAction =
  | { type: 'reply_message'; text: string; attachments?: ReadonlyArray<string> }
  | { type: 'attach_evidence'; attachments: ReadonlyArray<string>; note?: string }
  | { type: 'accept_return' }
  | { type: 'offer_refund'; refundAmount: number; partial?: boolean; note?: string }
  | { type: 'ship_replacement'; note?: string }
  | { type: 'escalate_mediation'; note?: string }
  | {
      type: 'custom';
      action: string; // channel-defined verb, e.g. 'shopee:confirm', 'amazon:reject_return'
      refundAmount?: number;
      channelSpecific?: Record<string, unknown>;
    };

export interface IncidentActionResult {
  ok: boolean;
  status?: string; // new provider status after the action, when known
  incident?: ImportedIncident; // echoed updated incident, avoids a re-fetch
}

/* -------------------------------------------------------------------------- */
/*                    Order model — NOT IMPLEMENTED BY ANY CHANNEL             */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ **Nothing produces these types today, and that is stated rather than
 * hidden.** They are the TARGET shape for a shared, ERP-side order importer that
 * does not exist yet — the piece that would let a second marketplace inherit
 * order→pedido upsert instead of writing its own, the way #786 promoted
 * `findOrCreateCliente` out of `apps/mercado-livre` once a second channel needed it.
 *
 * Mercado Livre maps its own wire type straight to `PedidoCoreFields`
 * (`apps/mercado-livre/lib/marketplace/pedidos/orderMapping.ts`) and never passes
 * through here. Making it produce these as well would create a SECOND order
 * mapper beside the live one — two copies that drift toward plausible while both
 * stay green, which is the failure root `CLAUDE.md` documents (#1369). So the
 * research is kept and the duplication is not.
 *
 * They survive deletion because the shapes encode real cross-channel work: which
 * identity is masked, which data needs a second gated call, and that every
 * channel returns its financial deductions in ONE settlement call. Re-deriving
 * that from five providers' docs is expensive; keeping ~90 lines of types is not.
 *
 * ⚠️ Before building the importer, re-validate these against the channel in hand.
 * They were designed in #288 against documentation, never against a running
 * integration — which is exactly how the deleted contract went wrong.
 *
 * ⚠️ All money is **reais** (see the module header).
 */

export interface ImportedOrderItem {
  externalItemId: string;
  externalListingId: string;
  sku?: string | null;
  title: string;
  quantity: number;
  unitPrice: number; // reais
  discount: number; // reais
}

/** Lightweight buyer summary that rides with the order (taxId possibly masked).
 *  The authoritative NF-e identity is `ImportedFiscalIdentity` (see below). */
export interface ImportedOrderBuyer {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  taxId?: string | null;
  taxIdMasked?: boolean;
  region?: string | null;
}

export interface ImportedOrderPayment {
  externalPaymentId: string;
  amount: number; // reais
  status: string;
  method?: string | null;
}

/** A postal address (delivery or fiscal). `region` = UF/state, `postalCode` = CEP. */
export interface ImportedAddress {
  recipientName?: string | null;
  line1: string; // logradouro + número (or full street line)
  line2?: string | null; // complemento
  district?: string | null; // bairro
  city: string;
  region: string; // estado / UF
  postalCode: string; // CEP
  country?: string | null; // ISO-3166; defaults to BR
  phone?: string | null;
  channelSpecific?: Record<string, unknown>; // raw provider bits (address id, masked tokens)
}

/**
 * NF-e-grade fiscal identity of the buyer (destinatário) — the authoritative
 * identity, distinct from the lightweight `ImportedOrderBuyer` that rides with
 * the order possibly masked. Often behind a gated/separate call (Amazon RDT
 * `getOrderBuyerInfo.buyerTaxInfo`, Mercado Livre `get_billing_info`, Shopee
 * post-invoice unmask).
 */
export interface ImportedFiscalIdentity {
  taxId?: string | null; // opaque tax-id digits (e.g. CPF/CNPJ in BR, or a foreign id)
  taxIdMasked?: boolean; // channel returned a masked value
  /** Generic classification — provider-agnostic. The local mapper applies the
   *  jurisdiction semantics (in BR: personal→CPF, business→CNPJ). */
  taxIdType?: 'personal' | 'business' | 'foreign' | 'unknown';
  legalName?: string | null; // legal/full name (razão social / nome completo)
  stateRegistration?: string | null; // sub-national tax registration (BR: inscrição estadual)
  ieIndicator?: string | null; // tax-status indicator, raw (BR: contribuinte / isento / não-contribuinte)
  email?: string | null;
  phone?: string | null;
}

export interface ImportedTrackingEvent {
  status: string;
  description?: string | null;
  timestampMs: number;
}

export interface ImportedTracking {
  trackingCode?: string | null; // codRastreio
  carrier?: string | null;
  status?: string | null; // raw provider status
  labelUrl?: string | null;
  estimatedDeliveryMs?: number | null;
  events?: ReadonlyArray<ImportedTrackingEvent>;
  channelSpecific?: Record<string, unknown>;
}

/** One marketplace charge line. `type` is the raw provider fee label
 *  (e.g. 'commission', 'service_fee', 'credit_card_fee', 'shipping_subsidy'). */
export interface ImportedOrderChargeLine {
  type: string;
  amount: number; // reais
  note?: string | null;
}

/**
 * Marketplace financial deductions for one order. Channels return every charge
 * type in ONE settlement call (Shopee `get_escrow_detail`, Amazon Finances,
 * Mercado Livre `getComissao` + `billing_info`), so this is a single structured
 * breakdown rather than three fetches.
 */
export interface ImportedOrderCharges {
  commission: number; // comissão de venda, reais
  fees: ReadonlyArray<ImportedOrderChargeLine>; // tarifas (frete/transação/serviço/cartão…)
  extraordinary: ReadonlyArray<ImportedOrderChargeLine>; // despesas extraordinárias
  total: number; // sum of all marketplace charges, reais
  netReceivable?: number | null; // escrow net the seller receives, when provided
  channelSpecific?: Record<string, unknown>; // raw escrow/billing/finances payload
}

export interface ImportedOrder {
  externalOrderId: string; // == pedido.numero
  externalPackId?: string | null; // pack consolidation: 1 ImportedOrder == 1 Pedido
  status: string;
  lastUpdatedMs: number; // drives the staleness guard
  buyer: ImportedOrderBuyer;
  items: ReadonlyArray<ImportedOrderItem>;
  payments: ReadonlyArray<ImportedOrderPayment>;
  /**
   * What the provider SAYS it is sending, for the completeness check.
   *
   * ⚠️ The rule this exists for is real and load-bearing — Mercado Livre, Shopee
   * and Amazon all silently truncate order items, and committing a truncated
   * order to payment/stock is a financial loss. But the guard belongs in the
   * channel, not in a shared error class: the live implementation is
   * `assertOrderItemsComplete` / `OrderItemsIncompleteError`
   * (`apps/mercado-livre/lib/marketplace/pedidos/orderMapping.ts`), which names
   * every missing `(item.id, variation_id, seller_sku, element_id)` tuple so the
   * failure is diagnosable from one log line. The generic
   * `OrderItemCountMismatchError` this module used to export carried three
   * numbers, had no caller ever, and was strictly worse.
   */
  reportedItemCount: number;
  // Canonical home for the fiscal/fulfilment data. Populated INLINE when the bulk
  // pull returns it (Loja Integrada, Magalu); left undefined when the channel
  // gates/masks it (Amazon RDT, Shopee pre-invoice) → fill with a second call.
  buyerFiscal?: ImportedFiscalIdentity; // dados fiscais do cliente
  shippingAddress?: ImportedAddress; // endereço de entrega
  fiscalAddress?: ImportedAddress; // endereço fiscal (defaults to shippingAddress)
  tracking?: ImportedTracking; // informações do rastreio
  charges?: ImportedOrderCharges; // comissão + tarifas + despesas extraordinárias
}
