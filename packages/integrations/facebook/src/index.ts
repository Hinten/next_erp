import type { MarketplaceChannel } from '@delfrance/core/plugins';

/**
 * Facebook (Marketplace + Messenger) plugin scaffold. Phase 5 wraps
 * the Graph API + Messenger Platform; webhook receivers in
 * `apps/integrations/app/api/webhooks/facebook/route.ts` reuse the
 * x-hub-signature verification helper.
 */
export interface FacebookConfig {
  appId: string;
  appSecretEnvVar: string;
  pageAccessTokenEnvVar: string;
  redirectUri: string;
}

export class FacebookNotConfiguredError extends Error {
  constructor() {
    super('Facebook plugin not yet implemented (Phase 5).');
    this.name = 'FacebookNotConfiguredError';
  }
}

export function createFacebookChannel(
  _config: FacebookConfig,
): MarketplaceChannel {
  return {
    id: 'facebook',
    syncProducts: async () => { throw new FacebookNotConfiguredError(); },
    pullOrders: async () => { throw new FacebookNotConfiguredError(); },
    pushTracking: async () => { throw new FacebookNotConfiguredError(); },
    oauthFlow: {
      start: () => { throw new FacebookNotConfiguredError(); },
      callback: async () => { throw new FacebookNotConfiguredError(); },
    },
  };
}
