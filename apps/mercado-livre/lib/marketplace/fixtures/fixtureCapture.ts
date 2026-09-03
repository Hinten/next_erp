/**
 * #1342 — the endpoint table and the wire-capture loop behind `capture:fixtures`.
 *
 * ⚠️ **This module deliberately does NOT use `createMercadoLivreApi`, and that is
 * the whole reason it exists.** Every typed method runs its response through
 * `parseOk(res, schema)` — Zod (`api.ts:784`). So `api.getShipment()` hands back a
 * PARSED object, and every field declared `.nullable().default(null)` comes back
 * materialised as an explicit `null` whether or not Mercado Livre sent the key. A
 * fixture built that way cannot distinguish "ML sent null" from "ML omitted it",
 * which is precisely the distinction a wire fixture exists to preserve — and
 * precisely the mistake #1342 Finding 1 documents about the `orderML` mirror,
 * whose `buildOrderMLWire` projection drops seven fields ML does send.
 *
 * So: a plain `fetch` per endpoint, and `await res.text()` returned verbatim. No
 * mapping, no normalisation, no key materialisation. Byte-faithfulness is the
 * entire product — it is what later lets a test assert "our Zod schema parses
 * this REAL body without loss", the validation that exists nowhere today and the
 * reason a `payments[]` / `discounts[]` shape change is currently silent.
 *
 * The IO half (arguments, channel context, writing files) is
 * `scripts/capture-fixtures.ts`. This half is pure enough to drive from a stubbed
 * `fetch`, which is the only way it can be verified at all: nothing in CI may ever
 * hold a real ML credential.
 */
import { DEFAULT_API_BASE_URL } from '@delfrance/integrations-mercado-livre';

/** Matches `DEFAULT_USER_AGENT` in `api.ts` — the capture should look like the backend. */
export const CAPTURE_USER_AGENT = '@delfrance/erp-next';

/**
 * How many claims `GET …/claims/search` asks for. ML's documented default is 30
 * and its maximum 100; anything larger is silently clamped to 100.
 *
 * ⚠️ **`offset + limit` must stay below 10000** — ML answers 400 above it. At
 * offset 0 that is not a constraint, but it is why this is not a bigger number.
 */
export const CLAIM_SEARCH_LIMIT = 50;

export interface CaptureTarget {
  /** File-name stem, derived from the path. Unique across a plan. */
  readonly slug: string;
  /** Path only — the base URL is applied at request time. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** ⚠️ Load-bearing and different per resource. See {@link buildCapturePlan}. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CaptureIds {
  readonly orderIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly shipmentIds: readonly string[];
  readonly paymentIds: readonly string[];
  readonly claimIds: readonly string[];
  /**
   * The connected account's ML `user_id`. Optional, and its absence is a real
   * state rather than a caller mistake: it is stamped onto the integração only
   * at OAuth exchange (#289), so an account connected before that backfill has
   * none.
   *
   * ⚠️ Without it the claims search is **omitted from the plan**, never sent
   * unfiltered — see {@link buildCapturePlan}.
   */
  readonly sellerId?: string;
}

export interface CaptureResult {
  readonly target: CaptureTarget;
  readonly status: number;
  /**
   * `res.ok` verbatim. ⚠️ A `false` here does **not** mean 404 — every
   * permanent 4xx is recorded now, so it can be 400, 405, 422… See
   * {@link ehFalhaFatal} for the statuses that throw instead of landing here.
   */
  readonly ok: boolean;
  /** The response text, verbatim. Never parsed, never re-serialised. */
  readonly body: string;
}

export interface CaptureDeps {
  readonly fetchImpl: typeof fetch;
  readonly accessToken: string;
  readonly baseUrl?: string;
}

/**
 * A response that is neither 2xx nor 404.
 *
 * ⚠️ **`body` is NON-ENUMERABLE, and that is a security property, not a style
 * choice.** #1015 is the worked example of a raw ML body reaching a log stream,
 * and the population that reaches this branch is exactly that one — a 401 on a
 * dead grant, a 403, a 429. Keeping the body off `message` is not enough: an
 * uncaught throw becomes an unhandled rejection, and Node's default handler
 * `util.inspect`s the error, which appends **every own enumerable property** —
 * so a plain `this.body = body` prints the credential response verbatim to
 * stderr, and `JSON.stringify(err)` carries it too. Non-enumerable keeps it
 * readable for a caller that genuinely needs it and invisible to both.
 *
 * The second half of the same guard lives in `scripts/capture-fixtures.ts`, whose
 * `main()` narrows on this class and prints `message` alone rather than letting
 * the rejection reach Node's handler at all. `path` and `status` stay enumerable
 * — both are ours, and they are what makes a stack dump actionable.
 */
export class FixtureCaptureHttpError extends Error {
  readonly path: string;
  readonly status: number;
  readonly body!: string;

  constructor(path: string, status: number, body: string) {
    super(`Mercado Livre respondeu ${status} em ${path} — captura interrompida.`);
    this.name = 'FixtureCaptureHttpError';
    this.path = path;
    this.status = status;
    Object.defineProperty(this, 'body', { value: body, enumerable: false });
  }
}

/**
 * Which HTTP statuses abort the run — everything else non-2xx is **data**.
 *
 * ⚠️ **The old rule was "not 404 ⇒ stop", and it meant this script never once
 * exited 0** (#1357). Two calls in every plan answer **400**, both permanently:
 *
 *  - `/post-purchase/v1/claims/search` with paging alone. ML documents this
 *    exactly — the endpoint needs at least one real FILTER, `offset`/`limit`/
 *    `sort` do not count, and a paging-only request returns
 *    `400 {"error":"invalid_query"}`. Fixed at the source below, but the plan
 *    used to guarantee it.
 *  - `/packs/{id}` for an order that is a pack MEMBER. The fan-out assumed two
 *    outcomes (a standalone order 404s, a pack id 200s); a member is a third,
 *    and it 400s.
 *
 * Since the search was the LAST entry in every plan, the run aborted at the end
 * no matter how much it had captured.
 *
 * So the line is drawn by what the status tells us about the REST of the plan,
 * not by how permanent it is:
 *
 *  - **Recorded** (400, 404, 405, 409, 410, 422, …) — a permanent, informative
 *    answer about *this one request*. Nothing about it says the other 22 calls
 *    are unsafe, and the answer itself is worth having on disk: a
 *    `packs-<id>.400.json` documents a fact #1357 had to discover by hand.
 *  - **`401` / `403`** — the grant is dead or under-scoped, so every remaining
 *    call is equally doomed; and the body can carry credential detail (#1015),
 *    which is why {@link FixtureCaptureHttpError} hides it.
 *  - **`429`** — rate limited. Continuing compounds it.
 *  - **`5xx`** — transient. Recorded as a body it would later read as "ML
 *    returns this", which is strictly worse than having no fixture.
 *
 * ⚠️ Recording is only safe because {@link fixtureFileName} keeps a non-200 off
 * the bare slug. A 400 filed as `<slug>.json` would read as the resource.
 */
export function ehFalhaFatal(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/** `/shipments/47868202073/sla` → `shipments-47868202073-sla`. */
export function slugForPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replaceAll('/', '-')
    .replace(/[^A-Za-z0-9._-]/g, '_');
}

function target(path: string, headers?: Record<string, string>): CaptureTarget {
  return headers === undefined
    ? { slug: slugForPath(path), path }
    : { slug: slugForPath(path), path, headers };
}

/**
 * ⚠️ **The headers are the load-bearing half of this table**, and they differ per
 * resource in ways that are not guessable:
 *
 *  - `/shipments/{id}`, `…/costs` and `…/payments` need `x-format-new: true`;
 *  - `…/orders` needs `X-New-Domain: true` instead;
 *  - `…/sla` deliberately gets **NEITHER** (#957) — it is a distinct fixture, not
 *    a duplicate of the shipment body, and adding `x-format-new` here silently
 *    changes what is captured;
 *  - `/orders/{id}/billing_info` needs `x-version: 2`.
 *
 * All four match `api.ts:1095-1155`; `fixtureCapture.test.ts` pins them so the
 * SLA exception cannot be "tidied up" into the shipment group.
 *
 * ⚠️ **`--orderId` fans out to `/packs/{id}` too**, because a pack id and an order
 * id are indistinguishable from the outside — so one flag covers both without the
 * operator having to know which they hold.
 *
 * ⚠️ **There are THREE outcomes, not two, and the third one used to kill the run.**
 * The original note here said "a single order 404s on `/packs`, a pack id 404s on
 * `/orders`". Measured against the #1087 account:
 *
 * | id | `/packs/{id}` |
 * | --- | --- |
 * | `2000018143664980` — a standalone order | **404**, recorded, exactly as designed |
 * | `2000018144681452` — an order that IS in a pack | **400** |
 * | `2000018144679512` — its sibling member | **400** |
 *
 * A pack MEMBER is neither of the two shapes anticipated, and under the old
 * "not 404 ⇒ stop" contract each one aborted the run. Both are now recorded as
 * `packs-<id>.400.json` — which is better than not asking, because the refusal is
 * the evidence.
 *
 * ⓘ The guess could be removed instead: `pack_id` sits on the order body
 * (`2000018144679512` and `2000018144681452` both carry `2000014733850447`;
 * `2000018143664980` carries `null`). That was considered and left alone —
 * deriving it needs a two-phase plan in this module AND in `verify:wire`, and it
 * would drop the `/packs/{orderId}` slug from the plan, leaving
 * `packs-2000018143664980.404.json` in the corpus with nothing ever re-fetching
 * it. A fixture no verify pass reaches is a check that cannot fail.
 *
 * ⚠️ **The claims search runs only when the seller id is known**, and ML documents
 * why: the endpoint requires at least one real FILTER, `offset`/`limit`/`sort`
 * explicitly do not count, and a paging-only request answers
 * `400 {"error":"invalid_query"}`. It used to send paging alone — so it 400'd on
 * every run, and being the LAST plan entry it aborted every run. With no seller id
 * the call is **omitted**: a request guaranteed to be refused discovers nothing.
 */
export function buildCapturePlan(ids: CaptureIds): CaptureTarget[] {
  const plan: CaptureTarget[] = [];
  const enc = encodeURIComponent;

  for (const id of ids.orderIds) {
    plan.push(target(`/orders/${enc(id)}`));
    plan.push(target(`/orders/${enc(id)}/billing_info`, { 'x-version': '2' }));
    plan.push(target(`/packs/${enc(id)}`));
  }

  for (const id of ids.itemIds) {
    plan.push(target(`/items/${enc(id)}`));
  }

  for (const id of ids.shipmentIds) {
    plan.push(target(`/shipments/${enc(id)}`, { 'x-format-new': 'true' }));
    plan.push(target(`/shipments/${enc(id)}/costs`, { 'x-format-new': 'true' }));
    plan.push(target(`/shipments/${enc(id)}/payments`, { 'x-format-new': 'true' }));
    plan.push(target(`/shipments/${enc(id)}/orders`, { 'X-New-Domain': 'true' }));
    // ⚠️ No `x-format-new` — #957. Do not "align" this with the four above.
    plan.push(target(`/shipments/${enc(id)}/sla`));
  }

  for (const id of ids.paymentIds) {
    plan.push(target(`/collections/${enc(id)}`));
  }

  for (const id of ids.claimIds) {
    plan.push(target(`/post-purchase/v1/claims/${enc(id)}`));
    plan.push(target(`/post-purchase/v1/claims/${enc(id)}/messages`));
  }

  // ML's own "consultas recomendadas" base pair: scope the search to this seller
  // and its role. Anything global is either refused or, in the `status`-only case,
  // documented as a rate-limiting risk.
  //
  // ⚠️ **No `status` filter on purpose.** The one claim this corpus holds
  // (`5567065796`) is `closed`, so `status=opened` would hide exactly the claim
  // the capture exists to discover.
  if (ids.sellerId != null && ids.sellerId !== '') {
    plan.push({
      slug: slugForPath('/post-purchase/v1/claims/search'),
      path: '/post-purchase/v1/claims/search',
      query: {
        'players.user_id': ids.sellerId,
        'players.role': 'respondent',
        limit: String(CLAIM_SEARCH_LIMIT),
        offset: '0',
      },
    });
  }

  return plan;
}

/**
 * The name the body is filed under. **Only a 200 takes the bare slug.**
 *
 * ⚠️ **The rule keys on the status, NOT on `ok`** — `res.ok` is true across the
 * whole 2xx range, and two of those statuses are bodies that must never wear a
 * complete body's name:
 *
 *  - **`206 Partial Content`**, which ML answers for an order it can only partly
 *    materialise — and a partial body **OMITS fields rather than nulling them**
 *    (`api.ts:226-230`, `types.ts:417`; there is a whole `getOrderResponse` method
 *    whose only job is to surface the distinction, #793). Those omissions are
 *    indistinguishable from ML's real omissions, which is the one thing this
 *    module exists to preserve — so a 206 filed as `<slug>.json` would later read
 *    as "ML returns this for an order", and any "our Zod schema parses this REAL
 *    body without loss" assertion would be validated against a body ML itself
 *    flagged as incomplete.
 *  - **`204 No Content`**, documented for `/shipments/{id}/items`, whose empty
 *    body under a `.json` name is a captured-nothing that reads as an answer.
 *
 * Every recorded 4xx is the same rule from the other side: worth keeping (a real
 * ML answer — "this account has no such claim", "you may not ask `/packs` about a
 * pack member" — is a finding), never under the name a complete body would take.
 * ⚠️ This is what makes {@link ehFalhaFatal}'s recording safe: a 400 under a bare
 * `<slug>.json` would read as the resource itself.
 */
export function fixtureFileName(result: Pick<CaptureResult, 'target' | 'status'>): string {
  return result.status === 200
    ? `${result.target.slug}.json`
    : `${result.target.slug}.${result.status}.json`;
}

/**
 * One request. The two behaviours that separate a fixture from a lie:
 *
 *  1. **A permanent 4xx is DATA.** A missing claim 404s, a pack member 400s on
 *     `/packs`, and both are real ML answers — recorded (`ok: false`) so the run
 *     continues, because a partial capture is useful and the refusal itself is
 *     evidence.
 *  2. **A failure that says nothing about this request throws.** A transient 5xx,
 *     a 401/403 on a dead grant, a 429 — recorded as an empty body any of them
 *     would later read as "ML returns this", which is strictly worse than having
 *     no fixture at all.
 *
 * {@link ehFalhaFatal} is where that line is drawn and why.
 *
 * There is no `catch` here on purpose: `fetch` does not throw on an HTTP status, so
 * a genuine network failure propagates untouched rather than being narrowed and
 * re-classified.
 */
export async function captureOne(
  captureTarget: CaptureTarget,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const url = new URL(captureTarget.path, deps.baseUrl ?? DEFAULT_API_BASE_URL);
  for (const [k, v] of Object.entries(captureTarget.query ?? {})) url.searchParams.set(k, v);

  const res = await deps.fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${deps.accessToken}`,
      'User-Agent': CAPTURE_USER_AGENT,
      ...captureTarget.headers,
    },
  });

  const body = await res.text();
  if (!res.ok && ehFalhaFatal(res.status)) {
    throw new FixtureCaptureHttpError(captureTarget.path, res.status, body);
  }
  return { target: captureTarget, status: res.status, ok: res.ok, body };
}

/**
 * Runs the plan **sequentially** — the account is rate limited and the ordering
 * makes the run readable.
 *
 * `onResult` fires as each body lands, so the caller can persist it immediately.
 * That is what makes the throw in {@link captureOne} affordable: a 5xx halfway
 * through still leaves every earlier fixture on disk.
 */
export async function captureAll(
  plan: readonly CaptureTarget[],
  deps: CaptureDeps,
  onResult?: (result: CaptureResult) => void,
): Promise<CaptureResult[]> {
  const results: CaptureResult[] = [];
  for (const captureTarget of plan) {
    const result = await captureOne(captureTarget, deps);
    results.push(result);
    onResult?.(result);
  }
  return results;
}
