import { execucaoPrecoAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `precosAmazon` run of the Amazon price push
 * (step 13): ONE document per conta, doc id = integracaoId, holding the current
 * (or last) operator-started price run — its phase, the walk's cursors and
 * counters, its dense parts' sizes, Decide's choice and the batches it named
 * with their recorded ends, and the first page's `readTime` that clocks the
 * run's avisos. Its parts live under it ({@link divergenciaPrecoAmazonCollection}).
 *
 * Root rule 7, tier 1: a run is claimed with `create`, or with
 * `update(…, { lastUpdateTime })` on the snapshot the claim decided on; a page
 * re-derives whether it holds the run (`execucaoId`, `proximaPagina`, `fase`)
 * from a fresh read, and only that page advances it. Always read by id, so it
 * needs no index.
 *
 * Declared ahead of its writers: nothing writes here yet.
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and has no
 * Meta), so there is no client access and no generated rules block.
 */
export const precoAmazonCollection = defineAdminCollection({
  path: 'precosAmazon',
  schema: execucaoPrecoAmazonSchema,
});
