/**
 * Compile-time fixture (no runtime; plugin-sdk has no test runner). Enforced by
 * this package's `tsc --noEmit` gate. Proves the three plugin contracts stay
 * reachable from the public surface, and that `defineIntegration` accepts each
 * of the three manifest kinds.
 *
 * ⚠️ It used to prove the same for a 25-member `MarketplaceChannel` and ~25
 * marketplace support types. Those are gone (#815) — a channel is a backend, not
 * a plugin. The one assertion worth keeping from that era is the NEGATIVE one at
 * the bottom: `'marketplace'` must not be assignable to `PluginManifest.kinds`,
 * or the SDK starts advertising a plugin kind nothing can register.
 */
import { defineIntegration } from './index';
import type { InvoiceProvider, PaymentGateway, PluginManifest, TaxProvider } from './index';

// The three contracts are usable from the public surface.
const tax: TaxProvider = {
  id: 'fixture-tax',
  calculate: ({ items }) => ({
    breakdown: items.map((i) => ({ name: 'flat', amount: i.amount })),
    total: items.reduce((a, i) => a + i.amount, 0),
  }),
};

const invoice: InvoiceProvider = {
  id: 'fixture-invoice',
  issue: async () => ({ status: 'pending' }),
};

const gateway: PaymentGateway = {
  id: 'fixture-gateway',
  createCharge: async ({ orderId }) => ({ chargeId: orderId, status: 'created' }),
  refund: async () => {},
  webhook: async () => ({ status: 'ok' }),
};

// defineIntegration type-checks with every valid kind, including a multi-kind plugin.
const integration = defineIntegration({
  manifest: { id: 'fixture', name: 'Fixture', version: '0.0.0', kinds: ['tax', 'invoice'] },
  register: () => {},
});

const payment = defineIntegration({
  manifest: { id: 'pay', name: 'Pay', version: '0.0.0', kinds: ['payment'] },
  register: () => {},
});

// ⚠️ The negative assertion. `'marketplace'` is NOT a plugin kind — a channel is
// an App Hosting backend resolved from its `integracao` doc, never registered.
// `@ts-expect-error` FAILS THE BUILD if the union ever regains the member, which
// is the only way this file can notice the contract creeping back.
// @ts-expect-error 'marketplace' is not a PluginManifest kind (#815, ADR 0015)
const kinds: PluginManifest['kinds'] = ['marketplace'];

void [tax, invoice, gateway, integration, payment, kinds];
