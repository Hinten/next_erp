import { oauthStateMeta, oauthStateSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `integracao/{integracaoId}/oauthState` — the per-attempt
 * OAuth connect record (#821): the `nonce` that makes a signed `state`
 * single-use, plus the PKCE `code_verifier`. Server-side only; the browser never
 * touches it (admin-only / default-denied, like `credenciais`).
 */
export const oauthStateCollection = defineAdminCollection({
  path: oauthStateMeta.collectionPath,
  schema: oauthStateSchema,
});
