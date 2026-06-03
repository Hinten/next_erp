import { defineAdminCollection } from '@delfrance/data/admin';
import { enviNfeMsgMeta, enviNfeMsgSchema } from '@delfrance/schemas';

/**
 * Admin-SDK handle for the per-filial `enviNfe` SEFAZ audit log
 * (`filiais/{filialId}/enviNfe`). Append-only: every SOAP round-trip
 * writes a new, schema-validated doc.
 */
export const enviNfeMsgCollection = defineAdminCollection({
  path: enviNfeMsgMeta.collectionPath,
  schema: enviNfeMsgSchema,
});
