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
 * What is left is one weak in-body check: `checkApplicationId` rejects payloads
 * announcing an application that is not ours, before anything is enqueued or
 * written. `application_id` is attacker-controlled body content, so this stops
 * scanners and casual abuse — the amplification #811 is actually about — not a
 * targeted forger who has seen one of our OAuth consent URLs (they carry
 * `client_id` in the query).
 *
 * ⚠️ **The empirical question is settled — do not re-add the probe.** A
 * `logWebhookHeaders` inventory rode along on every delivery precisely to answer
 * "does ML sign anything?" from live traffic rather than from the docs. The
 * first live run (2026-08-19) answered it: **no signature header of any kind**,
 * matching the written reference. It was removed once it had done its job.
 * The remaining follow-up, if this ever needs hardening, is a secret path
 * segment on the registered callback URL — not a signature check.
 *
 * ML's published notification source IPs were considered and **declined**: an
 * undocumented rotation on their side would reject every genuine notification,
 * and ML disables a topic after roughly an hour of non-200 responses.
 */

const CLIENT_ID_ENV_VAR = 'MERCADO_LIVRE_CLIENT_ID';

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
 * ⚠️ Deliberately read off the RAW body, and this must STAY that way even
 * though `parseNotificationBody` now produces a validated payload (#810). The
 * reason is ORDERING, not typing: this gate exists to refuse a foreign payload
 * *before* anything is enqueued or written, so it necessarily runs before the
 * parse. Moving it onto the parsed payload would put an enqueue ahead of the
 * check and undo #811.
 *
 * The coercion also stays stricter than the shared `asInt` on purpose — an
 * application id is `/^[1-9]\d*$/`, never `0`, never negative — so a comparison
 * failure here is a real mismatch rather than a coercion artefact. The two
 * disagreeing is harmless and expected: `asInt` may put a coerced
 * `application_id` on the payload while this reports `absent`, which only ever
 * costs a log line, never a rejection.
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
 * outage risk. The `absent` warn below is how we would find out it ever happens;
 * tightening afterwards is a one-line change.
 */
export function checkApplicationId(body: unknown): ApplicationIdVerdict {
  const configured = configuredApplicationId();
  if (!configured) return 'skip';

  if (body == null || typeof body !== 'object' || Array.isArray(body)) return 'absent';

  const received = normalizeApplicationId((body as Record<string, unknown>).application_id);
  if (!received) return 'absent';

  return received === configured ? 'ok' : 'foreign';
}

/** Test seam — clears the once-per-instance `CLIENT_ID` malformation warning. */
export function __resetWebhookOriginState(): void {
  warnedAboutClientId = false;
}
