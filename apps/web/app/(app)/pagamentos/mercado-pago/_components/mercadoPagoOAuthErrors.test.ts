/**
 * The two Mercado Pago describers `ConnectionPanel` delegates to (#563).
 *
 * `describeMercadoPagoConnectFailure`'s `null` arm is what makes the shared
 * panel rethrow (root `CLAUDE.md` rule 6); the conta describer is TOTAL and
 * transcribes the ternary the local `ContaError` component used to hold, so the
 * cases below are that component's three branches.
 */
import { describe, expect, it } from 'vitest';

import {
  MercadoPagoClientHttpError,
  MercadoPagoClientNetworkError,
  MercadoPagoClientRespostaInvalidaError,
} from '@/lib/mercado-pago/client';
import {
  MERCADO_PAGO_OAUTH_TOAST,
  describeMercadoPagoConnectFailure,
  describeMercadoPagoContaFailure,
} from './mercadoPagoOAuthErrors';

describe('describeMercadoPagoConnectFailure', () => {
  it('shows the backend message for an HTTP failure', () => {
    const err = new MercadoPagoClientHttpError('Método de pagamento não encontrado.', 404, null);
    expect(describeMercadoPagoConnectFailure(err)).toBe('Método de pagamento não encontrado.');
  });

  it('describes a 2xx-with-a-bad-body subclass through its HTTP base', () => {
    const err = new MercadoPagoClientRespostaInvalidaError('Resposta inválida.', 200, [
      'authorizeUrl',
    ]);
    expect(describeMercadoPagoConnectFailure(err)).toBe('Resposta inválida.');
  });

  it('gives a network failure its own copy', () => {
    expect(describeMercadoPagoConnectFailure(new MercadoPagoClientNetworkError('x'))).toBe(
      'Falha de rede ao iniciar a conexão.',
    );
  });

  it('returns null for anything that is not a Mercado Pago client error', () => {
    // Rule 6: not ours to describe — `ConnectionPanel` rethrows it.
    expect(describeMercadoPagoConnectFailure(new TypeError('boom'))).toBeNull();
    expect(describeMercadoPagoConnectFailure('nope')).toBeNull();
    expect(describeMercadoPagoConnectFailure(null)).toBeNull();
  });
});

describe('describeMercadoPagoContaFailure', () => {
  it('shows the backend message, with no retry offered', () => {
    const err = new MercadoPagoClientHttpError('Conta não configurada.', 400, null);
    expect(describeMercadoPagoContaFailure(err)).toEqual({
      message: 'Conta não configurada.',
      retryable: false,
    });
  });

  it('names the network case', () => {
    expect(describeMercadoPagoContaFailure(new MercadoPagoClientNetworkError('x'))).toEqual({
      message: 'Falha de rede ao consultar a conta.',
      retryable: false,
    });
  });

  it('is TOTAL — an unknown throwable still produces copy', () => {
    // A query error state has nowhere to rethrow to, so unlike the connect
    // describer this one may never answer `null`.
    expect(describeMercadoPagoContaFailure(new TypeError('boom'))).toEqual({
      message: 'Não foi possível consultar a conta.',
      retryable: false,
    });
    expect(describeMercadoPagoContaFailure('nope').message).toBe(
      'Não foi possível consultar a conta.',
    );
  });

  it('never marks a failure retryable (this channel has no such predicate)', () => {
    // `RetryAlert` renders no button without an `onRetry`, which is exactly the
    // plain yellow Alert this screen showed before the extraction.
    const casos: unknown[] = [
      new MercadoPagoClientHttpError('x', 503, null),
      new MercadoPagoClientNetworkError('x'),
      new TypeError('x'),
    ];
    for (const err of casos) {
      expect(describeMercadoPagoContaFailure(err).retryable).toBe(false);
    }
  });
});

describe('MERCADO_PAGO_OAUTH_TOAST', () => {
  it('keeps the callback contract the backend redirects against', () => {
    // The rename from a private `CONFIG` to this exported constant (#563) must
    // not touch the query-string key — `?mp=connected|error` is what the
    // callback appends, and a changed key silences every toast on both this
    // screen and the payment-method list.
    expect(MERCADO_PAGO_OAUTH_TOAST.chave).toBe('mp');
    expect(MERCADO_PAGO_OAUTH_TOAST.sucesso).toBe('Conta Mercado Pago conectada.');
    expect(MERCADO_PAGO_OAUTH_TOAST.mensagens.bad_state).toContain('assinatura do state');
  });
});
