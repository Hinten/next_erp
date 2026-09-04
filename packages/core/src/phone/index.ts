/**
 * Phone normalization for the standardized wire format: digits-only E.164
 * without the leading `+` (e.g. `5511999998888`) — byte-identical to the
 * WhatsApp Cloud API `wa_id`, so the future Facebook/WhatsApp integration
 * resolves clientes with a plain equality query on `telefone`.
 *
 * Legacy shapes in the corpus: the stored data is full of raw 10/11-digit BR
 * numbers (DDD + subscriber, no country code) — that is what the legacy app
 * wrote, and those rows arrive with the migration. This app normalizes on write
 * only — no backfill — so lookups against stored data must check both shapes
 * via `telefoneQueryShapes`.
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
 * the raw 10/11-digit shape the migrated corpus stores (the header note:
 * legacy rows arrive that way, so both encodings must be queried).
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

/* --------------------------------- display --------------------------------- */

/**
 * Drop the BR country code from a stored phone, yielding the local number
 * (DDD + subscriber) as digits. The inverse of {@link normalizeTelefone} for
 * the BR case, and a no-op for everything else:
 *
 *  - legacy raw values are 10/11 digits, so they can never be mistaken for a
 *    normalized one;
 *  - a foreign number keeps its own country code, since only `55` is stripped.
 */
export function localTelefone(input: string): string {
  const digits = input.replace(/\D/g, '');
  return (digits.length === 12 || digits.length === 13) && digits.startsWith('55')
    ? digits.slice(2)
    : digits;
}

/**
 * Null-preserving {@link localTelefone}, for a wire that wants the local BR
 * shape and OMITS the field when there is no phone: an empty, `null` or
 * absent value stays absent instead of becoming an empty string.
 *
 * Exists because two surfaces send the same phone to the same provider — the
 * Melhor Envio cart mapper in `apps/web` and the `debug-me-cart` diagnostic
 * that reproduces it — and a wrapper duplicated across them is a rule the
 * compiler cannot diff. They had already drifted (one yielded `null`, the
 * other `undefined`) before this was shared; the remaining difference is now
 * one `?? undefined` at the call site that needs it, not a second copy of the
 * rule.
 */
export function localTelefoneOrNull(input: string | null | undefined): string | null {
  return input ? localTelefone(input) : null;
}

/**
 * Mask a BR **local** number: 11 digits → `(00) 00000-0000`, 10 →
 * `(00) 0000-0000`. Any other length is returned unchanged.
 *
 * Takes the local shape, not this repo's stored shape — for a stored value use
 * {@link formatTelefone}. The two are separate because the DANFE renders the
 * `fone` parsed back out of a SIGNED XML, which is in SEFAZ's shape (6–14
 * digits, no country code — the opposite of this repo's standard). A fiscal
 * document must show the value that is in the signed XML, so it masks without
 * ever stripping.
 */
export function formatTelefoneLocal(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 11)
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10)
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return input;
}

/**
 * Format a telefone **as this repo stores it** — strip the `55`, then mask.
 *
 * Stripping happens inside the formatter on purpose. The two steps used to be
 * separate, and the `55`-stripping half lived inlined in a single page, so
 * every other surface (the orçamento, the comum sheet, the etiqueta genérica)
 * printed a 13-digit `5511999998888` raw: `formatTelefoneLocal` returns any
 * non-10/11-digit input unchanged. Folding them together removes the class of
 * bug rather than one instance — no call site can forget the first step.
 */
export function formatTelefone(input: string): string {
  const local = localTelefone(input);
  const masked = formatTelefoneLocal(local);
  // `formatTelefoneLocal` echoes its INPUT when it cannot mask; for a foreign
  // or malformed number return the caller's original string, not the stripped
  // digits, so nothing is silently mangled.
  return masked === local ? input : masked;
}
