import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import {
  extractMensagemArquivoIds,
  mensagemMeta,
  nowMicros,
  parseMensagemMediaDir,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * Eagerly mark mensagem-owned arquivos referenced by a deleted mensagem.
 *
 * A mark is only a reversible signal. The scheduled sweep performs the global
 * collection-group recheck and the final transaction; deleting here would be
 * unsafe because one arquivo can be shared by many messages/conversas.
 */
export async function markDeletedMensagemArquivos(
  db: Firestore,
  mensagem: unknown,
): Promise<number> {
  const ids = [...extractMensagemArquivoIds(mensagem)];
  if (ids.length === 0) return 0;
  const refs = ids.map((id) => arquivoCollection.docRef(db, {}, id));
  const snapshots = await db.getAll(...refs);
  const batch = db.batch();
  const markedAt = nowMicros();
  let marked = 0;
  for (const snapshot of snapshots) {
    if (!snapshot.exists) continue;
    const data = snapshot.data() ?? {};
    if (!parseMensagemMediaDir(data.filepath as string | null | undefined)) continue;
    if (data.markedForDeletionAt != null) continue; // do not reset the grace clock
    batch.update(snapshot.ref, { markedForDeletionAt: markedAt });
    marked += 1;
  }
  if (marked > 0) await batch.commit();
  logger.info(`markDeletedMensagemArquivos: ${marked} marked from ${ids.length} distinct refs`);
  return marked;
}

export const onMensagemDeleted = onDocumentDeleted(
  {
    document: `${mensagemMeta.collectionPath}/{mensagemId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const before = event.data?.data();
    if (!before) return;
    await markDeletedMensagemArquivos(getDb(), before);
  },
);
