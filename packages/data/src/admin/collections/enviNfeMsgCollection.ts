import { enviNfeMsgMeta, enviNfeMsgSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the per-filial `enviNfe` SEFAZ audit log
 * (`filiais/{filialId}/enviNfe`). Append-only: every SOAP round-trip
 * writes a new, schema-validated doc.
 */
export const enviNfeMsgCollection = defineAdminCollection({
  path: enviNfeMsgMeta.collectionPath,
  schema: enviNfeMsgSchema,
});
