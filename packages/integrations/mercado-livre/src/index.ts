import type { MarketplaceChannel } from '@delfrance/core/plugins';
import { buildAuthorizeUrl } from './oauth';

export * from './errors';
export * from './types';
export * from './oauth';
export * from './api';
export * from './mapping/attributes';
export * from './mapping/itemPayload';

/**
 * Mercado Livre plugin (MarketplaceChannel).
 *
 * The OAuth core (`oauth.ts`) + typed error taxonomy (`errors.ts`) + payload
 * schemas (`types.ts`) ship here. Token persistence + refresh and the ML REST
 * operations are driven by the App-Hosting backend (`apps/mercado-livre`), which
 * holds the Firestore/Admin-SDK dependency; this library stays platform-neutral
 * (fetch-only). Webhook receivers live in `apps/mercado-livre/app/api/webhooks`.
 */
export interface MercadoLivreConfig {
  clientId: string;
  clientSecretEnvVar: string;
  redirectUri: string;
}

export class MercadoLivreNotConfiguredError extends Error {
  constructor() {
    super('Mercado Livre plugin not yet implemented (Phase 5).');
    this.name = 'MercadoLivreNotConfiguredError';
  }
}

export function createMercadoLivreChannel(config: MercadoLivreConfig): MarketplaceChannel {
  return {
    id: 'mercado-livre',
    syncProducts: async () => {
      throw new MercadoLivreNotConfiguredError();
    },
    pullOrders: async () => {
      throw new MercadoLivreNotConfiguredError();
    },
    pushTracking: async () => {
      throw new MercadoLivreNotConfiguredError();
    },
    oauthFlow: {
      start(state: string): string {
        // The consent URL the /canais "Conectar" button redirects to. The token
        // exchange runs on the OAuth callback route in apps/mercado-livre.
        return buildAuthorizeUrl({
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          state,
        });
      },
      callback: async () => {
        // Persistence lives in apps/mercado-livre (needs Firestore); the callback
        // route calls `exchangeCode` + the credential store directly.
        throw new MercadoLivreNotConfiguredError();
      },
    },
  };
}
