/**
 * `GET /post-purchase/v1/claims/search` — its parameter surface, and the
 * preconditions ML documents for it.
 *
 * ⚠️ **The typed method used to accept `status | stage | limit | offset` and
 * nothing else, which means it could not express a single one of ML's own
 * recommended filters.** Not `players.*`, not `order_id`, not `pack_id`, not
 * `resource`+`resource_id`, not `range` or `sort`. Its one caller
 * (`importIncidentsMl`) therefore sent `status: 'opened'` with paging — a shape
 * ML's *Gerenciar reclamações* page now calls out by name:
 *
 *  - *"Consultas com somente `status=opened` são tecnicamente válidas, porém
 *    altamente ineficientes"* — an unbounded scan of the search engine, with
 *    *"risco de rate limiting ou bloqueio da aplicação se o padrão persistir"*;
 *  - and its **"Recomendação geral"**: always include `players.user_id` +
 *    `players.role` when filtering by a global criterion.
 *
 * So the params widen to the documented set, and the preconditions are checked
 * **before the request** — an invalid query is a local throw rather than a round
 * trip that comes back 400.
 *
 * ⚠️ **Being inefficient is not the same as being invalid, and the difference is
 * the whole design of {@link validateClaimSearchParams}.** A bare `status` is
 * documented as *technically valid*, so a guard that refused it would be a guard
 * that is wrong; it warns instead. What is genuinely refused is the shape ML
 * answers 400 to — above all **paging with no filter beside it**, which is what
 * had `capture:fixtures` aborting on every run (#1357).
 */
import { MercadoLivreClaimSearchParamsError } from './errors';

/**
 * Every parameter `…/claims/search` accepts.
 *
 * ⚠️ Values stay `string | number | undefined` so this object is assignable to
 * `RequestOpts['query']` verbatim: `buildUrl` (`api.ts`) skips `undefined` and
 * feeds each key to `URLSearchParams.set`, which leaves a `.` unescaped — so the
 * dotted names reach ML exactly as documented.
 *
 * ⚠️ **A `type` alias, not an `interface`, and that is load-bearing.** Only an
 * object-literal type alias gets TypeScript's *implicit index signature*, which
 * is what makes it assignable to `Record<string, string | number | undefined>`.
 * As an `interface` the assignment to `RequestOpts['query']` fails, and the only
 * ways out are a cast or a hand-copied query object — one unchecked, the other a
 * second list of parameter names to drift.
 */
export type MlClaimSearchParams = {
  /* -------------------------------- filters ------------------------------- */
  readonly id?: number;
  /** `mediations` · `return` · `fulfillment` · `ml_case` · `cancel_sale` · `cancel_purchase` · `change` · `service`. */
  readonly type?: string;
  /** `claim` · `dispute` · `recontact` · `stale` · `none`. */
  readonly stage?: string;
  /** `opened` · `closed`. ⚠️ Valid alone, but see the warning in {@link validateClaimSearchParams}. */
  readonly status?: string;
  /** `shipment` · `payment` · `order` · `purchase`. Needs a companion — see below. */
  readonly resource?: string;
  readonly resource_id?: number;
  readonly reason_id?: string;
  readonly site_id?: string;
  /** `complainant` · `respondent`. Paired with {@link MlClaimSearchParams['players.user_id']}. */
  readonly 'players.role'?: string;
  readonly 'players.user_id'?: number;
  /** Mutually exclusive with `pack_id`. */
  readonly order_id?: number;
  /** Mutually exclusive with `order_id`. */
  readonly pack_id?: number;
  /** Converted internally by ML to an `order_id`. */
  readonly payment_id?: number;
  readonly parent_id?: number;
  /** Use with `range`. ⚠️ ML requires milliseconds in the timestamp. */
  readonly date_created?: string;
  /** Use with `range`. ⚠️ ML requires milliseconds in the timestamp. */
  readonly last_updated?: string;

  /* ------------------------- paging / ordering ---------------------------- */
  /** Max 9999. ⚠️ `offset + limit` must stay **below** 10000. */
  readonly offset?: number;
  /** Default 30, max 100 — ML silently clamps anything larger. */
  readonly limit?: number;
  /** `campo:asc` or `campo:desc`. */
  readonly sort?: string;
  /** `campo:after:data,before:data`. ⚠️ Every timestamp needs milliseconds. */
  readonly range?: string;
};

/**
 * The keys that count as a FILTER, verbatim from ML's own 400 body:
 *
 * ```
 * "message": "at least any of these filters: id, type, stage, status,
 *             resource, resource_id, reason_id, site_id,
 *             players.role, players.user_id,
 *             order_id, pack_id, payment_id, parent_id,
 *             date_created, last_updated"
 * ```
 *
 * ⚠️ `offset`, `limit`, `sort` and `range` are deliberately **absent**. That is
 * the distinction the docs are explicit about — *"são de paginação/ordenação e
 * não contam como filtro"* — and getting it wrong is exactly how the fixture
 * capture shipped a query guaranteed to be refused.
 */
export const CLAIM_SEARCH_FILTER_KEYS: readonly (keyof MlClaimSearchParams)[] = [
  'id',
  'type',
  'stage',
  'status',
  'resource',
  'resource_id',
  'reason_id',
  'site_id',
  'players.role',
  'players.user_id',
  'order_id',
  'pack_id',
  'payment_id',
  'parent_id',
  'date_created',
  'last_updated',
];

/** ML rejects `offset + limit >= 10000`. */
export const CLAIM_SEARCH_WINDOW_MAX = 10000;

/** ML's documented `limit` default when the caller sends none. */
export const CLAIM_SEARCH_DEFAULT_LIMIT = 30;

/**
 * ML's documented `limit` ceiling: *"Valores maiores que 100 são ajustados
 * automaticamente para 100."*
 *
 * ⚠️ **It is a CLAMP, not a refusal, and that is why the window check below has
 * to apply it.** ML evaluates `offset + limit` against the clamped value, so
 * summing the RAW one refuses queries ML would answer: `offset: 9500,
 * limit: 1000` is legal (ML sees `9500 + 100 = 9600`) but a raw sum reads
 * `10500` and throws. Refusing a legal call is its own defect — the same
 * principle that keeps a bare `status` a warning here rather than an error.
 */
export const CLAIM_SEARCH_MAX_LIMIT = 100;

function presente(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

/** Which of {@link CLAIM_SEARCH_FILTER_KEYS} this query actually carries. */
export function claimSearchFiltersUsed(params: MlClaimSearchParams): (keyof MlClaimSearchParams)[] {
  return CLAIM_SEARCH_FILTER_KEYS.filter((k) => presente(params[k]));
}

/**
 * Every ISO-8601-looking timestamp in a string that is missing its millisecond
 * component. ML documents the requirement and gives the counter-example
 * (`range=last_updated:after:2026-03-19T12:31:54+00:00` → 400), so this looks
 * for `…THH:MM:SS` **not** followed by `.` + digits.
 */
export function timestampsSemMilissegundos(raw: string): string[] {
  const achados: string[] = [];
  for (const match of raw.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?/g)) {
    if (match[1] === undefined) achados.push(match[0]);
  }
  return achados;
}

/**
 * Refuse, locally, every query ML documents a 400 for. Returns nothing; throws
 * {@link MercadoLivreClaimSearchParamsError}.
 *
 * ⚠️ **A bare `status` is NOT refused.** ML calls it technically valid and only
 * inefficient, so refusing it would reject a legal call; it warns. The near-miss
 * that IS refused is paging with no filter beside it — `limit`/`offset`/`sort`
 * are present in perfectly good queries too, so "has paging" can never be the
 * test.
 */
export function validateClaimSearchParams(params: MlClaimSearchParams): void {
  const filtros = claimSearchFiltersUsed(params);

  if (filtros.length === 0) {
    throw new MercadoLivreClaimSearchParamsError(
      'A busca de reclamações exige pelo menos um filtro real — `offset`, `limit`, `sort` e ' +
        '`range` são paginação/ordenação e não contam. O Mercado Livre responde 400 ' +
        `(invalid_query). Filtros aceitos: ${CLAIM_SEARCH_FILTER_KEYS.join(', ')}.`,
    );
  }

  const temResource = presente(params.resource);
  const temResourceId = presente(params.resource_id);
  const temRole = presente(params['players.role']);
  const temUserId = presente(params['players.user_id']);

  if (temResourceId && !temResource) {
    throw new MercadoLivreClaimSearchParamsError(
      '`resource_id` exige `resource` — sozinho o Mercado Livre responde 400.',
    );
  }
  if (temResource && !temResourceId && !(temRole && temUserId)) {
    throw new MercadoLivreClaimSearchParamsError(
      '`resource` exige `resource_id`, ou o par `players.role` + `players.user_id`.',
    );
  }
  if (temRole !== temUserId) {
    throw new MercadoLivreClaimSearchParamsError(
      '`players.role` e `players.user_id` só valem juntos — um sem o outro é 400.',
    );
  }
  if (presente(params.order_id) && presente(params.pack_id)) {
    throw new MercadoLivreClaimSearchParamsError(
      '`order_id` e `pack_id` são mutuamente exclusivos na mesma consulta.',
    );
  }

  // ⚠️ The default matters: `offset=9999` with no `limit` is still refused,
  // because ML applies its own default of 30 and the sum lands past the cap.
  const offset = params.offset ?? 0;
  const limit = params.limit ?? CLAIM_SEARCH_DEFAULT_LIMIT;

  // ⚠️ Checked BEFORE the arithmetic, because `NaN` passes every comparison
  // below silently: `NaN + 30 >= 10000` is `false`, so a non-finite offset
  // sails through the window rule and leaves the process as the literal query
  // string `offset=NaN` — a 400 from ML about a value we could see was broken.
  // `SyncCursor.token` is an opaque persisted string in the generic sync
  // contract, so `Number(token)` is not guaranteed to yield a number and the
  // adapter has no way to know; catching it here covers every caller at once.
  for (const [nome, valor] of [
    ['offset', offset],
    ['limit', limit],
  ] as const) {
    if (!Number.isFinite(valor)) {
      throw new MercadoLivreClaimSearchParamsError(
        `\`${nome}\` precisa ser um número finito — recebido ${String(valor)}.`,
      );
    }
  }

  // ⚠️ The CLAMPED limit, never the raw one — see {@link CLAIM_SEARCH_MAX_LIMIT}.
  // ML compares the window against what it actually applies, so a raw sum would
  // refuse legal calls.
  const limitEfetivo = Math.min(limit, CLAIM_SEARCH_MAX_LIMIT);
  if (offset + limitEfetivo >= CLAIM_SEARCH_WINDOW_MAX) {
    throw new MercadoLivreClaimSearchParamsError(
      `offset + limit deve ser menor que ${CLAIM_SEARCH_WINDOW_MAX} — recebido ` +
        `${offset} + ${limitEfetivo} = ${offset + limitEfetivo}` +
        (limitEfetivo === limit ? '.' : ` (limit ${limit} é ajustado para ${limitEfetivo}).`),
    );
  }

  for (const campo of ['range', 'date_created', 'last_updated'] as const) {
    const valor = params[campo];
    if (typeof valor !== 'string') continue;
    const semMs = timestampsSemMilissegundos(valor);
    if (semMs.length > 0) {
      throw new MercadoLivreClaimSearchParamsError(
        `\`${campo}\` precisa de milissegundos no horário (ex.: 2026-03-19T12:31:54.000+00:00) — ` +
          `sem eles: ${semMs.join(', ')}.`,
      );
    }
  }

  // Valid, but ML documents the cost. `players.user_id` + `players.role` is its
  // own recommended way to bound a global criterion.
  if (filtros.length === 1 && filtros[0] === 'status') {
    console.warn(
      '[mercado-livre] claims/search com apenas `status` é uma varredura sem limite no motor ' +
        'de busca do ML (risco de rate limiting). Acrescente `players.user_id` + `players.role`.',
    );
  }
}
