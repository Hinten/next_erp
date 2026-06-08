import type { CollectionMetadata } from '@delfrance/schemas';

/**
 * Server-side cascade runtime. Uses firebase-admin (not the client SDK)
 * because the Flutter rules do not allow clients to read/write across
 * documents in a single batch wide enough for a cascade. Imported only
 * by `apps/integrations` and tooling.
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
