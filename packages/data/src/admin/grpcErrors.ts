/**
 * gRPC status-code discriminators for Admin-SDK Firestore calls — a single
 * source so the numeric code checks can't drift between call sites.
 *
 * These exist because the Admin SDK surfaces Firestore failures as plain
 * `Error`s carrying a numeric `code`, and the repo bans a generic `catch`
 * (root `CLAUDE.md` rule 6): a narrowing predicate is what lets a call site
 * swallow exactly one expected failure and rethrow everything else.
 */

/** gRPC ALREADY_EXISTS (code 6) — from `docRef.create()` on a doc that now exists. */
export function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 6;
}

/**
 * gRPC NOT_FOUND (code 5) — from `docRef.update()` on a doc that doesn't exist.
 * Unlike `.set(..., { merge: true })`, a strict `.update()` throws instead of
 * silently creating, so a best-effort stamp can use this to detect "the target
 * document was already deleted" without swallowing real failures.
 */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 5;
}

/**
 * gRPC FAILED_PRECONDITION (code 9) — from `docRef.update(patch, { lastUpdateTime })`
 * when the document changed after the read the patch was derived from.
 *
 * Firestore imposes no write ordering, so a read-modify-write whose patch
 * cannot be expressed as a `FieldValue` transform — a filtered array, a derived
 * total — can silently overwrite a concurrent writer. Passing the read's
 * `updateTime` as a precondition turns that silent loss into this error:
 *
 *     const snap = await ref.get();
 *     const patch = derive(snap.data());          // cannot be an increment/arrayUnion
 *     try {
 *       await ref.update(patch, { lastUpdateTime: snap.updateTime });
 *     } catch (err) {
 *       if (!isFailedPrecondition(err)) throw err;
 *       // re-READ and re-DERIVE, bounded; never retry the same `patch`
 *     }
 *
 * The retry must recompute the patch from a fresh read. Re-applying the patch
 * built from the snapshot that just lost reintroduces exactly the overwrite the
 * precondition prevented. Bound the attempts: a persistent loser is a real
 * contention problem and should surface rather than spin.
 *
 * Admin SDK only — the client SDK has no `lastUpdateTime` precondition. See
 * ADR 0011 (`apps/docs/src/content/docs/adr/0011-write-path-concurrency.md`)
 * for when this is the right rung and when a transform or a transaction is.
 */
export function isFailedPrecondition(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 9;
}
