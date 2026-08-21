import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { linkHasLiveListing, produtoMercadoLivre } from '@delfrance/schemas';

import {
  adicionarConta,
  planLinkChange,
  removerContaSeOrfa,
  sobrevivemLinksDoProduto,
} from '../../lib/marketplace/anuncios/integracoesComProduto';
import { getDb } from './lib/admin';

/**
 * Owns `produtos.integracoesComProduto` for PARENT produtos, deriving it from
 * the listing links themselves instead of the six hand-written stamp sites
 * (#920). All the logic is the pure, unit-tested core in
 * `lib/marketplace/integracoesComProduto.ts`; this file is the thin wrapper
 * (same split as `onIntegracaoMercadoLivreChanged` / `intFreteSync.ts`).
 *
 * Why it exists: that array is the anchor pre-filter both ML sweeps open with,
 * and it was only ever REMOVED by deriving it from the sibling `marketplace`
 * array. Breaking that coupling is what lets `marketplace` + `marketplaceIds` +
 * the stamping die at the Flutter decommission instead of inside the cutover
 * window (#431 lock 2).
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (root gotcha); an
 * `onDocument*` that omits `database` binds to `(default)` and NEVER fires. The
 * id is inlined at build time by build.mjs — Firebase reads no env during
 * codebase analysis.
 *
 * `retry: true` → Eventarc at-least-once, for TRANSIENT Firestore failures. A
 * redelivery replays the ORIGINAL CloudEvent (the same stale before/after
 * snapshots, not the current doc), which is safe on both arms: the add is an
 * `arrayUnion` and the remove re-derives its verdict inside a transaction from
 * what is stored NOW, so a replayed event can only reach the same conclusion or
 * decline to act.
 *
 * NO `secrets:` binding — deliberately. This trigger never touches the ML API;
 * per `src/options.ts`'s per-function-secrets rule, a function with no ML API
 * call must not get the app credentials bound.
 *
 * COST: the whole decision is made from the event payload BEFORE `getDb()`, and
 * that is load-bearing rather than a nicety. These link docs are rewritten
 * constantly for reasons that cannot move membership — every stock-send error
 * and price writeback merges `estado`/`errors`/`ultimaModificacao` through
 * `mergeIfExists` — so the overwhelming majority of invocations must cost zero
 * reads and zero writes.
 *
 * No loop risk: it writes ONE key on `produtos`, which has no trigger that
 * writes back to `produtos`. `onProdutoChanged` does fire, which is why
 * `integracoesComProduto` sits in its `PRODUTO_HISTORY_IGNORE_FIELDS` — denorm
 * churn is not an operator edit.
 */
export const onProdutoMercadoLivreLinkChanged = onDocumentWritten(
  {
    document: `${produtoMercadoLivre.meta.collectionPath}/{linkId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    region: process.env.FUNCTIONS_REGION ?? 'us-east5',
    retry: true,
  },
  async (event) => {
    // The middle `{produtoId}` wildcard sits inside the meta-derived path
    // prefix, so its type isn't inferred into `event.params` (only the trailing
    // `{linkId}` is) — both are present at runtime. Same cast as
    // `onEstoqueDeleted` in apps/functions.
    const { produtoId, linkId } = event.params as { produtoId: string; linkId: string };
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    const plano = planLinkChange(before, after, linkHasLiveListing);
    if (plano.add.length === 0 && plano.check.length === 0) return; // 0 reads, 0 writes

    const db = getDb();

    for (const integracaoId of plano.add) {
      const escrito = await adicionarConta(db, produtoId, integracaoId);
      logger.info('[mercado-livre] onProdutoMercadoLivreLinkChanged add', {
        produtoId,
        linkId,
        integracaoId,
        escrito,
      });
    }

    for (const integracaoId of plano.check) {
      const removido = await removerContaSeOrfa(
        db,
        produtoId,
        integracaoId,
        sobrevivemLinksDoProduto(db, produtoId, integracaoId),
      );
      logger.info('[mercado-livre] onProdutoMercadoLivreLinkChanged check', {
        produtoId,
        linkId,
        integracaoId,
        removido,
      });
    }
  },
);
