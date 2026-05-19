import { enderecoSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Singleton handle for the `enderecos` subcollection of a cliente. The path
 * is parameterized — pass `{ clienteId }` as the `PathContext` to every
 * `ref` / `docRef` / `resolvePath` call.
 */
export const enderecoCollection = defineCollection({
  path: 'clientes/{clienteId}/enderecos',
  schema: enderecoSchema,
});
