import type { Firestore } from 'firebase-admin/firestore';
import { arquivoCollection } from '@delfrance/data/admin/collections';
import { parseProductOriginalPath, productArquivoId } from '@delfrance/schemas';

/**
 * Map a finalized Storage object back to its owning `arquivos` doc id. Prefers
 * the `arquivoId` the client stamps in custom metadata (create-first uploads);
 * falls back to deriving it from a product-original path for objects that
 * predate the marker. Returns `null` when neither resolves (a legacy
 * video/generic object with no metadata — nothing to stamp).
 */
export function arquivoIdForObject(
  name: string,
  metadata?: Record<string, string> | null,
): string | null {
  const fromMeta = metadata?.arquivoId;
  if (fromMeta) return fromMeta;
  const parsed = parseProductOriginalPath(name);
  return parsed ? productArquivoId(parsed.produtoId, parsed.hash) : null;
}

/**
 * Flip the owning `arquivos` doc's `uploadState` to `'finalized'` — the
 * authoritative "the bytes actually arrived" signal the phantom-doc orphan
 * sweep keys off.
 *
 * UPDATE-only (mirrors `markDone` in processOriginal.ts): never creates the doc,
 * so an object uploaded out-of-band (e.g. the Console) with no create-first doc
 * is left untouched rather than producing a partial Arquivo. Idempotent — a
 * re-finalize on an already-finalized doc is a no-op.
 *
 * The public `url` is the client's responsibility (it patches `getDownloadURL`
 * right after upload); backfilling `url` here for the rare client-died-mid-patch
 * case is a deferred refinement (product images render via their derivative
 * docs, which carry their own URLs).
 */
export async function markUploadFinalized(db: Firestore, docId: string): Promise<void> {
  const ref = arquivoCollection.docRef(db, {}, docId);
  const snap = await ref.get();
  if (!snap.exists) return;
  if (snap.data()?.uploadState === 'finalized') return;
  await ref.update({ uploadState: 'finalized' });
}
