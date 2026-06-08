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
 *
 * `runTransaction` accepts the same `transactionOptions` shape as
 * `firebase-admin/firestore` (`{ maxAttempts?: number }`) so the adapter
 * can dial up the retry budget for high-contention counter docs.
 */
export interface AdminFirestoreLike {
  doc: (path: string) => AdminDocRefLike;
  runTransaction: <T>(
    fn: (tx: AdminTxLike) => Promise<T>,
    options?: { maxAttempts?: number },
  ) => Promise<T>;
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
 * Total transaction attempts (including the first). Matches the Admin
 * SDK's default of 5. We don't rely on the SDK's *internal* retry, though
 * — its backoff is short and unconfigurable, so a 50-wide burst hammers
 * the doc faster than the cooldown window. Instead we pass
 * `{ maxAttempts: 1 }` to the SDK (one shot per outer call) and wrap
 * `runTransaction` in our own loop with jittered backoff between failed
 * attempts. See `NFE_CONFIG_TX_BACKOFF_MAX_MS`.
 */
export const NFE_CONFIG_MAX_TX_ATTEMPTS = 5;

/**
 * Upper bound (ms) for the random delay inserted between failed attempts.
 * Each retry sleeps `Math.random() * NFE_CONFIG_TX_BACKOFF_MAX_MS`, so a
 * thundering herd of contending transactions spreads out across a
 * 1-second window instead of slamming the doc back-to-back.
 */
export const NFE_CONFIG_TX_BACKOFF_MAX_MS = 1000;

/**
 * gRPC ABORTED status code — Firestore raises this when an optimistic
 * transaction loses to a concurrent commit. Only this code should trigger
 * our retry; anything else (auth, NOT_FOUND, INTERNAL, …) is real and
 * surfaces to the caller.
 */
const GRPC_ABORTED = 10;

/**
 * Narrow to a Firestore `ABORTED` transaction conflict. Mirrors the
 * duck-typed error inspection used in `apps/integrations/app/api/admin/*`
 * — the Admin SDK doesn't export a transaction-aborted class to
 * `instanceof`, so we narrow on `Error` + a numeric `code === 10`.
 */
function isFirestoreAbortedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' && code === GRPC_ABORTED;
}

/**
 * Build an `NFeConfigStore` over the Admin SDK Firestore instance.
 *
 * Each `runTransaction` call inside the library translates 1:1 to a
 * Firestore transaction here. Under contention (N parallel
 * `nextNumeracao` calls on the same doc) the SDK raises `ABORTED` for
 * losers; we retry up to `NFE_CONFIG_MAX_TX_ATTEMPTS` times with a
 * jittered backoff bounded by `NFE_CONFIG_TX_BACKOFF_MAX_MS`.
 *
 * Override `configDocId` only if you're running a non-default seed (e.g.
 * multi-tenant test isolation in the staging concurrency test).
 */
export function nfeConfigStoreFromFirestore(
  fs: AdminFirestoreLike,
  options: {
    configDocId?: string;
    maxAttempts?: number;
    backoffMaxMs?: number;
  } = {},
): NFeConfigStore {
  const configDocId = options.configDocId ?? DEFAULT_NFE_CONFIG_DOC_ID;
  const maxAttempts = options.maxAttempts ?? NFE_CONFIG_MAX_TX_ATTEMPTS;
  const backoffMaxMs = options.backoffMaxMs ?? NFE_CONFIG_TX_BACKOFF_MAX_MS;

  const refFor = (filialId: string): AdminDocRefLike =>
    fs.doc(`filiais/${filialId}/nfeconfig/${configDocId}`);

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    async runTransaction<T>(fn: (tx: NFeConfigTx) => Promise<T>): Promise<T> {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await fs.runTransaction(async (txAdmin) => {
            const tx: NFeConfigTx = {
              async get(filialId) {
                const snap = await txAdmin.get(refFor(filialId));
                if (!snap.exists) return null;
                const data = snap.data();
                if (!data) return null;
                // Re-validate at the boundary — the Firestore document is
                // the ground truth, but we want a typed object internally.
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
          });
        } catch (err) {
          lastErr = err;
          if (!isFirestoreAbortedError(err)) throw err;
          if (attempt === maxAttempts) break;
          await sleep(Math.random() * backoffMaxMs);
        }
      }
      throw lastErr;
    },
  };
}
