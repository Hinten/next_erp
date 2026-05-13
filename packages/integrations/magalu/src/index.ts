import type { MarketplaceChannel } from '@delfrance/core/plugins';

/**
 * Magalu Open API plugin scaffold (MarketplaceChannel). Phase 5 wraps
 * the Magalu Open API REST endpoints and reuses
 * `apps/integrations/lib/signatures` for webhook auth.
 */
export interface MagaluConfig {
  clientId: string;
  clientSecretEnvVar: string;
  redirectUri: string;
}

export class MagaluNotConfiguredError extends Error {
  constructor() {
    super('Magalu plugin not yet implemented (Phase 5).');
    this.name = 'MagaluNotConfiguredError';
  }
}

export function createMagaluChannel(_config: MagaluConfig): MarketplaceChannel {
  return {
    id: 'magalu',
    syncProducts: async () => { throw new MagaluNotConfiguredError(); },
    pullOrders: async () => { throw new MagaluNotConfiguredError(); },
    pushTracking: async () => { throw new MagaluNotConfiguredError(); },
    oauthFlow: {
      start: () => { throw new MagaluNotConfiguredError(); },
      callback: async () => { throw new MagaluNotConfiguredError(); },
    },
  };
}
