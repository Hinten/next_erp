/**
 * Shared gRPC error discriminators for the Admin-SDK Firestore calls in this
 * folder — single source so the code checks can't drift between call sites.
 */

/** gRPC ALREADY_EXISTS (code 6) from `docRef.create()` on a doc that now exists. */
export function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 6;
}

/**
 * gRPC NOT_FOUND (code 5) from `docRef.update()` on a doc that doesn't exist
 * (unlike `.set(..., { merge: true })`, a strict `.update()` throws instead of
 * silently creating — the UPtin migration's best-effort error stamp (#441)
 * relies on this to detect "the source PML was already deleted").
 */
export function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 5;
}
