import { describe, it, expect } from 'vitest';
import { PluginRegistry, PluginNotRegisteredError, OrderItemCountMismatchError } from './index';
import type { MarketplaceChannel, ChannelContext, IncidentAction, ImportedOrder } from './index';

const ctx: ChannelContext = { integracaoId: 'i1', accessToken: 'live-token', account: {} };

/**
 * A channel implementing ONLY the required members. That this `satisfies
 * MarketplaceChannel` is the compile-time proof (enforced by `tsc --noEmit`, the
 * typecheck gate) that every other capability is genuinely optional — exactly
 * what keeps the 6 NotConfigured scaffolds green without implementing them.
 */
const requiredOnly = {
  id: 'required-only',
  syncProducts: async (_c: ChannelContext) => {},
  pullOrders: async (_c: ChannelContext) => {},
  pushTracking: async (_c: ChannelContext, _orderId: string, _code: string) => {},
  oauthFlow: {
    start: (state: string) => `https://example.test/oauth?state=${state}`,
    callback: async (_code: string, _state: string) => {},
  },
} satisfies MarketplaceChannel;

/** A channel that opts into several optional capabilities — proves their shapes. */
const withOptionals = {
  ...requiredOnly,
  id: 'with-optionals',
  pushPrice: async (_c: ChannelContext, update: { externalId: string; price: number }) => ({
    externalId: update.externalId,
    status: 'ok' as const,
  }),
  importOrders: async (_c: ChannelContext) => ({
    items: [] as ReadonlyArray<ImportedOrder>,
    nextCursor: undefined,
  }),
  getOrderCharges: async (_c: ChannelContext, _orderId: string) => ({
    commission: 1234,
    fees: [{ type: 'service_fee', amount: 50 }],
    extraordinary: [],
    total: 1284,
  }),
  respondIncident: async (_c: ChannelContext, _id: string, _action: IncidentAction) => ({
    ok: true,
  }),
} satisfies MarketplaceChannel;

/** Compile-time exhaustiveness over the IncidentAction discriminated union,
 *  including the `custom` escape hatch — guards against a future union change. */
function describeAction(action: IncidentAction): string {
  switch (action.type) {
    case 'reply_message':
      return action.text;
    case 'attach_evidence':
      return `${action.attachments.length} files`;
    case 'accept_return':
      return 'accept';
    case 'offer_refund':
      return `refund ${action.refundAmount}`;
    case 'ship_replacement':
      return 'replace';
    case 'escalate_mediation':
      return 'escalate';
    case 'custom':
      return action.action;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

describe('MarketplaceChannel contract (#288)', () => {
  it('a required-only channel satisfies the contract and has no optional members', () => {
    const ch: MarketplaceChannel = requiredOnly;
    expect(ch.id).toBe('required-only');
    // Optional capabilities are absent → callers must feature-detect.
    expect(typeof ch.pushPrice).toBe('undefined');
    expect(typeof ch.importOrders).toBe('undefined');
    expect(typeof ch.getOrderCharges).toBe('undefined');
    expect(typeof ch.respondIncident).toBe('undefined');
  });

  it('feature-detection narrows an optional capability', async () => {
    const ch: MarketplaceChannel = withOptionals;
    expect(typeof ch.pushPrice).toBe('function');
    if (typeof ch.pushPrice === 'function') {
      const r = await ch.pushPrice(ctx, { externalId: 'MLB1', price: 9990 });
      expect(r).toEqual({ externalId: 'MLB1', status: 'ok' });
    }
  });

  it('charges break down into commission / fees / extraordinary with a total', async () => {
    const ch: MarketplaceChannel = withOptionals;
    const charges = await ch.getOrderCharges?.(ctx, 'order-1');
    expect(charges?.commission).toBe(1234);
    expect(charges?.fees[0]).toEqual({ type: 'service_fee', amount: 50 });
    expect(charges?.total).toBe(1284);
  });

  it('describes every IncidentAction variant including custom', () => {
    expect(describeAction({ type: 'reply_message', text: 'hi' })).toBe('hi');
    expect(describeAction({ type: 'offer_refund', refundAmount: 500, partial: true })).toBe(
      'refund 500',
    );
    expect(describeAction({ type: 'custom', action: 'shopee:confirm' })).toBe('shopee:confirm');
  });
});

describe('OrderItemCountMismatchError', () => {
  it('carries the order id and the expected/received counts', () => {
    const err = new OrderItemCountMismatchError('ML-42', 3, 2);
    expect(err).toBeInstanceOf(OrderItemCountMismatchError);
    expect(err).toBeInstanceOf(Error); // narrowable, but a dedicated class for no-generic-catch
    expect(err.name).toBe('OrderItemCountMismatchError');
    expect(err.externalOrderId).toBe('ML-42');
    expect(err.expected).toBe(3);
    expect(err.received).toBe(2);
    expect(err.message).toContain('returned 2 items but reported 3');
  });
});

describe('PluginRegistry', () => {
  it('registers and retrieves a marketplace channel by id', () => {
    const reg = new PluginRegistry();
    reg.registerMarketplace(requiredOnly);
    expect(reg.marketplace('required-only').id).toBe('required-only');
  });

  it('throws PluginNotRegisteredError for an unknown id', () => {
    const reg = new PluginRegistry();
    expect(() => reg.marketplace('nope')).toThrow(PluginNotRegisteredError);
  });
});
