import { sincronizacaoEstoqueAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `sincronizacaoEstoqueAmazon` per-conta state of
 * the Amazon 5-minute stock tick (step 12): the window cursor and the depósito
 * it was taken at, the tick's single-flight lease, its failure counter and the
 * `semDeposito` aviso flag; doc id = integracaoId. Always read by id, so it
 * needs no index.
 *
 * Root rule 7, tier 1: the lease is `create`d, or taken over with
 * `update(…, { lastUpdateTime })` once expired; the final write is
 * preconditioned on the lease's own write time. `cursorMs` only moves forward
 * at one depósito; a depósito change, once durably handed off to a reconcile,
 * resets it together with `depositoDoCursor` (a cursor means nothing at another
 * depósito).
 *
 * ⚠️ Every stamp is MILLISECONDS (the unit of `estoques.ultimaModificacao`, the
 * values the cursor is compared with).
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and has no
 * Meta), so there is no client access and no generated rules block.
 */
export const sincronizacaoEstoqueAmazonCollection = defineAdminCollection({
  path: 'sincronizacaoEstoqueAmazon',
  schema: sincronizacaoEstoqueAmazonSchema,
});
