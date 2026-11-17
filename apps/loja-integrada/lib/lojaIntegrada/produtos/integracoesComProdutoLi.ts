/**
 * **Loja Integrada's binding of `produtos.integracoesComProduto`** (master plan step 9, PR 9-v) —
 * the channel-shaped half of the denorm whose neutral half lives in
 * `@delfrance/data/admin/produtos` (`integracoesComProduto.ts`).
 *
 * Read that module's header FIRST. It carries the reasoning, and the reasoning is the expensive
 * part: the FAILURE ASYMMETRY (a conta listed with no live link costs one skipped sweep row; a
 * live link with no conta entry is a SILENT stock and price outage, so when in doubt
 * over-include), the race discipline of the two writes (rule 7: the add is tier 0, an
 * `arrayUnion`; the remove is tier 1, re-derived inside the core's guarded write from the
 * survivor read of point 3), and why only the array key is ever written. Nothing here restates
 * it.
 * The Shopee binding (`apps/shopee/lib/shopee/anuncios/integracoesComProdutoShopee.ts`) is the
 * shape this file mirrors.
 *
 * What is Loja Integrada's, and where it lives:
 *
 * 1. **The conta ref is `contaLojaIntegrada`**, read by {@link contaDoLinkLi} through
 *    `contaIdFromRef` — the ONE conta-ref reader every channel binding and the product import's
 *    link decisions share. Both stored forms (`documents/integracao/<id>` and the bare
 *    `integracao/<id>`) name the same conta; a malformed ref names none. ⚠️ A copy of another
 *    channel's binding compiles here and reads `null` on every Loja Integrada link, so both sides
 *    of the plan's comparison are `null`, the zero-cost fast path swallows every write and the
 *    trigger does nothing, silently. `contaDoLinkLi` lives in `@delfrance/schemas`
 *    (`lojaIntegradaLink.ts`, beside the counts predicate, with its near-miss tests) and is
 *    re-exported here, so no importer changed; this binding's suite pins that it IS that copy.
 * 2. **The counts predicate is `vinculoLiConta`** (`@delfrance/schemas`, beside the link schema):
 *    the link names a store product (`id` a canonical positive integer, as a number or its
 *    decimal text) that is not in the trash (`removido !== true`). Hidden and blocked links
 *    COUNT; `estadoPublicacao` is not read. Total and non-throwing over a raw document, because
 *    it is handed whatever is on disk — and a throw inside the trigger's zero-read fast path
 *    would ride the Eventarc `retry: true` redelivery for ever.
 * 3. **The survivor read, and it is an INDEX decision** — {@link sobrevivemVinculosDoProdutoLi},
 *    which lives in `@delfrance/data/admin/produtos` (`sobreviventesLi.ts`, where its header
 *    argues the unfiltered read and its suite pins it): a `tools/migrations` script needs the
 *    identical read and cannot import an app. This module binds it to the guarded remove.
 * 4. **The `FieldValue` sentinels**, supplied at this app boundary because
 *    `packages/data/src/admin/**` may only `import type` from `firebase-admin`.
 *
 * ⚠️ **One trigger, parents and children alike.** A Loja Integrada child's link sits under the
 * ERP CHILD produto, in the same leaf collection (`produtolojaintegrada`) as a parent's link
 * under the ERP root, so the one trigger path covers both and there is no variation twin. Each
 * produto's array is derived from its OWN links; the import links a child only beside its
 * parent's link, so every linked root is anchored too.
 *
 * ⚠️ **No multi-document atomic write is spelled in this app** (`../estrutura.test.ts` bans the
 * call's name in every file): the guarded remove is the core's own inventoried site, and this
 * module only hands it a survivor closure. That is why the transaction inventory gains no row.
 *
 * ⚠️ **Narrow subpaths only.** This module sits in the Cloud Functions ENTRYPOINT graph
 * (`functions/src/onProdutoLojaIntegradaLinkChanged.ts`), so it imports
 * `@delfrance/data/admin/produtos` and never the `@delfrance/data/admin` barrel. Clock-free:
 * nothing here reads a clock or the environment.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  adicionarConta as adicionarContaCore,
  planLinkChange,
  removerContaSeOrfa as removerContaSeOrfaCore,
  sobrevivemVinculosDoProdutoLi,
  type SentinelasDeArray,
} from '@delfrance/data/admin/produtos';
import { contaDoLinkLi, vinculoLiConta } from '@delfrance/schemas';

/** The anchor's conta reader — the ONE copy, in `@delfrance/schemas` (the header's point 1). */
export { contaDoLinkLi };

/**
 * The array sentinels the promoted writers cannot import for themselves (the header's point 4).
 *
 * ⚠️ ONE object with NAMED keys, not two positional callbacks — both have the type
 * `(id: string) => unknown`, so a swap would compile and make the ADD path REMOVE the conta,
 * which is the silent-outage direction.
 */
const SENTINELAS: SentinelasDeArray = {
  arrayUnion: (id) => FieldValue.arrayUnion(id),
  arrayRemove: (id) => FieldValue.arrayRemove(id),
};

/* --------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------ */

/**
 * What a `produtolojaintegrada` write means for the array, decided from the event payload ALONE —
 * no read and no write on the common case.
 *
 * That fast path is load-bearing: link docs are rewritten for reasons that move nothing. The
 * product import refreshes the mirror fields `ativo` and `bloqueado` on every run (its `removido`
 * refresh is the one that can move membership, below); a `nome` filled once, or rewritten by a
 * later flow, moves nothing; and the publish and sync flows of later steps write the same
 * documents again. None of those may cost a Firestore read. What does move membership: a create
 * or delete of a counting link, a `removido` flip, an `id` that becomes (or stops being) a store
 * product id, and a conta ref re-pointed.
 *
 * `check` is "this conta may have lost its last counting link" — a candidate, never a decision.
 * Only the guarded write that re-reads the surviving links decides that.
 */
export function planejarMudancaDeLinkLi(
  antes: Record<string, unknown> | null,
  depois: Record<string, unknown> | null,
): { add: string[]; check: string[] } {
  return planLinkChange(antes, depois, vinculoLiConta, contaDoLinkLi);
}

/* --------------------------------------------------------------------------
 * IO
 * ------------------------------------------------------------------------ */

/**
 * Add a conta to the produto's array — the promoted tier-0 write, bound to this app's
 * `FieldValue`. `arrayUnion` is commutative and idempotent, so a redelivery handled while the
 * link still counts costs nothing. ⚠️ It reads nothing, so one handled AFTER the link's close
 * (Eventarc guarantees no order) lists a conta with no counting link, and nothing removes it —
 * the accepted over-inclusive residual the trigger's docblock describes.
 *
 * `false` means the produto is gone (the cascade beat us); the core never re-creates it.
 */
export function adicionarContaLi(
  db: Firestore,
  produtoId: string,
  contaId: string,
): Promise<boolean> {
  return adicionarContaCore(db, produtoId, contaId, SENTINELAS);
}

/**
 * Drop a conta from the produto's array once a guarded re-read proves the produto holds no
 * surviving counting link for it — the promoted tier-1 write, bound to this app's `FieldValue`
 * AND to {@link sobrevivemVinculosDoProdutoLi}.
 *
 * ⚠️ The survivor reader is bound HERE rather than passed in by the trigger, so exactly one place
 * can get the conta filter or the counts predicate wrong (the Shopee shape: one reader, no
 * variation fallback).
 *
 * `true` when the conta was removed; `false` when a counting link survived or the produto is
 * gone.
 */
export function removerContaLiSeOrfa(
  db: Firestore,
  produtoId: string,
  contaId: string,
): Promise<boolean> {
  return removerContaSeOrfaCore(
    db,
    produtoId,
    contaId,
    sobrevivemVinculosDoProdutoLi(db, produtoId, contaId),
    SENTINELAS,
  );
}
