/**
 * Public surface for third-party plugin authors.
 * Re-exports the contracts from @delfrance/core/plugins so plugin packages
 * don't import from internal paths.
 */
export type {
  TaxProvider,
  InvoiceProvider,
  PaymentGateway,
  MarketplaceChannel,
  // Marketplace channel support types (extended contract, #288)
  ChannelContext,
  SyncCursor,
  SyncPage,
  MinorUnits,
  PushResult,
  BulkPushResult,
  PriceUpdate,
  StockUpdate,
  ExportResult,
  DiscoveredCategory,
  DiscoveredAttribute,
  LabelResult,
  ImportedOrder,
  ImportedOrderItem,
  ImportedOrderBuyer,
  ImportedOrderPayment,
  ImportedAddress,
  ImportedFiscalIdentity,
  ImportedTracking,
  ImportedTrackingEvent,
  ImportedOrderCharges,
  ImportedOrderChargeLine,
  // Incident surface (returns / claims / mediations / cancellations)
  IncidentKind,
  IncidentParty,
  ImportedIncident,
  ImportedIncidentMessage,
  IncidentAction,
  IncidentActionResult,
} from '@delfrance/core/plugins';

// Re-exported as a runtime value (not just a type) so plugin authors can
// `instanceof`-narrow on it per the repo's no-generic-catch rule.
export { OrderItemCountMismatchError } from '@delfrance/core/plugins';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  /**
   * Which contract this plugin implements. A single plugin can implement more
   * than one (e.g. an NFe plugin that also exposes a TaxProvider).
   */
  kinds: ReadonlyArray<'tax' | 'invoice' | 'payment' | 'marketplace'>;
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
