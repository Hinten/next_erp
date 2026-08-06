/**
 * Origin checks for the Mercado Livre notification receiver — #811.
 *
 * **There is no signature to verify.** Mercado Livre does not sign its
 * notifications: as of the 03/08/2026 revision of the Notificações reference
 * there is no `x-signature`, no timestamp, no manifest and no shared secret, and
 * the application manager exposes only the OAuth `Client_Id`/`Secret_Key` pair
 * plus the topics checklist and the callback URL. (The `ts=…,v1=…` scheme people
 * find when searching is **Mercado Pago**, a different product — implemented
 * here in `apps/mercado-pago/lib/signatures/hmac.ts`.) Hence this file rather
 * than a `verifyMlSignature` next to `lib/signatures/hmac.ts`.
 *
 * What is left is one weak in-body check plus an evidence-gatherer:
 *
 *   - `checkApplicationId` rejects payloads announcing an application that is not
 *     ours, before anything is enqueued or written. `application_id` is
 *     attacker-controlled body content, so this stops scanners and casual abuse
 *     — the amplification #811 is actually about — not a targeted forger who has
 *     seen one of our OAuth consent URLs (they carry `client_id` in the query).
 *   - `logWebhookHeaders` records what ML actually puts on the wire, so the
 *     migration window settles empirically whether a signature header exists.
 *     If one shows up, we implement the real check; if none does, the follow-up
 *     is a secret path segment on the registered callback URL.
 *
 * ML's published notification source IPs were considered and **declined**: an
 * undocumented rotation on their side would reject every genuine notification,
 * and ML disables a topic after roughly an hour of non-200 responses.
 */

const CLIENT_ID_ENV_VAR = 'MERCADO_LIVRE_CLIENT_ID';
const LOG_HEADERS_ENV_VAR = 'MERCADO_LIVRE_WEBHOOK_LOG_HEADERS';

/**
 * - `ok`      — the payload names our application.
 * - `skip`    — no usable `MERCADO_LIVRE_CLIENT_ID`; the gate is off (fail-open).
 * - `absent`  — no readable `application_id` on the body.
 * - `foreign` — a well-formed id that is not ours.
 */
export type ApplicationIdVerdict = 'ok' | 'skip' | 'absent' | 'foreign';

/**
 * Coerce an ML application id to its canonical digit string, or null when the
 * value is not one.
 *
 * Deliberately read off the RAW body instead of `parseNotificationBody`'s
 * output: that path runs `asInt`, which returns null for a numeric *string*
 * (#810 tracks it as too strict). A tolerant coercion here means a wire-format
 * wobble on ML's side can never turn genuine traffic into a 403.
 */
function normalizeApplicationId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^[1-9]\d*$/.test(trimmed) ? trimmed : null;
  }
  return null;
}

let warnedAboutClientId = false;

/** The configured application id, or null when it is unset or unusable. */
function configuredApplicationId(): string | null {
  const raw = process.env[CLIENT_ID_ENV_VAR];
  if (raw == null || raw.trim() === '') return null;

  const normalized = normalizeApplicationId(raw);
  if (!normalized && !warnedAboutClientId) {
    // Fail OPEN, but loudly: comparing against a malformed id would reject every
    // genuine notification and ML would disable the topics within the hour.
    warnedAboutClientId = true;
    console.warn(
      `[mercado-livre/webhook] ${CLIENT_ID_ENV_VAR} is not a numeric application id — origin check disabled`,
    );
  }
  return normalized;
}

/**
 * Compare the body's `application_id` against our registered ML application.
 *
 * Fail-open in two cases, both deliberate. An unconfigured/malformed
 * `MERCADO_LIVRE_CLIENT_ID` yields `skip` — mirroring `verifyMpSignature`'s
 * skip-when-unset, because a misconfigured backend must not be able to shut off
 * the genuine notification stream. A missing `application_id` yields `absent`,
 * which the receiver accepts: ML's docs carry the field in every documented
 * topic, but rejecting on absent would trade a trivial bypass-closure for a real
 * outage risk. `logWebhookHeaders` plus the `absent` warn are how we would find
 * out it ever happens; tightening afterwards is a one-line change.
 */
export function checkApplicationId(body: unknown): ApplicationIdVerdict {
  const configured = configuredApplicationId();
  if (!configured) return 'skip';

  if (body == null || typeof body !== 'object' || Array.isArray(body)) return 'absent';

  const received = normalizeApplicationId((body as Record<string, unknown>).application_id);
  if (!received) return 'absent';

  return received === configured ? 'ok' : 'foreign';
}

/** Headers whose value is logged in full (truncated) — the signature candidates. */
const VALUE_LOGGED_HEADER = /signature|signed|hmac|digest|hub|meli|mercado|token/i;
/** Headers logged as their auth scheme only — never their credential. */
const SCHEME_ONLY_HEADERS = new Set(['authorization', 'proxy-authorization']);
const MAX_LOGGED_VALUE_CHARS = 256;
/**
 * Per-instance log budget. Distinct header shapes are rare (ML sends one), so
 * this is spent during warm-up and the instance then goes quiet — bounded volume
 * without a flag to flip mid-migration. App Hosting runs `minInstances: 0`, so
 * fresh instances re-log naturally.
 */
const MAX_LOGGED_SHAPES = 20;

const loggedShapes = new Set<string>();

function authSchemeOf(value: string | null): string {
  if (!value) return 'empty';
  const scheme = value.split(' ', 1)[0] ?? '';
  return scheme.length > 0 && scheme.length <= 32 ? scheme : 'unknown';
}

/**
 * Log the inbound header inventory — the migration-window evidence for whether
 * Mercado Livre signs anything.
 *
 * Header NAMES are always safe to log and are the whole point; values are not,
 * and ML's own security guide requires masked logs — so values are emitted only
 * for the signature-candidate names, truncated, with credential headers reduced
 * to their scheme.
 *
 * `MERCADO_LIVRE_WEBHOOK_LOG_HEADERS=all` logs every request (a focused window);
 * `=off` disables it entirely. Grep Cloud Logging for `header-inventory`.
 */
export function logWebhookHeaders(req: Request): void {
  const mode = process.env[LOG_HEADERS_ENV_VAR]?.trim().toLowerCase();
  if (mode === 'off') return;

  const names: string[] = [];
  for (const [name] of req.headers) names.push(name.toLowerCase());
  names.sort();
  const shape = names.join(',');

  if (mode !== 'all') {
    if (loggedShapes.has(shape)) return;
    if (loggedShapes.size >= MAX_LOGGED_SHAPES) return; // budget spent — stay quiet
    loggedShapes.add(shape);
  }

  const values: Record<string, string> = {};
  for (const name of names) {
    if (SCHEME_ONLY_HEADERS.has(name)) {
      values[name] = `<${authSchemeOf(req.headers.get(name))}>`;
    } else if (VALUE_LOGGED_HEADER.test(name)) {
      values[name] = (req.headers.get(name) ?? '').slice(0, MAX_LOGGED_VALUE_CHARS);
    }
  }

  // `warn`, not `info`: the repo's lint config allows only warn/error, and
  // warn-level is what the rest of this receiver logs at.
  console.warn('[mercado-livre/webhook] header-inventory', { names, values });
}

/** Test seam — clears the per-instance log budget. */
export function __resetWebhookHeaderLog(): void {
  loggedShapes.clear();
  warnedAboutClientId = false;
}
