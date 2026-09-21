import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { produtoShopee } from '@delfrance/schemas';

import {
  adicionarContaShopee,
  planejarMudancaDeLinkShopee,
  removerContaShopeeSeOrfa,
} from '../../lib/shopee/anuncios/integracoesComProdutoShopee';
import { getDb } from './lib/admin';

/**
 * Owns `produtos.integracoesComProduto` for the SHOPEE half, deriving it from
 * the listing links themselves rather than from a stamp every writer has to
 * remember (#1519, master plan step 11). The FIRST Firestore trigger of this
 * codebase.
 *
 * All the logic is in `lib/shopee/anuncios/integracoesComProdutoShopee.ts` —
 * the Shopee bindings — over the channel-neutral core in
 * `@delfrance/data/admin/produtos`, where the failure asymmetry and the race
 * discipline are argued. This file is the thin wrapper, the same split the
 * Mercado Livre twin uses.
 *
 * Why it exists: that array is the ANCHOR PRE-FILTER every marketplace sweep
 * opens with, so its accuracy IS stock + price coverage. A conta listed with no
 * live link costs one skipped sweep row; a live link with no conta entry is a
 * SILENT outage — the produto is never selected and nothing logs a reason.
 *
 * ⚠️ NO variação twin. Mercado Livre has one because an ML variation link can
 * name a conta its parent does not. A `variashopee` doc carries a REQUIRED
 * `produtoShopeeOuterRef` pointing at the parent LINK document, and the parent
 * link is written BEFORE the children, so a child link never exists without a
 * parent link for the same conta — this trigger already covers every membership
 * change the channel can have. One trigger, not two.
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (root `CLAUDE.md`
 * gotcha): an `onDocument*` that omits `database` binds to the non-existent
 * `(default)` and NEVER FIRES, with nothing anywhere to say so. The id is
 * inlined at build time by `build.mjs` — Firebase reads no env during codebase
 * analysis, so a live read would resolve `undefined` there. ⚠️ `src/lib/admin.ts`
 * already reads the same variable at RUNTIME for `getDb()`, which is a
 * different thing and does NOT cover this: codebase analysis happens in the
 * deploy's own process, before any env exists.
 *
 * `retry: true` → Eventarc at-least-once, for TRANSIENT Firestore failures. A
 * redelivery replays the ORIGINAL CloudEvent (the same stale before/after
 * snapshots, not the current document), which is safe on both arms and only
 * because of how each one is written: the add is an `arrayUnion`, commutative
 * and idempotent, and the remove re-derives its verdict from a guarded re-read
 * of what is stored NOW. So a replayed event can only reach the same conclusion
 * or decline to act.
 *
 * NO `secrets:` binding — deliberately. This trigger never calls Shopee, and
 * per `src/index.ts`'s per-function rule a function with no Shopee API call
 * must not get the partner credentials bound: a needless binding is one more
 * Secret Manager grant that can 403 the function at startup, taking it down
 * entirely. `index.test.ts` asserts the empty set.
 *
 * COST: the whole decision is made from the event payload BEFORE `getDb()`, and
 * that is load-bearing rather than a nicety. These link documents are rewritten
 * constantly for reasons that cannot move membership — step 9's importer merges
 * the parent link on EVERY re-import, and step 11's publisher writes it up to
 * THREE times per publish (the item id, then the models, then the read-back
 * status). The overwhelming majority of invocations must cost zero reads and
 * zero writes.
 *
 * A malformed document can never throw here: both folds are total over an
 * unvalidated snapshot body, because a throw inside the fast path would ride
 * the redelivery for ever.
 *
 * No loop risk: it writes ONE key on `produtos`, and `integracoesComProduto` is
 * already in `onProdutoChanged`'s `PRODUTO_HISTORY_IGNORE_FIELDS` — denorm
 * churn is not an operator edit.
 */
export const onProdutoShopeeLinkChanged = onDocumentWritten(
  {
    // The meta, never a literal: `produtos/{produtoId}/prodshopee`. The leaf
    // name is the VERIFIED Flutter one (#289) and a guessed spelling matches a
    // collection nothing writes — silently.
    document: `${produtoShopee.meta.collectionPath}/{linkId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    retry: true,
  },
  async (event) => {
    // The middle `{produtoId}` wildcard sits inside the meta-derived path
    // prefix, so its type isn't inferred into `event.params` (only the trailing
    // `{linkId}` is) — both are present at runtime. Same cast as the ML twin.
    const { produtoId, linkId } = event.params as { produtoId: string; linkId: string };
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    const plano = planejarMudancaDeLinkShopee(before, after);
    if (plano.add.length === 0 && plano.check.length === 0) return; // 0 reads, 0 writes

    const db = getDb();

    for (const integracaoId of plano.add) {
      const escrito = await adicionarContaShopee(db, produtoId, integracaoId);
      logger.info('[shopee] onProdutoShopeeLinkChanged add', {
        produtoId,
        linkId,
        integracaoId,
        escrito,
      });
    }

    for (const integracaoId of plano.check) {
      const removido = await removerContaShopeeSeOrfa(db, produtoId, integracaoId);
      logger.info('[shopee] onProdutoShopeeLinkChanged check', {
        produtoId,
        linkId,
        integracaoId,
        removido,
      });
    }
  },
);
