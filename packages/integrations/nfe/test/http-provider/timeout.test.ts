/**
 * NFeHttpClient deadlines (#1094): every method is bounded, the body read is
 * inside the window, a gateway 504 is an outcome-unknown timeout, and none of
 * it is retryable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNFeHttpClient,
  isRetryableNFeHttpError,
  NFE_NIVEL_POR_OPERACAO,
  NFE_PRAZO_MS,
  NFeCertificateError,
  NFeHttpError,
  NFeNetworkError,
  NFeSchemaError,
  NFeServerError,
  NFeTimeoutError,
  type NFeHttpClient,
} from '../../src/http-provider';

type FetchArgs = Parameters<typeof globalThis.fetch>;

function makeClient(fetch: typeof globalThis.fetch): NFeHttpClient {
  return createNFeHttpClient({
    baseUrl: 'http://localhost:3004',
    getAuthToken: async () => 'fake-token',
    fetch,
  });
}

/** A route that accepts and never answers; rejects with the signal's reason, as real fetch does. */
function fetchQueNuncaResponde() {
  return vi.fn(
    (...[, init]: FetchArgs) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

/** 200 headers, then a body that stalls until the signal aborts it. */
function fetchQueTravaNoCorpo() {
  return vi.fn(async (...[, init]: FetchArgs) => {
    const signal = init?.signal;
    const corpo = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(corpo, { status: 200 });
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

/** One invocation per method; `satisfies` makes a new method a compile error here. */
const INVOCAR = {
  emitir: (c: NFeHttpClient) => c.emitir('PED-1'),
  emitirLote: (c: NFeHttpClient) => c.emitirLote(['PED-1', 'PED-2']),
  consultar: (c: NFeHttpClient) => c.consultar('3526'),
  verificar: (c: NFeHttpClient) => c.verificar('F-1', ['msg-1']),
  processarPendentes: (c: NFeHttpClient) => c.processarPendentes(),
  cancelar: (c: NFeHttpClient) => c.cancelar('PED-1', 'nfe-1', 'cancelamento por teste'),
  inutilizar: (c: NFeHttpClient) =>
    c.inutilizar({
      filialId: 'F-1',
      serie: 1,
      nNFIni: 10,
      nNFFin: 12,
      xJust: 'faixa pulada no teste',
    }),
  cartaCorrecao: (c: NFeHttpClient) => c.cartaCorrecao('PED-1', 'nfe-1', 'correção do endereço'),
  danfe: (c: NFeHttpClient) => c.danfe('PED-1', 'nfe-1', 'simplificado'),
  cartaCorrecaoDanfe: (c: NFeHttpClient) => c.cartaCorrecaoDanfe('PED-1', 'nfe-1', 'cce-1'),
  statusServico: (c: NFeHttpClient) => c.statusServico('normal', 'F-1'),
  consultaCadastro: (c: NFeHttpClient) => c.consultaCadastro('12345678000190', 'SP', 'F-1'),
  uploadCertificado: (c: NFeHttpClient) => c.uploadCertificado('F-1', 'cGZ4', 'senha', 'a.pfx'),
  deleteCertificado: (c: NFeHttpClient) => c.deleteCertificado('F-1'),
} satisfies Record<keyof NFeHttpClient, (c: NFeHttpClient) => Promise<unknown>>;

/** The #1094 design, written out — NOT read from the table under test. */
const NIVEL_ESPERADO = {
  emitir: 'longo',
  emitirLote: 'longo',
  consultar: 'curto',
  verificar: 'longo',
  processarPendentes: 'longo',
  cancelar: 'longo',
  inutilizar: 'longo',
  cartaCorrecao: 'longo',
  danfe: 'curto',
  cartaCorrecaoDanfe: 'curto',
  statusServico: 'curto',
  consultaCadastro: 'curto',
  uploadCertificado: 'longo',
  deleteCertificado: 'longo',
} as const satisfies Record<keyof NFeHttpClient, 'curto' | 'longo'>;

describe('NFeHttpClient deadlines (#1094)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends an AbortSignal on JSON calls and on binary artifacts', async () => {
    const fetchMock = vi.fn(
      async (..._args: FetchArgs) =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
    );
    await makeClient(fetchMock).danfe('PED-1', 'nfe-1', 'simplificado');
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('pins every tier — downgrading a method to `curto` must be a deliberate, reviewed edit', () => {
    // ⚠️ `curto` fires BEFORE the platform gives up, so only a method whose repeat
    // is harmless may have it: a CC-e, an inutilização or an emission may not.
    expect(NFE_NIVEL_POR_OPERACAO).toEqual(NIVEL_ESPERADO);
    expect(NFE_PRAZO_MS).toEqual({ curto: 90_000, longo: 360_000 });
  });

  describe.each(Object.entries(NIVEL_ESPERADO))('%s (%s)', (operacao, nivel) => {
    const budget = { curto: 90_000, longo: 360_000 }[nivel];

    it(`is pending at ${String(budget - 1)} ms, times out at ${String(budget)} ms, never retryable`, async () => {
      const { estado, pronto } = observar(
        INVOCAR[operacao as keyof typeof INVOCAR](makeClient(fetchQueNuncaResponde())),
      );

      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(estado.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pronto;
      const err = estado.valor;
      expect(err).toBeInstanceOf(NFeTimeoutError);
      // ⚠️ A SUBCLASS, so `NFeHttpError || NFeNetworkError` narrowing keeps working…
      expect(err).toBeInstanceOf(NFeNetworkError);
      // …and yet never retried: the route may still be running.
      expect(isRetryableNFeHttpError(err)).toBe(false);
      const t = err as NFeTimeoutError;
      expect(t.origem).toBe('prazo');
      expect(t.timeoutMs).toBe(budget);
      expect(t.operacao).toBe(operacao);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('an emission timeout says the operation may still be running — never "tente novamente"', async () => {
    const { estado, pronto } = observar(INVOCAR.emitir(makeClient(fetchQueNuncaResponde())));
    await vi.advanceTimersByTimeAsync(NFE_PRAZO_MS.longo);
    await pronto;
    const msg = (estado.valor as Error).message;
    expect(msg).toContain('confira o estado da NF-e');
    expect(msg).not.toMatch(/tente novamente/i);
  });

  it('a read timeout says to try again, naming the window', async () => {
    const { estado, pronto } = observar(INVOCAR.statusServico(makeClient(fetchQueNuncaResponde())));
    await vi.advanceTimersByTimeAsync(NFE_PRAZO_MS.curto);
    await pronto;
    expect((estado.valor as Error).message).toBe(
      'A integração fiscal não respondeu em 90 s. Tente novamente.',
    );
  });

  it('a JSON route that stalls AFTER its headers times out — never a raw DOMException', async () => {
    const { estado, pronto } = observar(INVOCAR.consultar(makeClient(fetchQueTravaNoCorpo())));
    await vi.advanceTimersByTimeAsync(NFE_PRAZO_MS.curto);
    await pronto;
    expect(estado.valor).toBeInstanceOf(NFeTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a DANFE whose Blob stalls mid-body times out BEFORE anything is printed', async () => {
    const { estado, pronto } = observar(INVOCAR.danfe(makeClient(fetchQueTravaNoCorpo())));
    await vi.advanceTimersByTimeAsync(NFE_PRAZO_MS.curto);
    await pronto;
    expect(estado.valor).toBeInstanceOf(NFeTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a LATE network failure is the platform's gateway timeout — never a retryable NFeNetworkError", async () => {
    // At ~300 s the platform answers 504 without CORS headers; the browser only
    // sees a TypeError. As an NFeNetworkError it was retryable, and withNFeRetry
    // re-POSTed the emission over the run still talking to SEFAZ.
    const { estado, pronto } = observar(INVOCAR.emitir(makeClient(fetchQueFalhaTarde(300_000))));
    await vi.advanceTimersByTimeAsync(300_000);
    await pronto;
    expect(estado.valor).toBeInstanceOf(NFeTimeoutError);
    const t = estado.valor as NFeTimeoutError;
    expect(t.origem).toBe('gateway');
    expect(t.timeoutMs).toBeNull();
    expect(isRetryableNFeHttpError(t)).toBe(false);
    expect(t.message).toContain('confira o estado da NF-e');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('near-miss: an EARLY network failure stays a retryable NFeNetworkError', async () => {
    const { estado, pronto } = observar(INVOCAR.emitir(makeClient(fetchQueFalhaTarde(29_999))));
    await vi.advanceTimersByTimeAsync(29_999);
    await pronto;
    expect(estado.valor).toBeInstanceOf(NFeNetworkError);
    expect(estado.valor).not.toBeInstanceOf(NFeTimeoutError);
    expect(isRetryableNFeHttpError(estado.valor)).toBe(true);
  });

  it('a DANFE error whose body stalls after 500 headers times out too', async () => {
    const fetchMock = vi.fn(async (...[, init]: FetchArgs) => {
      const signal = init?.signal;
      const corpo = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(corpo, { status: 500 });
    });
    const { estado, pronto } = observar(INVOCAR.danfe(makeClient(fetchMock)));
    await vi.advanceTimersByTimeAsync(NFE_PRAZO_MS.curto);
    await pronto;
    expect(estado.valor).toBeInstanceOf(NFeTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a connection dropped mid-body is an NFeNetworkError (still retryable), not a timeout', async () => {
    const fetchMock = vi.fn(async () => {
      const corpo = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('network error'));
        },
      });
      return new Response(corpo, { status: 200 });
    });
    const err = await makeClient(fetchMock)
      .consultar('3526')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NFeNetworkError);
    expect(err).not.toBeInstanceOf(NFeTimeoutError);
    expect(isRetryableNFeHttpError(err)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('HTTP 504', () => {
    const gateway504 = () =>
      vi.fn(async () => new Response('<html>upstream request timeout</html>', { status: 504 }));

    it('on emitir is the platform gateway → a NON-retryable NFeTimeoutError', async () => {
      const err = await makeClient(gateway504())
        .emitir('PED-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NFeTimeoutError);
      const t = err as NFeTimeoutError;
      expect(t.origem).toBe('gateway');
      expect(t.timeoutMs).toBeNull();
      expect(t.operacao).toBe('emitir');
      // Before #1094 this was an NFeServerError, which withNFeRetry re-POSTed.
      expect(isRetryableNFeHttpError(err)).toBe(false);
    });

    it('on a cert endpoint is checked BEFORE its custom error mapping', async () => {
      const err = await makeClient(gateway504())
        .uploadCertificado('F-1', 'cGZ4', 'senha', 'a.pfx')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NFeTimeoutError);
      expect(err).not.toBeInstanceOf(NFeCertificateError);
    });

    it('on a DANFE artifact is a timeout too', async () => {
      const err = await makeClient(gateway504())
        .danfe('PED-1', 'nfe-1', 'zpl2')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NFeTimeoutError);
    });

    it('with an empty body is the gateway', async () => {
      const err = await makeClient(vi.fn(async () => new Response(null, { status: 504 })))
        .consultar('3526')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NFeTimeoutError);
    });

    it('with OUR coded envelope stays a route answer (NFeServerError)', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'lento', code: 'SEFAZ_LENTA' }), { status: 504 }),
      );
      const err = await makeClient(fetchMock)
        .consultar('3526')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NFeServerError);
      expect(err).not.toBeInstanceOf(NFeTimeoutError);
    });

    it('a 502 is untouched (NFeServerError, retryable as before)', async () => {
      const err = await makeClient(vi.fn(async () => new Response('bad gateway', { status: 502 })))
        .consultar('3526')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NFeServerError);
      expect(isRetryableNFeHttpError(err)).toBe(true);
    });
  });

  describe('the deadline is always released', () => {
    const consulta = {
      chave: '3526',
      cStat: '100',
      xMotivo: 'Autorizado',
      nProt: '1',
      raw: null,
    };
    const casos: Array<[string, () => Promise<Response>, (r: unknown) => void]> = [
      [
        'success',
        async () => new Response(JSON.stringify(consulta), { status: 200 }),
        (r) => expect(r).toEqual(consulta),
      ],
      [
        'an HTTP error',
        async () => new Response(JSON.stringify({ error: 'x' }), { status: 500 }),
        (e) => expect(e).toBeInstanceOf(NFeHttpError),
      ],
      [
        'a schema error',
        async () => new Response(JSON.stringify({ nada: true }), { status: 200 }),
        (e) => expect(e).toBeInstanceOf(NFeSchemaError),
      ],
      [
        'a gateway 504',
        async () => new Response('timeout', { status: 504 }),
        (e) => expect(e).toBeInstanceOf(NFeTimeoutError),
      ],
      [
        'a network error',
        async () => {
          throw new TypeError('failed to fetch');
        },
        (e) => expect(e).toBeInstanceOf(NFeNetworkError),
      ],
    ];

    it.each(casos)('after %s', async (_nome, resposta, verificar) => {
      const r = await makeClient(vi.fn(resposta))
        .consultar('3526')
        .catch((e: unknown) => e);
      verificar(r);
      expect(vi.getTimerCount()).toBe(0);
    });

    const falhasDanfe: Array<[string, () => Promise<Response>, (e: unknown) => void]> = [
      [
        'an HTTP 500',
        async () => new Response(JSON.stringify({ error: 'x' }), { status: 500 }),
        (e) => expect(e).toBeInstanceOf(NFeHttpError),
      ],
      [
        'a gateway 504',
        async () => new Response('timeout', { status: 504 }),
        (e) => expect(e).toBeInstanceOf(NFeTimeoutError),
      ],
      [
        'a network error',
        async () => {
          throw new TypeError('failed to fetch');
        },
        (e) => expect(e).toBeInstanceOf(NFeNetworkError),
      ],
    ];

    it.each(falhasDanfe)(
      'after a DANFE download ending in %s',
      async (_nome, resposta, verificar) => {
        const r = await makeClient(vi.fn(resposta))
          .danfe('PED-1', 'nfe-1', 'simplificado')
          .catch((e: unknown) => e);
        verificar(r);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('after a successful DANFE download', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(new Uint8Array([37, 80, 68, 70]), {
            status: 200,
            headers: { 'content-disposition': 'attachment; filename="danfe-7.pdf"' },
          }),
      );
      const out = await makeClient(fetchMock).danfe('PED-1', 'nfe-1', 'simplificado');
      expect(out.filename).toBe('danfe-7.pdf');
      expect(out.blob.size).toBe(4);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
