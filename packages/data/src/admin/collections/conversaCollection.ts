import { conversaMeta, conversaSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `chat` collection (conversas). Writes are
 * validated against `conversaSchema` before they hit Firestore; the path
 * comes from the schema's metadata so it stays a single source of truth.
 * Used by server-side channel pipelines (e.g. the WhatsApp inbound webhook,
 * #527) that create/update a conversa outside a browser session.
 */
export const conversaCollection = defineAdminCollection({
  path: conversaMeta.collectionPath,
  schema: conversaSchema,
});
