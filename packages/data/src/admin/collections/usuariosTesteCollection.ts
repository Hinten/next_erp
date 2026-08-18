import { usuarioTesteMercadoLivreMeta, usuarioTesteMercadoLivreSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `integracao/{integracaoId}/usuariosTeste` — the Mercado
 * Livre test-user store. Admin-only / default-deny (see
 * `usuarioTesteMercadoLivreMeta`); the browser reaches these only through the
 * `usuarios-teste` route on `apps/mercado-livre`, never Firestore directly.
 * Mirrors `credenciaisWhatsappCollection`.
 *
 * ⚠️ Doc ids are the ROLE (`vendedor` / `comprador`), not auto-ids: ML caps an
 * account at ten test users and never shows a credential twice, so a re-run of
 * the mint flow must be able to see what already exists instead of burning
 * another slot.
 */
export const usuariosTesteCollection = defineAdminCollection({
  path: usuarioTesteMercadoLivreMeta.collectionPath,
  schema: usuarioTesteMercadoLivreSchema,
});
