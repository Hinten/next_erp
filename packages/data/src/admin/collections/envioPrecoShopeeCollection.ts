import { envioPrecoShopeeSchema, relatorioEnvioPrecoSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `enviosPrecoShopee` price-job/checkpoint doc
 * (master-plan step 13, #1521) — the authed `atualizar-precos` route creates
 * the job (doc id = the job id; one ACTIVE job per conta, enforced by the
 * writer), the nested Cloud Function (`processShopeePriceSync`) drives it a
 * bounded batch per dispatch, and the status route reads it back for the UI to
 * poll. Twin of `envioPrecoMercadoLivreCollection`.
 *
 * ⚠️ Every stamp in the document is MILLISECONDS (`startedAt`, `updatedAt`,
 * `finishedAt`, `retomarEm`); the one non-epoch instant is `expiraEm`, a real
 * `Date` the TTL policy `enviosPrecoShopee` keys on.
 *
 * ⚠️ The start guard's `(integracaoId, status)` and the history's
 * `(integracaoId, startedAt DESC)` composites are hand-declared in
 * `firestore.indexes.json`: this schema has no `meta.defaultQuery`, so the lint
 * rule cannot see them, and on Firestore Enterprise a missing composite
 * full-scans and bills instead of failing.
 *
 * Admin-only / default-deny (the schema is not in `ALL_DOMAINS` and exports no
 * `…Meta`), so there is no client access and no generated rules block.
 */
export const envioPrecoShopeeCollection = defineAdminCollection({
  path: 'enviosPrecoShopee',
  schema: envioPrecoShopeeSchema,
});

/**
 * Admin handle for the sharded per-model REPORT under one Shopee price job —
 * `enviosPrecoShopee/{envioId}/relatorios/{0000|0001|…}`. It binds the SHARED
 * `relatorioEnvioPrecoSchema` (the ML run's row, channel-neutral in content):
 * one row definition, read once by whatever builds the download.
 *
 * Written by the job's per-item checkpoint in the SAME `db.batch()` as the job
 * doc, so a row and the `fila` consumption that produced it commit together,
 * and by the terminal transaction's one synthetic row. Every shard write stamps
 * `expiraEm` from the run's `startedAt` (a week past the run) — the
 * `relatorios` group's policy is shared with ML's shards, and
 * `balanco/*\/relatorios` is never stamped. Read by the download route, which
 * pages it by `__name__`: the shard ids are zero-padded, so lexical order is
 * shard order and no index is involved.
 *
 * Same admin-only / default-deny posture as the parent.
 */
export const relatorioEnvioPrecoShopeeCollection = defineAdminCollection({
  path: 'enviosPrecoShopee/{envioId}/relatorios',
  schema: relatorioEnvioPrecoSchema,
});
