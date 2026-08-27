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
 * ## Which answer is right where — the repo convention, settled in #1251
 *
 * The three integration packages had reached three different answers to the same
 * question. They are not interchangeable, and the deciding fact is always the
 * DIRECTION of the shape and whether the provider is documented to vary:
 *
 *  1. **A RESPONSE field → `wireNumber()` / `wireInt()`.** The default. A quoted
 *     value must never cost the whole resource. Enforced by
 *     `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`
 *     across `mercado-livre`, `mercado-pago` and `freight-br`.
 *  2. **A REQUEST field → a strict `z.number()`.** Tolerance is the wrong
 *     direction outbound: accepting a stringified number means FORWARDING one,
 *     and the provider answers a bad body with an opaque 4xx. Melhor Envio's
 *     `dimensionsWeightSchema`, `calculateRequestSchema.options.insurance_value`
 *     and `cartInsertRequestSchema.service` are the worked examples — they live
 *     in the same `types.ts` as response shapes, and are carve-outs in the guard
 *     with their reason written down.
 *  3. **`z.union([z.string(), z.number()])` — only when the provider is KNOWN to
 *     vary by endpoint, or when the field is not always numeric.** Melhor Envio's
 *     `price` / `custom_price` / `discount` (strings in `calculate`, numbers in
 *     the cart 201) and Mercado Livre's `street_number` (`'S/N'`, `'123-A'`) are
 *     the two shapes of this case. Read them through ONE named function —
 *     `parseMePrice` — never a local `Number()`.
 *
 * ⚠️ Modelling money as `z.string()` and parsing at the edge, which is where
 * `freight-br` started, is **not** a fourth answer: it is the MIRROR of #1087.
 * The day the provider sends a JSON number, the parse fails and takes the whole
 * response with it — and for `calculate`, whose body is an array, that is every
 * quote at once.
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

/** This repo's JSON error envelope, as every channel route emits it. */
export interface EnvelopeDeErro {
  error?: string;
  code?: string;
  issues?: string[];
}

/**
 * Read a non-2xx body as our `{ error, code, issues }` envelope, or `null` when
 * it is not one.
 *
 * ⚠️ The object-ness check is the point. Every client used to do a bare
 * `parsed as { error?: string }`, so a JSON body that happened to be an ARRAY or
 * a scalar was read as the envelope and `errBody?.error` came back `undefined`,
 * quietly discarding the real status message. `3a4b7278` fixed exactly this in
 * the Mercado Livre client and the three siblings never got the same treatment.
 */
export function envelopeDeErro(parsed: unknown): EnvelopeDeErro | null {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  return {
    ...(typeof obj.error === 'string' ? { error: obj.error } : {}),
    ...(typeof obj.code === 'string' ? { code: obj.code } : {}),
    ...(Array.isArray(obj.issues) ? { issues: obj.issues.map((i) => String(i)) } : {}),
  };
}

/**
 * What {@link lerRespostaJson} found. Three outcomes, because the three need
 * different words in front of an operator: the request never reached a route
 * that answers JSON, it reached one and the body was not what we claimed, or it
 * worked.
 */
export type LeituraResposta<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly motivo: 'nao-json'; readonly texto: string }
  | { readonly ok: false; readonly motivo: 'formato'; readonly campos: string[] };

/**
 * Read a 2xx response body against the schema that describes it.
 *
 * ## What it replaces
 *
 * Six near-identical HTTP clients in this repo ended their success path with
 * `return parsed as T` — a compile-time assertion with no runtime check. On a
 * 2xx the caller got whatever arrived wearing a type nobody verified, and the
 * three failure modes were all silent:
 *
 * | body on a 2xx | what the caller used to receive |
 * | --- | --- |
 * | the wrong shape | the object, cast; missing fields simply `undefined` |
 * | empty | `null as T`, blowing up later at the first property access |
 * | not JSON (a proxy's HTML) | `null as T`, or worse `{error: '<html>…'} as T` — a TRUTHY object, so `if (conta)` guards pass and `conta.connected` reads `undefined` |
 *
 * ## Why it returns instead of throwing
 *
 * Each client owns an error taxonomy its callers already narrow on
 * (`MercadoLivreClientHttpError`, `FreightValidationError`, …). Throwing a type
 * from here would be a class none of those `instanceof` chains know, which in
 * `apps/web` means an unhandled rejection rather than a message. Handing back a
 * result lets each client raise its own, and keeps `@delfrance/core`
 * channel-agnostic.
 *
 * ## Why it takes text rather than a Response
 *
 * Every caller has already read the body — they must, to build an error from a
 * non-2xx. Taking the string keeps this pure, keeps the status/verb/error
 * mapping where it belongs, and makes it testable without a fetch.
 *
 * ⚠️ **An empty body is a failure unless the schema says otherwise.** `texto`
 * of length zero parses as `null`, so a schema admitting it (`z.null()`,
 * `z.void()`, `z.unknown()`) opts in explicitly and every other schema rejects
 * it. That is what stops `null as T` from being reachable at all.
 *
 * ⚠️ **`campos` carries field PATHS and never values.** A response body is a
 * live credential often enough — an ML test user's `password` is one, and ML
 * reissues none — and these strings end up in `err.message`, which reaches
 * logs, an operator's screen, and (on the server clients) the durable failure
 * doc the notification pipeline writes. Same rule, and the same reason, as
 * `parseOk` in `packages/integrations/mercado-livre/src/api.ts` (#1015).
 */
export function lerRespostaJson<S extends z.ZodType>(
  texto: string,
  schema: S,
): LeituraResposta<z.infer<S>> {
  let parsed: unknown = null;
  if (texto.length > 0) {
    try {
      parsed = JSON.parse(texto);
    } catch (err) {
      // Narrow, per repo rule 6: only a malformed body is ours to report.
      if (err instanceof SyntaxError) return { ok: false, motivo: 'nao-json', texto };
      throw err;
    }
  }

  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, data: result.data as z.infer<S> };

  return { ok: false, motivo: 'formato', campos: camposInvalidos(result.error.issues) };
}

/** How many distinct paths a message may name before it stops being readable. */
const MAX_CAMPOS = 12;

/**
 * The distinct field paths a failed parse blames, as text.
 *
 * ⚠️ **Array indices are collapsed to `[]` BEFORE de-duplicating**, and that is
 * the whole point rather than cosmetics. `issue.path` carries the index, so one
 * wrong column in a 200-row response yields 200 *distinct* paths
 * (`linhas.0.id` … `linhas.199.id`) and a plain `new Set` collapses none of
 * them. The message then names one field two hundred times and buries every
 * other failure in it — and on the server clients that message is what gets
 * persisted into the failure doc, so it is the only record anyone gets.
 * `linhas[].id` says the same thing once.
 *
 * ⚠️ Exported because every hand-rolled copy loses both properties. The one in
 * `freight-br/src/melhor-envio/api.ts` de-duplicated AFTER the index was baked
 * into the path, and its schemas include `calculateResponseSchema` (an ARRAY),
 * so one null `name` across a 20-option quote produced twenty entries —
 * `0.name, 1.name, … 19.name` — in a message the route hands to the browser.
 */
export function camposInvalidos(issues: readonly z.core.$ZodIssue[]): string[] {
  const vistos = new Set<string>();
  for (const issue of issues) {
    const caminho = issue.path
      .map((seg) => (typeof seg === 'number' ? '[]' : String(seg)))
      .join('.')
      .replace(/\.\[\]/g, '[]');
    vistos.add(caminho === '' ? '(raiz)' : caminho);
  }
  const campos = [...vistos];
  // A backstop for the other direction: a body that disagrees about EVERY field
  // is one fact ("this is not the shape we asked for"), not forty.
  if (campos.length <= MAX_CAMPOS) return campos;
  return [...campos.slice(0, MAX_CAMPOS), `…e mais ${String(campos.length - MAX_CAMPOS)}`];
}
