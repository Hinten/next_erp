import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { produtoMeta } from '@delfrance/schemas';

import { FUNCTIONS_REGION } from './options';
import {
  planCategoriaDoProduto,
  resolverAvisosDoProduto,
} from '../../lib/marketplace/anuncios/categoriaAnuncio';
import { getDb } from './lib/admin';

/**
 * Closes the `anuncioCategoriaAlterada` avisos (#847) the moment an operator
 * changes a produto's ERP category — the answer that aviso asks for. Without it
 * the row would wait for the NEXT link write to notice, which on a slow-selling
 * listing can be weeks of a bell showing a problem that is already fixed.
 *
 * Every open aviso of the produto's listings closes: as `categoria-erp-alinhada`
 * where the new category IS the listing's ML one, as `categoria-erp-alterada`
 * (reviewed, and chose otherwise) everywhere else. Logic and its tests live in
 * `lib/marketplace/anuncios/categoriaAnuncio.ts`.
 *
 * ⚠️ Targets the NAMED `default` database — see `onProdutoMercadoLivreLinkChanged`.
 *
 * `retry: true`: the resolver re-reads every aviso it touches, so a replayed
 * event can only close what is still open.
 *
 * NO `secrets:` binding — it never calls the ML API (`src/options.ts`).
 *
 * ⚠️ COST: it runs on EVERY write to a produto — and produtos are written often
 * (prices, stock denorms, edits). The decision is therefore made from the event
 * payload before `getDb()`: only a real change of `categoriaProdutoOuterRef`
 * reaches Firestore, and that is rare.
 *
 * No loop risk: it writes only `avisos`.
 */
export const onProdutoCategoriaAlterada = onDocumentWritten(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    region: FUNCTIONS_REGION,
    retry: true,
  },
  async (event) => {
    const { produtoId } = event.params as { produtoId: string };
    const before = event.data?.before.exists
      ? (event.data.before.data() as Record<string, unknown>)
      : null;
    const after = event.data?.after.exists
      ? (event.data.after.data() as Record<string, unknown>)
      : null;

    const plano = planCategoriaDoProduto(before, after);
    if (plano == null) return; // 0 reads, 0 writes

    const resolvidos = await resolverAvisosDoProduto(getDb(), produtoId, plano.erpDepoisId, {
      nowMs: Date.now(),
    });
    logger.info('[mercado-livre] onProdutoCategoriaAlterada', {
      produtoId,
      erpDepoisId: plano.erpDepoisId,
      resolvidos,
    });
  },
);
