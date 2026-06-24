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

export interface MarketplaceChannel {
  id: string;
  syncProducts(): Promise<void>;
  pullOrders(): Promise<void>;
  pushTracking(orderId: string, trackingCode: string): Promise<void>;
  oauthFlow: {
    start(state: string): string; // returns redirect URL
    callback(code: string, state: string): Promise<void>;
  };
}

/**
 * @deprecated Freight does **not** use the plugin registry. The freight domain
 * is integrated directly via `@delfrance/integrations-freight-br` (the
 * `FreightHttpClient` interface + the `comprarEtiqueta` pipeline) plus the
 * per-tipo `FREIGHT_TIPO_CAPS` capability table in `@delfrance/schemas`. This
 * 3-method contract can't express OAuth, cart→checkout→generate, drop-off agency
 * resolution, per-tipo UI, or the marketplace fetch / read-only category, and has
 * no consumers. Kept only for backward-compat of the public plugin SDK — do not
 * implement against it. See the `freight-integrations` skill.
 */
export interface FreightProvider {
  id: string;
  quote(input: {
    fromCep: string;
    toCep: string;
    weightG: number;
  }): Promise<Array<{ carrier: string; service: string; price: number; etaDays: number }>>;
  purchase(quoteId: string): Promise<{ trackingCode: string }>;
  track(trackingCode: string): Promise<{ status: string; events: unknown[] }>;
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
  private freight = new Map<string, FreightProvider>();

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
  /** @deprecated See {@link FreightProvider} — freight bypasses the registry. */
  registerFreight(p: FreightProvider) {
    this.freight.set(p.id, p);
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
  /** @deprecated See {@link FreightProvider} — freight bypasses the registry. */
  freightProvider(id: string) {
    return this.must(this.freight, id, 'FreightProvider');
  }

  private must<T>(map: Map<string, T>, id: string, kind: string): T {
    const v = map.get(id);
    if (!v) throw new PluginNotRegisteredError(kind, id);
    return v;
  }
}
