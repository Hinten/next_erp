import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_USER_AGENT,
  FixtureCaptureHttpError,
  buildCapturePlan,
  captureAll,
  captureOne,
  fixtureFileName,
  slugForPath,
  type CaptureIds,
  type CaptureResult,
  type CaptureTarget,
} from './fixtureCapture';

const TOKEN = 'APP_USR-token-de-teste';
const BASE = 'https://api.mercadolibre.test';

const SEM_IDS: CaptureIds = {
  orderIds: [],
  itemIds: [],
  shipmentIds: [],
  paymentIds: [],
  claimIds: [],
};

interface Chamada {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * A stubbed `fetch` that records every call. `respond` decides the answer per URL;
 * the default is a 200 with an empty JSON object.
 *
 * ⚠️ It returns a real `Response`, not a duck-typed stand-in — `res.ok`,
 * `res.status` and `res.text()` are exactly what the module branches on, and a
 * hand-rolled object is free to disagree with the runtime about `ok`.
 */
function stubFetch(
  respond: (url: string) => Response = () => new Response('{}', { status: 200 }),
): {
  fetchImpl: typeof fetch;
  chamadas: Chamada[];
} {
  const chamadas: Chamada[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    chamadas.push({ url, headers });
    return respond(url);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, chamadas };
}

function alvo(plan: readonly CaptureTarget[], path: string): CaptureTarget {
  const hit = plan.find((t) => t.path === path);
  if (hit == null) throw new Error(`plano não contém ${path}`);
  return hit;
}

describe('slugForPath', () => {
  it('turns a path into a flat, filesystem-safe stem', () => {
    expect(slugForPath('/orders/2000018143664980')).toBe('orders-2000018143664980');
    expect(slugForPath('/shipments/47868202073/sla')).toBe('shipments-47868202073-sla');
    expect(slugForPath('/post-purchase/v1/claims/search')).toBe('post-purchase-v1-claims-search');
  });
});

describe('buildCapturePlan', () => {
  it('always captures the claims search, even with no ids at all', () => {
    const plan = buildCapturePlan(SEM_IDS);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.path).toBe('/post-purchase/v1/claims/search');
    expect(plan[0]!.query).toEqual({ limit: '50', offset: '0' });
  });

  it('fans an --orderId out to the order, its billing info AND the pack', () => {
    const plan = buildCapturePlan({ ...SEM_IDS, orderIds: ['2000018143664980'] });
    expect(plan.map((t) => t.path)).toEqual([
      '/orders/2000018143664980',
      '/orders/2000018143664980/billing_info',
      '/packs/2000018143664980',
      '/post-purchase/v1/claims/search',
    ]);
  });

  it('captures five distinct shipment bodies per --shipmentId', () => {
    const plan = buildCapturePlan({ ...SEM_IDS, shipmentIds: ['47868202073'] });
    expect(plan.map((t) => t.path)).toEqual([
      '/shipments/47868202073',
      '/shipments/47868202073/costs',
      '/shipments/47868202073/payments',
      '/shipments/47868202073/orders',
      '/shipments/47868202073/sla',
      '/post-purchase/v1/claims/search',
    ]);
  });

  it('captures the claim and its messages per --claimId', () => {
    const plan = buildCapturePlan({ ...SEM_IDS, claimIds: ['5555'] });
    expect(plan.map((t) => t.path)).toEqual([
      '/post-purchase/v1/claims/5555',
      '/post-purchase/v1/claims/5555/messages',
      '/post-purchase/v1/claims/search',
    ]);
  });

  it('captures the item and the payment bodies', () => {
    const plan = buildCapturePlan({
      ...SEM_IDS,
      itemIds: ['MLB5140167173'],
      paymentIds: ['174911485053'],
    });
    expect(plan.map((t) => t.path)).toEqual([
      '/items/MLB5140167173',
      '/collections/174911485053',
      '/post-purchase/v1/claims/search',
    ]);
  });

  it('gives every target a unique slug', () => {
    const plan = buildCapturePlan({
      orderIds: ['1', '2'],
      itemIds: ['MLB1'],
      shipmentIds: ['9', '8'],
      paymentIds: ['7'],
      claimIds: ['6'],
    });
    expect(new Set(plan.map((t) => t.slug)).size).toBe(plan.length);
  });
});

/**
 * ⚠️ The header table is the half of this module that is not guessable, and #957
 * is the reason: `…/sla` is a DISTINCT fixture precisely because it goes out
 * without `x-format-new`. These assertions exist so that exception cannot be
 * "aligned" with the other four shipment calls by someone tidying up.
 */
describe('buildCapturePlan — the per-resource headers', () => {
  const plan = buildCapturePlan({ ...SEM_IDS, orderIds: ['77'], shipmentIds: ['99'] });

  it('sends x-format-new on the shipment body, its costs and its payments', () => {
    for (const path of ['/shipments/99', '/shipments/99/costs', '/shipments/99/payments']) {
      expect(alvo(plan, path).headers).toEqual({ 'x-format-new': 'true' });
    }
  });

  it('sends X-New-Domain — not x-format-new — on the shipment orders', () => {
    expect(alvo(plan, '/shipments/99/orders').headers).toEqual({ 'X-New-Domain': 'true' });
  });

  it('sends NO header at all on the shipment SLA (#957)', () => {
    expect(alvo(plan, '/shipments/99/sla').headers).toBeUndefined();
  });

  it('sends x-version: 2 on the billing info', () => {
    expect(alvo(plan, '/orders/77/billing_info').headers).toEqual({ 'x-version': '2' });
  });

  it('sends no extra header on the plain order, pack, item, payment or claim paths', () => {
    for (const path of ['/orders/77', '/packs/77', '/post-purchase/v1/claims/search']) {
      expect(alvo(plan, path).headers).toBeUndefined();
    }
  });
});

describe('fixtureFileName', () => {
  const alvoOrder: CaptureTarget = { slug: 'orders-1', path: '/orders/1' };

  /**
   * ⚠️ Built as a FULL `CaptureResult`, `ok` included and set the way a real
   * response would set it — `ok: true` for 206 and 204, since `res.ok` spans the
   * whole 2xx range. An assertion that omitted `ok` would pass against an
   * implementation keyed on it (undefined is falsy) and so would not pin anything.
   */
  const resultado = (status: number): CaptureResult => ({
    target: alvoOrder,
    status,
    ok: status >= 200 && status < 300,
    body: '{}',
  });

  const completo = fixtureFileName(resultado(200));

  it('files a complete 200 body under the bare slug', () => {
    expect(completo).toBe('orders-1.json');
  });

  /**
   * The file-on-disk half of the same anti-lie rule the 5xx throw enforces: a body
   * sitting under the name a COMPLETE body would take reads, months later, as "ML
   * returns this for an order".
   *
   * ⚠️ 206 is the case that makes this key on the status rather than on `ok` —
   * `res.ok` is true across the whole 2xx range. ML answers `206 Partial Content`
   * for an order it can only partly materialise, and a partial body **omits**
   * fields rather than nulling them (`api.ts:226-230`, `types.ts:417`) — omissions
   * indistinguishable from ML's real ones, which is the single distinction this
   * module exists to preserve.
   */
  // 206 = a partial order body · 204 = an empty body · 404 = not found.
  it.each([
    [206, 'orders-1.206.json'],
    [204, 'orders-1.204.json'],
    [404, 'orders-1.404.json'],
  ])('files %i as %s, never under the complete body name', (status, esperado) => {
    const nome = fixtureFileName(resultado(status));
    expect(nome).toBe(esperado);
    expect(nome).not.toBe(completo);
  });
});

describe('captureOne — the request', () => {
  it('carries the bearer token, Accept and the per-target header', async () => {
    const { fetchImpl, chamadas } = stubFetch();
    await captureOne(alvo(buildCapturePlan({ ...SEM_IDS, shipmentIds: ['99'] }), '/shipments/99'), {
      fetchImpl,
      accessToken: TOKEN,
      baseUrl: BASE,
    });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe(`${BASE}/shipments/99`);
    expect(chamadas[0]!.headers).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'user-agent': CAPTURE_USER_AGENT,
      'x-format-new': 'true',
    });
  });

  it('appends the query string of a target that has one', async () => {
    const { fetchImpl, chamadas } = stubFetch();
    await captureOne(alvo(buildCapturePlan(SEM_IDS), '/post-purchase/v1/claims/search'), {
      fetchImpl,
      accessToken: TOKEN,
      baseUrl: BASE,
    });
    expect(chamadas[0]!.url).toBe(`${BASE}/post-purchase/v1/claims/search?limit=50&offset=0`);
  });
});

/**
 * The reason this script exists at all. `parseOk` (api.ts:784) would materialise
 * every `.nullable().default(null)` field, so a fixture taken through a typed
 * method cannot tell "ML sent null" from "ML omitted it" — the exact loss #1342
 * Finding 1 documents about the `orderML` mirror.
 */
describe('captureOne — byte-faithfulness', () => {
  const OMITIDO = '{"id":123,"status":"paid"}';
  const EXPLICITO = '{"id":123,"status":"paid","cancel_detail":null}';

  it('returns the body verbatim, leaving an OMITTED key omitted', async () => {
    const { fetchImpl } = stubFetch(() => new Response(OMITIDO, { status: 200 }));
    const r = await captureOne(
      { slug: 'orders-123', path: '/orders/123' },
      { fetchImpl, accessToken: TOKEN, baseUrl: BASE },
    );

    expect(r.body).toBe(OMITIDO);
    expect(r.body).not.toContain('cancel_detail');
  });

  it('keeps an explicit null distinguishable from an omitted key', async () => {
    const capture = async (payload: string): Promise<string> => {
      const { fetchImpl } = stubFetch(() => new Response(payload, { status: 200 }));
      const r = await captureOne(
        { slug: 'orders-123', path: '/orders/123' },
        { fetchImpl, accessToken: TOKEN, baseUrl: BASE },
      );
      return r.body;
    };

    expect(await capture(OMITIDO)).not.toBe(await capture(EXPLICITO));
    expect(await capture(EXPLICITO)).toContain('"cancel_detail":null');
  });

  it('does not reformat, reorder or re-serialise the body', async () => {
    const cru = '{ "b" : 2,\n  "a": 1 }';
    const { fetchImpl } = stubFetch(() => new Response(cru, { status: 200 }));
    const r = await captureOne(
      { slug: 'orders-123', path: '/orders/123' },
      { fetchImpl, accessToken: TOKEN, baseUrl: BASE },
    );
    expect(r.body).toBe(cru);
  });
});

describe('captureAll — a 404 is data, everything else is a failure', () => {
  const plan: CaptureTarget[] = [
    { slug: 'orders-1', path: '/orders/1' },
    { slug: 'packs-1', path: '/packs/1' },
    { slug: 'collections-7', path: '/collections/7' },
  ];

  it('records a 404 and keeps going', async () => {
    const { fetchImpl, chamadas } = stubFetch((url) =>
      url.endsWith('/packs/1')
        ? new Response('{"message":"pack_not_found"}', { status: 404 })
        : new Response('{"ok":true}', { status: 200 }),
    );

    const results = await captureAll(plan, { fetchImpl, accessToken: TOKEN, baseUrl: BASE });

    expect(chamadas).toHaveLength(3);
    expect(results.map((r) => [r.target.slug, r.status, r.ok])).toEqual([
      ['orders-1', 200, true],
      ['packs-1', 404, false],
      ['collections-7', 200, true],
    ]);
    // The 404 body is kept — it is a real ML answer. The caller files it under a
    // name that cannot be mistaken for a success body.
    expect(results[1]!.body).toBe('{"message":"pack_not_found"}');
  });

  it.each([500, 502, 401, 403, 429])('throws on %i rather than recording it', async (status) => {
    const { fetchImpl } = stubFetch((url) =>
      url.endsWith('/packs/1')
        ? new Response('boom', { status })
        : new Response('{"ok":true}', { status: 200 }),
    );

    await expect(
      captureAll(plan, { fetchImpl, accessToken: TOKEN, baseUrl: BASE }),
    ).rejects.toBeInstanceOf(FixtureCaptureHttpError);
  });

  it('names the path and the status, and keeps the body out of the message', async () => {
    const { fetchImpl } = stubFetch(() => new Response('segredo-do-corpo', { status: 503 }));
    const erro = await captureOne(plan[0]!, {
      fetchImpl,
      accessToken: TOKEN,
      baseUrl: BASE,
    }).catch((err: unknown) => err);

    expect(erro).toBeInstanceOf(FixtureCaptureHttpError);
    const http = erro as FixtureCaptureHttpError;
    expect(http.status).toBe(503);
    expect(http.path).toBe('/orders/1');
    expect(http.message).toContain('503');
    expect(http.message).toContain('/orders/1');
    expect(http.message).not.toContain('segredo-do-corpo');
  });

  /**
   * ⚠️ Keeping the body off `message` is NOT enough. An uncaught throw becomes an
   * unhandled rejection, and Node's default handler `util.inspect`s the error,
   * appending every own enumerable property — so an enumerable `body` prints the
   * response verbatim to stderr. The population reaching this branch is a 401 on
   * a dead grant, a 403, a 429: exactly the bodies #1015 was about.
   */
  it('keeps the body out of util.inspect and JSON.stringify, but readable', () => {
    const segredo = '{"access_token":"APP_USR-NAO-DEVE-VAZAR"}';
    const err = new FixtureCaptureHttpError('/orders/1', 401, segredo);

    const impresso = inspect(err);
    expect(impresso).not.toContain('APP_USR-NAO-DEVE-VAZAR');
    expect(JSON.stringify(err)).not.toContain('APP_USR-NAO-DEVE-VAZAR');
    expect(Object.keys(err)).not.toContain('body');

    // What a stack dump SHOULD still say — the two fields that make it actionable.
    expect(impresso).toContain('/orders/1');
    expect(impresso).toContain('401');

    // …and the body stays reachable for a caller that genuinely needs it.
    expect(err.body).toBe(segredo);
  });

  it('emits every result BEFORE the throw, so a partial capture survives', async () => {
    const { fetchImpl } = stubFetch((url) =>
      url.endsWith('/collections/7')
        ? new Response('boom', { status: 500 })
        : new Response('{"ok":true}', { status: 200 }),
    );

    const vistos: CaptureResult[] = [];
    await expect(
      captureAll(plan, { fetchImpl, accessToken: TOKEN, baseUrl: BASE }, (r) => vistos.push(r)),
    ).rejects.toBeInstanceOf(FixtureCaptureHttpError);

    expect(vistos.map((r) => r.target.slug)).toEqual(['orders-1', 'packs-1']);
  });

  it('never emits a result for a failed call', async () => {
    const { fetchImpl } = stubFetch(() => new Response('', { status: 500 }));
    const vistos: CaptureResult[] = [];
    await expect(
      captureAll([plan[0]!], { fetchImpl, accessToken: TOKEN, baseUrl: BASE }, (r) =>
        vistos.push(r),
      ),
    ).rejects.toBeInstanceOf(FixtureCaptureHttpError);
    expect(vistos).toEqual([]);
  });

  it('stops at the first failure instead of burning the rest of the plan', async () => {
    const { fetchImpl, chamadas } = stubFetch((url) =>
      url.endsWith('/packs/1')
        ? new Response('boom', { status: 500 })
        : new Response('{"ok":true}', { status: 200 }),
    );
    await expect(
      captureAll(plan, { fetchImpl, accessToken: TOKEN, baseUrl: BASE }),
    ).rejects.toBeInstanceOf(FixtureCaptureHttpError);
    expect(chamadas.map((c) => c.url)).toEqual([`${BASE}/orders/1`, `${BASE}/packs/1`]);
  });
});
