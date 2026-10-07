import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFreightHttpClient,
  FREIGHT_NIVEL_POR_OPERACAO,
  FREIGHT_PRAZO_MS,
  type FreightHttpClient,
} from '../../src/http-client/client';
import {
  FreightHttpError,
  FreightNetworkError,
  FreightSchemaError,
  FreightServerError,
  FreightTimeoutError,
} from '../../src/http-client/errors';

type FetchArgs = Parameters<typeof globalThis.fetch>;

function client(fetchImpl: typeof globalThis.fetch): FreightHttpClient {
  return createFreightHttpClient({
    baseUrl: 'http://localhost:3005',
    getAuthToken: async () => 'id-token',
    fetch: fetchImpl,
  });
}

/**
 * A route that accepts the connection and never answers. Rejects the way real
 * `fetch` does when its signal aborts: with the signal's reason, as-is.
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
 * A route that sends 200 headers and then stalls mid-body. A user-built
 * `Response` body is NOT cancelled by the request signal, so the stub wires the
 * abort into the stream itself — which is what a real network body does.
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

/**
 * A route that the PLATFORM gives up on: at `aposMs` the browser rejects with
 * `TypeError: Failed to fetch`, because the gateway's 504 carries no CORS
 * headers and a cross-origin `fetch` never sees it as a status (#1094 review).
 */
function fetchQueFalhaTarde(aposMs: number) {
  return vi.fn(
    () =>
      new Promise<Response>((_resolve, reject) => {
        setTimeout(() => reject(new TypeError('Failed to fetch')), aposMs);
      }),
  );
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
 * One invocation per method. `satisfies` makes a NEW client method a compile
 * error here until it is added — so no method can ship without a timeout test.
 */
const INVOCAR = {
  oauthStart: (c: FreightHttpClient) => c.oauthStart('int-1'),
  calculate: (c: FreightHttpClient) =>
    c.calculate('int-1', { from: { postal_code: 'a' }, to: { postal_code: 'b' } }),
  conta: (c: FreightHttpClient) => c.conta('int-1'),
  agencias: (c: FreightHttpClient) => c.agencias('int-1', { service: 3, state: 'RS', city: 'X' }),
  comprar: (c: FreightHttpClient) => c.comprar('int-1', 'ped-1', { service: 3 }),
  imprimir: (c: FreightHttpClient) => c.imprimir('int-1', 'lbl-1'),
  rastrear: (c: FreightHttpClient) => c.rastrear('int-1', 'lbl-1'),
} satisfies Record<keyof FreightHttpClient, (c: FreightHttpClient) => Promise<unknown>>;

/** The #1094 design, written out — NOT read from the table under test. */
const NIVEL_ESPERADO = {
  oauthStart: 'curto',
  calculate: 'curto',
  conta: 'curto',
  agencias: 'curto',
  comprar: 'longo',
  imprimir: 'curto',
  rastrear: 'curto',
} as const satisfies Record<keyof FreightHttpClient, 'curto' | 'longo'>;

describe('FreightHttpClient deadlines (#1094)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends an AbortSignal on every request', async () => {
    const fetchMock = vi.fn(
      async (..._args: FetchArgs) => new Response(JSON.stringify({ authorizeUrl: 'u' })),
    );
    await client(fetchMock).oauthStart('int-1');
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('pins every tier — downgrading a method to `curto` must be a deliberate, reviewed edit', () => {
    // ⚠️ `curto` fires BEFORE the platform gives up, so only a method whose repeat
    // is harmless may have it. `comprar` pays for a label.
    expect(FREIGHT_NIVEL_POR_OPERACAO).toEqual(NIVEL_ESPERADO);
    expect(FREIGHT_PRAZO_MS).toEqual({ curto: 60_000, longo: 360_000 });
  });

  describe.each(Object.entries(NIVEL_ESPERADO))('%s (%s)', (operacao, nivel) => {
    const budget = { curto: 60_000, longo: 360_000 }[nivel];

    it(`is still pending at ${String(budget - 1)} ms and times out at ${String(budget)} ms`, async () => {
      const { estado, pronto } = observar(
        INVOCAR[operacao as keyof typeof INVOCAR](client(fetchQueNuncaResponde())),
      );

      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(estado.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pronto;
      const err = estado.valor;
      expect(err).toBeInstanceOf(FreightTimeoutError);
      // ⚠️ A SUBCLASS: every catch site narrowing on FreightNetworkError keeps working.
      expect(err).toBeInstanceOf(FreightNetworkError);
      const t = err as FreightTimeoutError;
      expect(t.origem).toBe('prazo');
      expect(t.timeoutMs).toBe(budget);
      expect(t.operacao).toBe(operacao);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('comprar says the purchase may still be in progress — never "tente novamente"', async () => {
    const { estado, pronto } = observar(INVOCAR.comprar(client(fetchQueNuncaResponde())));
    await vi.advanceTimersByTimeAsync(FREIGHT_PRAZO_MS.longo);
    await pronto;
    const msg = (estado.valor as Error).message;
    expect(msg).toContain('confira se a etiqueta já aparece no pedido');
    expect(msg).not.toMatch(/tente novamente/i);
  });

  it('a read says to try again, naming the window', async () => {
    const { estado, pronto } = observar(INVOCAR.conta(client(fetchQueNuncaResponde())));
    await vi.advanceTimersByTimeAsync(FREIGHT_PRAZO_MS.curto);
    await pronto;
    expect((estado.valor as Error).message).toBe(
      'O serviço de frete não respondeu em 60 s. Tente novamente.',
    );
  });

  it('a route that stalls AFTER its headers times out too — never a raw DOMException', async () => {
    const { estado, pronto } = observar(INVOCAR.conta(client(fetchQueTravaNoCorpo())));
    await vi.advanceTimersByTimeAsync(FREIGHT_PRAZO_MS.curto);
    await pronto;
    expect(estado.valor).toBeInstanceOf(FreightTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a connection dropped mid-body is a FreightNetworkError, not a timeout', async () => {
    const fetchMock = vi.fn(async () => {
      const corpo = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(corpo, { status: 200 });
    });
    const err = await client(fetchMock)
      .conta('int-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreightNetworkError);
    expect(err).not.toBeInstanceOf(FreightTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a LATE network failure is the platform's gateway timeout — never a plain FreightNetworkError", async () => {
    // At ~300 s the platform answers 504 without CORS headers; the browser only
    // sees a TypeError. As a FreightNetworkError the operator read "falha de rede"
    // and clicked Comprar again over the purchase still running.
    const { estado, pronto } = observar(INVOCAR.comprar(client(fetchQueFalhaTarde(300_000))));
    await vi.advanceTimersByTimeAsync(300_000);
    await pronto;
    expect(estado.valor).toBeInstanceOf(FreightTimeoutError);
    const t = estado.valor as FreightTimeoutError;
    expect(t.origem).toBe('gateway');
    expect(t.timeoutMs).toBeNull();
    expect(t.message).toContain('confira se a etiqueta já aparece no pedido');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('near-miss: an EARLY network failure stays a FreightNetworkError', async () => {
    const { estado, pronto } = observar(INVOCAR.conta(client(fetchQueFalhaTarde(29_999))));
    await vi.advanceTimersByTimeAsync(29_999);
    await pronto;
    expect(estado.valor).toBeInstanceOf(FreightNetworkError);
    expect(estado.valor).not.toBeInstanceOf(FreightTimeoutError);
  });

  it('a fetch TypeError stays a FreightNetworkError', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('failed to fetch');
    });
    const err = await client(fetchMock)
      .conta('int-1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreightNetworkError);
    expect(err).not.toBeInstanceOf(FreightTimeoutError);
  });

  describe('HTTP 504', () => {
    it('with an HTML body is the platform gateway → FreightTimeoutError(gateway)', async () => {
      const fetchMock = vi.fn(
        async () => new Response('<html>upstream request timeout</html>', { status: 504 }),
      );
      const err = await client(fetchMock)
        .comprar('int-1', 'ped-1', { service: 3 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FreightTimeoutError);
      const t = err as FreightTimeoutError;
      expect(t.origem).toBe('gateway');
      expect(t.timeoutMs).toBeNull();
      expect(t.operacao).toBe('comprar');
      expect(t.message).toContain('confira se a etiqueta');
    });

    it('with an empty body is the platform gateway too', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 504 }));
      const err = await client(fetchMock)
        .conta('int-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FreightTimeoutError);
    });

    it('with OUR coded envelope (any other code) stays a route answer (FreightServerError)', async () => {
      // ⚠️ This used to use `ME_TIMEOUT` — #1679 made that ONE code a timeout
      // (below). Every other coded 504 must still read as the route's answer.
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Algo demorou', code: 'OUTRO_TIMEOUT' }), {
            status: 504,
          }),
      );
      const err = await client(fetchMock)
        .conta('int-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FreightServerError);
      expect(err).not.toBeInstanceOf(FreightTimeoutError);
      expect((err as Error).message).toBe('Algo demorou');
    });

    it('`ME_TIMEOUT` is Melhor Envio stalling → FreightTimeoutError(provedor), the route copy kept (#1679)', async () => {
      // A checkout that Melhor Envio never answered may have PAID — the same
      // "outcome unknown" every caller's timeout arm already handles.
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'O Melhor Envio não respondeu em 60 s ao pagar a etiqueta…',
              code: 'ME_TIMEOUT',
              operacao: 'checkout',
              timeoutMs: 60_000,
            }),
            { status: 504 },
          ),
      );
      const err = await client(fetchMock)
        .comprar('int-1', 'ped-1', { service: 3 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FreightTimeoutError);
      const t = err as FreightTimeoutError;
      expect(t.origem).toBe('provedor');
      expect(t.timeoutMs).toBe(60_000);
      expect(t.operacao).toBe('comprar');
      expect(t.message).toBe('O Melhor Envio não respondeu em 60 s ao pagar a etiqueta…');
    });

    it('`ME_TIMEOUT` with a non-numeric timeoutMs and no message still maps, with a null budget', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'ME_TIMEOUT', timeoutMs: 'muito' }), {
            status: 504,
          }),
      );
      const err = await client(fetchMock)
        .conta('int-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FreightTimeoutError);
      expect((err as FreightTimeoutError).timeoutMs).toBeNull();
      expect((err as Error).message).toBe(
        'O serviço de frete não respondeu a tempo. Tente novamente.',
      );
    });

    it('near-miss: `ME_TIMEOUT` on a status other than 504 is not a timeout', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'x', code: 'ME_TIMEOUT' }), { status: 502 }),
      );
      const err = await client(fetchMock)
        .conta('int-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FreightServerError);
    });

    it('a 502 is untouched (still FreightServerError)', async () => {
      const fetchMock = vi.fn(
        async () => new Response('<html>bad gateway</html>', { status: 502 }),
      );
      const err = await client(fetchMock)
        .conta('int-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FreightServerError);
    });
  });

  describe('the deadline is always released', () => {
    const casos: Array<[string, () => Promise<Response>, (e: unknown) => void]> = [
      [
        'success',
        async () =>
          new Response(JSON.stringify({ connected: false, me: null, balance: null }), {
            status: 200,
          }),
        (r) => expect(r).toEqual({ connected: false, me: null, balance: null }),
      ],
      [
        'an HTTP error',
        async () => new Response(JSON.stringify({ error: 'x' }), { status: 500 }),
        (e) => expect(e).toBeInstanceOf(FreightHttpError),
      ],
      [
        'a schema error',
        async () => new Response(JSON.stringify({ nada: true }), { status: 200 }),
        (e) => expect(e).toBeInstanceOf(FreightSchemaError),
      ],
      [
        'a gateway 504',
        async () => new Response('timeout', { status: 504 }),
        (e) => expect(e).toBeInstanceOf(FreightTimeoutError),
      ],
      [
        'a network error',
        async () => {
          throw new TypeError('failed to fetch');
        },
        (e) => expect(e).toBeInstanceOf(FreightNetworkError),
      ],
    ];

    it.each(casos)('after %s', async (_nome, resposta, verificar) => {
      const r = await client(vi.fn(resposta))
        .conta('int-1')
        .catch((e: unknown) => e);
      verificar(r);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
