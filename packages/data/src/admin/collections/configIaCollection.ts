import { configIaMeta, configIaSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for `configIa` — one document per AI agent, each a singleton
 * keyed by purpose. Read by known id on the suggestion path; the only writer is
 * the settings panel in `apps/web`.
 */
export const configIaCollection = defineAdminCollection({
  path: configIaMeta.collectionPath,
  schema: configIaSchema,
});
