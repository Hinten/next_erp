/**
 * Origin gates for the Mercado Livre notification receiver — #811.
 *
 * ML does **not** sign notification bodies: there is no `x-signature`, no HMAC
 * header, nothing in any documented topic payload (contrast Mercado Pago's
 * `x-signature`, Meta's `X-Hub-Signature-256` and Melhor Envio's
 * `X-ME-Signature`, all verified by their receivers via `lib/signatures/hmac.ts`).
 * So a signature check is not available here, and `lib/signatures/hmac.ts` stays
 * unused by this channel's webhook.
 *
 * What ML's security guide (`developers.mercadolivre.com.br` →
 * "Segurança de aplicações" → "Segurança em notificações") does prescribe, and
 * what this module implements:
 *
 *  1. `application_id` — every documented notification carries the id of the
 *     application the subscription belongs to. Ours is `MERCADO_LIVRE_CLIENT_ID`
 *     (in ML, the application id and the OAuth `client_id` are the same number).
 *     A payload stamped with someone else's app id cannot be a genuine ML
 *     notification for us.
 *  2. A published **source-IP allow-list**. ML documents its 8 sender IPs but
 *     warns "os IPs podem mudar", so this check is OPT-IN: it runs only when
 *     `MERCADO_LIVRE_WEBHOOK_ALLOWED_IPS` is set (the published list ships as a
 *     commented, paste-ready value in the repo-root `.env.example`). Blank ⇒ off,
 *     so an ML-side infra change can never silently black-hole genuine traffic.
 *  3. A **payload size cap** (ML suggests 1 MB), checked before the body is ever
 *     buffered.
 *
 * These are amplification guards, not data-integrity guards: the real anchor
 * stays the handler re-fetching the resource from the ML API with the seller's
 * own token before acting (ML's own "não confiar nos dados do webhook").
 *
 * Every env var is read LAZILY at call time (never at module load) so App
 * Hosting's runtime env and `vi.stubEnv` both work.
 */

/** ML's suggested maximum notification payload — 1 MiB. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

function envValue(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalize an ML numeric id to its textual form. ML is NOT consistent about
 * these: the docs' own `missed_feeds` sample carries `"user_id":"465432224"` as
 * a **string** while every other sample sends a number — so both shapes must be
 * accepted or a genuine notification would be rejected.
 */
function asIdString(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Compare two ML ids. The textual comparison is exact; the numeric fallback
 * exists for ids above `Number.MAX_SAFE_INTEGER`, where `JSON.parse` has already
 * rounded the wire value to the nearest double — applying the same rounding to
 * the configured id makes the two comparable again.
 */
function sameId(a: string, b: string): boolean {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

/**
 * Is this payload stamped with OUR registered ML application id?
 *
 * Takes the RAW parsed body rather than `parseNotificationBody`'s output on
 * purpose: that function's `asInt` coercion drops a numeric **string** to
 * `null`, which would 401 a genuine notification (see `asIdString` above).
 *
 * Fails OPEN when `MERCADO_LIVRE_CLIENT_ID` is unset — mirrors
 * `verifyMpSignature` in apps/mercado-pago. A 5xx/4xx on a missing env var
 * would make ML retry 8× over an hour and then DEACTIVATE the topic, which
 * costs far more than the check buys. An absent or foreign `application_id`
 * with the var set is rejected (allowlist, not blocklist).
 */
export function isExpectedApplication(body: unknown): boolean {
  const expected = envValue('MERCADO_LIVRE_CLIENT_ID');
  if (!expected) {
    console.warn(
      '[mercado-livre/webhook] MERCADO_LIVRE_CLIENT_ID is not set — application_id gate disabled',
    );
    return true;
  }
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return false;
  const received = asIdString((body as Record<string, unknown>).application_id);
  return received != null && sameId(received, expected);
}

/**
 * The client IP as seen through Firebase App Hosting's Google load balancer.
 *
 * ⚠️ The LEFT-most `X-Forwarded-For` entry is whatever the caller sent — it is
 * attacker-controlled and must never be trusted. Google's external ALB APPENDS
 * to the header, producing `<client-supplied…>, <real client ip>, <lb ip>`, so
 * the trustworthy entry is the **second from the right**. With a single entry
 * (local dev, a direct call, tests) there is no proxy to distrust, so it is used
 * as-is.
 */
function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const candidate = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (candidate) return normalizeIp(candidate);
  }
  const real = req.headers.get('x-real-ip')?.trim();
  return real ? normalizeIp(real) : null;
}

/** Strip the IPv4-mapped IPv6 prefix so `::ffff:18.215.140.160` matches the list. */
function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
}

/**
 * Is this request coming from one of ML's published sender IPs?
 *
 * OPT-IN: with `MERCADO_LIVRE_WEBHOOK_ALLOWED_IPS` unset (or blank) every IP is
 * allowed and the check costs one env read. ML warns its list can change, so the
 * addresses live in env — updating them is a config edit, never a deploy.
 */
export function isAllowedSourceIp(req: Request): boolean {
  const csv = envValue('MERCADO_LIVRE_WEBHOOK_ALLOWED_IPS');
  if (!csv) return true;
  const allowed = csv
    .split(',')
    .map((ip) => normalizeIp(ip.trim()))
    .filter(Boolean);
  if (allowed.length === 0) return true;
  const ip = clientIp(req);
  return ip != null && allowed.includes(ip);
}

/**
 * Is the declared body larger than the cap? Checked BEFORE `req.text()` so an
 * oversized forged POST is never buffered into the instance's memory. A body with
 * no `Content-Length` (chunked) passes — Cloud Run caps request size itself.
 */
export function isBodyTooLarge(req: Request): boolean {
  const header = req.headers.get('content-length');
  if (!header) return false;
  const bytes = Number(header);
  return Number.isFinite(bytes) && bytes > MAX_WEBHOOK_BODY_BYTES;
}
