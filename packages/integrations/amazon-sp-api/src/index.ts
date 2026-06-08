import type { MarketplaceChannel } from '@delfrance/core/plugins';

/**
 * Amazon SP-API plugin scaffold (MarketplaceChannel). Concrete impl in
 * Phase 5 wraps the `amazon-sp-api` npm package; LWA token rotation +
 * region routing handled inside that wrapper.
 */
export interface AmazonSpApiConfig {
  refreshTokenEnvVar: string;
  clientId: string;
  clientSecretEnvVar: string;
  marketplaceId: string;
  region: 'na' | 'eu' | 'fe';
}

export class AmazonSpApiNotConfiguredError extends Error {
  constructor() {
    super('Amazon SP-API plugin not yet implemented (Phase 5).');
    this.name = 'AmazonSpApiNotConfiguredError';
  }
}

export function createAmazonSpApiChannel(_config: AmazonSpApiConfig): MarketplaceChannel {
  return {
    id: 'amazon-sp-api',
    syncProducts: async () => {
      throw new AmazonSpApiNotConfiguredError();
    },
    pullOrders: async () => {
      throw new AmazonSpApiNotConfiguredError();
    },
    pushTracking: async () => {
      throw new AmazonSpApiNotConfiguredError();
    },
    oauthFlow: {
      start: () => {
        throw new AmazonSpApiNotConfiguredError();
      },
      callback: async () => {
        throw new AmazonSpApiNotConfiguredError();
      },
    },
  };
}
