import { inutNumeracaoMeta, inutNumeracaoSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the per-filial `inutilizacao` record subcollection
 * (`filiais/{filialId}/inutilizacao`). Append-only: every inutilização de
 * numeração round-trip — homologada (cStat 102) or rejeitada — writes a new,
 * schema-validated doc. The path is taken from the schema metadata so it stays
 * a single source of truth.
 */
export const inutNumeracaoCollection = defineAdminCollection({
  path: inutNumeracaoMeta.collectionPath,
  schema: inutNumeracaoSchema,
});
