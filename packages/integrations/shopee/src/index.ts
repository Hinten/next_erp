import type { MarketplaceChannel } from '@delfrance/core/plugins';

/**
 * Shopee plugin scaffold (MarketplaceChannel). Concrete impl lands in
 * Phase 5 atop the Open Platform v2 REST API. The Flutter side keeps
 * authoring orders during the migration; this package consumes the
 * mirrored Firestore docs and adds Next-side OAuth + sync.
 */
export interface ShopeeConfig {
  partnerId: string;
  partnerKeyEnvVar: string;
  redirectUri: string;
}

export class ShopeeNotConfiguredError extends Error {
  constructor() {
    super('Shopee plugin not yet implemented (Phase 5).');
    this.name = 'ShopeeNotConfiguredError';
  }
}

export function createShopeeChannel(_config: ShopeeConfig): MarketplaceChannel {
  return {
    id: 'shopee',
    syncProducts: async () => {
      throw new ShopeeNotConfiguredError();
    },
    pullOrders: async () => {
      throw new ShopeeNotConfiguredError();
    },
    pushTracking: async () => {
      throw new ShopeeNotConfiguredError();
    },
    oauthFlow: {
      start: () => {
        throw new ShopeeNotConfiguredError();
      },
      callback: async () => {
        throw new ShopeeNotConfiguredError();
      },
    },
  };
}
