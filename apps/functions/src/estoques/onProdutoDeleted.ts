import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { produtoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { sweepProdutoEstoques } from './estoqueCascade';

/**
 * On `produtos/{produtoId}` delete (parent OR variation child), cascade-delete
 * the produto's `estoques` docs and each one's nested `historicoEstoque` (#226).
 * The client-side `deleteProdutoCascade` (#199) only deletes the produto docs;
 * this trigger reclaims the subcollections Firestore would otherwise orphan
 * (#136), with no dependency on the client.
 *
 * Scoped to the estoque subtree for this issue, but this is the natural home for
 * the broader produto-subcollection sweep (#136) later. Targets the NAMED
 * `default` database (gotcha #8).
 */
export const onProdutoDeleted = onDocumentDeleted(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { produtoId } = event.params;
    const swept = await sweepProdutoEstoques(getDb(), produtoId);
    logger.info(
      `onProdutoDeleted: ${produtoId} → swept ${swept.estoques} estoques + ${swept.historico} historicoEstoque`,
    );
  },
);
