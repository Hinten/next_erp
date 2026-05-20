/**
 * Firebase Admin SDK adapter for the `NFeConfigStore` interface.
 *
 * **Server-only.** This module imports `firebase-admin/firestore` types
 * via a structural interface so the package doesn't take a hard dep on
 * the SDK — `apps/nfe` already depends on `firebase-admin` and passes
 * its `Firestore` instance here.
 *
 * Storage layout: per-filial counter doc at
 * `filiais/{filialId}/nfeconfig/{configId}`. The Dart side picks the
 * first doc in the subcollection (`documents.first()`), so we mirror
 * that — read the first doc; default config id `'default'` for fresh
 * seeds.
 */
import { nfeConfigSchema, type NFeConfig } from '@delfrance/schemas';

import type { NFeConfigStore, NFeConfigTx } from './index';

/**
 * Minimal structural type for `firebase-admin/firestore`'s `Firestore`.
 * We use the slash-delimited `doc(path)` API so the adapter doesn't
 * need to walk subcollections through a typed surface.
 */
export interface AdminFirestoreLike {
  doc: (path: string) => AdminDocRefLike;
  runTransaction: <T>(fn: (tx: AdminTxLike) => Promise<T>) => Promise<T>;
}

export interface AdminDocRefLike {
  readonly path: string;
  readonly id: string;
}

export interface AdminTxLike {
  get(ref: AdminDocRefLike): Promise<{
    readonly exists: boolean;
    data(): Record<string, unknown> | undefined;
  }>;
  set(ref: AdminDocRefLike, data: Record<string, unknown>): void;
}

/** Default config doc id under `filiais/{filialId}/nfeconfig`. */
export const DEFAULT_NFE_CONFIG_DOC_ID = 'default';

/**
 * Build an `NFeConfigStore` over the Admin SDK Firestore instance.
 *
 * Each `runTransaction` call inside the library translates 1:1 to a
 * Firestore transaction here — optimistic concurrency means a conflicting
 * commit retries automatically, so 50 parallel `nextNumeracao` calls
 * end up serialized through the per-doc lock without dropping a number.
 *
 * Override `configDocId` only if you're running a non-default seed (e.g.
 * multi-tenant test isolation in the staging concurrency test).
 */
export function nfeConfigStoreFromFirestore(
  fs: AdminFirestoreLike,
  options: { configDocId?: string } = {},
): NFeConfigStore {
  const configDocId = options.configDocId ?? DEFAULT_NFE_CONFIG_DOC_ID;

  const refFor = (filialId: string): AdminDocRefLike =>
    fs.doc(`filiais/${filialId}/nfeconfig/${configDocId}`);

  return {
    runTransaction: <T>(fn: (tx: NFeConfigTx) => Promise<T>) =>
      fs.runTransaction(async (txAdmin) => {
        const tx: NFeConfigTx = {
          async get(filialId) {
            const snap = await txAdmin.get(refFor(filialId));
            if (!snap.exists) return null;
            const data = snap.data();
            if (!data) return null;
            // Re-validate at the boundary — the Firestore document is the
            // ground truth, but we want a typed object internally.
            return nfeConfigSchema.parse(data) as NFeConfig;
          },
          set(filialId, next) {
            txAdmin.set(refFor(filialId), {
              ...next,
              timestamp: new Date().toISOString(),
            });
          },
        };
        return fn(tx);
      }),
  };
}
