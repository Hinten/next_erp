import { missedFeedsMercadoLivreMeta, missedFeedsMercadoLivreSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/** App-wide recovery health (#1292), doc id app-<appId>. Admin-only.
 * The sweep performs a transactionally guarded full write; no feed cursor is
 * stored. Old per-integration health rows are historical diagnostics only.
 */
export const missedFeedsMercadoLivreCollection = defineAdminCollection({
  path: missedFeedsMercadoLivreMeta.collectionPath,
  schema: missedFeedsMercadoLivreSchema,
});
