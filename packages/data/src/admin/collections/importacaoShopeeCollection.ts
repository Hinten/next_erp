import { importacaoShopeeMeta, importacaoShopeeSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `importacoesShopee` mass-import
 * job/checkpoint doc (master-plan step 9, #1517) — the authed `importar-todos`
 * route creates the job, the nested Cloud Function
 * (`processShopeeMassImport`) drives it a bounded batch per dispatch, and the
 * status route reads it back for the UI to poll. Twin of
 * `importacaoMercadoLivreCollection`.
 *
 * ⚠️ Every stamp in the document is MILLISECONDS (`startedAt`, `updatedAt`,
 * `finishedAt`), like the other two Shopee checkpoint docs and unlike the ML
 * backfill cursor; the only SECONDS are `options.updateTimeFromS`/`ToS`, which
 * are the wire's own unit and go straight back to `get_item_list`.
 *
 * ⚠️ The `(integracaoId, status)` composite the job's start guard queries is
 * hand-declared in `firestore.indexes.json`: this schema has no
 * `meta.defaultQuery`, so the lint rule cannot see it, and on Firestore
 * Enterprise a missing composite full-scans and bills instead of failing.
 *
 * Admin-only / default-deny (see `importacaoShopeeMeta` — the schema is not in
 * `ALL_DOMAINS`), so there is no client access and no generated rules block.
 */
export const importacaoShopeeCollection = defineAdminCollection({
  path: importacaoShopeeMeta.collectionPath,
  schema: importacaoShopeeSchema,
});
