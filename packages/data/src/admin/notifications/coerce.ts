/**
 * Tolerant wire coercion for webhook payloads.
 *
 * Coerce a provider's wire value to the shape the channel's task schema expects,
 * accepting the formats providers actually send: a number, a numeric string, an
 * ISO-8601 timestamp. Anything unparseable becomes null.
 *
 * The null-not-throw policy is the point. These run in the RECEIVER, before the
 * payload is enqueued, so that a notification which later has to be persisted as
 * a failure doc can never be rejected by the collection's strict write
 * validator. Providers rename fields, send an empty string where a timestamp
 * was, and switch numbers to strings without notice — and these fields are
 * purely informational: the sweep gates on the LOCAL `processedAt`, never on
 * them. So a null here costs nothing, while a throw would cost the whole
 * notification.
 *
 * ⚠️ **Keep every coercer in this file.** A channel that hand-rolls a private
 * copy is how #810 happened: Mercado Livre's local `asInt` accepted only
 * `typeof v === 'number'` while `asMillis` — one import away — had always
 * accepted numeric strings too. A single `user_id` arriving as a string would
 * have nulled the seller id, turned EVERY notification into `no-account`, and
 * stopped repo-wide ingestion with no error, only a growing failures
 * collection. Side by side they cannot drift again.
 */
import { MILLIS_UPPER_BOUND } from '@delfrance/core/datetime';

/** A signed run of digits, and nothing else. */
const INTEGER_STRING = /^[+-]?\d+$/;

/**
 * Coerce a provider integer (seller id, application id, delivery attempt count)
 * to a safe integer, accepting a number or a numeric string.
 *
 * ⚠️ The digits-only regex is deliberate — do NOT simplify it to bare
 * `Number(s)`, which reads `''` and `'  '` as **0**, `'0x1F'` as **31** and
 * `'1e3'` as **1000**. A coerced-from-garbage id is worse than a null one: null
 * routes the notification to `no-account` (persisted, re-driven by the sweep,
 * visible), while `0` silently queries for a seller that does not exist. This
 * mirrors `normalizeApplicationId` in the Mercado Livre origin check, which
 * reached the same conclusion independently.
 *
 * The safe-integer bound matters because Zod 4's `z.number().int()` rejects
 * anything above `Number.MAX_SAFE_INTEGER`. Returning null keeps `resource` and
 * `topic` alive for the dead-letter audit trail; letting `1e21` through would
 * fail the task-schema parse and DROP the whole notification.
 */
export function asInt(v: unknown): number | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!INTEGER_STRING.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Coerce a provider timestamp to epoch millis, accepting a number, an ISO-8601
 * string, or a numeric string.
 *
 * ⚠️ NOT the same as `coerceToMillis` from `@delfrance/core/datetime`, which
 * carries a µs/ms disambiguation heuristic. This one truncates ANY finite
 * number as millis — the exact receiver semantics the live channels rely on.
 * Don't swap them.
 *
 * ⚠️ But it is BOUNDED BY that heuristic, which is not decoration. Every
 * channel's persisted `sent`/`dateCreated` field is a `millisSinceEpoch()`,
 * whose preprocess runs `coerceToMillis` and substitutes `NaN` when it refuses
 * a value — and it refuses everything in the undeterminable gap
 * `(MILLIS_UPPER_BOUND, MICROS_LOWER_BOUND)`, then divides anything above the
 * gap by 1000. So an unclamped `sent: 5e13` reached `z.number().int()` as `NaN`
 * and threw a ZodError from inside `persistFailure`, which sits OUTSIDE
 * `handleTask`'s try/catch: the throw escaped, all five queue attempts failed
 * identically, and the notification was lost. Clamping here restores the
 * promise this module's header makes — a persisted failure doc can never be
 * rejected by the strict write validator — for every channel at once.
 */
export function asMillis(v: unknown): number | null {
  return inRange(rawMillis(v));
}

/** Keep only what `millisSinceEpoch()`'s preprocess will hand back unchanged. */
function inRange(ms: number | null): number | null {
  return ms != null && Math.abs(ms) <= MILLIS_UPPER_BOUND ? ms : null;
}

function rawMillis(v: unknown): number | null {
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
