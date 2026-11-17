import { pedidoReconciliacaoEstoqueAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `pedidoReconciliacaoEstoqueAmazon` request doc
 * of the Amazon stock reconcile (step 12); doc id = integracaoId. `pendente`
 * and the once-a-day guard of the automatic request live HERE, apart from the
 * run's own document, so a request never invalidates a page's precondition on
 * the run. Set by a request, cleared by the claim that starts a run, read by
 * the run's close. Always read by id, so it needs no index.
 *
 * Root rule 7, tier 1: every write is a `create` or an
 * `update(…, { lastUpdateTime })` on the snapshot it was decided from.
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and has no
 * Meta), so there is no client access and no generated rules block.
 */
export const pedidoReconciliacaoEstoqueAmazonCollection = defineAdminCollection({
  path: 'pedidoReconciliacaoEstoqueAmazon',
  schema: pedidoReconciliacaoEstoqueAmazonSchema,
});
