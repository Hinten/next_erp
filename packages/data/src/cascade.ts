import type { CollectionMetadata } from '@delfrance/schemas';

/**
 * ⚠️ SUPERSEDED, and currently has ZERO callers. Delete cascades now run
 * server-side in `apps/functions` — bespoke per domain, or via the shared
 * `defineCascadeCaroGenerico` factory (`apps/functions/src/lib/`). Do not wire
 * this module into a new one.
 *
 * Beyond being unused, its shape is the one the cascade triggers deliberately
 * avoid: it sweeps exactly the paths a domain DECLARES in `meta.cascade`, and a
 * registry-derived list silently orphans whatever it does not know about —
 * Flutter writes subcollections this repo never registered, and
 * `integracaoMeta.cascade` omits `brandshopee` today. The triggers ask
 * Firestore what exists instead; see the ⚠️ in `admin/deleteSubtree.ts`.
 *
 * Kept only because it is a public export of `@delfrance/data/server` and it
 * still carries the `restrict` semantics nothing else implements.
 *
 * Server-side cascade runtime. Uses firebase-admin (not the client SDK)
 * because the Flutter rules do not allow clients to read/write across
 * documents in a single batch wide enough for a cascade.
 *
 * Strategy:
 * - For `onDelete: 'restrict'` declarations: query the child collection
 *   limited to 1 doc; if any exists, throw `CascadeBlockedError`.
 * - For `onDelete: 'cascade'` declarations: page through the child
 *   collection in batches of 200 and delete via `BulkWriter`.
 *
 * Apps depend on `firebase-admin` themselves; we type against the shape
 * we use and avoid importing the package here so this module stays
 * client-safe at type-check time.
 */

export class CascadeBlockedError extends Error {
  constructor(public readonly path: string) {
    super(`Cascade blocked: child collection "${path}" is not empty.`);
    this.name = 'CascadeBlockedError';
  }
}

interface AdminCollectionRef {
  limit(n: number): {
    get(): Promise<{ empty: boolean; size: number; docs: AdminQueryDocSnap[] }>;
  };
}

interface AdminQueryDocSnap {
  ref: { delete(): Promise<unknown> };
}

interface AdminFirestore {
  collection(path: string): AdminCollectionRef;
}

export interface CascadeOptions {
  /**
   * The Firestore admin instance (`firebase-admin/firestore` `Firestore`).
   * Typed structurally so this module doesn't pull in firebase-admin types
   * in environments that don't need them (e.g. apps/web).
   */
  admin: AdminFirestore;
  /**
   * Resolves any `{placeholder}` segments in metadata cascade paths into a
   * concrete Firestore path. Typically built from the parent doc's id.
   */
  resolvePath: (path: string) => string;
  /**
   * Per-page batch size for paged deletes.
   */
  pageSize?: number;
}

/**
 * Apply a domain's cascade declarations as part of deleting a parent doc.
 * The caller is responsible for deleting the parent itself; this only
 * handles dependent collections.
 *
 * Throws `CascadeBlockedError` for any restrict-declared subcollection
 * that is non-empty.
 */
export async function applyCascade(meta: CollectionMetadata, opts: CascadeOptions): Promise<void> {
  if (!meta.cascade?.length) return;
  const pageSize = opts.pageSize ?? 200;

  for (const decl of meta.cascade) {
    const resolved = opts.resolvePath(decl.path);
    const ref = opts.admin.collection(resolved);

    if (decl.onDelete === 'restrict') {
      const snap = await ref.limit(1).get();
      if (!snap.empty) throw new CascadeBlockedError(resolved);
      continue;
    }

    // cascade: page-delete until empty
    while (true) {
      const snap = await ref.limit(pageSize).get();
      if (snap.empty) break;
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
      if (snap.size < pageSize) break;
    }
  }
}
