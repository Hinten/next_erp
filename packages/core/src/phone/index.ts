/**
 * Phone normalization for the standardized wire format: digits-only E.164
 * without the leading `+` (e.g. `5511999998888`) — byte-identical to the
 * WhatsApp Cloud API `wa_id`, so the future Facebook/WhatsApp integration
 * resolves clientes with a plain equality query on `telefone`.
 *
 * Legacy coexistence: the live Flutter app still writes raw 10/11-digit
 * BR numbers (DDD + subscriber, no country code). This app normalizes on
 * write only — no migration — so lookups against stored data must check
 * both shapes via `telefoneQueryShapes`.
 */

/**
 * Normalize a phone to digits-only E.164 without `+`. Strips every
 * non-digit, then prepends the BR country code to 10/11-digit inputs
 * (DDD + subscriber).
 *
 * BR assumption: any 10/11-digit input is treated as Brazilian, since that
 * is the only shape this ERP receives without a country code. A foreign
 * subscriber number of that length typed WITHOUT its country code would be
 * mis-prefixed with `55` — foreign callers must include the country code
 * (≥12 digits). Inputs of 12+ digits — already-normalized `55…` values and
 * any number that already carries a country code — pass through unchanged,
 * which makes the function idempotent.
 */
export function normalizeTelefone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

/**
 * Lenient E.164 check: 10–15 digits, country code included. Foreign
 * numbers (tipo Estrangeiro) pass as typed; empty/null is the schema's
 * nullable layer's concern, not this function's.
 */
export function isValidTelefone(value: string): boolean {
  return /^\d{10,15}$/.test(value);
}

/**
 * Every wire shape a phone may be stored under, for
 * `where('telefone', 'in', …)` dedup queries: the input as typed (digits),
 * its normalized form, and — when the input is already normalized BR —
 * the raw 10/11-digit shape the Flutter app writes.
 */
export function telefoneQueryShapes(input: string): string[] {
  const digits = input.replace(/\D/g, '');
  if (digits === '') return [];
  const shapes = new Set([digits, normalizeTelefone(digits)]);
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    shapes.add(digits.slice(2));
  }
  return [...shapes];
}
