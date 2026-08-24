import { z } from 'zod';

/**
 * Numeric RESPONSE fields that survive Mercado Livre sending a number as a JSON
 * **string**.
 *
 * ## What broke
 *
 * On 2026-08-21, `GET /collections/174034247387` answered with `order_id` quoted
 * (`"2000018052464608"`) while `id` stayed a JSON number. Both were declared
 * `z.number().int()`, so Zod rejected the WHOLE body, `parseOk` raised
 * `MercadoLivreValidationError`, the pagamento never imported, the pedido stuck
 * at `emProcessamento`, and Cloud Tasks retried the identical request until the
 * notification parked (#1087).
 *
 * ⚠️ The blast radius was out of all proportion to the field: `order_id` is only
 * a FALLBACK for the order key — `parsePaymentOrderKey` prefers
 * `external_reference`, which arrived present and valid. The import had
 * everything it needed and still died, because `parseOk` validates the whole
 * body before any caller reads a field. That is why the answer is a blanket
 * sweep of `types.ts` rather than a fix to `order_id`: quoting a number is a
 * SERIALIZER-level drift, so the field it lands on next is not predictable.
 *
 * Doing it wholesale is safe in `types.ts` and only there — that file holds
 * response schemas exclusively, so widening it can never make this ERP SEND a
 * coerced value to ML.
 *
 * ## What it must never do
 *
 * ⚠️ **`z.coerce.number()` is banned, and this module is not a route to it.** It
 * reads `''` and `null` as **0**, `true` as **1** and `[]` as **0**. These are
 * money fields: a payment silently recorded as R$ 0,00 reconciles against
 * nothing and is strictly worse than the loud parse failure it would replace.
 * Anything that is not unambiguously one number is handed to `z.number()`
 * UNCHANGED, so it still fails with the same `invalid_type` issue at the same
 * `path` — which is what makes the failure diagnosable.
 *
 * ⚠️ The regex is deliberate — do NOT simplify it to a bare `Number(s)`, which
 * reads `'0x1F'` as **31** and `'1e3'` as **1000**. `asInt` in
 * `@delfrance/data/admin/notifications/coerce.ts` reached this conclusion
 * independently, for the reason it states: a coerced-from-garbage id is worse
 * than a rejected one.
 *
 * ⚠️ Deliberately NOT re-exported from `./index.ts`. Its contract is "the shapes
 * ML's own responses arrive in", not "a coercion utility". #810 is the worked
 * example of what a second, drifting copy of a coercer costs, and `index.ts` is
 * the surface `apps/mercado-livre` imports — exporting this would invite exactly
 * that. Tests import it from `../src/mlNumber` directly.
 */

/**
 * A signed decimal literal, and nothing else: an optional sign, then either
 * digits with an optional fractional part, or a bare fractional part.
 *
 * Accepts what a serializer actually emits — `'0'`, `'-3'`, `'+3'`, `'1.5'`,
 * `'123.45'`, `'0.500000'` (C `%f`), `'2000018052464608'` (a stringified id).
 *
 * Rejects, each for a stated reason:
 *  - `'1,50'`  — a pt-BR decimal comma. The live payload sends dot decimals
 *                (`1000.02`), and a locale-aware parse would read this as 1.5
 *                **or** 150 depending on the parser. Never guess a separator on
 *                a money field.
 *  - `'0x1F'`  — bare `Number()` says 31.
 *  - `'1e3'`   — bare `Number()` says 1000. JSON may write a NUMBER that way, and
 *                `JSON.parse` handles it before we ever see it; a QUOTED one is a
 *                string ML built by hand, and reading an exponent out of it is a
 *                guess.
 *  - `''`, `'  '`, `'abc'`, `'Infinity'`, `'NaN'`, `'1 000'`, `'1_000'`, `'3.'`.
 *
 * The leading `+` is accepted to match `INTEGER_STRING` in `coerce.ts`; a
 * gratuitous disagreement between two sibling coercers is how #810 started.
 */
const DECIMAL_STRING = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * The shared preprocess step. Returns a `number` when — and only when — the input
 * is a string that means exactly one number; otherwise returns the input VERBATIM
 * so the wrapped `z.number()` produces the ordinary `invalid_type`.
 */
function toNumberish(v: unknown): unknown {
  if (typeof v !== 'string') return v; // number/null/undefined/boolean pass straight through
  const t = v.trim();
  if (!DECIMAL_STRING.test(t)) return v;
  const n = Number(t);
  // ⚠️ Load-bearing, and the one hole a decimal regex does not already close.
  // `Number('9007199254740993')` is 9007199254740992 — silently rounded — and
  // `z.number()` ACCEPTS that. A rounded id IS an invented value, the one thing
  // this module promises never to produce. `mlInt()` gets the check free from
  // `.int()` (Zod 4 answers `too_big` above MAX_SAFE_INTEGER), but `card_id` is
  // an identifier declared WITHOUT `.int()`, and real ML order ids already run to
  // ~2e15 — only ~4.5x below the cliff.
  //
  // Integer strings only: no money amount approaches 2^53, and `'0.500000'` must
  // not be rejected for having a fractional part.
  //
  // No `Number.isFinite` guard is needed alongside it. A 400-digit run of `9`
  // matches the regex and overflows to `Infinity`, but `z.number()` REJECTS
  // `Infinity` (and `NaN`), so the inner schema already closes that one.
  if (!t.includes('.') && !Number.isSafeInteger(n)) return v;
  return n;
}

/** A JSON number, or a decimal string that unambiguously means one. */
export function mlNumber() {
  return z.preprocess(toNumberish, z.number());
}

/**
 * {@link mlNumber} for a field that was declared `z.number().int()`. `.int()`
 * keeps its Zod 4 semantics unchanged, including the `MAX_SAFE_INTEGER` ceiling —
 * no `.refine(Number.isSafeInteger)` is needed on top.
 */
export function mlInt() {
  return z.preprocess(toNumberish, z.number().int());
}
