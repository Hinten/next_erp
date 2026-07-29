/**
 * Tolerant wire coercion for webhook payloads.
 *
 * Coerce a provider timestamp to epoch millis, accepting a number, an ISO-8601
 * string, or a numeric string; anything unparseable becomes null.
 *
 * The null-not-throw policy is the point. This runs in the RECEIVER, before the
 * payload is enqueued, so that a notification which later has to be persisted as
 * a failure doc can never be rejected by the collection's strict write
 * validator. Providers rename fields, send an empty string where a timestamp
 * was, and switch numbers to strings without notice — and these fields are
 * purely informational: the sweep gates on the LOCAL `processedAt`, never on
 * them. So a null here costs nothing, while a throw would cost the whole
 * notification.
 *
 * ⚠️ NOT the same as `coerceToMillis` from `@delfrance/core/datetime`, which
 * carries a µs/ms disambiguation heuristic and returns null inside the
 * undeterminable gap. This one truncates ANY finite number as millis — the exact
 * receiver semantics the live channels rely on. Don't swap them.
 */
export function asMillis(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const iso = Date.parse(s); // ISO-8601
    if (Number.isFinite(iso)) return iso;
    const n = Number(s); // numeric string (epoch millis)
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}
