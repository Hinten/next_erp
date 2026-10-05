/**
 * The two `process.env` readers the stock core is tuned with.
 *
 * ⚠️ Reading `process.env` is legal under `admin/` — these subpaths are
 * server-only by construction and `admin/cache/readCache.ts:301` and
 * `admin/oauthState/pkce.ts:58` already do it. What is NOT legal here is
 * reading a CHANNEL's env name: the quantity core (`./quantidades`) takes every
 * tunable as a required parameter precisely so one arithmetic can serve two
 * marketplaces with different names, defaults and pinned values. These helpers
 * are the plumbing each channel's own reader is written with, never a back door
 * into the core.
 */

/**
 * Read a non-negative integer tunable from `process.env` — LAZILY, at call
 * time, so tests can mutate the env and a value change needs only a redeploy,
 * never a code edit. Unset/blank/non-integer/negative → `fallback`.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Read a boolean env flag — true only when the value is exactly `'1'`. */
export function envFlag(name: string): boolean {
  return process.env[name] === '1';
}
