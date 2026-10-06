import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMelhorEnvioApi, type MelhorEnvioApi } from '../../src/melhor-envio/api';
import {
  MelhorEnvioError,
  MelhorEnvioHttpError,
  MelhorEnvioNetworkError,
  MelhorEnvioSchemaError,
  MelhorEnvioTimeoutError,
  MelhorEnvioValidationError,
} from '../../src/melhor-envio/errors';
import {
  exchangeCode,
  melhorEnvioBaseUrl,
  type OAuthConfig,
  refreshAccessToken,
} from '../../src/melhor-envio/oauth';
import {
  DURACAO_MAXIMA_COMPRAR_MS,
  mensagemDeTempoEsgotadoMe,
  type OperacaoMelhorEnvio,
  PRAZO_ME_MS,
  PRAZO_ME_TOKEN_MS,
} from '../../src/melhor-envio/prazos';
import { comprarEtiqueta } from '../../src/melhor-envio/comprarEtiqueta';

type FetchArgs = Parameters<typeof globalThis.fetch>;

function api(
  fetchImpl: typeof globalThis.fetch,
  getAccessToken = async () => 'tok',
): MelhorEnvioApi {
  return createMelhorEnvioApi({
    baseUrl: melhorEnvioBaseUrl(true),
    getAccessToken,
    userAgent: '@delfrance/erp-next (contato@example.com)',
    fetchImpl,
  });
}

function oauthConfig(fetchImpl: typeof globalThis.fetch): OAuthConfig {
  return {
    baseUrl: melhorEnvioBaseUrl(true),
    clientId: 'cid',
    clientSecret: 'secret',
    redirectUri: 'https://app.example.com/api/oauth/melhor-envio/callback',
    userAgent: '@delfrance/erp-next (contato@example.com)',
    fetchImpl,
  };
}

/**
 * Melhor Envio accepting the connection and never answering. Rejects the way
 * real `fetch` does when its signal aborts: with the signal's reason, as-is.
 */
function fetchQueNuncaResponde() {
  return vi.fn(
    (...[, init]: FetchArgs) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

/**
 * 200 headers, then a stall mid-body. A user-built `Response` body is NOT
 * cancelled by the request signal, so the stub wires the abort into the stream —
 * which is what a real network body does.
 */
function fetchQueTravaNoCorpo() {
  return vi.fn(async (...[, init]: FetchArgs) => {
    const signal = init?.signal;
    const corpo = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(corpo, { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/** Start `promise` and record when it settles, without awaiting it. */
function observar(promise: Promise<unknown>) {
  const estado: { settled: boolean; valor?: unknown } = { settled: false };
  const pronto = promise.then(
    (v) => {
      estado.settled = true;
      estado.valor = v;
    },
    (e: unknown) => {
      estado.settled = true;
      estado.valor = e;
    },
  );
  return { estado, pronto };
}

/**
 * One invocation per method. `satisfies` makes a NEW api method a compile error
 * here until it is added — so no method ships without a deadline test.
 * `addToCart`'s cart carries no sender location, so `ensureCartAgency` returns
 * at once and the only request is the cart POST itself.
 */
const INVOCAR = {
  getMe: (a: MelhorEnvioApi) => a.getMe(),
  getBalance: (a: MelhorEnvioApi) => a.getBalance(),
  listServices: (a: MelhorEnvioApi) => a.listServices(),
  listAgencies: (a: MelhorEnvioApi) => a.listAgencies({ company: 2, country: 'BR', state: 'RS' }),
  getOrder: (a: MelhorEnvioApi) => a.getOrder('lbl-1'),
  tracking: (a: MelhorEnvioApi) => a.tracking(['lbl-1']),
  calculate: (a: MelhorEnvioApi) =>
    a.calculate({ from: { postal_code: '01001000' }, to: { postal_code: '20040002' } }),
  print: (a: MelhorEnvioApi) => a.print(['lbl-1']),
  addToCart: (a: MelhorEnvioApi) => a.addToCart({ service: 3 }),
  checkout: (a: MelhorEnvioApi) => a.checkout(['lbl-1']),
  generate: (a: MelhorEnvioApi) => a.generate(['lbl-1']),
} satisfies Record<keyof MelhorEnvioApi, (a: MelhorEnvioApi) => Promise<unknown>>;

/** The #1679 design, written out — NOT read from the table under test. */
const PRAZO_ESPERADO = {
  getMe: 10_000,
  getBalance: 10_000,
  listServices: 10_000,
  listAgencies: 10_000,
  getOrder: 10_000,
  tracking: 10_000,
  calculate: 20_000,
  print: 15_000,
  addToCart: 30_000,
  checkout: 60_000,
  generate: 45_000,
} as const satisfies Record<keyof MelhorEnvioApi, number>;

describe('Melhor Envio server transport deadlines (#1679)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins every budget — changing one must be a deliberate, reviewed edit', () => {
    expect(PRAZO_ME_MS).toEqual(PRAZO_ESPERADO);
    expect(PRAZO_ME_TOKEN_MS).toBe(20_000);
  });

  it('pins the bound on a whole buy', () => {
    expect(DURACAO_MAXIMA_COMPRAR_MS).toBe(200_000);
  });

  /**
   * ⚠️ The bound is checked against the calls the REAL pipeline makes, not
   * against the formula that defines it — so a new Melhor Envio call added to
   * `comprarEtiqueta` (a balance pre-check, a second getOrder) turns this red
   * instead of silently outgrowing the bound while the ceiling test, which only
   * sees the constant, stays green (review of #1679).
   *
   * Every request's own deadline is summed, plus ONE token POST: the stub's
   * `getAccessToken` stands in for `getOrRefreshAccessToken`, which refreshes at
   * most once per run (a fresh token clears the skew for the rest of it).
   */
  describe('DURACAO_MAXIMA_COMPRAR_MS covers every call the real pipeline makes', () => {
    function operacaoDe(method: string, url: string): OperacaoMelhorEnvio {
      const caminho = new URL(url).pathname;
      if (caminho === '/api/v2/me/shipment/services') return 'listServices';
      if (caminho === '/api/v2/me/shipment/agencies') return 'listAgencies';
      if (caminho === '/api/v2/me/cart' && method === 'POST') return 'addToCart';
      if (caminho === '/api/v2/me/shipment/checkout') return 'checkout';
      if (caminho === '/api/v2/me/shipment/generate') return 'generate';
      if (caminho === '/api/v2/me/shipment/print') return 'print';
      if (caminho.startsWith('/api/v2/me/orders/')) return 'getOrder';
      throw new Error(`chamada inesperada ao Melhor Envio: ${method} ${caminho}`);
    }

    function gravador(pedidoJaPago: boolean) {
      const ops: OperacaoMelhorEnvio[] = [];
      const fetchImpl = vi.fn(async (...[input, init]: FetchArgs) => {
        const op = operacaoDe(init?.method ?? 'GET', String(input));
        ops.push(op);
        const corpo: Record<OperacaoMelhorEnvio, unknown> = {
          listServices: [{ id: 3, company: { id: 2, name: 'Jadlog' } }],
          listAgencies: [{ id: 195 }],
          addToCart: { id: 'lbl-1' },
          checkout: {},
          generate: {},
          print: { url: 'https://sandbox.melhorenvio.com.br/imprimir/x' },
          getOrder: pedidoJaPago
            ? { id: 'lbl-1', paid_at: '2026-10-06 10:00:00', generated_at: null }
            : { id: 'lbl-1', tracking: 'ME1BR' },
          getMe: {},
          getBalance: {},
          tracking: {},
          calculate: [],
        };
        return new Response(JSON.stringify(corpo[op]), { status: 200 });
      });
      return { ops, fetchImpl };
    }

    const somar = (ops: OperacaoMelhorEnvio[]): number =>
      PRAZO_ME_TOKEN_MS + ops.reduce((s, op) => s + PRAZO_ME_MS[op], 0);

    it('the FRESH buy, with the drop-off agency resolved', async () => {
      const { ops, fetchImpl } = gravador(false);
      await comprarEtiqueta({
        api: api(fetchImpl),
        printLabelId: null,
        // A sender location and no agency: `ensureCartAgency` runs both lookups.
        buildCartPayload: () => ({ service: 3, from: { state_abbr: 'RS', city: 'Canoas' } }),
        persistPrintLabelId: async () => undefined,
      });
      expect(ops).toEqual([
        'listServices',
        'listAgencies',
        'addToCart',
        'checkout',
        'generate',
        'print',
        'getOrder',
      ]);
      expect(somar(ops)).toBeLessThanOrEqual(DURACAO_MAXIMA_COMPRAR_MS);
    });

    it('the RESUME of an unpaid anchored label', async () => {
      const { ops, fetchImpl } = gravador(false);
      await comprarEtiqueta({
        api: api(fetchImpl),
        printLabelId: 'lbl-1',
        buildCartPayload: () => ({ service: 3 }),
        persistPrintLabelId: async () => undefined,
      });
      expect(ops[0]).toBe('getOrder');
      expect(somar(ops)).toBeLessThanOrEqual(DURACAO_MAXIMA_COMPRAR_MS);
    });

    it('the RESUME of a paid label', async () => {
      const { ops, fetchImpl } = gravador(true);
      await comprarEtiqueta({
        api: api(fetchImpl),
        printLabelId: 'lbl-1',
        buildCartPayload: () => ({ service: 3 }),
        persistPrintLabelId: async () => undefined,
      });
      expect(ops).not.toContain('checkout');
      expect(somar(ops)).toBeLessThanOrEqual(DURACAO_MAXIMA_COMPRAR_MS);
    });
  });

  // One method is enough here: the per-method table below HANGS for any method
  // that does not pass the signal, so that is where "every" is enforced.
  it('passes the deadline signal to fetch', async () => {
    const fetchMock = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({})));
    await api(fetchMock)
      .getBalance()
      .catch(() => undefined);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  describe.each(Object.entries(PRAZO_ESPERADO))('%s (%i ms)', (operacao, budget) => {
    it(`is still pending at budget−1 and times out at the budget`, async () => {
      const { estado, pronto } = observar(
        INVOCAR[operacao as keyof typeof INVOCAR](api(fetchQueNuncaResponde())),
      );

      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(estado.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pronto;
      const err = estado.valor;
      expect(err).toBeInstanceOf(MelhorEnvioTimeoutError);
      // ⚠️ SUBCLASSES: the OAuth callback's `'rede'` arm and every
      // `isMelhorEnvioError` route guard keep recognising it.
      expect(err).toBeInstanceOf(MelhorEnvioNetworkError);
      expect(err).toBeInstanceOf(MelhorEnvioError);
      const t = err as MelhorEnvioTimeoutError;
      expect(t.operacao).toBe(operacao);
      expect(t.timeoutMs).toBe(budget);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('checkout says the label may be PAID — never "nada foi pago" or a bare "tente novamente"', async () => {
    const { estado, pronto } = observar(INVOCAR.checkout(api(fetchQueNuncaResponde())));
    await vi.advanceTimersByTimeAsync(PRAZO_ME_MS.checkout);
    await pronto;
    const msg = (estado.valor as Error).message;
    expect(msg).toContain('o pagamento pode ter sido concluído');
    expect(msg).toContain('confira o pedido antes de comprar de novo');
    expect(msg).not.toMatch(/nada foi pago/i);
  });

  it('the cart insert says nothing was paid, through the real transport', async () => {
    const { estado, pronto } = observar(INVOCAR.addToCart(api(fetchQueNuncaResponde())));
    await vi.advanceTimersByTimeAsync(PRAZO_ME_MS.addToCart);
    await pronto;
    expect((estado.valor as Error).message).toContain('Nada foi pago nesta tentativa');
  });

  // ⚠️ The copy invariant, over EVERY operation (the token POST included): only
  // the cart insert — which runs before the anchor and is never paid by our
  // explicit-id checkout — may say nothing was paid. Saying it anywhere after
  // the anchor would tell an operator to re-buy over a label already paid.
  const TODAS: readonly (OperacaoMelhorEnvio | 'token')[] = [
    ...(Object.keys(PRAZO_ME_MS) as OperacaoMelhorEnvio[]),
    'token',
  ];
  it.each(TODAS)('%s: "nada foi pago" iff it is the cart insert', (operacao) => {
    const msg = mensagemDeTempoEsgotadoMe(operacao, 10_000);
    expect(/nada foi pago/i.test(msg)).toBe(operacao === 'addToCart');
  });

  it('generate says the label is ALREADY paid and the buy resumes without paying again', () => {
    const msg = mensagemDeTempoEsgotadoMe('generate', PRAZO_ME_MS.generate);
    expect(msg).toContain('já paga');
    expect(msg).toContain('sem pagar outra vez');
  });

  it('a read names the window and says to try again', async () => {
    const { estado, pronto } = observar(INVOCAR.getMe(api(fetchQueNuncaResponde())));
    await vi.advanceTimersByTimeAsync(PRAZO_ME_MS.getMe);
    await pronto;
    expect((estado.valor as Error).message).toBe(
      'O Melhor Envio não respondeu em 10 s. Tente novamente.',
    );
  });

  it('a stall AFTER the headers times out too — never a raw DOMException', async () => {
    const { estado, pronto } = observar(INVOCAR.getOrder(api(fetchQueTravaNoCorpo())));
    await vi.advanceTimersByTimeAsync(PRAZO_ME_MS.getOrder);
    await pronto;
    expect(estado.valor).toBeInstanceOf(MelhorEnvioTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a fetch TypeError is a MelhorEnvioNetworkError (was the bare base), never a timeout', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('ECONNRESET');
    });
    const err = await api(fetchMock)
      .checkout(['lbl-1'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MelhorEnvioNetworkError);
    expect(err).not.toBeInstanceOf(MelhorEnvioTimeoutError);
    expect((err as MelhorEnvioNetworkError).cause).toBeInstanceOf(TypeError);
    expect((err as Error).message).toContain('POST /api/v2/me/shipment/checkout');
  });

  it('a connection dropped mid-body is a MelhorEnvioNetworkError, not a timeout', async () => {
    const fetchMock = vi.fn(async () => {
      const corpo = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(corpo, { status: 200 });
    });
    const err = await api(fetchMock)
      .getOrder('lbl-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MelhorEnvioNetworkError);
    expect(err).not.toBeInstanceOf(MelhorEnvioTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens the window AFTER the token: a slow token refresh does not eat the call budget', async () => {
    // ⚠️ Rejects on an already-aborted signal, as real `fetch` does — without
    // that, a window opened BEFORE the token would fire unseen and the call
    // would still succeed, so this test could not fail (review of #1679).
    const fetchMock = vi.fn(async (...[, init]: FetchArgs) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify({ balance: 10 }), { status: 200 });
    });
    const tokenLento = () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('tok'), PRAZO_ME_MS.getBalance + 5_000);
      });
    const { estado, pronto } = observar(api(fetchMock, tokenLento).getBalance());
    await vi.advanceTimersByTimeAsync(PRAZO_ME_MS.getBalance + 5_000);
    await pronto;
    expect(estado.valor).not.toBeInstanceOf(MelhorEnvioError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('the deadline is always released', () => {
    const casos: Array<[string, () => Promise<Response>, (e: unknown) => void]> = [
      [
        'success',
        async () => new Response(JSON.stringify({ balance: 10 }), { status: 200 }),
        (r) => expect(r).not.toBeInstanceOf(Error),
      ],
      [
        'an HTTP error',
        async () => new Response(JSON.stringify({ message: 'x' }), { status: 500 }),
        (e) => expect(e).toBeInstanceOf(MelhorEnvioHttpError),
      ],
      [
        'a 422',
        async () => new Response(JSON.stringify({ message: 'x', errors: {} }), { status: 422 }),
        (e) => expect(e).toBeInstanceOf(MelhorEnvioValidationError),
      ],
      [
        'a schema error',
        async () => new Response(JSON.stringify({ balance: 'muito' }), { status: 200 }),
        (e) => expect(e).toBeInstanceOf(MelhorEnvioSchemaError),
      ],
      [
        'a network error',
        async () => {
          throw new TypeError('failed to fetch');
        },
        (e) => expect(e).toBeInstanceOf(MelhorEnvioNetworkError),
      ],
    ];

    it.each(casos)('after %s', async (_nome, resposta, verificar) => {
      const r = await api(vi.fn(resposta))
        .getBalance()
        .catch((e: unknown) => e);
      verificar(r);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('/oauth/token', () => {
    it.each([
      ['exchangeCode', (c: OAuthConfig) => exchangeCode(c, 'code-1')],
      ['refreshAccessToken', (c: OAuthConfig) => refreshAccessToken(c, 'refresh-1')],
    ])('%s times out at PRAZO_ME_TOKEN_MS', async (_nome, chamar) => {
      const { estado, pronto } = observar(chamar(oauthConfig(fetchQueNuncaResponde())));

      await vi.advanceTimersByTimeAsync(PRAZO_ME_TOKEN_MS - 1);
      expect(estado.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pronto;
      expect(estado.valor).toBeInstanceOf(MelhorEnvioTimeoutError);
      expect((estado.valor as MelhorEnvioTimeoutError).operacao).toBe('token');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a stall mid-body is a timeout, not a raw DOMException', async () => {
      const { estado, pronto } = observar(
        refreshAccessToken(oauthConfig(fetchQueTravaNoCorpo()), 'r'),
      );
      await vi.advanceTimersByTimeAsync(PRAZO_ME_TOKEN_MS);
      await pronto;
      expect(estado.valor).toBeInstanceOf(MelhorEnvioTimeoutError);
    });

    it.each([
      [
        'a network error',
        async () => {
          throw new TypeError('ECONNRESET');
        },
      ],
      ['an HTTP error', async () => new Response(JSON.stringify({ error: 'x' }), { status: 400 })],
    ])('releases the deadline after %s', async (_nome, resposta) => {
      await refreshAccessToken(oauthConfig(vi.fn(resposta)), 'r').catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('releases the deadline after a success', async () => {
      const fetchMock = vi.fn(
        async (..._args: FetchArgs) =>
          new Response(
            JSON.stringify({
              token_type: 'Bearer',
              expires_in: 2_592_000,
              access_token: 'a',
              refresh_token: 'r',
            }),
            { status: 200 },
          ),
      );
      await refreshAccessToken(oauthConfig(fetchMock), 'r');
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
