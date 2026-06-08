import type { MarketplaceChannel } from '@delfrance/core/plugins';

/**
 * Loja Integrada plugin scaffold (MarketplaceChannel). Phase 5 wraps
 * the Loja Integrada REST API.
 */
export interface LojaIntegradaConfig {
  apiKeyEnvVar: string;
  appKeyEnvVar?: string;
}

export class LojaIntegradaNotConfiguredError extends Error {
  constructor() {
    super('Loja Integrada plugin not yet implemented (Phase 5).');
    this.name = 'LojaIntegradaNotConfiguredError';
  }
}

export function createLojaIntegradaChannel(_config: LojaIntegradaConfig): MarketplaceChannel {
  return {
    id: 'loja-integrada',
    syncProducts: async () => {
      throw new LojaIntegradaNotConfiguredError();
    },
    pullOrders: async () => {
      throw new LojaIntegradaNotConfiguredError();
    },
    pushTracking: async () => {
      throw new LojaIntegradaNotConfiguredError();
    },
    oauthFlow: {
      start: () => {
        throw new LojaIntegradaNotConfiguredError();
      },
      callback: async () => {
        throw new LojaIntegradaNotConfiguredError();
      },
    },
  };
}
