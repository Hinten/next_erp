/**
 * Query-parameter readers for the Shopee taxonomy routes.
 *
 * Every taxonomy route takes an `integracaoId` plus one or two numeric or text
 * parameters, and every one of them must answer a pt-BR 400 rather than reach
 * the provider with a value nobody validated.
 *
 * ## Why hand-rolled, and why never `parseInt`
 *
 * `parseInt('100182abc')` answers `100182` and `Number('')` answers `0`. Both
 * are silent: the route would sign a perfectly valid call for the WRONG
 * category and Shopee would answer 200 with somebody else's attributes, brands
 * or bands. `env.ts` already learned this for `SHOPEE_PARTNER_ID` (a truncated
 * partner id signs cleanly and the only symptom is `error_sign` on every call),
 * so the same test lives here: `/^\d+$/` first, then `Number`, then
 * `Number.isSafeInteger`.
 *
 * `/^\d+$/` is deliberately stricter than "is a number": it rejects `1e5`,
 * `1.5`, `+1`, `-1`, `0x10` and — because the numeric readers do NOT trim —
 * ` 100182` as well. A category id past `Number.MAX_SAFE_INTEGER` is refused
 * rather than rounded: Shopee's own category ids are six digits today, but
 * brand ids already exceed int32, so "it fits" is not something to assume about
 * a provider id.
 *
 * ⚠️ **Numeric parameters are not trimmed; text ones are.** The asymmetry is
 * deliberate. Whitespace around an id is not a typo to be forgiven — nothing
 * legitimate produces it, and forgiving it here would be the one place in the
 * request path where a value is silently rewritten before validation. Around a
 * free-text `nome` it is ordinary operator input, and trimming is what makes a
 * blank field read as "absent" rather than as a one-space product name.
 *
 * ## Next-free on purpose
 *
 * These readers answer a value or a MESSAGE; turning a message into a
 * `NextResponse` is the route's job (`core/respond.ts` imports `next/server`,
 * this module must not). Same split `core/validationIssues.ts` already makes.
 */

/**
 * A parameter read: the parsed value, or the pt-BR message a route puts in its
 * 400 body.
 *
 * A discriminated union rather than `T | null`, because `null` is a legitimate
 * value for the optional readers — `lerCategoryIdOpcional` answering `null`
 * means "the caller asked for the shop-wide read", which is a different fact
 * from "the caller sent something unusable".
 */
export type LeituraParam<T> =
  | { readonly ok: true; readonly valor: T }
  | { readonly ok: false; readonly erro: string };

function ok<T>(valor: T): LeituraParam<T> {
  return { ok: true, valor };
}

function erro<T>(mensagem: string): LeituraParam<T> {
  return { ok: false, erro: mensagem };
}

/**
 * The raw parameter exactly as it arrived, or `null` when the key is absent or
 * its value is the empty string.
 *
 * The empty string counts as absent for the same reason `env.ts` blank-guards
 * every `SHOPEE_*` read: `?categoryId=` is what a form submits for an untouched
 * field, and `''` reaching the digits test would answer "deve conter apenas
 * dígitos" to a caller who sent nothing at all. Whitespace is NOT emptiness
 * here — see the header.
 */
function bruto(params: URLSearchParams, nome: string): string | null {
  const raw = params.get(nome);
  return raw !== null && raw.length > 0 ? raw : null;
}

/**
 * A positive provider id: digits only, a safe integer, strictly greater than 0.
 *
 * `> 0` and not `>= 0`: `category_id 0` is not a category on any of the nine
 * taxonomy pages. (`brand_id 0` — "No Brand" — IS real data, but it arrives in
 * a RESPONSE and never as a query parameter here.)
 */
function idPositivo(nome: string, raw: string): LeituraParam<number> {
  if (!/^\d+$/.test(raw)) return erro(`${nome} deve conter apenas dígitos.`);
  const valor = Number(raw);
  if (!Number.isSafeInteger(valor) || valor <= 0) {
    return erro(`${nome} deve ser um inteiro positivo.`);
  }
  return ok(valor);
}

/** The ERP `integracao` id every taxonomy route is scoped to. */
export function lerIntegracaoId(params: URLSearchParams): LeituraParam<string> {
  return lerTextoObrigatorio(params, 'integracaoId');
}

/** `categoryId`, required — the leaf-gated routes cannot run without one. */
export function lerCategoryIdObrigatorio(params: URLSearchParams): LeituraParam<number> {
  const raw = bruto(params, 'categoryId');
  if (raw === null) return erro('categoryId é obrigatório.');
  return idPositivo('categoryId', raw);
}

/**
 * `categoryId`, optional — `null` means the shop-wide read.
 *
 * ⚠️ `null` is a VALUE here, not a failure. `get_item_limit` documents the
 * parameter as optional and answers the per-shop bands without it, and the
 * cache keys `null` distinctly from any id (guide 209 §6: the bands differ per
 * category). An absent parameter that degraded to `0` would key the shop-wide
 * answer under a category that does not exist.
 */
export function lerCategoryIdOpcional(params: URLSearchParams): LeituraParam<number | null> {
  const raw = bruto(params, 'categoryId');
  if (raw === null) return ok(null);
  return idPositivo('categoryId', raw);
}

/** Bounds for {@link lerInteiro}. `padrao` is required: every caller has one. */
export interface OpcoesInteiro {
  readonly min: number;
  readonly max?: number;
  /** Used when the parameter is absent or empty — never when it is invalid. */
  readonly padrao: number;
  /**
   * Overrides the derived range message. Present for `status`, whose values are
   * an enumeration (`1 normal` / `2 pendente`) rather than a range — "deve estar
   * entre 1 e 2" would be true and useless.
   */
  readonly mensagem?: string;
}

/**
 * A bounded non-negative integer parameter (`offset`, `pageSize`, `status`).
 *
 * One message per parameter, whatever the reason: a caller who sent `-1`, `1.5`
 * or `1000` for `pageSize` needs the same sentence, and splitting it would mean
 * three near-identical strings to keep in step with the package bound.
 *
 * ⚠️ The bound is enforced HERE as well as in the package (`ShopeeConfigError`
 * before the fetch). That is not redundancy: this one is a 400 naming the
 * parameter the caller sent, the package's is a 500 about our own call. Neither
 * can be dropped in favour of the other.
 */
export function lerInteiro(
  params: URLSearchParams,
  nome: string,
  opcoes: OpcoesInteiro,
): LeituraParam<number> {
  const { min, max, padrao, mensagem } = opcoes;
  const foraDeFaixa =
    mensagem ??
    (max === undefined
      ? `${nome} deve ser um inteiro >= ${min}.`
      : `${nome} deve estar entre ${min} e ${max}.`);

  const raw = bruto(params, nome);
  if (raw === null) return ok(padrao);
  // Digits only: `-1`, `1.5` and `1e5` never reach `Number`, so no value is
  // silently floored, truncated or expanded into the accepted range.
  if (!/^\d+$/.test(raw)) return erro(foraDeFaixa);
  const valor = Number(raw);
  if (!Number.isSafeInteger(valor)) return erro(foraDeFaixa);
  if (valor < min) return erro(foraDeFaixa);
  if (max !== undefined && valor > max) return erro(foraDeFaixa);
  return ok(valor);
}

/** A required free-text parameter, trimmed. Blank counts as absent. */
export function lerTextoObrigatorio(params: URLSearchParams, nome: string): LeituraParam<string> {
  const raw = bruto(params, nome)?.trim();
  if (raw == null || raw.length === 0) return erro(`${nome} é obrigatório.`);
  return ok(raw);
}

/** An optional free-text parameter, trimmed. Absent or blank ⇒ `null`. */
export function lerTextoOpcional(
  params: URLSearchParams,
  nome: string,
): LeituraParam<string | null> {
  const raw = bruto(params, nome)?.trim();
  return ok(raw != null && raw.length > 0 ? raw : null);
}
