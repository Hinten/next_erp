/**
 * Public surface for third-party plugin authors.
 * Re-exports the contracts from @delfrance/core/plugins so plugin packages
 * don't import from internal paths.
 *
 * ⚠️ **There is no `marketplace` kind, and adding one back is a mistake** (#815).
 * A sales channel is not a plugin in this repo: it is one App Hosting backend
 * (`apps/<channel>`) resolved per request from its `integracao` document, never
 * registered or looked up by plugin id. What used to be re-exported here — a
 * 25-member `MarketplaceChannel` plus ~25 support types — had zero importers
 * outside this barrel and two test files, while the one real channel implemented
 * three of its four required members as `throw`.
 *
 * Building a marketplace integration: read `MARKETPLACE_TIPO_CAPS`
 * (`@delfrance/schemas`), the model in `@delfrance/core/marketplace`, ADR 0015,
 * and the `marketplace-integration` skill.
 */
export type { TaxProvider, InvoiceProvider, PaymentGateway } from '@delfrance/core/plugins';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /**
   * Which contract this plugin implements. A single plugin can implement more
   * than one (e.g. an NFe plugin that also exposes a TaxProvider).
   */
  kinds: ReadonlyArray<'tax' | 'invoice' | 'payment'>;
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
