/**
 * `withNFeRetry` per-endpoint retry policy (#90). The key invariant: idempotent
 * / server-deduped endpoints retry the full transient set, but `cartaCorrecao`
 * (NOT idempotent — each send increments nSeqEvento) retries ONLY the pre-send
 * 503, never a post-send network/5xx.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  NFeNetworkError,
  NFeRejectedError,
  NFeRuntimeNotReadyError,
  NFeServerError,
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
});
