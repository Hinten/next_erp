/**
 * The two Melhor Envio describers `ConnectionPanel` delegates to (#563).
 *
 * `describeMelhorEnvioConnectFailure`'s `null` arm is what makes the shared
 * panel rethrow (root `CLAUDE.md` rule 6); the conta describer is TOTAL and
 * transcribes the ternary the local `ContaError` component used to hold, so the
 * cases below are that component's three branches.
 */
import { describe, expect, it } from 'vitest';

import {
  FreightHttpError,
  FreightNetworkError,
  FreightNotFoundError,
} from '@delfrance/integrations-freight-br/http-client';

import {
  MELHOR_ENVIO_OAUTH_TOAST,
  describeMelhorEnvioConnectFailure,
  describeMelhorEnvioContaFailure,
} from './melhorEnvioOAuthErrors';

describe('describeMelhorEnvioConnectFailure', () => {
  it('shows the backend message for an HTTP failure', () => {
    const err = new FreightHttpError('Conta de frete não encontrada.', 404, null);
    expect(describeMelhorEnvioConnectFailure(err)).toBe('Conta de frete não encontrada.');
  });

  it('describes an HTTP subclass through its base class', () => {
    // Every status-specific freight error extends `FreightHttpError`, so the
    // first arm covers them — no per-subclass branch to keep in step.
    const err = new FreightNotFoundError('int_frete inexistente.', null);
    expect(describeMelhorEnvioConnectFailure(err)).toBe('int_frete inexistente.');
  });

  it('gives a network failure its own copy', () => {
    expect(describeMelhorEnvioConnectFailure(new FreightNetworkError('x'))).toBe(
      'Falha de rede ao iniciar a conexão.',
    );
  });

  it('returns null for anything that is not a freight client error', () => {
    // Rule 6: not ours to describe — `ConnectionPanel` rethrows it.
    expect(describeMelhorEnvioConnectFailure(new TypeError('boom'))).toBeNull();
    expect(describeMelhorEnvioConnectFailure('nope')).toBeNull();
    expect(describeMelhorEnvioConnectFailure(null)).toBeNull();
  });
});

describe('describeMelhorEnvioContaFailure', () => {
  it('shows the backend message, with no retry offered', () => {
    const err = new FreightHttpError('Conta não configurada.', 400, null);
    expect(describeMelhorEnvioContaFailure(err)).toEqual({
      message: 'Conta não configurada.',
      retryable: false,
    });
  });

  it('names the network case', () => {
    expect(describeMelhorEnvioContaFailure(new FreightNetworkError('x'))).toEqual({
      message: 'Falha de rede ao consultar a conta.',
      retryable: false,
    });
  });

  it('is TOTAL — an unknown throwable still produces copy', () => {
    // A query error state has nowhere to rethrow to, so unlike the connect
    // describer this one may never answer `null`.
    expect(describeMelhorEnvioContaFailure(new TypeError('boom'))).toEqual({
      message: 'Não foi possível consultar a conta.',
      retryable: false,
    });
    expect(describeMelhorEnvioContaFailure('nope').message).toBe(
      'Não foi possível consultar a conta.',
    );
  });

  it('never marks a failure retryable (this channel has no such predicate)', () => {
    // `RetryAlert` renders no button without an `onRetry`, which is exactly the
    // plain yellow Alert this screen showed before the extraction.
    const casos: unknown[] = [
      new FreightHttpError('x', 503, null),
      new FreightNetworkError('x'),
      new TypeError('x'),
    ];
    for (const err of casos) {
      expect(describeMelhorEnvioContaFailure(err).retryable).toBe(false);
    }
  });
});

describe('MELHOR_ENVIO_OAUTH_TOAST', () => {
  it('keeps the callback contract the backend redirects against', () => {
    // The rename from a private `CONFIG` to this exported constant (#563) must
    // not touch the query-string key — `?me=connected|error` is what the
    // callback appends, and a changed key silences every toast on both this
    // screen and the Melhor Envio list.
    expect(MELHOR_ENVIO_OAUTH_TOAST.chave).toBe('me');
    expect(MELHOR_ENVIO_OAUTH_TOAST.sucesso).toBe('Conta Melhor Envio conectada.');
    expect(MELHOR_ENVIO_OAUTH_TOAST.mensagens.bad_state).toContain('assinatura do state');
  });
});
