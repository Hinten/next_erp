import type { Firestore, WriteBatch } from 'firebase/firestore';
import { historicoCustoCollection } from '@/lib/data/historicoCollections';
import { newDocId } from './docId';

/**
 * Queue one `historicoDeCusto` record (the cost value at this point in time)
 * onto the batch. Wire shape matches the Flutter `HistoricoCusto` model
 * (`{ valor: double, timestamp: ms-epoch int }`) — the old app never wrote
 * these, but the Next editor records every cost change so the history is
 * populated going forward (coexistence-safe: Flutter reads the same shape).
 */
export function appendCustoHistory(
  batch: WriteBatch,
  db: Firestore,
  produtoId: string,
  valor: number,
): void {
  batch.set(historicoCustoCollection.docRef(db, { produtoId }, newDocId()), {
    valor,
    timestamp: Date.now(),
  });
}
