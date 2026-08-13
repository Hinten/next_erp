import { missedFeedsMercadoLivreMeta, missedFeedsMercadoLivreSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `missedFeedsMercadoLivre` per-conta health doc
 * (#812) — the 05:00 `missed_feeds` backstop sweep (apps/mercado-livre nested
 * functions) merges one summary per conta per run: the counters on a clean
 * sweep, or `lastError` alone on a contained failure. Doc id = integracaoId.
 *
 * ⚠️ It is **written, never read** — the sweep keeps no cursor (ML's feed has no
 * time filter; see the schema docstring), so this doc exists purely as the
 * durable, queryable record of which contas are currently broken.
 *
 * Admin-only / default-deny (see `missedFeedsMercadoLivreMeta` — the schema is
 * not in `ALL_DOMAINS`), so there is no client access and no generated rules
 * block.
 */
export const missedFeedsMercadoLivreCollection = defineAdminCollection({
  path: missedFeedsMercadoLivreMeta.collectionPath,
  schema: missedFeedsMercadoLivreSchema,
});
