/**
 * `describeMercadoLivreConnectFailure` — the narrowing `ConnectionPanel`
 * delegates to for the Conectar button (#563).
 *
 * The arm that matters is the `null`: it is what makes the shared panel rethrow
 * (root `CLAUDE.md` rule 6), and it cannot be asserted from the component test,
 * where the same fact only shows up as an escaped rejection.
 */
import { describe, expect, it } from 'vitest';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  MercadoLivreClientRespostaInvalidaError,
} from '@/lib/mercado-livre/client';
import {
  MERCADO_LIVRE_OAUTH_TOAST,
  describeMercadoLivreConnectFailure,
} from './mercadoLivreOAuthErrors';

describe('describeMercadoLivreConnectFailure', () => {
  it('shows the backend message for an HTTP failure', () => {
    const err = new MercadoLivreClientHttpError('Integração não encontrada.', 404, null);
    expect(describeMercadoLivreConnectFailure(err)).toBe('Integração não encontrada.');
  });

  it('keeps ML_REAUTH_REQUIRED on the backend message, not on the reconnect copy', () => {
    // `describeMercadoLivreFailure` rewrites this code into "reconecte em
    // Canais de venda" — the very button being clicked. On the connect path a
    // disconnected account is the EXPECTED state, so the shared mapper is
    // deliberately not used here.
    const err = new MercadoLivreClientHttpError(
      'A conta precisa ser reconectada.',
      401,
      'ML_REAUTH_REQUIRED',
    );
    expect(describeMercadoLivreConnectFailure(err)).toBe('A conta precisa ser reconectada.');
  });

  it('describes a 2xx-with-a-bad-body subclass through its HTTP base', () => {
    const err = new MercadoLivreClientRespostaInvalidaError('Resposta inválida.', 200, [
      'authorizeUrl',
    ]);
    expect(describeMercadoLivreConnectFailure(err)).toBe('Resposta inválida.');
  });

  it('gives a network failure its own copy', () => {
    expect(describeMercadoLivreConnectFailure(new MercadoLivreClientNetworkError('x'))).toBe(
      'Falha de rede ao iniciar a conexão.',
    );
  });

  it('returns null for anything that is not a Mercado Livre client error', () => {
    // Rule 6: not ours to describe — `ConnectionPanel` rethrows it.
    expect(describeMercadoLivreConnectFailure(new TypeError('boom'))).toBeNull();
    expect(describeMercadoLivreConnectFailure('nope')).toBeNull();
    expect(describeMercadoLivreConnectFailure(null)).toBeNull();
  });
});

describe('MERCADO_LIVRE_OAUTH_TOAST', () => {
  it('keeps the callback contract the backend redirects against', () => {
    // The rename from a private `CONFIG` to this exported constant (#563) must
    // not touch the query-string key — `?ml=connected|error` is what
    // apps/mercado-livre's callback appends, and a changed key silences every
    // toast on both this screen and the channel list.
    expect(MERCADO_LIVRE_OAUTH_TOAST.chave).toBe('ml');
    expect(MERCADO_LIVRE_OAUTH_TOAST.sucesso).toBe('Conta Mercado Livre conectada.');
    expect(MERCADO_LIVRE_OAUTH_TOAST.mensagens.bad_state).toContain('assinatura do state');
  });
});
