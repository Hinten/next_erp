import { z } from 'zod';

/**
 * Numeric RESPONSE fields that survive a provider sending a number as a JSON
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
 * sweep of a channel's response schemas rather than a fix to `order_id`:
 * quoting a number is a SERIALIZER-level drift, so the field it lands on next is
 * not predictable.
 *
 * Doing it wholesale is safe in a RESPONSE-schema file and only there — widening
 * a shape we READ can never make this ERP SEND a coerced value to a provider.
 *
 * ## Why it lives in `@delfrance/core` rather than in a channel
 *
 * The resource that drifted is a **Mercado Pago payment**; `/collections/{id}`
 * is merely the alias Mercado Livre's host serves it under. The same object
 * reached through `GET /v1/payments/{id}` carried the identical exposure
 * (#1251), so the rule was never Mercado-Livre-shaped to begin with. #810 is the
 * worked example of what a second, drifting private copy costs: Mercado Livre's
 * local `asInt` accepted only `typeof v === 'number'` while its sibling one
 * import away had always accepted numeric strings too, and side by side they
 * could not have drifted. ⚠️ **Do not let a channel grow its own copy of this
 * regex.**
 *
 * ⚠️ Related but deliberately NOT the same function: `asInt` in
 * `@delfrance/data/admin/notifications/coerce.ts`. That one is integer-only and
 * TRUNCATES a non-integer number, which is the right contract for a webhook
 * receiver normalizing a payload before enqueue; this one refuses anything it
 * cannot read exactly. They share the leading-`+` spelling on purpose — a
 * gratuitous disagreement between two sibling coercers is how #810 started — but
 * merging them would change both contracts.
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
 * reads `'0x1F'` as **31** and `'1e3'` as **1000**. `asInt` reached this
 * conclusion independently, for the reason it states: a coerced-from-garbage id
 * is worse than a rejected one.
 *
 * ⚠️ This module is the DEFINITION site, so it is the one place a bare
 * `z.number()` is correct. The repo-state guard
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`
 * bans it across the channel packages and deliberately does not scan
 * `packages/core`.
 *
 * ⚠️ Exposed as the `@delfrance/core/wire` SUBPATH and deliberately kept out of
 * the root barrel: `@delfrance/core`'s root is reachable from every browser
 * bundle in the monorepo (via `@delfrance/schemas`), and this is an
 * explicit-import utility, not something `formatReais` should drag along.
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
 *                string the provider built by hand, and reading an exponent out
 *                of it is a guess.
 *  - `''`, `'  '`, `'abc'`, `'Infinity'`, `'NaN'`, `'1 000'`, `'1_000'`, `'3.'`.
 *
 * The leading `+` is accepted to match `INTEGER_STRING` in `coerce.ts`; a
 * gratuitous disagreement between two sibling coercers is how #810 started.
 */
const DECIMAL_STRING = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * A provider's numeric string as a number, or `null` when it is not one.
 *
 * ⚠️ **The one place this rule is written.** Anything in this repo that has to
 * read a quoted provider number — the Zod builders below, and `asNumber` in
 * `apps/mercado-livre`'s `orderMLWire.ts`, which rebuilds the pedido's `orderML`
 * mirror off the raw order-embedded payment — calls THIS, rather than keeping
 * its own regex. See the module header for why a second copy is the bug.
 *
 * Returns `null` — never `0` — for anything it cannot read.
 */
export function parseWireDecimal(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!DECIMAL_STRING.test(t)) return null;
  const n = Number(t);
  // ⚠️ Load-bearing, and the one hole a decimal regex does not already close.
  // `Number('9007199254740993')` is 9007199254740992 — silently rounded — and
  // `z.number()` ACCEPTS that. A rounded id IS an invented value, the one thing
  // this module promises never to produce. `wireInt()` gets the check free from
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
  // called from plain, non-Zod callers (`orderMLWire`), which have no inner
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
 * ⚠️ `??`, not `||`: `parseWireDecimal('0')` is `0`, which is falsy and a
 * perfectly good amount.
 */
function toNumberish(v: unknown): unknown {
  if (typeof v !== 'string') return v; // number/null/undefined/boolean pass straight through
  return parseWireDecimal(v) ?? v;
}

/** A JSON number, or a decimal string that unambiguously means one. */
export function wireNumber() {
  return z.preprocess(toNumberish, z.number());
}

/**
 * {@link wireNumber} for a field that was declared `z.number().int()`. `.int()`
 * keeps its Zod 4 semantics unchanged, including the `MAX_SAFE_INTEGER` ceiling —
 * no `.refine(Number.isSafeInteger)` is needed on top.
 */
export function wireInt() {
  return z.preprocess(toNumberish, z.number().int());
}
