import { defineCollection } from '@delfrance/data';
import { relatorioBalancoSchema } from '@delfrance/schemas';

/**
 * The `balanco/{balancoId}/relatorios` subcollection — the sharded snapshot the
 * finalize job writes, and the source the finalized report view and its CSV
 * read from (each item carries `sku` + `nome`, so rendering it needs no produto
 * reads at all).
 *
 * ⚠️ Read-only from this app: the collection is `serverOwned`, so every client
 * write is denied by the generated rules. The handle exists for the report
 * view's shard reads.
 */
export const relatorioBalancoCollection = defineCollection({
  path: 'balanco/{balancoId}/relatorios',
  schema: relatorioBalancoSchema,
});
