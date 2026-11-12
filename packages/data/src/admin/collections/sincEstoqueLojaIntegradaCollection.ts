import {
  COLECAO_RECONCILE_ESTOQUE_LI,
  COLECAO_SINC_ESTOQUE_LI,
  SUBCOLECOES_SINC_ESTOQUE_LI,
  fatiaKitsComponenteEstoqueLiSchema,
  kitsComponenteEstoqueLiSchema,
  paisSnapshotEstoqueLiSchema,
  reconcileEstoqueLojaIntegradaSchema,
  sincEstoqueLojaIntegradaSchema,
  snapshotEstoqueLiSchema,
} from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handles of the Loja Integrada stock sync (master plan step 12, PR 12-a): the per-conta
 * root `sincEstoqueLojaIntegrada/{integracaoId}` (the reconcile's cursor and last-run counters),
 * its `snapshot` and `kits` subcollections, and the daily reconcile's ONE run document
 * `reconcileEstoqueLojaIntegrada/atual`.
 *
 * ⚠️ Every stamp is MILLISECONDS (`…Ms`).
 *
 * Every read is by id or a where-less listing of one conta's own subcollection, so no index is
 * declared for any of them. Every write is the lease holder's native precondition (`create`, or
 * `update(patch, { lastUpdateTime })` on the slice's own read, advance-only) — no transaction
 * here, nothing for the transaction inventory to classify. (Said WITHOUT the API's identifier on
 * purpose: the inventory guard greps every source file for it.)
 *
 * ⚠️ The maps (`e`, `kits`, `comps`, `contadores`) are written whole with a raw `update()` field —
 * never through `mergeIfExists`, whose patch must be flat, nor through `merge`, which would union
 * a pruned map with the stored one.
 *
 * ⚠️ The subcollection leaf names (`snapshot`, `kits`) are generic, so `groupQuery()` on these
 * handles would also reach any other collection of the same name. Nothing calls it: every read
 * goes through `ref(db, { integracaoId })`.
 *
 * Admin-only / default-deny (none of these schemas is in `ALL_DOMAINS`, none has a Meta), so
 * there is no client access and no generated rules block — the rulesets regenerate with a zero
 * diff. Mirrors `pollPedidosLojaIntegradaCollection`.
 */
export const sincEstoqueLojaIntegradaCollection = defineAdminCollection({
  path: COLECAO_SINC_ESTOQUE_LI,
  schema: sincEstoqueLojaIntegradaSchema,
});

/** `sincEstoqueLojaIntegrada/{integracaoId}/<sub>` — one conta's own subcollection path. */
const subcolecaoDaConta = (sub: string): string =>
  `${COLECAO_SINC_ESTOQUE_LI}/{integracaoId}/${sub}`;

/** `snapshot/{'00'..'31'}` — one bucket of the ERP-side snapshot (`baldeSnapshotEstoqueLi`). */
export const snapshotEstoqueLiCollection = defineAdminCollection({
  path: subcolecaoDaConta(SUBCOLECOES_SINC_ESTOQUE_LI.snapshot),
  schema: snapshotEstoqueLiSchema,
});

/**
 * `snapshot/pais` — the parents document, beside the 32 buckets in the SAME subcollection, so
 * this handle and {@link snapshotEstoqueLiCollection} share a path: pick the handle by the doc id
 * (`ID_PAIS_SNAPSHOT_ESTOQUE_LI` here, a bucket id there), never by listing.
 */
export const paisSnapshotEstoqueLiCollection = defineAdminCollection({
  path: subcolecaoDaConta(SUBCOLECOES_SINC_ESTOQUE_LI.snapshot),
  schema: paisSnapshotEstoqueLiSchema,
});

/** `kits/{componenteProdutoId}` — the header of one component's store kits. */
export const kitsComponenteEstoqueLiCollection = defineAdminCollection({
  path: subcolecaoDaConta(SUBCOLECOES_SINC_ESTOQUE_LI.kits),
  schema: kitsComponenteEstoqueLiSchema,
});

/**
 * `kits/{componenteProdutoId}~{n}` — one shard (`idFatiaKitsEstoqueLi`), in the SAME subcollection
 * as the headers: pick the handle by the doc id, never by listing.
 */
export const fatiaKitsComponenteEstoqueLiCollection = defineAdminCollection({
  path: subcolecaoDaConta(SUBCOLECOES_SINC_ESTOQUE_LI.kits),
  schema: fatiaKitsComponenteEstoqueLiSchema,
});

/** `reconcileEstoqueLojaIntegrada/atual` — the daily reconcile's lease and chain (ONE document). */
export const reconcileEstoqueLojaIntegradaCollection = defineAdminCollection({
  path: COLECAO_RECONCILE_ESTOQUE_LI,
  schema: reconcileEstoqueLojaIntegradaSchema,
});
