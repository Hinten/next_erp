import type { Firestore } from 'firebase-admin/firestore';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin';
import { produtoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';
import { ESTADO_PUBLICACAO_ML } from '@delfrance/schemas';

/** An in-flight legacy writeback must lose to a migration claim or cutover. */
export async function updateListingUnlessMigrating(
  db: Firestore,
  target: { produtoId: string; linkDocId: string; itemId?: string },
  patch: Record<string, unknown>,
): Promise<boolean> {
  const ref = produtoMercadoLivreLinkCollection.docRef(
    db,
    { produtoId: target.produtoId },
    target.linkDocId,
  );
  const snap = await ref.get();
  const raw = snap.data();
  if (
    !snap.exists ||
    raw?.estado === ESTADO_PUBLICACAO_ML.aguardandoMigracao ||
    (target.itemId != null && raw?.id != null && raw.id !== target.itemId)
  )
    return false;
  const data = produtoMercadoLivreLinkCollection.parseMerge(patch);
  try {
    await ref.update(data, { lastUpdateTime: snap.updateTime });
    return true;
  } catch (err) {
    if (isNotFound(err) || isFailedPrecondition(err)) return false;
    throw err;
  }
}
