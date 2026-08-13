import {
  oauthStateIntegracaoMeta,
  oauthStateIntFreteMeta,
  oauthStateMetodoPgtoMeta,
  oauthStateSchema,
} from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handles for the per-attempt OAuth connect record (#821, #1034) — the
 * `nonce` that makes a signed `state` single-use, plus the PKCE `code_verifier`.
 * One handle per channel, all over the same schema. Server-side only; the browser
 * never touches them (admin-only / default-denied, like `credenciais`).
 *
 * ℹ️ `defineAdminCollection` derives the collection-GROUP id from the last path
 * segment, so all three share `collectionGroup('oauthState')`. That is deliberate
 * and harmless — nothing queries these as a group, and nothing should: a
 * cross-channel sweep over live code verifiers has no legitimate caller.
 */
export const oauthStateCollection = defineAdminCollection({
  path: oauthStateIntegracaoMeta.collectionPath,
  schema: oauthStateSchema,
});

export const oauthStateIntFreteCollection = defineAdminCollection({
  path: oauthStateIntFreteMeta.collectionPath,
  schema: oauthStateSchema,
});

export const oauthStateMetodoPgtoCollection = defineAdminCollection({
  path: oauthStateMetodoPgtoMeta.collectionPath,
  schema: oauthStateSchema,
});
