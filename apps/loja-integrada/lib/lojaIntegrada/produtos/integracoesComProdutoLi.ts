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
 * survivor read below), and why only the array key is ever written. Nothing here restates it.
 * The Shopee binding (`apps/shopee/lib/shopee/anuncios/integracoesComProdutoShopee.ts`) is the
 * shape this file mirrors.
 *
 * What is Loja Integrada's and lives here:
 *
 * 1. **The conta ref is `contaLojaIntegrada`**, read through `contaIdFromRef` — the ONE conta-ref
 *    reader every channel binding and the product import's link decisions share. Both stored
 *    forms (`documents/integracao/<id>` and the bare `integracao/<id>`) name the same conta; a
 *    malformed ref names none. ⚠️ A copy of another channel's binding compiles here and reads
 *    `null` on every Loja Integrada link, so both sides of the plan's comparison are `null`, the
 *    zero-cost fast path swallows every write and the trigger does nothing, silently — which is
 *    why {@link contaDoLinkLi} carries near-miss tests of its own.
 * 2. **The counts predicate is `vinculoLiConta`** (`@delfrance/schemas`, beside the link schema):
 *    the link names a store product (`id` a canonical positive integer, as a number or its
 *    decimal text) that is not in the trash (`removido !== true`). Hidden and blocked links
 *    COUNT; `estadoPublicacao` is not read. Total and non-throwing over a raw document, because
 *    it is handed whatever is on disk — and a throw inside the trigger's zero-read fast path
 *    would ride the Eventarc `retry: true` redelivery for ever.
 * 3. **The survivor read, and it is an INDEX decision** — see
 *    {@link sobrevivemVinculosDoProdutoLi}.
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
 * `@delfrance/data/admin/collections` and `@delfrance/data/admin/produtos` and never the
 * `@delfrance/data/admin` barrel. Clock-free: nothing here reads a clock or the environment.
 */
import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { produtoLojaIntegradaLinkCollection } from '@delfrance/data/admin/collections';
import {
  adicionarConta as adicionarContaCore,
  contaIdFromRef,
  planLinkChange,
  removerContaSeOrfa as removerContaSeOrfaCore,
  type SentinelasDeArray,
} from '@delfrance/data/admin/produtos';
import { vinculoLiConta } from '@delfrance/schemas';

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
 * The integração doc id a `produtolojaintegrada` link belongs to, or `null`.
 *
 * ⚠️ **`contaLojaIntegrada`** — the header's point 1. Both stored forms read as the same conta
 * (`'documents/integracao/C1'` ≡ `'integracao/C1'` ⇒ `C1`); another conta's ref reads as THAT
 * conta, and a malformed ref (another collection, a bare id, a non-string) as `null` — never as
 * some other conta. Non-throwing, because `contaIdFromRef` is.
 */
export function contaDoLinkLi(link: Record<string, unknown>): string | null {
  return contaIdFromRef(link.contaLojaIntegrada);
}

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
 * Does this produto still hold a `produtolojaintegrada` link that COUNTS for this conta? The
 * reader the guarded removal evaluates inside its own read set.
 *
 * ⚠️ **The read is UNFILTERED, and that is the index decision.** `firestore.indexes.json`
 * declares the COLLECTION_GROUP composite `produtolojaintegrada (contaLojaIntegrada, id)` for
 * the order import's lookup, and NO `produtolojaintegrada` COLLECTION index — so a `where` on
 * the conta ref here would be an undeclared predicate, and on Firestore Enterprise an undeclared
 * predicate does not throw: it silently full-scans, billed by data SCANNED (root `CLAUDE.md`
 * rule 1). A produto carries a handful of link documents — one per conta it is listed under —
 * so reading them all and filtering in code needs NO index at all, which is the Shopee binding's
 * argument for its own scan. This step declares no index for it.
 *
 * ⚠️ **And a filter would also disagree with the plan.** The trigger decides its candidate with
 * {@link contaDoLinkLi} and `vinculoLiConta`; filtering here with the SAME two readers is what
 * keeps the survivor verdict consistent with that decision. A query could not: `contaIdFromRef`
 * also folds a ref stored with a leading slash or an empty segment, which an `in` over the two
 * canonical forms would miss, and `vinculoLiConta` counts an `id` stored as its decimal TEXT,
 * which a typed range on `id` would miss. Either miss reads "no survivor" for a link that
 * counts, and drops the conta — the silent-outage direction.
 *
 * ⚠️ The verdict comes from the `tx.get` result and from nothing captured before the write
 * opened: a retry of the core's guarded write re-runs this callback, but re-applies any outer
 * closure verbatim.
 */
export function sobrevivemVinculosDoProdutoLi(
  db: Firestore,
  produtoId: string,
  contaId: string,
): (tx: Transaction) => Promise<boolean> {
  return async (tx) => {
    const snap = await tx.get(produtoLojaIntegradaLinkCollection.ref(db, { produtoId }));
    return snap.docs.some((d) => {
      const data = (d.data() ?? {}) as Record<string, unknown>;
      return contaDoLinkLi(data) === contaId && vinculoLiConta(data);
    });
  };
}

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
