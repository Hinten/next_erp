/**
 * The mirror's ordering guard — ADR 0011 tier 2 (an event-clock watermark).
 *
 * Firestore triggers are delivered at least once and in NO guaranteed order, and a
 * retry can arrive days after a newer event. So the mirror never trusts the event:
 * it re-reads the source document and stamps what it SAW with the source's own
 * clock — the document's `updateTime` when it exists, or the read's `readTime`
 * when it does not. Every observation of one path is then totally ordered, and the
 * target keeps, per path, the stamp of the newest observation it applied.
 *
 * Why `readTime` is a sound stamp for an absence: a delete committed at `t1` is
 * only observed by a read at `r ≥ t1`, and a re-create at `t2` that the read did
 * not see must have committed after it (`t2 > r`), so its `updateTime` sorts after
 * the absence. An absence and a presence can therefore never tie.
 *
 * Pure and total: no clock, no I/O.
 */

/** The source's commit clock, as Firestore's `Timestamp` exposes it. */
export interface Stamp {
  readonly seconds: number;
  readonly nanoseconds: number;
}

/** What one read of the source document saw. */
export interface Observation {
  readonly exists: boolean;
  readonly stamp: Stamp;
}

/** The newest observation already applied to the target for one path. */
export interface Watermark {
  readonly exists: boolean;
  readonly stamp: Stamp;
}

export type Decision = 'apply' | 'skip';

/** Negative when `a` is older than `b`, zero when equal, positive when newer. */
export function compareStamps(a: Stamp, b: Stamp): number {
  return a.seconds !== b.seconds ? a.seconds - b.seconds : a.nanoseconds - b.nanoseconds;
}

/**
 * Apply an observation unless the target already holds a NEWER one.
 *
 * An EQUAL stamp applies on purpose: it is the same version observed twice (a
 * duplicate delivery, or the replay re-reading a document nothing changed since),
 * and re-writing it is idempotent. Refusing it instead would make the replay unable
 * to repair a document the import overwrote AFTER the mirror had already stamped it
 * — the import does not touch the watermark, so the stamp still says "current"
 * while the document holds the older T0 version.
 */
export function decide(observed: Observation, applied: Watermark | null): Decision {
  if (applied === null) return 'apply';
  return compareStamps(observed.stamp, applied.stamp) >= 0 ? 'apply' : 'skip';
}

/** Thrown when a stored watermark is not one this module wrote. */
export class CorruptWatermarkError extends Error {
  constructor(path: string, detail: string) {
    super(`legacy-mirror: watermark for '${path}' is malformed (${detail}).`);
    this.name = 'CorruptWatermarkError';
  }
}

function isStamp(value: unknown): value is Stamp {
  if (typeof value !== 'object' || value === null) return false;
  const { seconds, nanoseconds } = value as { seconds?: unknown; nanoseconds?: unknown };
  return Number.isInteger(seconds) && Number.isInteger(nanoseconds);
}

/**
 * Read a stored watermark document. `undefined` (no document) is "nothing applied
 * yet"; anything else this module did not write is refused rather than guessed at,
 * because treating it as absent would let a stale observation win.
 */
export function parseWatermark(path: string, data: unknown): Watermark | null {
  if (data === undefined) return null;
  if (typeof data !== 'object' || data === null) {
    throw new CorruptWatermarkError(path, 'not an object');
  }
  const { exists, stamp } = data as { exists?: unknown; stamp?: unknown };
  if (typeof exists !== 'boolean') throw new CorruptWatermarkError(path, '`exists` not boolean');
  if (!isStamp(stamp)) throw new CorruptWatermarkError(path, '`stamp` not a timestamp');
  return { exists, stamp };
}
