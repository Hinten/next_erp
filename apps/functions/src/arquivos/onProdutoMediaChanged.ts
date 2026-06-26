import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { produtoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { reconcileMediaMarks } from './mediaMarks';

/**
 * On a `produtos/{id}` update, eagerly (un)mark arquivos a photo/video/anexo edit
 * removed/re-added: thin wrapper over {@link reconcileMediaMarks}. The complement
 * to the scheduled `sweepUnreferencedArquivos` — it captures the removal at edit
 * time (the event already carries before/after) instead of rediscovering it later
 * via the regex pipeline + owner lookup; that sweep stays as the backstop for
 * produto DELETES (until #136), manual console edits and missed trigger
 * deliveries.
 *
 * Targets the repo's NAMED `default` Firestore database (see getDb / gotcha #8);
 * an `onDocument*` that omits `database` binds to `(default)` and never fires.
 */
export const onProdutoMediaChanged = onDocumentUpdated(
  {
    document: `${produtoMeta.collectionPath}/{produtoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    await reconcileMediaMarks(getDb(), before, after);
  },
);
