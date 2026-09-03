import { describe, it, expect } from 'vitest';
import { PluginRegistry, PluginNotRegisteredError } from './index';
import type { InvoiceProvider, TaxProvider } from './index';

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

describe('PluginRegistry', () => {
  it('registers and retrieves each of the two kinds by id', () => {
    const reg = new PluginRegistry();
    reg.registerTax(tax);
    reg.registerInvoice(invoice);

    expect(reg.tax('flat-tax').id).toBe('flat-tax');
    expect(reg.invoice('fixture-invoice').id).toBe('fixture-invoice');
  });

  it('throws PluginNotRegisteredError for an unknown id, naming the kind', () => {
    const reg = new PluginRegistry();
    expect(() => reg.invoice('nope')).toThrow(PluginNotRegisteredError);
    try {
      reg.invoice('nope');
    } catch (err) {
      if (!(err instanceof PluginNotRegisteredError)) throw err;
      expect(err.kind).toBe('InvoiceProvider');
      expect(err.pluginId).toBe('nope');
    }
  });

  it('keeps the two kinds in separate maps', () => {
    const reg = new PluginRegistry();
    reg.registerTax(tax);
    // A tax id must not resolve as an invoice.
    expect(() => reg.invoice('flat-tax')).toThrow(PluginNotRegisteredError);
  });

  /**
   * ⚠️ The guards for #815 and #1429. Both kinds were removed because the thing
   * they claimed to look up is resolved per request from a Firestore document by
   * its own backend — never by plugin id. Between them, the two maps had exactly
   * two callers in the repo's entire history: their own unit tests.
   *
   * Assert their ABSENCE rather than trusting a comment: re-adding either
   * typechecks, lints, builds and passes every other suite. See ADR 0015.
   */
  it('has no marketplace kind — a channel is never looked up by plugin id', () => {
    const reg = new PluginRegistry() as unknown as Record<string, unknown>;
    expect(reg.registerMarketplace).toBeUndefined();
    expect(reg.marketplace).toBeUndefined();
  });

  it('has no payment kind — a payment account is never looked up by plugin id', () => {
    const reg = new PluginRegistry() as unknown as Record<string, unknown>;
    expect(reg.registerPayment).toBeUndefined();
    expect(reg.payment).toBeUndefined();
  });
});
