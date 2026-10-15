import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFreightHttpClient } from '../../src/http-client/client';
import { FreightHttpError, FreightSchemaError } from '../../src/http-client/errors';
import { mockFetch } from '../_helpers/mockFetch';

/**
 * The fourth copy of `return parsed as T`, and the only one that is not in
 * `apps/web` — it ships into the browser through
 * `@delfrance/integrations-freight-br/http-client`.
 *
 * ⚠️ What made it worse than the Mercado Livre original: a non-JSON body became
 * `{ error: text }` BEFORE the status check, so an HTML page arriving with a
 * 2xx was handed to the caller as a truthy object. `conta().connected` then read
 * `undefined` — falsy — and the panel reported a disconnected account.
 */

function client(fetchImpl: typeof globalThis.fetch) {
  return createFreightHttpClient({
    baseUrl: 'http://localhost:3001/',
    getAuthToken: async () => 'id-token',
    fetch: fetchImpl,
  });
}

function ok(body: string, contentType = 'application/json'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a 2xx whose body is not what we claimed', () => {
  it('⭐ throws instead of reporting a disconnected account', async () => {
    const c = client(mockFetch(async () => ok('{}')));

    const err = (await c.conta('f1').catch((e: unknown) => e)) as FreightSchemaError;

    expect(err).toBeInstanceOf(FreightSchemaError);
    expect(err.campos).toEqual(['connected', 'me', 'balance']);
  });

  it('⭐ throws on an EMPTY body instead of handing back null', async () => {
    const c = client(mockFetch(async () => ok('')));

    await expect(c.conta('f1')).rejects.toBeInstanceOf(FreightSchemaError);
  });

  it('⭐ throws AND logs when a 2xx carries HTML', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(mockFetch(async () => ok('<!DOCTYPE html><html>login</html>', 'text/html')));

    await expect(c.conta('f1')).rejects.toBeInstanceOf(FreightSchemaError);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('is caught by callers narrowing to FreightHttpError', async () => {
    // ⚠️ Why it is a subclass. The checkout's print handlers narrow to the
    // Freight error family and rethrow anything else, out of `void`-ed clicks.
    const c = client(mockFetch(async () => ok('{}')));

    const err = await c.conta('f1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FreightHttpError);
  });

  it('still passes a well-formed body through', async () => {
    // The control.
    const c = client(
      mockFetch(async () => ok(JSON.stringify({ connected: false, me: null, balance: null }))),
    );

    await expect(c.conta('f1')).resolves.toEqual({
      connected: false,
      me: null,
      balance: null,
    });
  });

  it('defaults an absent agencies array rather than failing the read', async () => {
    // `EtiquetaComprarModal` already reads it as `agencias.data?.agencies ?? []`,
    // which is the evidence that the wire may omit it.
    const c = client(mockFetch(async () => ok('{}')));

    const r = await c.agencias('f1', { service: 1, state: 'SP', city: 'São Paulo' });

    expect(r.agencies).toEqual([]);
  });

  it('near-miss: an absent servicos array FAILS the read — it is not defaulted like agencies', async () => {
    // `agencias` defaults because a caller already reads it tolerantly; nothing
    // reads `servicos` that way, and an empty picker would claim the account has
    // no services at all.
    const c = client(mockFetch(async () => ok('{}')));

    const err = (await c.servicos('f1').catch((e: unknown) => e)) as FreightSchemaError;

    expect(err).toBeInstanceOf(FreightSchemaError);
    expect(err.campos).toEqual(['servicos']);
  });

  it('reads a quoted service or company id as a number and keeps unknown keys', async () => {
    // The ME response shapes are wire-tolerant (`wireNumber`), and a newer
    // backend's extra keys must not break an older tab.
    const corpo = {
      servicos: [
        { id: '3', name: 'Expresso', company: { id: '2', name: 'Transportadora B' }, type: 'x' },
      ],
      novoCampo: true,
    };
    const c = client(mockFetch(async () => ok(JSON.stringify(corpo))));

    const r = await c.servicos('f1');

    expect(r.servicos[0]).toMatchObject({ id: 3, company: { id: 2, name: 'Transportadora B' } });
    expect(r.servicos[0]).toHaveProperty('type', 'x');
  });

  it('near-miss: a service without an id fails the read rather than reaching the picker', async () => {
    // The id is what a mapping row stores; a service the operator can pick must
    // carry one.
    const c = client(
      mockFetch(async () => ok(JSON.stringify({ servicos: [{ name: 'Econômico' }] }))),
    );

    const err = (await c.servicos('f1').catch((e: unknown) => e)) as FreightSchemaError;

    expect(err).toBeInstanceOf(FreightSchemaError);
    expect(err.campos).toEqual(['servicos[].id']);
  });

  it('⚠️ names the fields but never the values', async () => {
    // A freight response carries account data; this message reaches the browser.
    const c = client(
      mockFetch(async () => ok(JSON.stringify({ printLabelId: 'segredo-do-cliente' }))),
    );

    const err = (await c.imprimir('f1', 'p1').catch((e: unknown) => e)) as FreightSchemaError;

    expect(err.message).not.toContain('segredo-do-cliente');
    expect(err.campos).toEqual(['url']);
  });
});

describe('non-2xx bodies', () => {
  it('⭐ no longer puts a whole HTML page into the thrown error', async () => {
    // `parsed = { error: text }` ran BEFORE the status check, so the raw document
    // became the error body. The ML client fixed this in 3a4b7278.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(
      mockFetch(async () => new Response('<!DOCTYPE html><html>502</html>', { status: 502 })),
    );

    const err = (await c.conta('f1').catch((e: unknown) => e)) as FreightHttpError;

    expect(err).toBeInstanceOf(FreightHttpError);
    expect(JSON.stringify(err.body ?? null)).not.toContain('DOCTYPE');
    expect(String(spy.mock.calls[0]?.[1])).toContain('502');
  });

  it('still maps a typed status the way it always did', async () => {
    // The control for the branch above: the rich status dispatcher must survive.
    const c = client(
      mockFetch(
        async () =>
          new Response(JSON.stringify({ error: 'nope' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const err = (await c.conta('f1').catch((e: unknown) => e)) as FreightHttpError;

    expect(err.status).toBe(404);
  });
});
