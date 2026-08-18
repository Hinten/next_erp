import type { MarketplaceChannel } from '@delfrance/core/plugins';
import { createMercadoLivreApi } from './api';
import { getIncidentMl, importIncidentsMl } from './incidents';
import { buildAuthorizeUrl } from './oauth';

export * from './errors';
export * from './types';
export * from './shipmentFields';
export * from './oauth';
export * from './api';
export * from './incidents';
export * from './mapping/attributes';
export * from './mapping/itemPayload';
export * from './mapping/importItem';
export * from './mapping/importVariations';
export * from './mapping/importUserProduct';
export * from './mapping/pictures';
export * from './zplDanfeFilter';
// AI attribute suggestion — pure logic only. No AI SDK is imported anywhere in
// this package: the schema is a plain JSON Schema and the prompt a plain
// object, so whichever runtime A2 settles on consumes them unchanged.
export * from './ai/attributeSchema';
export * from './ai/attributePrompt';
export * from './ai/attributeApply';
export * from './ai/medidasSchema';
export * from './ai/medidasReference';
export * from './ai/medidasPrompt';
export * from './ai/medidasApply';

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
  /** Test seam for the channel's REST calls — defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Thrown by the contract members this channel object deliberately does not
 * implement — `syncProducts`, `pullOrders`, `pushTracking` and
 * `oauthFlow.callback`. The Mercado Livre integration itself is complete; it
 * simply does not run through those four, because each needs Firestore and so
 * lives in the `apps/mercado-livre` backend instead. Reaching one means a
 * caller routed through the plugin contract where it should have called the
 * backend.
 *
 * ⚠️ Operator-visible: `apps/mercado-livre/lib/marketplace/respond.ts` maps this
 * message into a 501 body (`code: 'ML_NOT_IMPLEMENTED'`). Keep it diagnostic.
 * Folding these four into the contract is part of #815.
 */
export class MercadoLivreNotConfiguredError extends Error {
  constructor() {
    super(
      'Mercado Livre: este membro do contrato de plugin não é implementado — ' +
        'a integração roda no backend apps/mercado-livre.',
    );
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
    // Incident READ surface (claims import, Step 14). `respondIncident` stays
    // absent on purpose — Step 14 is import-only; callers feature-detect.
    importIncidents: (ctx, cursor) =>
      importIncidentsMl(
        createMercadoLivreApi({ getAccessToken: async () => ctx.accessToken, fetch: config.fetch }),
        cursor,
      ),
    getIncident: (ctx, externalIncidentId) =>
      getIncidentMl(
        createMercadoLivreApi({ getAccessToken: async () => ctx.accessToken, fetch: config.fetch }),
        externalIncidentId,
      ),
    oauthFlow: {
      start(
        state: string,
        pkce?: { codeChallenge: string; codeChallengeMethod?: 'S256' | 'plain' },
      ): string {
        // The consent URL the /canais "Conectar" button redirects to. The token
        // exchange runs on the OAuth callback route in apps/mercado-livre, which
        // is also where the matching `code_verifier` is held — deciding whether
        // PKCE is in play belongs there, next to the flag and the store, not here.
        return buildAuthorizeUrl({
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          state,
          codeChallenge: pkce?.codeChallenge,
          codeChallengeMethod: pkce?.codeChallengeMethod,
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
