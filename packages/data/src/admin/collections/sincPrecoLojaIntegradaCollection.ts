import {
  COLECAO_SINC_PRECO_LI,
  SUBCOLECOES_SINC_PRECO_LI,
  paisErpSnapshotPrecoLiSchema,
  sincPrecoLojaIntegradaSchema,
  snapshotPrecoLiSchema,
} from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handles of the Loja Integrada price sync (master plan step 13, PR 13-a): the per-conta
 * root `sincPrecoLojaIntegrada/{integracaoId}` (the price list's cursor, the last run, one run's
 * own state and the non-convergence memory) and its `snapshot` subcollection — the 32 buckets and
 * the parents unit's `paisErp` document. The sibling of `sincEstoqueLojaIntegradaCollection.ts`.
 *
 * The price slot `reconcileEstoqueLojaIntegrada/slot-preco` has NO handle of its own: it is a
 * second document of the run document's collection, with the run document's schema, so it is
 * reached through `reconcileEstoqueLojaIntegradaCollection` at `ID_SLOT_PRECO_RECONCILE_LI`.
 *
 * ⚠️ Every stamp is MILLISECONDS (`…Ms`); every price is integer centavos.
 *
 * Every read is by id or a where-less listing of one conta's own subcollection, so no index is
 * declared for any of them. Every write is a native precondition (`create`, or
 * `update(handle.parseMerge(patch), { lastUpdateTime })` on the writer's own read, advance-only),
 * written only by the reconcile slice holding the lease — no transaction here, nothing for the
 * transaction inventory to classify. (Said WITHOUT the API's identifier on purpose: the inventory
 * guard greps every source file for it.)
 *
 * ⚠️ The maps and lists (`e`, `pais`, `vistos`, `amostras`, `candidatos`, `contadores`,
 * `enviadosPreco`) are written whole with a raw `update()` field — never through
 * `mergeIfExists`, whose patch must be flat, nor through `merge`, which would union a pruned map
 * with the stored one.
 *
 * ⚠️ The subcollection leaf name (`snapshot`) is generic — the stock's buckets live under the same
 * name in `sincEstoqueLojaIntegrada` — so `groupQuery()` on these handles would reach both. Nothing
 * calls it: every read goes through `ref(db, { integracaoId })`.
 *
 * Admin-only / default-deny (none of these schemas is in `ALL_DOMAINS`, none has a Meta), so there
 * is no client access and no generated rules block — the rulesets regenerate with a zero diff.
 */
export const sincPrecoLojaIntegradaCollection = defineAdminCollection({
  path: COLECAO_SINC_PRECO_LI,
  schema: sincPrecoLojaIntegradaSchema,
});

/** `sincPrecoLojaIntegrada/{integracaoId}/<sub>` — one conta's own subcollection path. */
const subcolecaoDaConta = (sub: string): string => `${COLECAO_SINC_PRECO_LI}/{integracaoId}/${sub}`;

/** `snapshot/{'00'..'31'}` — one bucket of the price snapshot (`baldeSnapshotEstoqueLi`). */
export const snapshotPrecoLiCollection = defineAdminCollection({
  path: subcolecaoDaConta(SUBCOLECOES_SINC_PRECO_LI.snapshot),
  schema: snapshotPrecoLiSchema,
});

/**
 * `snapshot/paisErp` — the parents unit's document, beside the 32 buckets in the SAME
 * subcollection, so this handle and {@link snapshotPrecoLiCollection} share a path: pick the
 * handle by the doc id (`ID_PAIS_ERP_SNAPSHOT_PRECO_LI` here, a bucket id there), never by listing.
 */
export const paisErpSnapshotPrecoLiCollection = defineAdminCollection({
  path: subcolecaoDaConta(SUBCOLECOES_SINC_PRECO_LI.snapshot),
  schema: paisErpSnapshotPrecoLiSchema,
});
