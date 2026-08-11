import { AfterSaveBlockedError } from '@delfrance/ui';

/**
 * Commit every pending listing edit as part of the produto's save.
 *
 * The order matters more than it looks. Stopping at the first failure would
 * mean a conflict on one anúncio silently discards the operator's edits to
 * another one in the same tab — they saved, they were told something went
 * wrong about a different listing, and their work is gone. So every flush is
 * attempted, and the FIRST blocker is re-thrown afterwards; `ObjectView` turns
 * an `AfterSaveBlockedError` into the form alert and skips navigating away from
 * the screen that holds the conflict modal.
 *
 * Anything that is not an `AfterSaveBlockedError` propagates immediately — a
 * listing form already narrows the errors it expects, so an escape at this
 * level is a bug and must not be swallowed.
 */
export async function flushListings(flushes: Iterable<() => Promise<void>>): Promise<void> {
  let blocked: AfterSaveBlockedError | null = null;
  for (const flush of [...flushes]) {
    try {
      await flush();
    } catch (err) {
      if (err instanceof AfterSaveBlockedError) {
        blocked ??= err;
        continue;
      }
      throw err;
    }
  }
  if (blocked) throw blocked;
}
