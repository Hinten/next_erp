import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { tabelaDeMedidasMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { reconcileMediaMarks } from './mediaMarks';

/**
 * On any `tabMedi/{id}` write, eagerly (un)mark the arquivos a tabela-de-medidas
 * photo edit removed/re-added — the tabMedi analogue of {@link onProdutoMediaChanged},
 * sharing {@link reconcileMediaMarks}.
 *
 * Uses `onDocumentWritten` (not just `onDocumentUpdated`) so it ALSO covers a
 * tabela DELETE: `after` is empty → every `before` foto ref is marked, then
 * `sweepMarkedForDeletion` deletes them after the grace (re-verifying the now-gone
 * owner holds no ref). This makes tabMedi delete-cleanup eager + emulator-testable,
 * rather than deferring to the live-only unreferenced pipeline like produto does
 * (until #136). A create carries no fotos under the save-first UX → no-op. Writes
 * touch only `arquivos`, so the trigger never re-fires itself.
 *
 * Targets the NAMED `default` Firestore database (gotcha #8); an `onDocument*`
 * that omits `database` binds to `(default)` and never fires.
 */
export const onTabMediMediaChanged = onDocumentWritten(
  {
    document: `${tabelaDeMedidasMeta.collectionPath}/{tabMediId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before && !after) return;
    await reconcileMediaMarks(getDb(), before, after);
  },
);
