import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdminClientHttpError,
  AdminClientNetworkError,
  AdminClientRespostaInvalidaError,
  createUser,
  refreshClaims,
} from './users';

/**
 * The least defended HTTP helper in the repo, and it had no tests. Three
 * separate ways a failure escaped un-typed:
 *
 *  1. `(await res.json()) as T` sat OUTSIDE any try, so an empty or non-JSON
 *     2xx threw a raw `SyntaxError` at the React caller.
 *  2. The `fetch` rejection was not wrapped, so a network failure arrived as a
 *     bare `TypeError` — which, in local dev, usually just means the
 *     integrations app on :3001 is not running.
 *  3. A non-2xx threw a bare `Error`, dropping the status: the UI could not
 *     tell "you may not grant that permission bit" from "the backend is down".
 */

const TOKEN = 'id-token';

function stubFetch(impl: typeof globalThis.fetch) {
  vi.stubGlobal('fetch', impl);
}

const PAYLOAD = {
  email: 'a@b.c',
  nome: 'Alguém',
  senha: 'x',
  cargos: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a 2xx that is not the shape we claimed', () => {
  it('⭐ raises a typed error instead of a raw SyntaxError on an EMPTY body', async () => {
    // `res.json()` on an empty body throws `SyntaxError: Unexpected end of JSON
    // input` — a message about a parser, surfacing in a React error boundary,
    // naming neither the endpoint nor the account being created.
    stubFetch(async () => new Response('', { status: 200 }));

    const err = await createUser(PAYLOAD, TOKEN).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdminClientRespostaInvalidaError);
    expect(err).not.toBeInstanceOf(SyntaxError);
  });

  it('⭐ raises a typed error for a body missing the uid', async () => {
    // The caller reads `.uid` immediately. `{}` cast to `CreateUserResult` gave
    // `undefined`, and the screen reported a user created with no id.
    stubFetch(async () => new Response('{}', { status: 200 }));

    const err = (await createUser(PAYLOAD, TOKEN).catch(
      (e: unknown) => e,
    )) as AdminClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(AdminClientRespostaInvalidaError);
    expect(err.campos).toEqual(['uid']);
  });

  it('keeps permissions a STRING — the BigInt encoding, not a number', async () => {
    // Claims are BigInt-encoded as strings to dodge the JS 53-bit limit. A
    // schema that accepted a number here would be accepting a value that has
    // already lost bits.
    stubFetch(
      async () => new Response(JSON.stringify({ uid: 'u1', permissions: 12345 }), { status: 200 }),
    );

    await expect(refreshClaims('u1', TOKEN)).rejects.toBeInstanceOf(
      AdminClientRespostaInvalidaError,
    );
  });

  it('still returns a well-formed result', async () => {
    // The control.
    stubFetch(async () => new Response(JSON.stringify({ uid: 'u1' }), { status: 200 }));

    await expect(createUser(PAYLOAD, TOKEN)).resolves.toEqual({ uid: 'u1' });
  });
});

describe('failures that used to escape un-typed', () => {
  it('⭐ wraps a network failure instead of letting a raw TypeError through', async () => {
    // In local dev this is the common case: `pnpm --filter @delfrance/web dev`
    // alone leaves :3001 down, and every admin action failed with "Failed to
    // fetch" and no hint about which service was missing.
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    const err = await createUser(PAYLOAD, TOKEN).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdminClientNetworkError);
  });

  it('⭐ keeps the STATUS on a non-2xx instead of throwing a bare Error', async () => {
    // 403 (this operator cannot grant that bit) and 500 (the backend is broken)
    // need different words, and the old bare `Error` made them identical.
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: 'Sem permissão.', code: 'PERM_NEGADA' }), {
          status: 403,
        }),
    );

    const err = (await createUser(PAYLOAD, TOKEN).catch((e: unknown) => e)) as AdminClientHttpError;

    expect(err).toBeInstanceOf(AdminClientHttpError);
    expect(err.status).toBe(403);
    expect(err.code).toBe('PERM_NEGADA');
    expect(err.message).toBe('Sem permissão.');
  });

  it('falls back to the status line when there is no envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch(
      async () => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
    );

    const err = (await createUser(PAYLOAD, TOKEN).catch((e: unknown) => e)) as AdminClientHttpError;

    expect(err.message).toContain('502');
    expect(err.message).not.toContain('<html');
  });
});
