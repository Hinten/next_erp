import { reconciliacaoEstoqueAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `reconciliacaoEstoqueAmazon` run of the Amazon
 * daily stock reconcile (step 12): ONE document per conta, doc id =
 * integracaoId, holding the current (or last) run — its phase, the depósito its
 * walk read, the walk's cursors and counters, and the first read's `readTime`
 * that clocks the run's avisos. Its drift blocks live under it
 * ({@link divergenciaEstoqueAmazonCollection}).
 *
 * Root rule 7, tier 1: a run is claimed with `create`, or with
 * `update(…, { lastUpdateTime })` on the snapshot the claim decided on; a page
 * re-derives whether it holds the run (`execucaoId`, `proximaPagina`) from a
 * fresh read, and only that page advances `progressoEmMs`. A request for a run never
 * writes here (`pedidoReconciliacaoEstoqueAmazonCollection`), so it cannot
 * break a page's precondition. Always read by id, so it needs no index.
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and has no
 * Meta), so there is no client access and no generated rules block.
 */
export const reconciliacaoEstoqueAmazonCollection = defineAdminCollection({
  path: 'reconciliacaoEstoqueAmazon',
  schema: reconciliacaoEstoqueAmazonSchema,
});
