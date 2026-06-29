import { type DocumentReference, type Firestore, getDocs, writeBatch } from 'firebase/firestore';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { regraImpostoCollection } from '@/lib/data/regraImpostoCollection';

/** Firestore's hard cap on writes per batch. */
const BATCH_LIMIT = 500;

/**
 * Delete an operação and its `regraimposto` subcollection (Firestore never
 * cascades). Uses `writeBatch` chunked at the 500-op cap rather than one request
 * per delete — reliable + fast even for an operação with many macros. The
 * operação doc rides the final chunk, so it is removed last.
 */
export async function deleteOperacaoCascade(db: Firestore, id: string): Promise<void> {
  const regras = await getDocs(regraImpostoCollection.ref(db, { operacaoId: id }));
  // The regra refs (RegraImposto converter) and the operação ref (Operacao
  // converter) differ, so widen both to DocumentReference<unknown> for the batch.
  const refs: DocumentReference<unknown>[] = [
    ...regras.docs.map((d) => d.ref as DocumentReference<unknown>),
    operacaoCollection.docRef(db, {}, id) as DocumentReference<unknown>,
  ];
  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(i, i + BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
  }
}
