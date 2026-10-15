/**
 * Returns (step 17, #1525) — the paths, request shapes, bound guards and wire
 * constants of the six `v2.returns.*` operations {@link ShopeeClient} runs to
 * read a return and to answer it, and the ONE reader of the three encodings of
 * a return's solution.
 *
 * The operations themselves are `api.ts`'s (`getReturnList`, `getReturnDetail`,
 * `getReturnAvailableSolutions`, `confirmReturn`, `offerReturn`,
 * `acceptReturnOffer`); their response schemas are `types.ts`'s section
 * "Returns (step 17)". This module holds what they share — the `logistica.ts`
 * split, for the same reason: `api.ts` must not grow by another step's worth of
 * request types and guards.
 *
 * ⚠️ **This module never imports `api.ts`** — the edge runs the other way
 * (`api.ts` imports this one). That is why its two numeric guards are LOCAL
 * copies of `api.ts`'s, exactly as `logistica.ts` keeps its own.
 *
 * ⚠️ **Every guard runs BEFORE the access token is asked for**, and every branch
 * is a `ShopeeConfigError` — a caller bug, never a provider failure.
 *
 * ⚠️ **No guard message carries a VALUE.** A `return_sn` identifies a buyer's
 * return, so each refusal names the FIELD, a LENGTH or a TYPE, and nothing else
 * (the `logistica.ts` rule — never `api.ts`'s older value-echoing guards).
 *
 * ⚠️ **`return_sn` travels VERBATIM** (blank refused, nothing trimmed — the
 * step-14 rule), and it is NEVER judged digits-only: the pages' own samples are
 * ALPHANUMERIC (`get_return_detail`'s `2206140TA5PM808`). Its full shape
 * (`ehReturnSnShopee`, `@delfrance/schemas`) is the APP's predicate, for ids
 * that arrive from outside — a push, a route, a URL; this package only refuses
 * what can never be one.
 *
 * ⚠️ **Deliberately absent** (deferred together, #1525 R-5): `dispute`,
 * `cancel_dispute`, `upload_proof`, `convert_image`, `query_proof` and
 * `get_return_dispute_reason`. Both disputes send the OPERATOR's email to
 * Shopee, and the other four drive nothing without them. Their dotted refusal
 * codes (`number.error`, `no.proof`) are why no returns classifier lives here
 * yet: none of the six pages above documents a dotted code.
 */
import { z } from 'zod';

import { roundReais } from '@delfrance/core/money';

import { ShopeeConfigError } from './errors';

/* -------------------------------------------------------------------------- */
/*                                 The paths                                  */
/* -------------------------------------------------------------------------- */

/** `GET` — ONE page of this shop's returns, filtered by a create and/or update window. */
export const SHOPEE_GET_RETURN_LIST_PATH = '/api/v2/returns/get_return_list';
/** `GET` — one return, by `return_sn`. The importer's only read. */
export const SHOPEE_GET_RETURN_DETAIL_PATH = '/api/v2/returns/get_return_detail';
/** `GET` — which solutions the seller may OFFER, and each one's refund bounds. */
export const SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH = '/api/v2/returns/get_available_solutions';
/** `POST` — "Confirm refund": agree to the buyer's request. ⚠️ Moves money. */
export const SHOPEE_RETURN_CONFIRM_PATH = '/api/v2/returns/confirm';
/** `POST` — propose a solution (and an adjusted amount) to the buyer. */
export const SHOPEE_RETURN_OFFER_PATH = '/api/v2/returns/offer';
/** `POST` — accept the BUYER's latest proposal. ⚠️ Moves money. */
export const SHOPEE_RETURN_ACCEPT_OFFER_PATH = '/api/v2/returns/accept_offer';

/* -------------------------------------------------------------------------- */
/*                             The wire constants                             */
/* -------------------------------------------------------------------------- */

/** `get_return_list.page_size` — "<= 100", REQUIRED. */
export const SHOPEE_RETURN_LIST_MAX_PAGE_SIZE = 100;

/**
 * Both `get_return_list` windows — "The maximum date range … is 15 days":
 * 1 296 000 seconds. ⚠️ One second past is REFUSED here, never truncated: a
 * caller that asked for more than Shopee answers would read the shorter answer
 * as the whole window.
 */
export const SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS = 1_296_000;

/**
 * The envelope `error` values the six returns pages print where their own
 * tables say "Empty if no error happened": `' '` (one SPACE) on four —
 * `get_available_solutions`, `confirm`, `offer`, `accept_offer` — and `'-'` on
 * two — `get_return_list`, `get_return_detail`. The same doc-authoring
 * contradiction `types.ts`' header records for the lost-push pair and
 * `get_package_detail`, with a NEW value, and this is the THIRD alias constant
 * (beside `SHOPEE_LOST_PUSH_ERROR_ALIASES` and
 * `SHOPEE_PACKAGE_DETAIL_ERROR_ALIASES`, `api.ts`) and the FIRST to name `' '`.
 * One constant for the six because the module is one page family with one
 * contradiction — the lost-push pair's argument.
 *
 * ⚠️ EXACT equality (`call.ts`, stage 1): `'  '`, `'\t'`, `' -'` and `'- '`
 * stay FAILURES, and `' '` stays a failure on every operation that does not
 * name this constant (`call.test.ts` and `api.test.ts` pin both).
 *
 * ⚠️ The "present `response`" half needs no flag: every returns schema is
 * `wrappedOp` with a REQUIRED `response`, so a body `{error: ' '}` with no
 * `response` passes stage 1 and dies at stage 2 as a `ShopeeSchemaError` —
 * never a success.
 *
 * ⚠️ Cost of guessing wrong: WITH the alias, a `' '` that meant failure
 * surfaces as a `ShopeeSchemaError` or as a write the importer's next re-read
 * contradicts — never a silent loss. WITHOUT it, every successful `confirm`
 * reads as a FAILURE (the operator retries a money action Shopee already ran)
 * and every import dies on `get_return_detail`.
 *
 * ⚠️ Narrow it on the first real BR call per operation (register 231): the
 * importer and the routes log the observed `error` VALUE (`erroEnvelope`),
 * never the body.
 */
export const SHOPEE_RETURNS_ERROR_ALIASES = [' ', '-'] as const;

/**
 * `ReturnSolution` as the WRITE side sends it (`offer.proposed_solution`).
 * ⚠️ Strict on purpose — outbound only. Never parse a RECEIVED solution with
 * it: the read side is an int32 on the list and the detail, the string on
 * `negotiation.latest_solution`. Read through
 * {@link normalizarSolucaoDeDevolucao}.
 */
export const shopeeReturnSolutionSchema = z.enum(['RETURN_REFUND', 'REFUND']);
export type ShopeeReturnSolution = z.infer<typeof shopeeReturnSolutionSchema>;
export const SHOPEE_RETURN_SOLUTION = {
  devolucaoEReembolso: 'RETURN_REFUND',
  soReembolso: 'REFUND',
} as const satisfies Record<string, ShopeeReturnSolution>;

/* -------------------------------------------------------------------------- */
/*                             The request shapes                             */
/* -------------------------------------------------------------------------- */

/** One return — wire `{ return_sn }` (query or body). Sent VERBATIM. */
export interface ShopeeAlvoDeDevolucao {
  readonly returnSn: string;
}

/**
 * `get_return_list` — ONE page.
 *
 * ⚠️ Deliberately NOT exposed: the `status`, `negotiation_status`,
 * `seller_proof_status` and `seller_compensation_status` filters. The sweep
 * wants every return, and the compensation filter's spelling is contradicted
 * (`NOT_REQUIRED` vs `COMPENSATION_NOT_REQUIRED`) — a wrong spelling silently
 * matches nothing. The `getOrderList` precedent.
 */
export interface GetReturnListParams {
  /**
   * A safe integer `>= 0`, sent VERBATIM. ⚠️ Page index vs entry offset, and
   * its base, are UNVERIFIED (register 235): the page's prose says "entry",
   * its name and sample say page, and "Default is 0" contradicts REQUIRED.
   */
  readonly pageNo: number;
  /** 1…{@link SHOPEE_RETURN_LIST_MAX_PAGE_SIZE}. */
  readonly pageSize: number;
  /**
   * SECONDS. Each window both bounds or neither, `from < to`, span at most
   * {@link SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS}. When BOTH windows are sent,
   * `update_time_from >= create_time_from` (the page's own error "The
   * update_time_from must be after create_time_from", refused pre-flight). An
   * update-only window is ALLOWED — whether Shopee accepts one is register 234.
   */
  readonly createTimeFromS?: number;
  readonly createTimeToS?: number;
  readonly updateTimeFromS?: number;
  readonly updateTimeToS?: number;
}

/** `offer` — wire `{ return_sn, proposed_solution, proposed_adjusted_refund_amount? }`. */
export interface OfferReturnParams extends ShopeeAlvoDeDevolucao {
  readonly proposedSolution: ShopeeReturnSolution;
  /**
   * REAIS, the wire's float. ⚠️ Absent ⇒ NO key on the wire — never `null`,
   * never `0`. ⚠️ REFUSED, never rounded, when `roundReais(v) !== v`: two
   * decimals for BR is assumed (register 238), and the package never picks an
   * amount the caller did not. The per-return min/max bounds come from
   * `get_available_solutions` and are the APP's check; Shopee's own refusal
   * stays the arbiter.
   */
  readonly proposedAdjustedRefundAmount?: number;
}

/* -------------------------------------------------------------------------- */
/*                                The guards                                  */
/* -------------------------------------------------------------------------- */

/** A wire timestamp in SECONDS: a positive safe integer. Local copy of `api.ts`'s, without the value echo. */
function assertSegundosPositivos(nome: string, valor: unknown): asserts valor is number {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) {
    throw new ShopeeConfigError(
      `${nome} deve ser um inteiro positivo em segundos (recebido: ${typeof valor}).`,
    );
  }
}

/** A money amount: finite and strictly positive. Local copy of `api.ts`'s, without the value echo. */
function assertPositivoFinito(nome: string, valor: unknown): asserts valor is number {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) {
    throw new ShopeeConfigError(`${nome} deve ser um número positivo (recebido: ${typeof valor}).`);
  }
}

/**
 * The single-return operations (`get_return_detail`, `get_available_solutions`,
 * `confirm`, `accept_offer`, and `offer` through its own guard): `return_sn` a
 * non-blank string.
 *
 * ⚠️ Judged, never rewritten — a padded id travels as given. ⚠️ The message
 * names the FIELD (and a length or a type) only.
 */
export function assertAlvoDeDevolucao(p: ShopeeAlvoDeDevolucao): void {
  const sn: unknown = p.returnSn;
  if (typeof sn !== 'string') {
    throw new ShopeeConfigError(
      `return_sn deve ser um texto (recebido: ${sn === null ? 'null' : typeof sn}).`,
    );
  }
  if (sn.trim() === '') {
    throw new ShopeeConfigError(
      `return_sn não pode ser vazio (recebido: ${String(sn.length)} caracteres em branco).`,
    );
  }
}

/**
 * One window: both bounds or neither, each in seconds, `from < to`, at most 15
 * days. `null` when neither bound was given.
 */
function lerJanela(
  campo: 'create_time' | 'update_time',
  de: unknown,
  ate: unknown,
): { readonly de: number; readonly ate: number } | null {
  if (de === undefined && ate === undefined) return null;
  // ⚠️ Half a window is REFUSED, never completed with a default: Shopee would
  // answer some window, and the caller would read it as the one it asked for.
  if (de === undefined || ate === undefined) {
    throw new ShopeeConfigError(
      `${campo}_from e ${campo}_to vão juntos — informe os dois ou nenhum (recebido só ${de === undefined ? `${campo}_to` : `${campo}_from`}).`,
    );
  }
  assertSegundosPositivos(`${campo}_from`, de);
  assertSegundosPositivos(`${campo}_to`, ate);
  if (de >= ate) {
    throw new ShopeeConfigError(`${campo}_from deve ser anterior a ${campo}_to.`);
  }
  if (ate - de > SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS) {
    throw new ShopeeConfigError(
      `a janela ${campo}_from…${campo}_to excede ${String(SHOPEE_RETURN_LIST_MAX_WINDOW_SECONDS)} segundos (15 dias) — a Shopee a recusa.`,
    );
  }
  return { de, ate };
}

/** Every `get_return_list` bound, checked BEFORE the access token is asked for. */
export function assertReturnListParams(p: GetReturnListParams): void {
  const tamanho: unknown = p.pageSize;
  if (
    typeof tamanho !== 'number' ||
    !Number.isSafeInteger(tamanho) ||
    tamanho < 1 ||
    tamanho > SHOPEE_RETURN_LIST_MAX_PAGE_SIZE
  ) {
    throw new ShopeeConfigError(
      `page_size deve ser um inteiro de 1 a ${String(SHOPEE_RETURN_LIST_MAX_PAGE_SIZE)} (recebido: ${typeof tamanho}).`,
    );
  }
  const pagina: unknown = p.pageNo;
  if (typeof pagina !== 'number' || !Number.isSafeInteger(pagina) || pagina < 0) {
    throw new ShopeeConfigError(
      `page_no deve ser um inteiro >= 0 (recebido: ${typeof pagina}) — enviado como dado, sem conversão de base.`,
    );
  }

  const porCriacao = lerJanela('create_time', p.createTimeFromS, p.createTimeToS);
  const porAtualizacao = lerJanela('update_time', p.updateTimeFromS, p.updateTimeToS);
  if (porCriacao !== null && porAtualizacao !== null && porAtualizacao.de < porCriacao.de) {
    throw new ShopeeConfigError(
      'update_time_from deve ser >= create_time_from quando as duas janelas são enviadas (a regra da própria página).',
    );
  }
}

/** Every `offer` bound, checked BEFORE the access token is asked for. */
export function assertOfferReturnParams(p: OfferReturnParams): void {
  assertAlvoDeDevolucao(p);
  // A JS caller (or a cast) can still pass anything; the type cannot.
  const solucao: unknown = p.proposedSolution;
  if (!shopeeReturnSolutionSchema.safeParse(solucao).success) {
    throw new ShopeeConfigError(
      `proposed_solution deve ser ${shopeeReturnSolutionSchema.options.join(' ou ')} (recebido: ${solucao === null ? 'null' : typeof solucao}).`,
    );
  }
  const valor: unknown = p.proposedAdjustedRefundAmount;
  if (valor === undefined) return;
  assertPositivoFinito('proposed_adjusted_refund_amount', valor);
  if (roundReais(valor) !== valor) {
    throw new ShopeeConfigError(
      'proposed_adjusted_refund_amount deve ter no máximo duas casas decimais — o arredondamento é de quem chama, nunca do pacote.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                   The solution — three encodings, one reader               */
/* -------------------------------------------------------------------------- */

/**
 * The ONE table of {@link normalizarSolucaoDeDevolucao}. A `Map`, so an
 * inherited key (`constructor`, `__proto__`) can never match.
 */
const SOLUCAO_POR_GRAFIA: ReadonlyMap<unknown, ShopeeReturnSolution> = new Map<
  unknown,
  ShopeeReturnSolution
>([
  [0, SHOPEE_RETURN_SOLUTION.devolucaoEReembolso],
  ['0', SHOPEE_RETURN_SOLUTION.devolucaoEReembolso],
  [SHOPEE_RETURN_SOLUTION.devolucaoEReembolso, SHOPEE_RETURN_SOLUTION.devolucaoEReembolso],
  [1, SHOPEE_RETURN_SOLUTION.soReembolso],
  ['1', SHOPEE_RETURN_SOLUTION.soReembolso],
  [SHOPEE_RETURN_SOLUTION.soReembolso, SHOPEE_RETURN_SOLUTION.soReembolso],
]);

/**
 * `ReturnSolution` arrives in THREE encodings of one concept: an int32 `0|1` on
 * read (`return_solution` on the list and the detail), the string enum on write
 * and on `negotiation.latest_solution`, and an unstated one in push 32's
 * `new_value` (register 236). This is the one reader of all three.
 *
 * ⚠️ A FOLD — its output drives an equality in the importer — so its SCOPE is
 * the contract, and `test/devolucoes.test.ts` pins both halves.
 * EQUAL: `0` ≡ `'0'` ≡ `'RETURN_REFUND'`; `1` ≡ `'1'` ≡ `'REFUND'`.
 * DISTINCT (→ `null`): `2`, `-1`, `'2'`, `' 0'`, `'0 '`, `'refund'` (case is
 * kept), `'RETURN_AND_REFUND'`, `'REFUND_ONLY'`, `''`, `null`, `undefined`.
 * Nothing is trimmed, case-folded or parsed: an encoding Shopee has not printed
 * reads as UNKNOWN, never as the nearest known one.
 */
export function normalizarSolucaoDeDevolucao(bruto: unknown): ShopeeReturnSolution | null {
  return SOLUCAO_POR_GRAFIA.get(bruto) ?? null;
}
