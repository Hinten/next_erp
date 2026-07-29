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
