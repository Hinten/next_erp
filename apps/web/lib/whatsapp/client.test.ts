import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WhatsappClientHttpError,
  WhatsappClientNetworkError,
  WhatsappClientRespostaInvalidaError,
  createWhatsappClient,
} from './client';

/**
 * This client had NO tests, and six of its nine methods were the quietest call
 * sites in the repo: they `await call(...)` and throw the body away, so the
 * only signal of success is the absence of a throw. With `return parsed as T`
 * that meant an empty body, an HTML body and a real answer were literally
 * indistinguishable — `setToken` could report success having stored nothing.
 */

function client(fetchImpl: typeof globalThis.fetch) {
  return createWhatsappClient({
    baseUrl: 'http://localhost:3008',
    getAuthToken: async () => 'token',
    fetch: fetchImpl,
  });
}

function ok(body: string, contentType = 'application/json'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

const CONTA = { connected: true, hasToken: true, phone: null };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the six methods that discard their body', () => {
  it('⭐ setToken throws when the backend answers an EMPTY 200', async () => {
    // Nothing downstream reads the value, so before this the call resolved and
    // the panel said the token was stored. Validating costs nothing precisely
    // BECAUSE nothing reads it — there is no consumer to break.
    const c = client(async () => ok(''));

    await expect(c.setToken('i1', 'tok')).rejects.toBeInstanceOf(
      WhatsappClientRespostaInvalidaError,
    );
  });

  it('⭐ registerNumber throws when a 200 carries HTML', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok('<!DOCTYPE html><html></html>', 'text/html'));

    await expect(c.registerNumber('i1', '123456')).rejects.toBeInstanceOf(
      WhatsappClientRespostaInvalidaError,
    );
  });

  it('still resolves on a real answer', async () => {
    // The control, and it covers all six: they share one helper and one schema.
    const c = client(async () => ok(JSON.stringify({ ok: true })));

    await expect(c.setToken('i1', 'tok')).resolves.toBeUndefined();
    await expect(c.revokeToken('i1')).resolves.toBeUndefined();
    await expect(c.requestCode('i1', 'SMS')).resolves.toBeUndefined();
    await expect(c.verifyCode('i1', '123456')).resolves.toBeUndefined();
    await expect(c.registerNumber('i1', '123456')).resolves.toBeUndefined();
    await expect(c.deregisterNumber('i1')).resolves.toBeUndefined();
  });
});

describe('conta', () => {
  it('⭐ throws on a wrong-shaped body instead of reading connected as undefined', async () => {
    const c = client(async () => ok('{}'));

    const err = (await c
      .conta('i1')
      .catch((e: unknown) => e)) as WhatsappClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(WhatsappClientRespostaInvalidaError);
    expect(err.campos).toEqual(['connected', 'hasToken', 'phone']);
  });

  it('keeps `reason` optional — it is present only for the número gap', async () => {
    // The field is documented as appearing only when a stored credential is not
    // live. A required schema would reject every healthy account.
    const c = client(async () => ok(JSON.stringify(CONTA)));

    await expect(c.conta('i1')).resolves.toEqual(CONTA);
  });

  it('accepts the reason when it IS there', async () => {
    // The control for the case above.
    const corpo = { ...CONTA, connected: false, reason: 'numero_nao_configurado' };
    const c = client(async () => ok(JSON.stringify(corpo)));

    expect((await c.conta('i1')).reason).toBe('numero_nao_configurado');
  });

  it('rejects a reason value nobody has defined', async () => {
    // Anti-vacuity: `.optional()` must not degrade into "anything goes".
    const c = client(async () => ok(JSON.stringify({ ...CONTA, reason: 'motivo-inventado' })));

    await expect(c.conta('i1')).rejects.toBeInstanceOf(WhatsappClientRespostaInvalidaError);
  });
});

describe('health', () => {
  it('tolerates a missing checks array by defaulting it to empty', async () => {
    // The card renders a list; an absent array is a display gap, not a reason to
    // fail the whole health read.
    const c = client(async () =>
      ok(JSON.stringify({ generatedAt: 1, canSend: true, canReceive: null })),
    );

    expect((await c.health('i1')).checks).toEqual([]);
  });

  it('rejects an unknown check status', async () => {
    const c = client(async () =>
      ok(
        JSON.stringify({
          generatedAt: 1,
          canSend: true,
          canReceive: null,
          checks: [{ id: 'x', status: 'talvez', label: 'l', detail: null, hint: null }],
        }),
      ),
    );

    await expect(c.health('i1')).rejects.toBeInstanceOf(WhatsappClientRespostaInvalidaError);
  });
});

describe('error mapping', () => {
  it('is caught by callers narrowing to WhatsappClientHttpError', async () => {
    // ⚠️ Why it is a subclass: `ContaWhatsappPanel` narrows to this class and
    // rethrows anything else out of a mutation handler.
    const c = client(async () => ok('{}'));

    const err = await c.conta('i1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WhatsappClientHttpError);
    expect((err as WhatsappClientHttpError).code).toBe('RESPOSTA_INVALIDA');
  });

  it('⭐ no longer puts a whole HTML page into err.message', async () => {
    // The defect ML fixed in 3a4b7278 and this client kept.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => new Response('<!DOCTYPE html><html>502</html>', { status: 502 }));

    const err = (await c.conta('i1').catch((e: unknown) => e)) as WhatsappClientHttpError;

    expect(err.message).not.toContain('<!DOCTYPE');
    expect(err.message).toContain('HTTP 502');
  });

  it('a genuine network failure is still a network error', async () => {
    const c = client(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(c.conta('i1')).rejects.toBeInstanceOf(WhatsappClientNetworkError);
  });
});
