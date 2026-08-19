import { describe, expect, it } from 'vitest';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';
import {
  describeMercadoLivreFailure,
  isRetryableMercadoLivreError,
  mercadoLivreErrorMessage,
  mercadoLivreQueryRetry,
} from './errors';

const FALLBACKS = {
  network: 'Falha de rede ao consultar.',
  unknown: 'Não foi possível consultar.',
};

describe('describeMercadoLivreFailure', () => {
  it('tells the operator to reconnect when the code says so', () => {
    const err = new MercadoLivreClientHttpError('unauthorized', 409, 'ML_REAUTH_REQUIRED');
    expect(describeMercadoLivreFailure(err, FALLBACKS)).toEqual({
      message: 'Conta Mercado Livre não conectada — reconecte em Canais de venda.',
      retryable: false,
    });
  });

  // The regression this module exists for. `reportableMessage` keyed the
  // reconnect copy on `status === 409`, but `sugerir-medidas` answers 409 for
  // three AI states that say nothing about the account connection — so a busy
  // agent told the operator to go reconnect a perfectly healthy account.
  it('does NOT claim a disconnected account for a 409 that is not a reauth', () => {
    const codes = ['AI_JA_EM_ANDAMENTO', 'AI_DESATIVADA', 'AI_PROVEDOR_NAO_SUPORTADO', null];
    for (const code of codes) {
      const err = new MercadoLivreClientHttpError(
        'Já existe uma sugestão em andamento.',
        409,
        code,
      );
      expect(describeMercadoLivreFailure(err, FALLBACKS).message).toBe(
        'Já existe uma sugestão em andamento.',
      );
    }
  });

  it('keeps the backend message for a transient upstream failure, and offers a retry', () => {
    const err = new MercadoLivreClientHttpError(
      'A integração falhou (HTTP 503).',
      503,
      'ML_NETWORK_ERROR',
    );
    expect(describeMercadoLivreFailure(err, FALLBACKS)).toEqual({
      message: 'A integração falhou (HTTP 503).',
      retryable: true,
    });
  });

  it('uses the network fallback when the backend was never reached', () => {
    const err = new MercadoLivreClientNetworkError(
      'failed to fetch',
      new TypeError('fetch failed'),
    );
    expect(describeMercadoLivreFailure(err, FALLBACKS)).toEqual({
      message: 'Falha de rede ao consultar.',
      retryable: true,
    });
  });

  it('falls back to a generic network message when the caller gives none', () => {
    const err = new MercadoLivreClientNetworkError('failed to fetch');
    expect(describeMercadoLivreFailure(err, { unknown: 'x' }).message).toBe(
      'Não foi possível contatar o Mercado Livre.',
    );
  });

  it('uses the unknown fallback for an error that is not ours', () => {
    expect(describeMercadoLivreFailure(new Error('boom'), FALLBACKS)).toEqual({
      message: 'Não foi possível consultar.',
      retryable: false,
    });
  });
});

describe('isRetryableMercadoLivreError', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries a transient HTTP %i', (status) => {
    expect(isRetryableMercadoLivreError(new MercadoLivreClientHttpError('x', status, null))).toBe(
      true,
    );
  });

  it.each([400, 401, 403, 404, 409, 422, 501])('never retries HTTP %i', (status) => {
    expect(isRetryableMercadoLivreError(new MercadoLivreClientHttpError('x', status, null))).toBe(
      false,
    );
  });

  it.each([
    'ML_PUBLISH_BLOCKED',
    'ML_IMPORT_BLOCKED',
    'ML_MASS_IMPORT_RUNNING',
    'ML_PRICE_SYNC_RUNNING',
    'SEM_TABELA_NORMAL',
    'ML_SELECAO_EXCEDE_LIMITE',
    'ML_CONTA_SEM_DEPOSITO',
    'ML_CONTA_PAUSADA',
    'ML_CONTA_MULTIORIGEM',
  ])('never retries %s, whatever status carries it', (code) => {
    // 503 on purpose: the code has to win over the status, or a failure the
    // operator must fix elsewhere gets hammered.
    expect(isRetryableMercadoLivreError(new MercadoLivreClientHttpError('x', 503, code))).toBe(
      false,
    );
  });

  it('retries a genuine network failure', () => {
    const err = new MercadoLivreClientNetworkError('x', new TypeError('fetch failed'));
    expect(isRetryableMercadoLivreError(err)).toBe(true);
  });

  // `enviarEstoque`/`enviarPrecos` accept an AbortSignal, and `client.ts` wraps
  // the raw fetch rejection — so a cancel arrives as a network error. Retrying
  // it would restart exactly the work the operator just stopped.
  it('never retries a request the operator cancelled', () => {
    const err = new MercadoLivreClientNetworkError('aborted', new DOMException('', 'AbortError'));
    expect(isRetryableMercadoLivreError(err)).toBe(false);
  });

  it('denies by default for an unrecognised error', () => {
    expect(isRetryableMercadoLivreError(new Error('boom'))).toBe(false);
    expect(isRetryableMercadoLivreError('boom')).toBe(false);
  });
});

describe('mercadoLivreQueryRetry', () => {
  const transient = new MercadoLivreClientNetworkError('x', new TypeError('fetch failed'));

  it('allows two extra attempts for a transient failure, then stops', () => {
    expect(mercadoLivreQueryRetry(0, transient)).toBe(true);
    expect(mercadoLivreQueryRetry(1, transient)).toBe(true);
    expect(mercadoLivreQueryRetry(2, transient)).toBe(false);
  });

  it('does not even try once when the failure is permanent', () => {
    expect(mercadoLivreQueryRetry(0, new MercadoLivreClientHttpError('x', 404, null))).toBe(false);
  });
});

describe('mercadoLivreErrorMessage', () => {
  it('is the message half of describeMercadoLivreFailure', () => {
    const err = new MercadoLivreClientHttpError('Categoria inválida.', 400, null);
    expect(mercadoLivreErrorMessage(err, FALLBACKS)).toBe('Categoria inválida.');
  });
});
