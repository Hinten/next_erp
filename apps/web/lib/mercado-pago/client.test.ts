import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MercadoPagoClientHttpError,
  MercadoPagoClientNetworkError,
  MercadoPagoClientRespostaInvalidaError,
  createMercadoPagoClient,
} from './client';

/**
 * This client had NO tests at all, which is part of why it kept two defects the
 * Mercado Livre sibling had already fixed:
 *
 *  1. `return parsed as T` — a 2xx of any shape was reported as a success.
 *  2. `parsed = { error: text }` on a non-JSON body, so a proxy's whole HTML
 *     document became `err.message` verbatim (fixed for ML in 3a4b7278).
 *
 * ⚠️ Defect 1 is worse here than it looks. `conta` is the ONLY method that
 * reads anything, and `connected` is the field the panel switches on — so a
 * body of the wrong shape gave `undefined`, which is falsy, and the screen told
 * the operator to reconnect an account that was perfectly connected.
 */

function client(fetchImpl: typeof globalThis.fetch) {
  return createMercadoPagoClient({
    baseUrl: 'http://localhost:3007',
    getAuthToken: async () => 'token',
    fetch: fetchImpl,
  });
}

function ok(body: string, contentType = 'application/json'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

const NEXT_404 = '<!DOCTYPE html><html><head><title>404</title></head><body>404</body></html>';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a 2xx whose body is not what we claimed', () => {
  it('⭐ throws instead of reporting a disconnected account for a wrong-shaped body', () => {
    // The whole reason this matters: `{}` cast to `MercadoPagoConta` reads
    // `connected === undefined`, and the panel renders "não conectada" for a
    // live account. The operator then reconnects it, spending an OAuth round
    // trip to fix nothing.
    const c = client(async () => ok('{}'));

    return expect(c.conta('m1')).rejects.toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
  });

  it('names the failing fields', async () => {
    const c = client(async () => ok('{}'));

    const err = (await c
      .conta('m1')
      .catch((e: unknown) => e)) as MercadoPagoClientRespostaInvalidaError;

    expect(err.campos).toEqual(['connected', 'me']);
  });

  it('⭐ throws on an EMPTY body instead of handing back null', async () => {
    const c = client(async () => ok(''));

    await expect(c.conta('m1')).rejects.toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
  });

  it('⭐ throws AND logs when a 2xx carries HTML', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok(NEXT_404, 'text/html'));

    await expect(c.conta('m1')).rejects.toBeInstanceOf(MercadoPagoClientRespostaInvalidaError);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('is caught by callers narrowing to MercadoPagoClientHttpError', async () => {
    // ⚠️ Why it is a subclass. `ContaMercadoPagoPanel` narrows to this class and
    // rethrows anything else, into a `void`-ed click handler.
    const c = client(async () => ok('{}'));

    const err = await c.conta('m1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoPagoClientHttpError);
    expect((err as MercadoPagoClientHttpError).code).toBe('RESPOSTA_INVALIDA');
  });

  it('still passes a well-formed body through', async () => {
    // The control. Without it every assertion above is satisfied by a client
    // that simply never works.
    const c = client(async () => ok(JSON.stringify({ connected: true, me: null })));

    await expect(c.conta('m1')).resolves.toEqual({ connected: true, me: null });
  });

  it('accepts a QUOTED collector id — a forwarded MP number', async () => {
    // Same rule as the ML schemas: tolerant where the value originates at the
    // provider, because a quoted id must never cost the whole response (#1087).
    const c = client(async () =>
      ok(JSON.stringify({ connected: true, me: { id: '123456789', nickname: null, email: null } })),
    );

    expect((await c.conta('m1')).me?.id).toBe(123_456_789);
  });
});

describe('non-2xx bodies', () => {
  it('⭐ no longer puts a whole HTML page into err.message', async () => {
    // The defect ML fixed in 3a4b7278 and this client kept: `{ error: text }`
    // made the raw document the message, burying the real cause under markup.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => new Response(NEXT_404, { status: 502 }));

    const err = (await c.conta('m1').catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.message).not.toContain('<!DOCTYPE');
    expect(err.message).toContain('HTTP 502');
    // The body stays reachable for whoever is debugging.
    expect(String(spy.mock.calls[0]?.[1])).toContain('404');
  });

  it('a JSON body that is an ARRAY still produces the status message', async () => {
    // ⚠️ Deliberately NOT labelled "the array guard works": at this level it
    // cannot see that guard. Mutating `envelopeDeErro` to accept arrays leaves
    // this test green, because the per-field `typeof` checks already reduce an
    // array to an empty envelope and the caller falls back either way. The
    // guard's real effect — `null` rather than `{}` — is only observable in
    // `packages/core/src/wire/envelopeDeErro.test.ts`, which is where it is
    // asserted. What this pins is the behaviour the operator sees.
    const c = client(
      async () =>
        new Response('[1,2,3]', { status: 500, headers: { 'content-type': 'application/json' } }),
    );

    const err = (await c.conta('m1').catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.message).toContain('HTTP 500');
  });

  it('still prefers OUR envelope when the backend sent one', async () => {
    const c = client(
      async () =>
        new Response(
          JSON.stringify({ error: 'Conta não conectada.', code: 'MP_REAUTH_REQUIRED' }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const err = (await c.conta('m1').catch((e: unknown) => e)) as MercadoPagoClientHttpError;

    expect(err.message).toBe('Conta não conectada.');
    expect(err.code).toBe('MP_REAUTH_REQUIRED');
  });

  it('a genuine network failure is still a network error', async () => {
    const c = client(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(c.conta('m1')).rejects.toBeInstanceOf(MercadoPagoClientNetworkError);
  });
});
