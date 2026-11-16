import { vezFeedAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `feedsAmazonEmCurso` lease of the Amazon feed
 * core (step 12a, PR 12-b): ONE document per (fluxo, conta), doc id
 * `idVezFeedAmazon(fluxo, contaId)` = `<fluxo>-<contaId>`, so at most one feed
 * of a fluxo is in flight per conta.
 *
 * Root rule 7, tier 1 only: `create`, or `update(…, { lastUpdateTime })` on the
 * snapshot the pure lease decision read; a lost precondition re-reads and
 * re-decides. Every release first checks that the releaser still holds the
 * lease (its run, or its feed once submitted). The lease runs no multi-document
 * atomic write. (Said WITHOUT the API's identifier on purpose: the inventory
 * guard greps every source file for it.)
 *
 * ⚠️ Every stamp is MILLISECONDS. The lease is NEVER TTL-stamped: its schema
 * has no `expiraEm`, and `feedsAmazonEmCurso` has no TTL policy. Always read by
 * id, so it needs no index.
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and has no
 * Meta), so there is no client access and no generated rules block.
 */
export const vezFeedAmazonCollection = defineAdminCollection({
  path: 'feedsAmazonEmCurso',
  schema: vezFeedAmazonSchema,
});
