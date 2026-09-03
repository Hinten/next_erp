/**
 * Plugin contracts for the two domains that are still registry-shaped: tax and
 * invoice. Concrete implementations live in `packages/integrations/<channel>`.
 *
 * ⚠️ **These are the contract for THIRD-PARTY plugins. Nothing in-tree registers
 * anything at boot** — the only `PluginRegistry` instance left in the repo is the
 * one `apps/example` builds to demo a `TaxProvider`. In-tree integrations resolve
 * their account **per request** from a Firestore document (`integracao` /
 * `int_frete` / `metodo_pgto`), which is what makes one App Hosting backend per
 * channel possible.
 *
 * ⚠️ **Two contracts have been REMOVED from this file, and neither may come back.**
 * Both were declared at ERP-orchestration altitude while `packages/core` is
 * storage- and secret-agnostic, so the one implementation built against each
 * could not implement it here:
 *
 *  - **`MarketplaceChannel`** (#815, ADR 0015) — 3 of its 4 required members were
 *    `throw`. Replaced by `MARKETPLACE_TIPO_CAPS` (`@delfrance/schemas`) +
 *    `@delfrance/core/marketplace` + one backend per channel.
 *  - **`PaymentGateway`** (#1429) — all 3 members were `throw`, `registerPayment`
 *    had one caller (its own test), and the one live consumer was a permanently
 *    disabled button. Its `webhook` had *already shipped* outside the contract, on
 *    `defineNotificationPipeline`; its `createCharge` mis-described the real
 *    operation (a Checkout Pro **preference** returning a link and an expiry, not a
 *    charge id and a status); its `refund` had no precedent anywhere, in this repo
 *    or the legacy one. Payments are handled by `apps/mercado-pago`.
 *
 * `FreightProvider` went the same way in #262. Read ADR 0015 before proposing any
 * new contract here.
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
 * ⚠️ Two kinds, not four. There is no `registerMarketplace` (#815) and no
 * `registerPayment` (#1429) — a channel and a payment account are both resolved
 * per request from their own Firestore document by their own backend, never
 * looked up by plugin id. Between them those two maps had, across the repo's
 * entire history, exactly two callers: their own unit tests.
 */
export class PluginRegistry {
  private taxes = new Map<string, TaxProvider>();
  private invoices = new Map<string, InvoiceProvider>();

  registerTax(p: TaxProvider) {
    this.taxes.set(p.id, p);
  }
  registerInvoice(p: InvoiceProvider) {
    this.invoices.set(p.id, p);
  }

  tax(id: string) {
    return this.must(this.taxes, id, 'TaxProvider');
  }
  invoice(id: string) {
    return this.must(this.invoices, id, 'InvoiceProvider');
  }

  private must<T>(map: Map<string, T>, id: string, kind: string): T {
    const v = map.get(id);
    if (!v) throw new PluginNotRegisteredError(kind, id);
    return v;
  }
}
