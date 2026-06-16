import { filialMeta, filialSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the `filiais` collection. apps/nfe uses it to read a
 * filial's CNPJ at emission/upload time and to merge the public certificate
 * metadata (`filial.certificado`) onto the filial doc — the cert upload route
 * writes only that field via `parseMerge`, leaving the rest untouched.
 */
export const filialCollection = defineAdminCollection({
  path: filialMeta.collectionPath,
  schema: filialSchema,
});
