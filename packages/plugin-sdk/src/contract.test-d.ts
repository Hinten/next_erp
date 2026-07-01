/**
 * Compile-time fixture (no runtime; plugin-sdk has no test runner). Enforced by
 * this package's `tsc --noEmit` gate. Proves the #288 marketplace contract types
 * and the `OrderItemCountMismatchError` VALUE re-export are reachable from the
 * public plugin-sdk surface — guarding against a regression that drops one or
 * turns the error's `export {` into `export type {`.
 */
import { OrderItemCountMismatchError, defineIntegration } from './index';
import type {
  MarketplaceChannel,
  ChannelContext,
  ImportedOrder,
  ImportedOrderCharges,
  ImportedFiscalIdentity,
  ImportedAddress,
  ImportedTracking,
  IncidentAction,
  ImportedIncident,
  PriceUpdate,
  SyncPage,
} from './index';

// Types are usable from the public surface.
const ctx: ChannelContext = { integracaoId: 'i', accessToken: 't', account: {} };
const charges = (o: ImportedOrder): ImportedOrderCharges | undefined => o.charges;
const fiscal = (o: ImportedOrder): ImportedFiscalIdentity | undefined => o.buyerFiscal;
const ship = (o: ImportedOrder): ImportedAddress | undefined => o.shippingAddress;
const track = (o: ImportedOrder): ImportedTracking | undefined => o.tracking;
const incidentId = (i: ImportedIncident): string => i.externalId;
const actionType = (a: IncidentAction): string => a.type;
const firstOrder = (p: SyncPage<ImportedOrder>): ImportedOrder | undefined => p.items[0];
const priced: PriceUpdate = { externalId: 'x', price: 100 };

// A required-only channel satisfies the re-exported contract type.
const channel = {
  id: 'fixture',
  syncProducts: async (_c: ChannelContext) => {},
  pullOrders: async (_c: ChannelContext) => {},
  pushTracking: async (_c: ChannelContext, _o: string, _t: string) => {},
  oauthFlow: { start: (s: string) => s, callback: async (_c: string, _s: string) => {} },
} satisfies MarketplaceChannel;

// The error is a runtime value (constructable + instanceof), not only a type.
const err = new OrderItemCountMismatchError('o', 2, 1);
const isError: boolean = err instanceof Error;

// defineIntegration still type-checks with the 'marketplace' kind.
const integration = defineIntegration({
  manifest: { id: 'fixture', name: 'Fixture', version: '0.0.0', kinds: ['marketplace'] },
  register: () => {},
});

// Reference the bindings so the fixture reads as exercised (noUnusedLocals is off,
// but this documents intent).
void [
  ctx,
  charges,
  fiscal,
  ship,
  track,
  incidentId,
  actionType,
  firstOrder,
  priced,
  channel,
  isError,
  integration,
];
