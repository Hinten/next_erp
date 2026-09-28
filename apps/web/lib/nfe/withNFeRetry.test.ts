/**
 * `withNFeRetry` per-endpoint retry policy (#90). The key invariant: idempotent
 * / server-deduped endpoints retry the full transient set, but an endpoint that
 * is NOT safe to re-POST retries ONLY the pre-send 503, never a post-send
 * network/5xx: `cartaCorrecao` (each send increments nSeqEvento), `inutilizar`
 * (563), and — since #1654 §3 — `emitir` and `emitirLote`, whose re-POST
 * regenerates and RE-SENDS every rejeitada/error member.
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
    const emitir = vi.fn(
      failThenSucceed(1, new NFeRuntimeNotReadyError('cert', null), { nfeId: 'n1' } as never),
    );
    const client = withNFeRetry(fakeClient({ emitir }));
    await expect(client.emitir('PED-1')).resolves.toMatchObject({ nfeId: 'n1' });
    expect(emitir).toHaveBeenCalledTimes(2);
  });

  it('emitirLote DOES retry the pre-send NFeRuntimeNotReadyError', async () => {
    const emitirLote = vi.fn(
      failThenSucceed(1, new NFeRuntimeNotReadyError('cert', null), { results: [] } as never),
    );
    const client = withNFeRetry(fakeClient({ emitirLote }));
    await expect(client.emitirLote(['PED-1'])).resolves.toMatchObject({ results: [] });
    expect(emitirLote).toHaveBeenCalledTimes(2);
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
    const cartaCorrecao = vi.fn(
      failThenSucceed(1, new NFeRuntimeNotReadyError('cert', null), { nSeqEvento: 1 } as never),
    );
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
    const inutilizar = vi.fn(
      failThenSucceed(1, new NFeRuntimeNotReadyError('cert', null), { aprovada: true } as never),
    );
    const client = withNFeRetry(fakeClient({ inutilizar }));
    await expect(client.inutilizar(inutArgs)).resolves.toMatchObject({ aprovada: true });
    expect(inutilizar).toHaveBeenCalledTimes(2);
  });
});
