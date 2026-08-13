/**
 * Plugin contracts. Concrete implementations live in
 * `packages/integrations/<channel>` and are registered at app boot via
 * `PluginRegistry`.
 *
 * Brazilian-specific features (NFe, MercadoPago, marketplaces) are plugins
 * — never imported by `packages/core` or `packages/data` directly.
 */

export interface TaxProvider {
  id: string;
  calculate(input: { items: ReadonlyArray<{ amount: number; ncm?: string }> }): {
    breakdown: ReadonlyArray<{ name: string; amount: number }>;
    total: number;
  };
}

export interface InvoiceProvider {
  id: string;
  issue(
    orderId: string,
  ): Promise<{ status: 'authorized' | 'pending' | 'rejected'; protocol?: string }>;
}

export interface PaymentGateway {
  id: string;
  createCharge(input: { amount: number; currency: string; orderId: string }): Promise<{
    chargeId: string;
    status: string;
  }>;
  refund(chargeId: string): Promise<void>;
  webhook(payload: unknown): Promise<{ orderId?: string; status: string }>;
}

/* -------------------------------------------------------------------------- */
/*                  Marketplace channel — shared contract types               */
/* -------------------------------------------------------------------------- */

/**
 * Opaque, server-resolved auth + account context handed to every channel op.
 * The channel never reads Firestore or env directly: the caller resolves the
 * `integracao` doc + the admin-only `credenciais` subcollection, refreshes the
 * token, and passes live values in. Keeps `packages/core` storage- and
 * secret-agnostic. `account` carries the per-channel singularities (shopId /
 * sellerId / sellingPartnerId+region / tenantId / apiKey) modeled in #289.
 */
export interface ChannelContext {
  integracaoId: string;
  accessToken: string; // live, non-expired
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

/** Money as integer minor units (centavos). No floats anywhere in the contract. */
export type MinorUnits = number;

export interface PushResult {
  externalId: string;
  status: 'ok' | 'skipped' | 'error';
  code?: string;
  message?: string;
}

export interface BulkPushResult {
  total: number;
  ok: number;
  skipped: number;
  errors: number;
  results: ReadonlyArray<PushResult>;
}

export interface PriceUpdate {
  externalId: string;
  price: MinorUnits;
  promoPrice?: MinorUnits | null;
}

export interface StockUpdate {
  externalId: string;
  quantity: number;
}

export interface ExportResult {
  produtoId: string;
  externalId?: string;
  externalParentId?: string;
  status: 'created' | 'updated' | 'validated' | 'error';
  issues?: ReadonlyArray<{ code: string; message: string }>;
}

export interface DiscoveredCategory {
  id: string;
  name: string;
  parentId?: string | null;
  leaf?: boolean;
}

export interface DiscoveredAttribute {
  id: string;
  name: string;
  required: boolean;
  type: 'text' | 'number' | 'enum' | 'boolean';
  options?: ReadonlyArray<{ id: string; name: string }>;
}

/** A label (PDF/ZPL/ZPL2). `format` is opaque so core stays carrier-agnostic. */
export interface LabelResult {
  data: string;
  format: string;
  trackingCode?: string | null;
}

/* ---------- Order import + enrichment ---------- */

export interface ImportedOrderItem {
  externalItemId: string;
  externalListingId: string;
  sku?: string | null;
  title: string;
  quantity: number;
  unitPrice: MinorUnits;
  discount: MinorUnits;
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
  amount: MinorUnits;
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
  amount: MinorUnits;
  note?: string | null;
}

/**
 * Marketplace financial deductions for one order. Channels return every charge
 * type in ONE settlement call (Shopee `get_escrow_detail`, Amazon Finances,
 * Mercado Livre `getComissao` + `billing_info`), so this is a single structured
 * breakdown rather than three fetches.
 */
export interface ImportedOrderCharges {
  commission: MinorUnits; // comissão de venda
  fees: ReadonlyArray<ImportedOrderChargeLine>; // tarifas (frete/transação/serviço/cartão…)
  extraordinary: ReadonlyArray<ImportedOrderChargeLine>; // despesas extraordinárias (ajustes/penalidades)
  total: MinorUnits; // sum of all marketplace charges
  netReceivable?: MinorUnits | null; // escrow net the seller receives, when provided
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
  reportedItemCount: number; // for the completeness check (see importOrders contract)
  // Canonical home for the fiscal/fulfilment data. Populated INLINE when the bulk
  // pull returns it (Loja Integrada, Magalu); left undefined when the channel
  // gates/masks it (Amazon RDT, Shopee pre-invoice) → fill via the getters below.
  buyerFiscal?: ImportedFiscalIdentity; // dados fiscais do cliente
  shippingAddress?: ImportedAddress; // endereço de entrega
  fiscalAddress?: ImportedAddress; // endereço fiscal (defaults to shippingAddress when not separated)
  tracking?: ImportedTracking; // informações do rastreio
  charges?: ImportedOrderCharges; // comissão + tarifas + despesas extraordinárias (one settlement)
}

/* ---------- Incident surface: returns / claims / mediations / cancellations ----------
 * Provider-agnostic; mirrors the wire vocabulary of TIPO_INCIDENTE / TIPO_RESOLUCAO
 * (packages/schemas/src/pedido/collection/incidente.ts) WITHOUT importing the Zod
 * schema — core stays browser/schema-free. Optional + extensible: the `custom`
 * action and the `channelSpecific` bag absorb the per-channel long tail (Shopee's
 * three substate tracks, ML available_actions/expected_resolutions, Amazon
 * A-to-z/SAFE-T), so incident handling evolves without core churn — it persists
 * through the passthrough `Incidente` schema. */

export type IncidentKind =
  | 'mediation' // ML claim→dispute, Shopee SELLER_DISPUTE, Amazon A-to-z
  | 'claim' // generic complaint (Magalu, Amazon A-to-z pre-decision)
  | 'return' // devolução
  | 'cancellation' // cancel_purchase OR cancel_sale (direction carried in status/channelSpecific)
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
 * escape hatch so new per-channel verbs need no core change.
 */
export type IncidentAction =
  | { type: 'reply_message'; text: string; attachments?: ReadonlyArray<string> }
  | { type: 'attach_evidence'; attachments: ReadonlyArray<string>; note?: string }
  | { type: 'accept_return' }
  | { type: 'offer_refund'; refundAmount: MinorUnits; partial?: boolean; note?: string }
  | { type: 'ship_replacement'; note?: string }
  | { type: 'escalate_mediation'; note?: string }
  | {
      type: 'custom';
      action: string; // channel-defined verb, e.g. 'shopee:confirm', 'amazon:reject_return'
      refundAmount?: MinorUnits;
      channelSpecific?: Record<string, unknown>;
    };

export interface IncidentActionResult {
  ok: boolean;
  status?: string; // new provider status after the action, when known
  incident?: ImportedIncident; // echoed updated incident, avoids a re-fetch
  label?: LabelResult; // accept_return may yield a return label (Amazon/ML)
}

/* -------------------------------------------------------------------------- */
/*                          MarketplaceChannel contract                       */
/* -------------------------------------------------------------------------- */

/**
 * A sales-channel plugin (Mercado Livre, Shopee, Amazon, Magalu, Loja
 * Integrada). The core members (`id`, `syncProducts`, `pullOrders`,
 * `pushTracking`, `oauthFlow`) are REQUIRED; every other capability is
 * OPTIONAL — a channel implements only what its API supports and callers
 * feature-detect (`typeof channel.pushPrice === 'function'`).
 *
 * Label responsibility: carrier-bought labels stay in the freight domain;
 * marketplace-owned labels (Shopee/Magalu/Amazon Easy Ship) are fetched via
 * `fetchLabel`, which the freight domain delegates to when a pedido's freight is
 * `marketplaceOwned`. `generateLabel` is the rare native-mint path.
 */
export interface MarketplaceChannel {
  id: string;

  /* Core (REQUIRED) */
  syncProducts(ctx: ChannelContext): Promise<void>;
  pullOrders(ctx: ChannelContext): Promise<void>;
  pushTracking(ctx: ChannelContext, orderId: string, trackingCode: string): Promise<void>;
  oauthFlow: {
    /**
     * Returns the consent redirect URL. `pkce` is OPTIONAL because PKCE
     * (RFC 7636) is a per-registered-application toggle on most channels — a
     * channel whose app has it off must not receive a challenge, and a channel
     * that ignores the argument entirely stays assignable to this type.
     */
    start(
      state: string,
      pkce?: { codeChallenge: string; codeChallengeMethod?: 'S256' | 'plain' },
    ): string;
    callback(code: string, state: string): Promise<void>;
  };

  /* Price (OPTIONAL) */
  pushPrice?(ctx: ChannelContext, update: PriceUpdate): Promise<PushResult>;
  pushAllPrices?(ctx: ChannelContext, updates: ReadonlyArray<PriceUpdate>): Promise<BulkPushResult>;

  /* Stock (OPTIONAL) */
  pushStock?(ctx: ChannelContext, updates: ReadonlyArray<StockUpdate>): Promise<BulkPushResult>;

  /* Listing lifecycle (OPTIONAL) — `validateOnly` == Amazon VALIDATION_PREVIEW */
  exportProduct?(
    ctx: ChannelContext,
    produtoId: string,
    opts?: { validateOnly?: boolean },
  ): Promise<ExportResult>;
  bindListing?(ctx: ChannelContext, produtoId: string, externalId: string): Promise<ExportResult>;
  syncProduct?(ctx: ChannelContext, produtoId: string): Promise<ExportResult>;

  /* Import (OPTIONAL) */
  importProducts?(ctx: ChannelContext, cursor?: SyncCursor): Promise<SyncPage<ExportResult>>;

  /**
   * Granular order pull (OPTIONAL). CONTRACT: for every order,
   * `items.length` MUST equal `reportedItemCount`, else throw
   * `OrderItemCountMismatchError` — never return a truncated order. The caller
   * upserts transactionally, dedups by `externalOrderId`, and skips when the
   * local lastUpdate >= `lastUpdatedMs`.
   */
  importOrders?(ctx: ChannelContext, cursor?: SyncCursor): Promise<SyncPage<ImportedOrder>>;

  /* Order enrichment (OPTIONAL) — fiscal identity, addresses, payments, tracking,
   * charges. Universal DATA, but frequently gated/lazy/separate: Amazon RDT
   * (getOrderBuyerInfo.buyerTaxInfo + shippingAddress under one token), ML
   * get_billing_info, Shopee post-invoice unmask + get_tracking_number, escrow.
   * Prefer the inline ImportedOrder.* fields; call these only to fill what the
   * pull masked or omitted. Channels that return everything inline may implement
   * none. */
  getOrderFiscalIdentity?(ctx: ChannelContext, orderId: string): Promise<ImportedFiscalIdentity>; // dados fiscais do cliente
  getShippingAddress?(ctx: ChannelContext, orderId: string): Promise<ImportedAddress>; // endereço de entrega
  getFiscalAddress?(ctx: ChannelContext, orderId: string): Promise<ImportedAddress>; // endereço fiscal
  getOrderPayments?(
    ctx: ChannelContext,
    orderId: string,
  ): Promise<ReadonlyArray<ImportedOrderPayment>>; // informações do pagamento
  getOrderTracking?(ctx: ChannelContext, orderId: string): Promise<ImportedTracking>; // informações do rastreio
  getOrderCharges?(ctx: ChannelContext, orderId: string): Promise<ImportedOrderCharges>; // comissão / tarifas / despesas extraordinárias (one settlement call)

  /* Labels (OPTIONAL) — marketplace-owned; freight delegates here */
  fetchLabel?(ctx: ChannelContext, orderId: string): Promise<LabelResult>;
  generateLabel?(ctx: ChannelContext, orderId: string): Promise<LabelResult>;

  /* Invoice upload (OPTIONAL) — `xml` opaque; NF-e meaning owned by the nfe plugin */
  uploadInvoice?(ctx: ChannelContext, orderId: string, xml: string): Promise<void>;

  /* Discovery (OPTIONAL) */
  discoverCategories?(
    ctx: ChannelContext,
    query?: string,
  ): Promise<ReadonlyArray<DiscoveredCategory>>;
  discoverAttributes?(
    ctx: ChannelContext,
    categoryId: string,
  ): Promise<ReadonlyArray<DiscoveredAttribute>>;

  /* Incidents — returns/claims/mediations/cancellations (OPTIONAL).
   * importIncidents = the single read primitive (collapses ML searchClaims,
   * Shopee listReturns, Amazon listReturns/AtoZ/SafeT, LI list-and-infer).
   * getIncident = targeted hydrate (Shopee list omits substates; ML full claim).
   * respondIncident = the single write primitive, dispatching on IncidentAction.type. */
  importIncidents?(ctx: ChannelContext, cursor?: SyncCursor): Promise<SyncPage<ImportedIncident>>;
  getIncident?(ctx: ChannelContext, externalIncidentId: string): Promise<ImportedIncident>;
  respondIncident?(
    ctx: ChannelContext,
    externalIncidentId: string,
    action: IncidentAction,
  ): Promise<IncidentActionResult>;
}

/**
 * Thrown by `importOrders` when a marketplace returns fewer (or more) order
 * items than it reports — the known Mercado Livre / Shopee / Amazon
 * silent-truncation bug. Callers must NOT commit a truncated order to
 * payment/stock; they block and surface this. A dedicated class (not a generic
 * `Error`) so `catch` blocks can narrow on it per the repo's no-generic-catch rule.
 */
export class OrderItemCountMismatchError extends Error {
  readonly externalOrderId: string;
  readonly expected: number;
  readonly received: number;
  constructor(externalOrderId: string, expected: number, received: number) {
    super(`Order "${externalOrderId}" returned ${received} items but reported ${expected}.`);
    this.name = 'OrderItemCountMismatchError';
    this.externalOrderId = externalOrderId;
    this.expected = expected;
    this.received = received;
  }
}

export class PluginNotRegisteredError extends Error {
  readonly kind: string;
  readonly pluginId: string;
  constructor(kind: string, pluginId: string) {
    super(`No ${kind} registered for "${pluginId}".`);
    this.name = 'PluginNotRegisteredError';
    this.kind = kind;
    this.pluginId = pluginId;
  }
}

export class PluginRegistry {
  private taxes = new Map<string, TaxProvider>();
  private invoices = new Map<string, InvoiceProvider>();
  private payments = new Map<string, PaymentGateway>();
  private marketplaces = new Map<string, MarketplaceChannel>();

  registerTax(p: TaxProvider) {
    this.taxes.set(p.id, p);
  }
  registerInvoice(p: InvoiceProvider) {
    this.invoices.set(p.id, p);
  }
  registerPayment(p: PaymentGateway) {
    this.payments.set(p.id, p);
  }
  registerMarketplace(p: MarketplaceChannel) {
    this.marketplaces.set(p.id, p);
  }

  tax(id: string) {
    return this.must(this.taxes, id, 'TaxProvider');
  }
  invoice(id: string) {
    return this.must(this.invoices, id, 'InvoiceProvider');
  }
  payment(id: string) {
    return this.must(this.payments, id, 'PaymentGateway');
  }
  marketplace(id: string) {
    return this.must(this.marketplaces, id, 'MarketplaceChannel');
  }

  private must<T>(map: Map<string, T>, id: string, kind: string): T {
    const v = map.get(id);
    if (!v) throw new PluginNotRegisteredError(kind, id);
    return v;
  }
}
