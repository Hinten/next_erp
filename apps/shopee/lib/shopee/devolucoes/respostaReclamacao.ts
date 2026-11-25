/**
 * What BOTH `reclamacao` routes answer for a Shopee refusal (#1525, step 17,
 * review R3-2): the two codes they share. One
 * home, so neither route imports the other and the panel's `incerto` rule
 * (`falhaDaAcaoShopee` in `apps/web`) keys on ONE spelling.
 */

/** The 404 — Shopee does not know the return. */
export const CODIGO_INEXISTENTE = 'SHOPEE_RECLAMACAO_INEXISTENTE';

/**
 * The 502 of a Shopee refusal neither route maps. ⚠️ A DEFINITE Shopee
 * answer, never an unknown outcome: the panel (`falhaDaAcaoShopee` in
 * `apps/web`) keys on this code.
 */
export const CODIGO_FALHA_SHOPEE = 'SHOPEE_RECLAMACAO_FALHA_SHOPEE';
