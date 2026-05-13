import { defineIntegration } from '@delfrance/plugin-sdk';
import type { TaxProvider } from '@delfrance/core/plugins';

/**
 * Toy `TaxProvider` plugin demonstrating the public surface a third
 * party uses to author an integration: defineIntegration(...) with a
 * manifest + register callback. The host app calls `register({
 * register })` at boot; the plugin pushes its impl into whichever
 * registry slot matches its declared `kinds`.
 */

const flatRateTax: TaxProvider = {
  id: 'demo-flat-tax',
  calculate({ items }) {
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    const tax = Math.round(total * 0.1); // demo: flat 10%
    return {
      total,
      breakdown: [{ name: 'Demo flat tax (10%)', amount: tax }],
    };
  },
};

export default defineIntegration({
  manifest: {
    id: 'demo-flat-tax',
    name: 'Demo Flat Tax',
    version: '0.0.0',
    kinds: ['tax'],
  },
  register({ register }) {
    register(flatRateTax);
  },
});
