import { defineCollection } from '@delfrance/data';
import { balancoSchema } from '@delfrance/schemas';

/**
 * Singleton handle for the `balanco` collection — one stock count over one
 * depósito.
 *
 * ⚠️ `estado`, `dataFinalizado` and `finalizacao` are server-owned: the client
 * creates a balanço with all three null and the `finalizarBalanco` callable
 * owns them from there. A `merge()` from this app must never include them —
 * the generated rules deny the write, with no `su` bypass.
 */
export const balancoCollection = defineCollection({
  path: 'balanco',
  schema: balancoSchema,
});
