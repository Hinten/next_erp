import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { createMercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { produtoMercadoLivre } from '@delfrance/schemas';

import { FUNCTIONS_REGION } from './options';
import {
  aplicarPlanoCategoriaDoLink,
  planCategoriaDoLink,
} from '../../lib/marketplace/anuncios/categoriaAnuncio';
import { loadMercadoLivreContext } from '../../lib/marketplace/core/mercadoLivre';
import { getDb } from './lib/admin';

/**
 * Raises — and closes — the `anuncioCategoriaAlterada` aviso (#847) when a
 * listing link's ML category changes. All the logic is the unit-tested core in
 * `lib/marketplace/anuncios/categoriaAnuncio.ts`; this is the thin wrapper (the
 * `onProdutoMercadoLivreLinkChanged` split).
 *
 * Why a trigger on the LINK and not a step in the `items` sync: four writers
 * store ML's category on the link — the `items` sync, "Reverificar anúncio",
 * publish's echo and a re-import — and whichever runs first absorbs the change.
 * A check inside one of them misses every change another one stored; the
 * committed write is the one place all four meet.
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (root gotcha); an
 * `onDocument*` that omits `database` binds to `(default)` and NEVER fires.
 *
 * `retry: true` → Eventarc at-least-once for TRANSIENT failures (Firestore). A
 * redelivery replays the ORIGINAL payload, which is safe: the payload only
 * CLASSIFIES the event, and every decision is re-derived from the CURRENT link,
 * produto and aviso. ML failures never throw here — the aviso's names and fee
 * preview are best-effort, and losing the aviso to a decoration would be worse.
 *
 * Secrets: `MERCADO_LIVRE_CLIENT_ID` / `_SECRET` ARE bound — the raise path reads
 * the new category and ML's fee preview with the conta's token. That is why this
 * is a function of its own rather than an arm of `onProdutoMercadoLivreLinkChanged`,
 * which deliberately binds none (`src/options.ts`, per-function secrets).
 *
 * COST: the decision is made from the event payload BEFORE `getDb()`. These link
 * docs are rewritten constantly (every stock-send error and price writeback), and
 * a category change or a listing going not-live is rare, so nearly every
 * invocation costs zero reads, zero writes and no token refresh.
 *
 * No loop risk: it writes `avisos` and (create-if-absent) `categorias`, neither
 * of which triggers anything that writes back to a listing link.
 */
export const onAnuncioCategoriaAlterada = onDocumentWritten(
  {
    document: `${produtoMercadoLivre.meta.collectionPath}/{linkId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    region: FUNCTIONS_REGION,
    retry: true,
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
  },
  async (event) => {
    // Same cast as `onProdutoMercadoLivreLinkChanged`: the middle `{produtoId}`
    // wildcard sits inside the meta-derived prefix, so only `{linkId}` is typed.
    const { produtoId, linkId } = event.params as { produtoId: string; linkId: string };
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    const plano = planCategoriaDoLink(before, after);
    if (plano == null) return; // 0 reads, 0 writes

    const db = getDb();
    const resultado = await aplicarPlanoCategoriaDoLink(
      db,
      { produtoId, linkDocId: linkId },
      plano,
      {
        increment: (by) => FieldValue.increment(by),
        nowMs: Date.now(),
        logger,
        resolverApi: async (integracaoId) => {
          const ctx = await loadMercadoLivreContext(db, integracaoId);
          const channelCtx = await ctx.resolveChannelContext();
          return createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
        },
      },
    );
    logger.info('[mercado-livre] onAnuncioCategoriaAlterada', {
      produtoId,
      linkId,
      plano,
      resultado,
    });
  },
);
