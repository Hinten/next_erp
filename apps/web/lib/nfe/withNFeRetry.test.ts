/**
 * `withNFeRetry` per-endpoint retry policy (#90). The key invariants:
 * idempotent / server-deduped endpoints retry the full transient set;
 * `cartaCorrecao` and `inutilizar` retry ONLY the pre-send 503; `verificar` and
 * `processarPendentes` never retry; and a TIMEOUT (#1094) is never retried by
 * any of them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNFeHttpClient,
  NFeNetworkError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
  NFeTimeoutError,
  NFeXsdValidationFailedError,
  NFE_PRAZO_MS,
  type NFeHttpClient,
} from '@delfrance/integrations-nfe/http-provider';

import { withNFeRetry } from './withNFeRetry';

/** A client whose every method delegates to one vi.fn — overridden per test. */
function fakeClient(overrides: Partial<NFeHttpClient>): NFeHttpClient {
  const notImpl = () => Promise.reject(new Error('not implemented in fake'));
  return {
    emitir: notImpl as never,
    emitirLote: notImpl as never,
    consultar: notImpl as never,
    verificar: notImpl as never,
    consultaCadastro: notImpl as never,
    processarPendentes: notImpl as never,
    cancelar: notImpl as never,
    inutilizar: notImpl as never,
    cartaCorrecao: notImpl as never,
    danfe: notImpl as never,
    cartaCorrecaoDanfe: notImpl as never,
    statusServico: notImpl as never,
    uploadCertificado: notImpl as never,
    deleteCertificado: notImpl as never,
    ...overrides,
  };
}

/** A fn that rejects `failures` times (with `err`) then resolves `value`. */
function failThenSucceed<T>(failures: number, err: unknown, value: T): () => Promise<T> {
  let calls = 0;
  return () => {
    calls += 1;
    return calls <= failures ? Promise.reject(err) : Promise.resolve(value);
  };
}

describe('withNFeRetry', () => {
  it('emitir retries a transient NFeServerError then succeeds', async () => {
    const emitir = vi.fn(
      failThenSucceed(1, new NFeServerError('boom', 500, null), { nfeId: 'n1' } as never),
    );
    const client = withNFeRetry(fakeClient({ emitir }));
    await expect(client.emitir('PED-1')).resolves.toMatchObject({ nfeId: 'n1' });
    expect(emitir).toHaveBeenCalledTimes(2);
  });

  it('emitir does NOT retry a deterministic NFeRejectedError', async () => {
    const emitir = vi.fn(() => Promise.reject(new NFeRejectedError('204', 'dup', null)));
    const client = withNFeRetry(fakeClient({ emitir }));
    await expect(client.emitir('PED-1')).rejects.toBeInstanceOf(NFeRejectedError);
    expect(emitir).toHaveBeenCalledTimes(1);
  });

  it('consultar retries a transient NFeNetworkError', async () => {
    const consultar = vi.fn(
      failThenSucceed(1, new NFeNetworkError('reset'), { cStat: '100' } as never),
    );
    const client = withNFeRetry(fakeClient({ consultar }));
    await expect(client.consultar('chave')).resolves.toMatchObject({ cStat: '100' });
    expect(consultar).toHaveBeenCalledTimes(2);
  });

  it('verificar passes args through and resolves on success (single attempt)', async () => {
    const verificar = vi.fn(() =>
      Promise.resolve({ filialId: 'F-1', results: [], msgsNaoEncontradas: [] } as never),
    );
    const client = withNFeRetry(fakeClient({ verificar }));
    await expect(client.verificar('F-1', ['msg-1'])).resolves.toMatchObject({ filialId: 'F-1' });
    expect(verificar).toHaveBeenCalledTimes(1);
    expect(verificar).toHaveBeenCalledWith('F-1', ['msg-1']);
  });

  it('verificar does NOT retry a transient 5xx — a re-POST could overlap the in-flight server run', async () => {
    const verificar = vi.fn(() => Promise.reject(new NFeServerError('boom', 500, null)));
    const client = withNFeRetry(fakeClient({ verificar }));
    await expect(client.verificar('F-1', ['msg-1'])).rejects.toBeInstanceOf(NFeServerError);
    expect(verificar).toHaveBeenCalledTimes(1);
  });

  it('verificar does NOT retry a network error either (no retry at all)', async () => {
    const verificar = vi.fn(() => Promise.reject(new NFeNetworkError('reset')));
    const client = withNFeRetry(fakeClient({ verificar }));
    await expect(client.verificar('F-1', ['msg-1'])).rejects.toBeInstanceOf(NFeNetworkError);
    expect(verificar).toHaveBeenCalledTimes(1);
  });

  it('consultaCadastro retries a transient NFeNetworkError (read-only POST)', async () => {
    const consultaCadastro = vi.fn(
      failThenSucceed(1, new NFeNetworkError('reset'), { supported: true, infCad: [] } as never),
    );
    const client = withNFeRetry(fakeClient({ consultaCadastro }));
    await expect(client.consultaCadastro('14200166000187', 'SP', 'F-1')).resolves.toMatchObject({
      supported: true,
    });
    expect(consultaCadastro).toHaveBeenCalledTimes(2);
  });

  it('consultaCadastro makes ONE attempt on an XSD-coded 500 — no SEFAZ re-POST burst (#1602)', async () => {
    // End to end through the REAL client error mapper: the route's XSD-coded 500
    // must arrive as a deterministic error, or retryTransient re-runs the route —
    // and with it the POST to SEFAZ — three times for a failure that cannot change.
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: 'XSD validation failed for <retConsCad>',
            code: 'NFeXsdValidationError',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const client = withNFeRetry(
      createNFeHttpClient({
        baseUrl: 'http://nfe.test',
        getAuthToken: () => Promise.resolve('token'),
        fetch,
      }),
    );
    await expect(client.consultaCadastro('14200166000187', 'SP', 'F-1')).rejects.toBeInstanceOf(
      NFeXsdValidationFailedError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cartaCorrecao does NOT retry a post-send NFeServerError (not idempotent)', async () => {
    const cartaCorrecao = vi.fn(() => Promise.reject(new NFeServerError('boom', 500, null)));
    const client = withNFeRetry(fakeClient({ cartaCorrecao }));
    await expect(client.cartaCorrecao('PED-1', 'n1', 'x'.repeat(20))).rejects.toBeInstanceOf(
      NFeServerError,
    );
    expect(cartaCorrecao).toHaveBeenCalledTimes(1);
  });

  it('cartaCorrecao DOES retry the pre-send NFeRuntimeNotReadyError', async () => {
    const cartaCorrecao = vi.fn(
      failThenSucceed(1, new NFeRuntimeNotReadyError('cert', null), { nSeqEvento: 1 } as never),
    );
    const client = withNFeRetry(fakeClient({ cartaCorrecao }));
    await expect(client.cartaCorrecao('PED-1', 'n1', 'x'.repeat(20))).resolves.toMatchObject({
      nSeqEvento: 1,
    });
    expect(cartaCorrecao).toHaveBeenCalledTimes(2);
  });

  it('processarPendentes does NOT retry a transient NFeServerError — it transmits and loops over SEFAZ', async () => {
    const processarPendentes = vi.fn(() => Promise.reject(new NFeServerError('boom', 500, null)));
    const client = withNFeRetry(fakeClient({ processarPendentes }));
    await expect(client.processarPendentes()).rejects.toBeInstanceOf(NFeServerError);
    expect(processarPendentes).toHaveBeenCalledTimes(1);
  });

  it('processarPendentes does NOT retry a network error either', async () => {
    const processarPendentes = vi.fn(() => Promise.reject(new NFeNetworkError('reset')));
    const client = withNFeRetry(fakeClient({ processarPendentes }));
    await expect(client.processarPendentes()).rejects.toBeInstanceOf(NFeNetworkError);
    expect(processarPendentes).toHaveBeenCalledTimes(1);
  });

  const inutArgs = { filialId: 'F-1', serie: 1, nNFIni: 1, nNFFin: 1, xJust: 'x'.repeat(20) };

  it('inutilizar does NOT retry a post-send NFeServerError (563 is not idempotent)', async () => {
    const inutilizar = vi.fn(() => Promise.reject(new NFeServerError('boom', 500, null)));
    const client = withNFeRetry(fakeClient({ inutilizar }));
    await expect(client.inutilizar(inutArgs)).rejects.toBeInstanceOf(NFeServerError);
    expect(inutilizar).toHaveBeenCalledTimes(1);
  });

  it('inutilizar DOES retry the pre-send NFeRuntimeNotReadyError', async () => {
    const inutilizar = vi.fn(
      failThenSucceed(1, new NFeRuntimeNotReadyError('cert', null), { aprovada: true } as never),
    );
    const client = withNFeRetry(fakeClient({ inutilizar }));
    await expect(client.inutilizar(inutArgs)).resolves.toMatchObject({ aprovada: true });
    expect(inutilizar).toHaveBeenCalledTimes(2);
  });
});

/**
 * #1094, end to end through the REAL client: its deadline and its gateway-504
 * mapping must surface as an error `retryTransient` refuses, or a timed-out
 * emission is re-POSTed 200–800 ms later over the run still talking to SEFAZ.
 */
describe('withNFeRetry never re-sends after a timeout (#1094)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function realClient(fetch: typeof globalThis.fetch): NFeHttpClient {
    return withNFeRetry(
      createNFeHttpClient({
        baseUrl: 'http://nfe.test',
        getAuthToken: () => Promise.resolve('token'),
        fetch,
      }),
    );
  }

  /** A route that accepts and never answers; rejects with the signal's reason. */
  function fetchQueNuncaResponde() {
    return vi.fn(
      (...[, init]: Parameters<typeof globalThis.fetch>) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
  }

  it('a timed-out emitir fetches ONCE', async () => {
    vi.useFakeTimers();
    const fetch = fetchQueNuncaResponde();
    const out = realClient(fetch)
      .emitir('PED-1')
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(NFE_PRAZO_MS.longo);
    expect(await out).toBeInstanceOf(NFeTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000); // any backoff would have fired by now
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a timed-out danfe (a read) fetches ONCE too — its budget is already spent', async () => {
    vi.useFakeTimers();
    const fetch = fetchQueNuncaResponde();
    const out = realClient(fetch)
      .danfe('PED-1', 'nfe-1', 'simplificado')
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(NFE_PRAZO_MS.curto);
    expect(await out).toBeInstanceOf(NFeTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a gateway 504 on emitir fetches ONCE — it used to be a retried NFeServerError', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response('<html>upstream request timeout</html>', { status: 504 })),
    );
    await expect(realClient(fetch).emitir('PED-1')).rejects.toBeInstanceOf(NFeTimeoutError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('near-miss: a plain 500 on emitir IS still retried (decision (b), documented)', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(realClient(fetch).emitir('PED-1')).rejects.toBeInstanceOf(NFeServerError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
