/**
 * `withNFeRetry` per-endpoint retry policy (#90). The key invariant: idempotent
 * / server-deduped endpoints retry the full transient set, but an endpoint that
 * is NOT safe to re-POST retries ONLY the pre-send 503, never a post-send
 * network/5xx: `cartaCorrecao` (each send increments nSeqEvento), `inutilizar`
 * (563), and — since #1654 §3 — `emitir` and `emitirLote`, whose re-POST
 * regenerates and RE-SENDS every rejeitada/error member. "Pre-send" is read
 * from the 503's BODY (apps/nfe's marker), never from its class: the client
 * maps every 503 to `NFeRuntimeNotReadyError`, the platform's own included.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createNFeHttpClient,
  NFeNetworkError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
  NFeXsdValidationFailedError,
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

/**
 * The pre-send 503 exactly as the client builds it from apps/nfe's answer to a
 * `getNFeRuntime()` failure: `{ error: 'NF-e runtime not ready', code: … }`.
 */
const naoProntoDoNFe = () =>
  new NFeRuntimeNotReadyError('NF-e runtime not ready', {
    error: 'NF-e runtime not ready',
    code: 'NFE_AMBIENTE inválido',
  });

/** A real client over `fetch`, wrapped by the policy under test. */
function clienteReal(fetch: typeof globalThis.fetch): NFeHttpClient {
  return withNFeRetry(
    createNFeHttpClient({
      baseUrl: 'http://nfe.test',
      getAuthToken: () => Promise.resolve('token'),
      fetch,
    }),
  );
}

/** The four calls that are not safe to re-send, each with valid arguments. */
const NAO_REENVIAVEIS: ReadonlyArray<
  readonly [keyof NFeHttpClient, (c: NFeHttpClient) => Promise<unknown>]
> = [
  ['emitir', (c) => c.emitir('PED-1')],
  ['emitirLote', (c) => c.emitirLote(['PED-1', 'PED-2'])],
  [
    'inutilizar',
    (c) => c.inutilizar({ filialId: 'F-1', serie: 1, nNFIni: 1, nNFFin: 1, xJust: 'x'.repeat(20) }),
  ],
  ['cartaCorrecao', (c) => c.cartaCorrecao('PED-1', 'n1', 'x'.repeat(20))],
];

/**
 * 503s apps/nfe did NOT answer. Cloud Run answers its own 503 when the
 * instance serving the request fails mid-request (memory exhausted, instance
 * terminated) — after the SEFAZ send — and the client maps EVERY 503 to
 * `NFeRuntimeNotReadyError`, whatever its body.
 */
const SEM_A_MARCA_DO_NFE: ReadonlyArray<readonly [string, () => Response]> = [
  [
    'an HTML body (the platform’s own page)',
    () =>
      new Response('<html><body><h1>Service Unavailable</h1></body></html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html' },
      }),
  ],
  ['an empty body', () => new Response(null, { status: 503 })],
  [
    'a JSON body with another error',
    () =>
      new Response(JSON.stringify({ error: 'Service Unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
  ],
];

describe('withNFeRetry', () => {
  // #1654 §3 — REWRITTEN on purpose: this used to pin that emitir retried a
  // 5xx. A re-POST is not deduped for a rejeitada/error member (the server
  // regenerates and re-sends it), and a bug now answers 500 by design.
  it.each([
    ['NFeServerError', () => new NFeServerError('boom', 500, null)],
    ['NFeNetworkError', () => new NFeNetworkError('reset')],
  ] as const)(
    'emitir does NOT retry a post-send %s — a re-POST would re-send rejeitada/error members',
    async (_rotulo, erro) => {
      const falha = erro();
      const emitir = vi.fn(() => Promise.reject(falha));
      const client = withNFeRetry(fakeClient({ emitir }));
      await expect(client.emitir('PED-1')).rejects.toBe(falha);
      expect(emitir).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['NFeServerError', () => new NFeServerError('boom', 500, null)],
    ['NFeNetworkError', () => new NFeNetworkError('reset')],
  ] as const)(
    'emitirLote does NOT retry a post-send %s — a re-POST would re-send rejeitada/error members',
    async (_rotulo, erro) => {
      const falha = erro();
      const emitirLote = vi.fn(() => Promise.reject(falha));
      const client = withNFeRetry(fakeClient({ emitirLote }));
      await expect(client.emitirLote(['PED-1', 'PED-2'])).rejects.toBe(falha);
      expect(emitirLote).toHaveBeenCalledTimes(1);
    },
  );

  it('emitir DOES retry the pre-send NFeRuntimeNotReadyError', async () => {
    const emitir = vi.fn(failThenSucceed(1, naoProntoDoNFe(), { nfeId: 'n1' } as never));
    const client = withNFeRetry(fakeClient({ emitir }));
    await expect(client.emitir('PED-1')).resolves.toMatchObject({ nfeId: 'n1' });
    expect(emitir).toHaveBeenCalledTimes(2);
  });

  it('emitirLote DOES retry the pre-send NFeRuntimeNotReadyError', async () => {
    const emitirLote = vi.fn(failThenSucceed(1, naoProntoDoNFe(), { results: [] } as never));
    const client = withNFeRetry(fakeClient({ emitirLote }));
    await expect(client.emitirLote(['PED-1'])).resolves.toMatchObject({ results: [] });
    expect(emitirLote).toHaveBeenCalledTimes(2);
  });

  it.each(
    NAO_REENVIAVEIS.flatMap(([metodo, chamar]) =>
      SEM_A_MARCA_DO_NFE.map(([corpo, resposta]) => [metodo, corpo, chamar, resposta] as const),
    ),
  )(
    '%s makes ONE attempt on a 503 without apps/nfe’s marker — %s — it may come after the send',
    async (_metodo, _corpo, chamar, resposta) => {
      const fetch = vi.fn(() => Promise.resolve(resposta()));
      await expect(chamar(clienteReal(fetch))).rejects.toBeInstanceOf(NFeRuntimeNotReadyError);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('emitirLote DOES retry the route’s own pre-send 503, end to end through the real client', async () => {
    // Exactly what `emitir-lote/route.ts` answers when getNFeRuntime() fails.
    const respostas = [
      () =>
        new Response(
          JSON.stringify({ error: 'NF-e runtime not ready', code: 'NFE_AMBIENTE inválido' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ];
    const fetch = vi.fn(() => Promise.resolve(respostas[fetch.mock.calls.length - 1]!()));
    await expect(clienteReal(fetch).emitirLote(['PED-1', 'PED-2'])).resolves.toEqual({
      results: [],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('emitirLote makes ONE attempt on the route’s 500 for a bug — no re-POST of the batch (#1654 §3)', async () => {
    // End to end through the REAL client error mapper: the 500 the route now
    // answers for an unclassified failure arrives as an NFeServerError, and the
    // policy must not re-run the batch (and its re-sends) on it.
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Cannot read properties of undefined (reading 'itens')",
            code: 'TypeError',
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
    await expect(client.emitirLote(['PED-1', 'PED-2'])).rejects.toBeInstanceOf(NFeServerError);
    expect(fetch).toHaveBeenCalledTimes(1);
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
    const cartaCorrecao = vi.fn(failThenSucceed(1, naoProntoDoNFe(), { nSeqEvento: 1 } as never));
    const client = withNFeRetry(fakeClient({ cartaCorrecao }));
    await expect(client.cartaCorrecao('PED-1', 'n1', 'x'.repeat(20))).resolves.toMatchObject({
      nSeqEvento: 1,
    });
    expect(cartaCorrecao).toHaveBeenCalledTimes(2);
  });

  const inutArgs = { filialId: 'F-1', serie: 1, nNFIni: 1, nNFFin: 1, xJust: 'x'.repeat(20) };

  it('inutilizar does NOT retry a post-send NFeServerError (563 is not idempotent)', async () => {
    const inutilizar = vi.fn(() => Promise.reject(new NFeServerError('boom', 500, null)));
    const client = withNFeRetry(fakeClient({ inutilizar }));
    await expect(client.inutilizar(inutArgs)).rejects.toBeInstanceOf(NFeServerError);
    expect(inutilizar).toHaveBeenCalledTimes(1);
  });

  it('inutilizar DOES retry the pre-send NFeRuntimeNotReadyError', async () => {
    const inutilizar = vi.fn(failThenSucceed(1, naoProntoDoNFe(), { aprovada: true } as never));
    const client = withNFeRetry(fakeClient({ inutilizar }));
    await expect(client.inutilizar(inutArgs)).resolves.toMatchObject({ aprovada: true });
    expect(inutilizar).toHaveBeenCalledTimes(2);
  });
});
