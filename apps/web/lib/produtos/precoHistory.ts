import type { Firestore, WriteBatch } from 'firebase/firestore';
import type { PrecoChange } from '@delfrance/schemas';
import { historicoPrecoCollection } from '@/lib/data/historicoCollections';
import { newDocId } from './docId';

/**
 * Queue one `historicoDePrecos` record per price change onto the batch —
 * mirror of the Flutter `Produto.save()` history writes
 * (`packages/produtos/lib/src/models.dart:2078-2130`). Wire shape: outerRef =
 * `documents/listaDePrecos/<id>` (`pathWithDocuments`), values explicitly
 * null when absent, timestamp = ms epoch.
 */
export function appendPrecoHistory(
  batch: WriteBatch,
  db: Firestore,
  produtoId: string,
  changes: PrecoChange[],
): void {
  for (const change of changes) {
    batch.set(historicoPrecoCollection.docRef(db, { produtoId }, newDocId()), {
      listaDePrecoHistoricoOuterRef: `documents/listaDePrecos/${change.listaId}`,
      valorOriginal: change.valorOriginal,
      valorFinal: change.valorFinal,
      timestamp: Date.now(),
    });
  }
}
