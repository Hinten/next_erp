import { defineCollection } from '@delfrance/data';
import { arquivoMeta, arquivoSchema } from '@delfrance/schemas';

/**
 * Client-SDK handle for the `arquivos` collection. Reads/writes round-trip
 * through `arquivoSchema` via the `withConverter` wrapper, so the upload
 * helpers never touch raw `firebase/firestore` refs.
 */
export const arquivoCollection = defineCollection({
  path: arquivoMeta.collectionPath,
  schema: arquivoSchema,
});
