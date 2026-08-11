/**
 * Read-cache hit rates, shaped for one structured log field.
 *
 * The primitive's own sampler is deliberately off at every adoption site
 * (`sampleEvery: 0`): it writes through `console.warn`, the wrong severity for a
 * metric, and at its default of 500 gets an instance serving fewer logs nothing
 * at all — which is most of them. So the numbers are emitted here instead, at
 * the boundaries that already log a summary line.
 *
 * ⚠️ `readCacheStatsSnapshot()` counters are CUMULATIVE for the process
 * lifetime. They survive `clear()` and reset only via `__resetAllReadCaches`. A
 * raw cumulative number therefore cannot answer "what was the hit rate for THIS
 * sweep" — that is what `readCacheDelta` is for. Per-task handlers want the
 * cumulative form: a task has no tick to bracket, and consecutive lines from one
 * warm instance are diffable after the fact.
 */
import { type ReadCacheStats, readCacheStatsSnapshot } from './readCache';

/** `<hits>/<misses>` per cache, or `null` when no cache has been touched yet. */
export type CacheReport = Record<string, string> | null;

function format(hits: number, misses: number): string {
  const total = hits + misses;
  const pct = total === 0 ? 0 : Math.round((hits / total) * 100);
  return `${hits}/${misses} (${pct}%)`;
}

/**
 * Cumulative hits/misses per cache since this instance started.
 *
 * `null` only when NO cache has been constructed in this process — caches
 * register at construction (module load), not on first use, so in practice this
 * means the code path never imported one.
 *
 * ⚠️ The kill switch (`DATA_READ_CACHE_DISABLED=1`) does NOT produce `null`: it
 * short-circuits inside `get`, before any counter moves, so every cache reports
 * `0/0`. All-zeroes across the board is therefore the switch's signature — and
 * also what a genuinely idle instance looks like, so read it against the rest of
 * the log line rather than on its own.
 */
export function readCacheSummary(): CacheReport {
  const snapshot = readCacheStatsSnapshot();
  if (snapshot.length === 0) return null;
  return Object.fromEntries(snapshot.map((s) => [s.name, format(s.hits, s.misses)]));
}

/** Snapshot to bracket a tick with. Pass it to `readCacheDelta` when the tick ends. */
export function readCacheMark(): readonly ReadCacheStats[] {
  return readCacheStatsSnapshot();
}

/**
 * Hits/misses accrued BETWEEN a `readCacheMark()` and now — the per-tick number.
 * A cache that first registered inside the tick is included with its full count.
 */
export function readCacheDelta(before: readonly ReadCacheStats[]): CacheReport {
  const snapshot = readCacheStatsSnapshot();
  if (snapshot.length === 0) return null;
  const baseline = new Map(before.map((s) => [s.name, s]));
  return Object.fromEntries(
    snapshot.map((s) => {
      const prev = baseline.get(s.name);
      return [s.name, format(s.hits - (prev?.hits ?? 0), s.misses - (prev?.misses ?? 0))];
    }),
  );
}
