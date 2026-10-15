import { pollPedidosLojaIntegradaSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `pollPedidosLojaIntegrada` per-conta state of
 * the Loja Integrada 5-minute order poller (master plan step 3, PR 3-e): the
 * naive cursor, the single-flight lease, `vistos` and the failure counter;
 * doc id = integracaoId. The poll document is always read by id, so it needs
 * no index.
 *
 * Every write is a native precondition (root rule 7, tier 1): the lease and the
 * refusal record `create`, or `update(…, { lastUpdateTime })` against the
 * snapshot they decided on; the final write is preconditioned on the lease's
 * own write time. The poller runs no Firestore transaction at all — nothing
 * for the transaction inventory to classify. (Said WITHOUT the API's
 * identifier on purpose: the inventory guard greps every source file for it.)
 *
 * ⚠️ `vistos` is a MAP, so write it with a raw `update()` field (which
 * replaces the whole map) — never through `mergeIfExists`, whose patch must be
 * flat, nor through `merge`, which would union a pruned map with the stored one.
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and has no
 * Meta), so there is no client access and no generated rules block. Mirrors
 * `notificacaoLojaIntegradaCollection`.
 */
export const pollPedidosLojaIntegradaCollection = defineAdminCollection({
  path: 'pollPedidosLojaIntegrada',
  schema: pollPedidosLojaIntegradaSchema,
});
