/**
 * Compile-time fixture (no runtime; plugin-sdk has no test runner). Enforced by
 * this package's `tsc --noEmit` gate. Proves the two plugin contracts stay
 * reachable from the public surface, and that `defineIntegration` accepts both
 * manifest kinds.
 *
 * ⚠️ It once proved the same for a 25-member `MarketplaceChannel` (#815) and a
 * 3-member `PaymentGateway` (#1429). Both are gone — a channel and a payment
 * account are backends, not plugins. The assertions worth keeping from that era
 * are the NEGATIVE ones at the bottom: neither kind may become assignable again,
 * or the SDK starts advertising a plugin kind nothing can register.
 */
import { defineIntegration } from './index';
import type { InvoiceProvider, PluginManifest, TaxProvider } from './index';

// The two contracts are usable from the public surface.
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

// defineIntegration type-checks with each kind, and with a multi-kind plugin.
const integration = defineIntegration({
  manifest: { id: 'fixture', name: 'Fixture', version: '0.0.0', kinds: ['tax', 'invoice'] },
  register: () => {},
});

const invoiceOnly = defineIntegration({
  manifest: { id: 'nfe', name: 'NFe', version: '0.0.0', kinds: ['invoice'] },
  register: () => {},
});

// ⚠️ The negative assertions. Neither `'marketplace'` nor `'payment'` is a plugin
// kind — both are App Hosting backends resolved from a Firestore doc, never
// registered. `@ts-expect-error` FAILS THE BUILD if the union regains the member,
// which is the only way this file notices a contract creeping back.
// @ts-expect-error 'marketplace' is not a PluginManifest kind (#815, ADR 0015)
const marketplaceKind: PluginManifest['kinds'] = ['marketplace'];
// @ts-expect-error 'payment' is not a PluginManifest kind (#1429)
const paymentKind: PluginManifest['kinds'] = ['payment'];

void [tax, invoice, integration, invoiceOnly, marketplaceKind, paymentKind];
