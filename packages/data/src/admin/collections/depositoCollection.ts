import { depositoMeta, depositoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `depositos` collection (physical warehouses). Added
 * for #802's `check-deposito-source` pre-flip verification, which has to answer
 * "does the depósito this conta points at actually exist?" — the one check the
 * Mercado Livre stock sweep does NOT make, and the difference between publishing
 * real quantities and publishing zero across a whole account.
 */
export const depositoCollection = defineAdminCollection({
  path: depositoMeta.collectionPath,
  schema: depositoSchema,
});
