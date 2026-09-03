/**
 * Public surface for third-party plugin authors.
 * Re-exports the contracts from @delfrance/core/plugins so plugin packages
 * don't import from internal paths.
 *
 * ⚠️ **There is no `marketplace` kind (#815) and no `payment` kind (#1429), and
 * neither may come back.** Sales channels and payment accounts are not plugins in
 * this repo: each is one App Hosting backend (`apps/<channel>`) resolved per
 * request from its own Firestore document, never registered or looked up by plugin
 * id. What used to be re-exported here — a 25-member `MarketplaceChannel` with ~25
 * support types, and a 3-member `PaymentGateway` — had zero importers outside this
 * barrel and the test fixtures, while every implementation built against them was
 * `throw`.
 *
 * Building a marketplace integration: `MARKETPLACE_TIPO_CAPS`
 * (`@delfrance/schemas`), the model in `@delfrance/core/marketplace`, ADR 0015, and
 * the `marketplace-integration` skill. Building a payment integration: mirror
 * `apps/mercado-pago` — the procedure is on `tipoIntegracaoPgtoSchema` in
 * `@delfrance/schemas`.
 */
export type { TaxProvider, InvoiceProvider } from '@delfrance/core/plugins';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /**
   * Which contract this plugin implements. A single plugin can implement more
   * than one (e.g. an NFe plugin that also exposes a TaxProvider).
   */
  kinds: ReadonlyArray<'tax' | 'invoice'>;
}

export interface DefinedIntegration {
  manifest: PluginManifest;
  register(input: { register: (impl: unknown) => void }): void;
}

export function defineIntegration(input: {
  manifest: PluginManifest;
  register: DefinedIntegration['register'];
}): DefinedIntegration {
  return input;
}
