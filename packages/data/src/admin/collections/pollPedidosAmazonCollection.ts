import { pollPedidosAmazonSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `pollPedidosAmazon` per-conta state of the
 * Amazon 15-minute backstop poll (master plan step 4, PR 4-a): the ms cursor,
 * the resumable drain (`pendente`), `vistos`, the single-flight lease and the
 * failure counter; doc id = integracaoId. The poll document is always read by
 * id, so it needs no index.
 *
 * Every write is a native precondition (root rule 7, tier 1): the lease and the
 * refusal record `create`, or `update(…, { lastUpdateTime })` against the
 * snapshot they decided on; the final write is preconditioned on the lease's
 * own write time and, when it loses, re-derived from ONE re-read. The poll runs
 * no multi-document atomic write at all — nothing for the transaction inventory
 * to classify. (Said WITHOUT the API's identifier on purpose: the inventory
 * guard greps every source file for it.)
 *
 * ⚠️ `vistos` and `pendente` are MAPS, so write them with a raw `update()` field
 * (which replaces the whole map) — never through `mergeIfExists`, whose patch
 * must be flat, nor through `merge`, which would union a pruned map with the
 * stored one.
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and has no
 * Meta), so there is no client access and no generated rules block. Mirrors
 * `pollPedidosLojaIntegradaCollection`.
 */
export const pollPedidosAmazonCollection = defineAdminCollection({
  path: 'pollPedidosAmazon',
  schema: pollPedidosAmazonSchema,
});
