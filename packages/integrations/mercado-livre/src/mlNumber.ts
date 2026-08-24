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
 * A Mercado Livre numeric string as a number, or `null` when it is not one.
 *
 * ⚠️ **The one place this rule is written.** Anything else in this repo that has
 * to read a quoted ML number — the Zod builders below, and `asNumber` in
 * `apps/mercado-livre`'s `orderMLWire.ts`, which rebuilds the pedido's `orderML`
 * mirror off the raw order-embedded payment — calls THIS, rather than keeping its
 * own regex. That is the whole lesson of #810: Mercado Livre's private `asInt`
 * accepted only `typeof v === 'number'` while its sibling one import away had
 * always accepted numeric strings too, and side by side they could not have
 * drifted. A second copy of the rule here would repeat it exactly.
 *
 * Returns `null` — never `0` — for anything it cannot read.
 */
export function parseMlDecimal(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!DECIMAL_STRING.test(t)) return null;
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
  if (!t.includes('.') && !Number.isSafeInteger(n)) return null;
  // ⚠️ And the DECIMAL half of the same overflow. `'9'.repeat(400)` is caught
  // above (no dot, not a safe integer), but `'9'.repeat(400) + '.5'` skips that
  // branch and is `Infinity`. `z.number()` rejects `Infinity`, so the Zod
  // builders below would have been fine either way — but this function is also
  // called from a plain, non-Zod caller (`orderMLWire`), which has no inner
  // schema to catch it. Relying on the consumer is precisely the assumption that
  // breaks the moment a second one appears.
  return Number.isFinite(n) ? n : null;
}

/**
 * The shared preprocess step. Returns a `number` when — and only when — the input
 * is a string that means exactly one number; otherwise returns the input VERBATIM
 * so the wrapped `z.number()` produces the ordinary `invalid_type` at the right
 * `path`.
 *
 * ⚠️ `??`, not `||`: `parseMlDecimal('0')` is `0`, which is falsy and a perfectly
 * good amount.
 */
function toNumberish(v: unknown): unknown {
  if (typeof v !== 'string') return v; // number/null/undefined/boolean pass straight through
  return parseMlDecimal(v) ?? v;
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
