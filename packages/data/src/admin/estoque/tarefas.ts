/**
 * The Cloud Tasks body budget every stock sender chunks against.
 *
 * Shared rather than copied because the number is an arithmetic fact about
 * firebase-admin's enqueue (`{ data: task }`, UTF-8, then Base64) and about
 * Cloud Tasks' own limit — not a channel preference. A per-channel copy would
 * drift the moment one of them "rounded" it, and the failure is a task that is
 * rejected at enqueue time, i.e. a whole page of listings never sent.
 *
 * `Buffer` is fine under `admin/` — these subpaths are server-only and
 * `admin/oauthState/state.ts:92` and `admin/cargoClaims/claims.ts:74` already
 * use it.
 */

/**
 * Conservative budget for the Base64 body stored on the Cloud Task. The REST
 * reference still documents a 100 KB task limit while the quota page documents
 * 1 MiB, so 80 KiB leaves room for the task envelope under the stricter value.
 */
export const STOCK_TASK_ENCODED_BODY_BUDGET_BYTES = 80 * 1024;

/** Early warning at 80% of the task-body budget. */
export const STOCK_TASK_ENCODED_BODY_WARN_BYTES = 64 * 1024;

/** Mirror firebase-admin's `{ data: task }` UTF-8 body followed by Base64 encoding. */
export function stockTaskEncodedBodyBytes(task: unknown): number {
  const json = JSON.stringify({ data: task });
  const encoded = Buffer.from(json, 'utf8').toString('base64');
  return Buffer.byteLength(encoded, 'ascii');
}
