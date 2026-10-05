import {
  AVISOS_LEITURA_COLLECTION_PATH,
  avisoMeta,
  avisoSchema,
  avisosLeituraSchema,
} from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * `avisos` — the operator notification inbox. READ-ONLY from the browser: the
 * generated ruleset denies every client write (`serverOwned`), so the handle's
 * `merge` would fail by design. Producers write through
 * `@delfrance/data/admin/avisos`.
 */
export const avisoCollection = defineCollection({
  path: avisoMeta.collectionPath,
  schema: avisoSchema,
});

/**
 * `avisosLeitura/{uid}` — this operator's read state, and the one thing here the
 * client DOES write.
 *
 * ⚠️ Not backed by a registered `*Meta`: its rules come solely from a hand-written
 * `EXTRA_MATCH_BLOCK` in `@delfrance/rules-gen` scoping the document to
 * `request.auth.uid == uid`. A registered meta could only say
 * `p('d_aviso', 2)` — which would let any operator overwrite anyone else's read
 * state — and a second, stricter block would not help, because Firestore ORs
 * every matching `allow`. Same shape as `grupoEconomicoCollection`, which is why
 * both paths are allow-listed by name in `collectionCoverage.test.ts`.
 */
export const avisosLeituraCollection = defineCollection({
  path: AVISOS_LEITURA_COLLECTION_PATH,
  schema: avisosLeituraSchema,
});
