import { describe, it, expect } from 'vitest';
import { PluginRegistry, PluginNotRegisteredError } from './index';
import type { InvoiceProvider, PaymentGateway, TaxProvider } from './index';

const tax: TaxProvider = {
  id: 'flat-tax',
  calculate: ({ items }) => {
    const total = items.reduce((acc, i) => acc + i.amount, 0) * 0.1;
    return { breakdown: [{ name: 'flat', amount: total }], total };
  },
};

const invoice: InvoiceProvider = {
  id: 'fixture-invoice',
  issue: async () => ({ status: 'pending' }),
};

const gateway: PaymentGateway = {
  id: 'fixture-gateway',
  createCharge: async ({ orderId }) => ({ chargeId: `c-${orderId}`, status: 'created' }),
  refund: async () => {},
  webhook: async () => ({ status: 'ok' }),
};

describe('PluginRegistry', () => {
  it('registers and retrieves each of the three kinds by id', () => {
    const reg = new PluginRegistry();
    reg.registerTax(tax);
    reg.registerInvoice(invoice);
    reg.registerPayment(gateway);

    expect(reg.tax('flat-tax').id).toBe('flat-tax');
    expect(reg.invoice('fixture-invoice').id).toBe('fixture-invoice');
    expect(reg.payment('fixture-gateway').id).toBe('fixture-gateway');
  });

  it('throws PluginNotRegisteredError for an unknown id, naming the kind', () => {
    const reg = new PluginRegistry();
    expect(() => reg.payment('nope')).toThrow(PluginNotRegisteredError);
    try {
      reg.payment('nope');
    } catch (err) {
      if (!(err instanceof PluginNotRegisteredError)) throw err;
      expect(err.kind).toBe('PaymentGateway');
      expect(err.pluginId).toBe('nope');
    }
  });

  it('keeps the three kinds in separate maps', () => {
    const reg = new PluginRegistry();
    reg.registerTax(tax);
    // A tax id must not resolve as a payment.
    expect(() => reg.payment('flat-tax')).toThrow(PluginNotRegisteredError);
  });

  /**
   * ⚠️ The guard for #815. `registerMarketplace` / `marketplace(id)` were removed
   * because a marketplace is resolved per request from its `integracao` document
   * by its own App Hosting backend — it is never looked up by plugin id, and the
   * marketplace map's only caller in the repo's whole history was this file.
   * Re-adding it would re-open the door the ADR closed, so assert its absence
   * rather than trusting a comment. See ADR 0015.
   */
  it('has no marketplace kind — a channel is never looked up by plugin id', () => {
    const reg = new PluginRegistry() as unknown as Record<string, unknown>;
    expect(reg.registerMarketplace).toBeUndefined();
    expect(reg.marketplace).toBeUndefined();
  });
});
