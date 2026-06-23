import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { estoqueProdutoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { deleteHistoricoEstoque } from './estoqueCascade';

/**
 * On `produtos/{produtoId}/estoques/{estoqueId}` delete, sweep that estoque's
 * `historicoEstoque` records (Firestore never cascades subcollections). Covers
 * the standalone case — a single estoque deleted via the UI or a future
 * reconcile sweep; the produto-wide cascade (`onProdutoDeleted`) already sweeps
 * history directly, so re-fires from THAT path find it gone (a no-op).
 *
 * Targets the repo's NAMED `default` Firestore database (gotcha #8); a trigger
 * that omits `database` binds to `(default)` and never fires.
 */
export const onEstoqueDeleted = onDocumentDeleted(
  {
    document: `${estoqueProdutoMeta.collectionPath}/{estoqueId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    // The middle `{produtoId}` wildcard sits inside the meta-derived path prefix,
    // so its type isn't inferred into `event.params` (only the trailing
    // `{estoqueId}` is) — both are present at runtime.
    const { produtoId, estoqueId } = event.params as { produtoId: string; estoqueId: string };
    const swept = await deleteHistoricoEstoque(getDb(), produtoId, estoqueId);
    logger.info(`onEstoqueDeleted: ${produtoId}/${estoqueId} → swept ${swept} historicoEstoque`);
  },
);
