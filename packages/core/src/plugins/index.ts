/**
 * Plugin contracts for the three domains that are genuinely registry-shaped:
 * tax, invoice and payment. Concrete implementations live in
 * `packages/integrations/<channel>`.
 *
 * ⚠️ **These are the contract for THIRD-PARTY plugins. No in-tree channel is
 * looked up by plugin id at boot** — `apps/web/lib/plugins/paymentRegistry.ts`
 * holds the only live registry and it is deliberately empty. The header here
 * used to claim implementations "are registered at app boot via
 * `PluginRegistry`"; that was never true of any in-tree channel and is what let
 * the docs guide keep instructing authors to register into something nothing
 * reads.
 *
 * ⚠️ **`MarketplaceChannel` is NOT here, and must not come back** (#815). Its
 * members were declared at ERP-orchestration altitude (`produtoId`, `orderId`,
 * "sync all products") while `packages/core` is storage- and secret-agnostic, so
 * the one channel built against it could not implement three of its four
 * required members. A marketplace is described by `MARKETPLACE_TIPO_CAPS`
 * (`@delfrance/schemas`), its data shapes by `@delfrance/core/marketplace`, and
 * its behaviour by one App Hosting backend per channel. `FreightProvider` was
 * removed for the identical reason in #262. See ADR 0015.
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

/**
 * ⚠️ Three kinds, not four. There is no `registerMarketplace` — a marketplace is
 * resolved per request from its `integracao` document by its own backend, never
 * looked up by plugin id, so the marketplace map had exactly one caller in the
 * repo's history: its own unit test. See the ⚠️ in the module header.
 */
export class PluginRegistry {
  private taxes = new Map<string, TaxProvider>();
  private invoices = new Map<string, InvoiceProvider>();
  private payments = new Map<string, PaymentGateway>();

  registerTax(p: TaxProvider) {
    this.taxes.set(p.id, p);
  }
  registerInvoice(p: InvoiceProvider) {
    this.invoices.set(p.id, p);
  }
  registerPayment(p: PaymentGateway) {
    this.payments.set(p.id, p);
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

  private must<T>(map: Map<string, T>, id: string, kind: string): T {
    const v = map.get(id);
    if (!v) throw new PluginNotRegisteredError(kind, id);
    return v;
  }
}
