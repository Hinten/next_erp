/**
 * **Shopee's binding of `produtos.integracoesComProduto`** (#1519, step 11) —
 * the channel-shaped half of the denorm whose neutral half lives in
 * `@delfrance/data/admin/produtos`.
 *
 * Read that module's header FIRST. It carries the reasoning, and the reasoning
 * is the expensive part: the FAILURE ASYMMETRY (a false positive costs one
 * skipped sweep row; a false negative is a silent stock + price outage, so when
 * in doubt over-include), the race discipline of the two writes, and why only
 * the array key is ever written. Nothing here restates it — a second copy of an
 * argument drifts toward plausible while reading correct.
 *
 * What is Shopee's and lives here:
 *
 * 1. ⚠️ **The conta ref is on `contaProdutoShopeeOuterRef`, NOT
 *    `contaOuterRef`.** That is Mercado Livre's field name, and it is one
 *    identifier apart. A copy-paste of ML's binding compiles, resolves `null`
 *    on every Shopee link, makes both sides of the plan's comparison `null`,
 *    takes the zero-cost fast path — and the trigger becomes a no-op that logs
 *    nothing. That is exactly why the promoted `planLinkChange` takes the
 *    reader as a REQUIRED parameter with no default, and why
 *    {@link contaDoLinkShopee} carries a near-miss test of its own.
 * 2. The predicate: `anuncioShopeeVivo` (`./statusAnuncio`), which is also the
 *    re-verify/pause gate. Total and NON-THROWING over an unvalidated document
 *    — it is handed `event.data.after.data()`, i.e. whatever is on disk,
 *    including a migrated Flutter row carrying the pre-2024 `DELETED` spelling.
 *    A throw inside the trigger's zero-read fast path would ride the Eventarc
 *    `retry: true` redelivery for ever. `contaIdFromRef` is non-throwing by
 *    construction for the same reason.
 * 3. The survivor scan, and it is an INDEX decision — see
 *    {@link sobrevivemAnunciosDoProduto}.
 * 4. The `FieldValue` sentinels, supplied at this app boundary because
 *    `packages/data/src/admin/**` may only `import type` from `firebase-admin`
 *    (`adminBundleSafety.test.ts`) — the same seam `escreverAviso`'s
 *    `increment` uses.
 *
 * ⚠️ **NO variação twin.** Mercado Livre needs a second trigger because an ML
 * variation link can name a conta its parent link does not. A `variashopee` doc
 * carries a REQUIRED `produtoShopeeOuterRef` pointing at the parent LINK
 * document, and the parent link is written BEFORE the children — so a child
 * link never exists without a parent link for the same conta, and the parent
 * trigger already covers every membership change this channel can have. One
 * trigger, not two.
 *
 * ⚠️ **Narrow subpaths only.** This module sits in the Cloud Functions
 * ENTRYPOINT graph (`functions/src/onProdutoShopeeLinkChanged.ts`), so it
 * imports `@delfrance/data/admin/collections` and
 * `@delfrance/data/admin/produtos` and never the `@delfrance/data/admin`
 * barrel, which would drag the whole admin surface — notifications, cache,
 * pipelines, reconcile — in behind two predicates.
 *
 * Clock-free: nothing here reads a clock, and the multi-document atomic write
 * behind a removal lives in the promoted `removerContaSeOrfa`, never in this
 * folder.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';
import {
  adicionarConta as adicionarContaCore,
  contaIdFromRef,
  planLinkChange,
  removerContaSeOrfa as removerContaSeOrfaCore,
  type SentinelasDeArray,
} from '@delfrance/data/admin/produtos';

import { anuncioShopeeVivo } from './statusAnuncio';

/**
 * The array sentinels the promoted writers cannot import for themselves. See
 * the header's point 4; verbatim the Mercado Livre binding's own constant.
 *
 * ⚠️ ONE object with NAMED keys, not two positional callbacks — both have the
 * type `(id: string) => unknown`, so a swap would compile and make the ADD path
 * REMOVE the conta, which is the silent-outage direction.
 */
const SENTINELAS: SentinelasDeArray = {
  arrayUnion: (id) => FieldValue.arrayUnion(id),
  arrayRemove: (id) => FieldValue.arrayRemove(id),
};

/* --------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------ */

/**
 * The integração doc id a `prodshopee` link belongs to, or `null`.
 *
 * ⚠️ **`contaProdutoShopeeOuterRef`** — the header's point 1. Reading
 * `contaOuterRef` here (Mercado Livre's field, and the shape a copy-paste
 * brings) resolves `null` for every Shopee link and turns the trigger into a
 * silent no-op.
 *
 * Non-throwing, and it tolerates both stored ref forms
 * (`documents/integracao/<id>` and the bare `integracao/<id>`) because
 * `contaIdFromRef` does.
 */
export function contaDoLinkShopee(link: Record<string, unknown>): string | null {
  return contaIdFromRef(link.contaProdutoShopeeOuterRef);
}

/**
 * What a `prodshopee` write means for the array, decided from the event payload
 * ALONE — no read and no write on the overwhelmingly common case.
 *
 * That fast path is load-bearing here even more than it is for Mercado Livre:
 * step 9's importer merges the parent link on EVERY re-import, and step 11's
 * publisher writes it up to THREE times per publish (the item id, then the
 * models, then the read-back status). None of those can move membership, and
 * none of them may cost a Firestore read.
 *
 * `check` is "this conta may have lost its last listing" — a candidate, never a
 * decision. Only the guarded write that re-reads the surviving links decides
 * that.
 */
export function planejarMudancaDeLinkShopee(
  antes: Record<string, unknown> | null,
  depois: Record<string, unknown> | null,
): { add: string[]; check: string[] } {
  return planLinkChange(antes, depois, anuncioShopeeVivo, contaDoLinkShopee);
}

/* --------------------------------------------------------------------------
 * IO
 * ------------------------------------------------------------------------ */

/**
 * Does this produto still hold a `prodshopee` link that COUNTS for this conta?
 * The reader the guarded removal evaluates inside its own read set.
 *
 * ⚠️ **The scan is UNFILTERED, and that is the index decision.**
 * `firestore.indexes.json` declares a `prodshopee` COLLECTION_GROUP composite
 * `(item_id, contaProdutoShopeeOuterRef)` and NO `prodshopee` COLLECTION index
 * on the conta ref — so a `where('contaProdutoShopeeOuterRef', 'in', …)` here
 * would be an undeclared predicate, and on Firestore Enterprise an undeclared
 * predicate does not throw: it silently full-scans, billed by data SCANNED
 * (root `CLAUDE.md` rule 1). A produto carries a handful of `prodshopee`
 * documents — one per conta per listing — so reading them all and filtering in
 * code needs NO index at all. That is `sobrevivemVariacoesDoProduto`'s own
 * argument on the Mercado Livre side, verbatim. **Step 11 declares no new
 * index, and #1532's list is unchanged.**
 *
 * ⚠️ The verdict comes from the `tx.get` result and from nothing captured
 * before the write opened: an OCC retry re-runs this callback but re-applies
 * any outer closure verbatim, and losing here is the silent-outage direction.
 */
export function sobrevivemAnunciosDoProduto(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): (tx: FirebaseFirestore.Transaction) => Promise<boolean> {
  return async (tx) => {
    const snap = await tx.get(produtoShopeeLinkCollection.ref(db, { produtoId }));
    return snap.docs.some((d) => {
      const data = (d.data() ?? {}) as Record<string, unknown>;
      return contaDoLinkShopee(data) === integracaoId && anuncioShopeeVivo(data);
    });
  };
}

/**
 * Add a conta to the produto's array — the promoted tier-0 write, bound to this
 * app's `FieldValue`. `arrayUnion` is commutative and idempotent, so an
 * Eventarc redelivery costs nothing.
 *
 * `false` means the produto is gone (the cascade beat us); see the core.
 */
export function adicionarContaShopee(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): Promise<boolean> {
  return adicionarContaCore(db, produtoId, integracaoId, SENTINELAS);
}

/**
 * Drop a conta from the produto's array once a guarded re-read proves this
 * produto holds no surviving Shopee listing for it — the promoted tier-1 write,
 * bound to this app's `FieldValue` AND to {@link sobrevivemAnunciosDoProduto}.
 *
 * ⚠️ The survivor reader is bound HERE rather than passed in by the trigger, so
 * exactly one place can get the conta filter or the liveness predicate wrong.
 * Mercado Livre hands its own in because it has TWO readers to choose between
 * (the parent-link query and the variação scan); Shopee has one.
 */
export function removerContaShopeeSeOrfa(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
): Promise<boolean> {
  return removerContaSeOrfaCore(
    db,
    produtoId,
    integracaoId,
    sobrevivemAnunciosDoProduto(db, produtoId, integracaoId),
    SENTINELAS,
  );
}
