import {
  impostoCategoriaMeta,
  impostoCategoriaSchema,
  impostoProdutoMeta,
  impostoProdutoSchema,
  regraImpostoMeta,
  regraImpostoSchema,
} from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handles for the three tax-config collections the Imposto cascade
 * reads (`src/admin/imposto/`): the produto-scoped and categoria-scoped
 * `imposto` subcollections and the operação's `regras`. One file, three
 * handles, same shape as `produtoShopeeLinkCollection.ts` — they are read
 * together, by one module, and nothing else.
 *
 * ⚠️ **The paths are the LEGACY Flutter wire names, on purpose** (`apps/nfe`
 * `CLAUDE.md` rule 5, #423). The migrated corpus carries them verbatim, so the
 * produto scope key is Flutter's typo `impostoOpercaoOuterRef`
 * (`impostoProduto.ts`), the categoria one is
 * `impostoCategoriaOperacaoOuterRef`, and the regra collection id is `regras`
 * while the Dart getter was `regraimposto`. None of the three is renameable
 * without a migration.
 *
 * ⚠️ **Readers use `safeParse` + DROP, never `parseRead`.** `parseRead` is
 * `parseSoftRead`: it warns and returns the **raw** document
 * (`defineAdminCollection.ts`), which is the right default for a display read
 * and exactly wrong here. The cascade's contract is that a doc failing its own
 * collection schema **never reaches a tier** — because a lower tier answering
 * in its place is not a loud failure, it is a wrong NF-e (and now a wrong
 * `tax_info` on a Shopee listing). `firestoreImpostoResolver.ts` drops such a
 * doc and logs its concrete path.
 *
 * ⚠️ **No writer.** Nothing in this repo writes these three collections
 * server-side; the handles exist for the READ refs and for the schema that
 * decides which docs participate in the cascade. Adding an Admin handle changes
 * no `*Meta`, no `PERM` and no path, so it regenerates no ruleset (root
 * `CLAUDE.md` rule 2 is not triggered) — the four metas were already in
 * `ALL_DOMAINS`.
 */

/** `produtos/{produtoId}/imposto` — the produto-scoped tax config (tier 2). */
export const impostoProdutoCollection = defineAdminCollection({
  path: impostoProdutoMeta.collectionPath,
  schema: impostoProdutoSchema,
});

/** `categorias/{categoriaId}/imposto` — the categoria-scoped tax config (tier 3). */
export const impostoCategoriaCollection = defineAdminCollection({
  path: impostoCategoriaMeta.collectionPath,
  schema: impostoCategoriaSchema,
});

/**
 * `operacao/{operacaoId}/regras` — the operação's tax rules (tier 4). The path
 * placeholder is `operacaoId`, so the context is `{ operacaoId }`.
 */
export const regraImpostoCollection = defineAdminCollection({
  path: regraImpostoMeta.collectionPath,
  schema: regraImpostoSchema,
});
