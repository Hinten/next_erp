import { envioPrecoMercadoLivreSchema, relatorioEnvioPrecoSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `enviosPrecoMercadoLivre` price-sync
 * job/checkpoint doc (Step 11 PR-C) — the authed "Atualizar preços" route
 * creates the job (doc id = the job id; one ACTIVE job per conta, enforced by
 * the writer, `startPriceSyncJob`), the nested Cloud Function
 * (`processMercadoLivrePriceSync`) drives it to completion, and the status
 * route reads it back for the UI to poll. Admin-only / default-deny (the
 * schema is not in `ALL_DOMAINS`), so there is no client access and no
 * generated rules block.
 */
export const envioPrecoMercadoLivreCollection = defineAdminCollection({
  path: 'enviosPrecoMercadoLivre',
  schema: envioPrecoMercadoLivreSchema,
});

/**
 * Admin handle for the sharded per-item REPORT under one price-sync job —
 * `enviosPrecoMercadoLivre/{envioId}/relatorios/{0000|0001|…}`. Written by the
 * job's checkpoint (in the SAME `db.batch()` as the job doc, so a row and the
 * `fila` consumption that produced it commit together) and read by the download
 * route, which pages it by `__name__` — the shard ids are zero-padded, so
 * lexical order is shard order and no index is involved.
 *
 * Same admin-only / default-deny posture as the parent, and for the same reason:
 * the schema is not in `ALL_DOMAINS` and exports no `…Meta`, so rules-gen emits
 * nothing and Firestore default-denies every client read.
 */
export const relatorioEnvioPrecoMercadoLivreCollection = defineAdminCollection({
  path: 'enviosPrecoMercadoLivre/{envioId}/relatorios',
  schema: relatorioEnvioPrecoSchema,
});
