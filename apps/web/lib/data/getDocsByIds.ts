import { getDocs, getDocsFromServer, type Firestore } from 'firebase/firestore';
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
 *
 * ⚠️ **`source` decides what an ABSENT id means.** The default `getDocs`
 * silently falls back to the local cache when the server is unreachable, so an
 * id the cache has never seen comes back missing and is indistinguishable from
 * a document that genuinely does not exist. That is fine when the caller
 * degrades gracefully, and wrong when it will *persist* a value derived from
 * the result — pass `{ source: 'server' }` there so an offline/transient
 * failure REJECTS instead of masquerading as "not found".
 */
export async function getDocsByIds<T extends z.ZodTypeAny>(
  db: Firestore,
  handle: CollectionHandle<T>,
  ids: ReadonlyArray<string>,
  ctx: PathContext = {},
  options: { readonly source?: 'default' | 'server' } = {},
): Promise<Map<string, z.infer<T>>> {
  const out = new Map<string, z.infer<T>>();
  const unique = [...new Set(ids)].filter((id) => id.length > 0);
  if (unique.length === 0) return out;

  const base = handle.ref(db, ctx);
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += IN_CHUNK) chunks.push(unique.slice(i, i + IN_CHUNK));

  const run = options.source === 'server' ? getDocsFromServer : getDocs;
  const snaps = await Promise.all(
    chunks.map((chunk) => run(buildQuery(base, [whereDocIdIn(chunk)]))),
  );
  for (const snap of snaps) {
    for (const d of snap.docs) out.set(d.id, d.data());
  }
  return out;
}
