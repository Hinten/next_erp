import type { MarketplaceChannel } from '@delfrance/core/plugins';

/**
 * Mercado Livre plugin scaffold (MarketplaceChannel).
 *
 * OAuth + REST client lands in Phase 5. Webhook receivers live in
 * `apps/integrations/app/api/webhooks/mercado-livre/route.ts` and
 * dispatch heavy work (catalog sync, order pull) to Cloud Functions.
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

export function createMercadoLivreChannel(
  config: MercadoLivreConfig,
): MarketplaceChannel {
  return {
    id: 'mercado-livre',
    syncProducts: async () => { throw new MercadoLivreNotConfiguredError(); },
    pullOrders: async () => { throw new MercadoLivreNotConfiguredError(); },
    pushTracking: async () => { throw new MercadoLivreNotConfiguredError(); },
    oauthFlow: {
      start(state: string): string {
        // Exposed today so the UI in /canais can render the "Conectar"
        // button against a deterministic redirect target. The actual
        // token exchange happens in apps/integrations on callback.
        const u = new URL('https://auth.mercadolivre.com.br/authorization');
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', config.clientId);
        u.searchParams.set('redirect_uri', config.redirectUri);
        u.searchParams.set('state', state);
        return u.toString();
      },
      callback: async () => {
        throw new MercadoLivreNotConfiguredError();
      },
    },
  };
}
