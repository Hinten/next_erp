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

/** How many claims `GET …/claims/search` asks for. It accepts only status/stage/limit/offset. */
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
}

export interface CaptureResult {
  readonly target: CaptureTarget;
  readonly status: number;
  /** `false` only ever means 404 — every other non-2xx throws. */
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
 * ⚠️ `body` is carried for a caller that genuinely needs it, but the script prints
 * `message` alone: #1015 is the worked example of a raw ML body reaching a log
 * stream. The path and the status are enough to act on.
 */
export class FixtureCaptureHttpError extends Error {
  readonly path: string;
  readonly status: number;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`Mercado Livre respondeu ${status} em ${path} — captura interrompida.`);
    this.name = 'FixtureCaptureHttpError';
    this.path = path;
    this.status = status;
    this.body = body;
  }
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
 * id are indistinguishable from the outside. A single order 404s on `/packs`, a
 * pack id 404s on `/orders`, and a 404 is recorded rather than fatal — so one flag
 * covers both without the operator having to know which they hold.
 *
 * The claims search needs no id at all and always runs: it is how claim ids are
 * discovered on an account that may legitimately have none.
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

  plan.push({
    slug: slugForPath('/post-purchase/v1/claims/search'),
    path: '/post-purchase/v1/claims/search',
    query: { limit: String(CLAIM_SEARCH_LIMIT), offset: '0' },
  });

  return plan;
}

/**
 * The name the body is filed under.
 *
 * ⚠️ **A 404 body never takes the name a success body would take.** The 404 is
 * worth keeping — it is a real ML answer, and "this account has no such claim" is
 * a finding — but filed as `<slug>.json` it becomes exactly the lie this script
 * exists to avoid: months later it reads as "ML returns this for an order". The
 * status goes in the name instead.
 */
export function fixtureFileName(result: Pick<CaptureResult, 'target' | 'ok' | 'status'>): string {
  return result.ok ? `${result.target.slug}.json` : `${result.target.slug}.${result.status}.json`;
}

/**
 * One request. The two behaviours that separate a fixture from a lie:
 *
 *  1. **A 404 is DATA.** A missing claim is expected on this account, and a partial
 *     capture is useful — so it is recorded (`ok: false`) and the run continues.
 *  2. **Everything else throws.** A transient 5xx (or a 401 on a dead grant, or a
 *     429) recorded as an empty body would later read as "ML returns this", which
 *     is strictly worse than having no fixture at all.
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
  if (!res.ok && res.status !== 404) {
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
