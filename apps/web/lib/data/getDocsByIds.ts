import { getDocs, type Firestore } from 'firebase/firestore';
import { buildQuery, whereDocIdIn, type CollectionHandle, type PathContext } from '@delfrance/data';
import type { z } from 'zod';

/** Firebase JS SDK v12 caps an `in` filter at 30 values. */
const IN_CHUNK = 30;

/**
 * Bulk-fetch documents of a collection by id → `Map<id, data>`. Dedupes and
 * drops empty ids, splits into `in`-queries of ≤30 ids (the SDK cap), and runs
 * every chunk concurrently (`Promise.all`). Ids with no matching document are
 * simply absent from the result.
 *
 * Built for the checkout screen's two produto fetch waves over a pedido of up
 * to 1000 items: ~34 concurrent chunked queries instead of ~1000 serial
 * `getDoc`s. Reads round-trip through the handle's converter (`parseSoftRead`).
 */
export async function getDocsByIds<T extends z.ZodTypeAny>(
  db: Firestore,
  handle: CollectionHandle<T>,
  ids: ReadonlyArray<string>,
  ctx: PathContext = {},
): Promise<Map<string, z.infer<T>>> {
  const out = new Map<string, z.infer<T>>();
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return out;

  const base = handle.ref(db, ctx);
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) chunks.push(unique.slice(i, i + IN_CHUNK));

  const snaps = await Promise.all(
    chunks.map((chunk) => getDocs(buildQuery(base, [whereDocIdIn(chunk)]))),
  );
  for (const snap of snaps) {
    for (const d of snap.docs) out.set(d.id, d.data());
  }
  return out;
}
