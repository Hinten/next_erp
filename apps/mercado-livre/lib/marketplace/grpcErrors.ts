/**
 * Shared gRPC error discriminators for the Admin-SDK Firestore calls in this
 * folder — single source so the code checks can't drift between call sites.
 */

/** gRPC ALREADY_EXISTS (code 6) from `docRef.create()` on a doc that now exists. */
export function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 6;
}
