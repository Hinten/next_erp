import { defineCollection } from '@delfrance/data';
import { inutNumeracaoSchema } from '@delfrance/schemas';

/**
 * Subcollection: `filiais/{filialId}/inutilizacao` — the append-only log of
 * every inutilização de numeração (NfeInutilizacao4), homologada or rejeitada.
 * Listed newest-first on the inutilização screen, mirroring the old Flutter
 * `InutNFeTable`.
 */
export const inutilizacaoCollection = defineCollection({
  path: 'filiais/{filialId}/inutilizacao',
  schema: inutNumeracaoSchema,
});
