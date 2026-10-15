import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { PERM } from '@delfrance/auth';
import { createCallerVerifier, type CallerVerifierOptions } from './index';

// Apps inject the real SDK constructors. Keep these tests independent of a
// runtime Admin import, as required by adminBundleSafety.test.ts.
class TokenValidationError extends Error {
  readonly code = 'auth/id-token-expired';
}

class AdminInitializationError extends Error {
  readonly code = 'app/invalid-credential';
}

const REQUIRED = PERM.configuracoes.write;
const CALLER = { uid: 'u1', permissions: REQUIRED.toString() };
const DECODED = {
  ...CALLER,
  aud: 'test-project',
  auth_time: 1,
  exp: 2,
  firebase: { identities: {}, sign_in_provider: 'custom' },
  iat: 1,
  iss: 'https://securetoken.google.com/test-project',
  sub: 'u1',
} satisfies DecodedIdToken;

const verifyIdToken = vi.fn<Auth['verifyIdToken']>();
const getAdminAuth = vi.fn(() => ({ verifyIdToken }));

function verifier(overrides: Partial<CallerVerifierOptions> = {}) {
  return createCallerVerifier({
    getAdminAuth,
    authErrorType: TokenValidationError,
    appErrorType: AdminInitializationError,
    logPrefix: 'test/auth',
    ...overrides,
  });
}

function req(authorization?: string) {
  return new Request('http://localhost/api/call', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

beforeEach(() => {
  verifyIdToken.mockReset();
  getAdminAuth.mockReset().mockReturnValue({ verifyIdToken });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCallerVerifier', () => {
  it('does not initialize Admin when the verifier is created', () => {
    verifier();
    expect(getAdminAuth).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Basic abc', 'bearer token'])(
    'returns 401 without initializing Admin for header %s',
    async (authorization) => {
      expect(await verifier()(req(authorization), REQUIRED)).toEqual({
        error: { status: 401, body: { error: 'Authorization Bearer token ausente.' } },
      });
      expect(getAdminAuth).not.toHaveBeenCalled();
      expect(verifyIdToken).not.toHaveBeenCalled();
    },
  );

  it('verifies the exact token and returns only the caller fields', async () => {
    verifyIdToken.mockResolvedValue(DECODED);
    expect(await verifier()(req('Bearer token'), REQUIRED)).toEqual({ caller: CALLER });
    expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith('token');
    expect(getAdminAuth).toHaveBeenCalledOnce();
  });

  it.each([undefined, '0', 'not-a-bitmask'])(
    'returns 403 for permissions %s',
    async (permissions) => {
      verifyIdToken.mockResolvedValue({ ...DECODED, permissions });
      expect(await verifier()(req('Bearer token'), REQUIRED)).toEqual({
        error: { status: 403, body: { error: 'Sem permissão para esta operação.' } },
      });
    },
  );

  it('maps only the injected token error class to 401', async () => {
    verifyIdToken.mockRejectedValue(new TokenValidationError('expired'));
    expect(await verifier()(req('Bearer token'), REQUIRED)).toEqual({
      error: {
        status: 401,
        body: {
          error: 'Token inválido ou expirado (auth/id-token-expired).',
          code: 'auth/id-token-expired',
        },
      },
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[test/auth] verifyIdToken rejected: auth/id-token-expired',
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it('maps only the injected app error class to 500 and logs its detail', async () => {
    verifyIdToken.mockRejectedValue(new AdminInitializationError('bad credential'));
    expect(await verifier()(req('Bearer token'), REQUIRED)).toEqual({
      error: {
        status: 500,
        body: {
          error: 'Falha ao inicializar Firebase Admin (app/invalid-credential).',
          code: 'app/invalid-credential',
        },
      },
    });
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      '[test/auth] admin init failed: app/invalid-credential - bad credential',
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('also maps a synchronous Admin initialization failure to 500', async () => {
    getAdminAuth.mockImplementation(() => {
      throw new AdminInitializationError('initialization failed');
    });
    const result = await verifier()(req('Bearer token'), REQUIRED);
    expect(result).toMatchObject({
      error: { status: 500, body: { code: 'app/invalid-credential' } },
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('rethrows a synchronous unexpected getter failure unchanged', async () => {
    const failure = new TypeError('misconfigured getter');
    getAdminAuth.mockImplementation(() => {
      throw failure;
    });
    await expect(verifier()(req('Bearer token'), REQUIRED)).rejects.toBe(failure);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    new TypeError('unexpected'),
    Object.assign(new Error('auth impostor'), { code: 'auth/id-token-expired' }),
    Object.assign(new Error('app impostor'), { code: 'app/invalid-credential' }),
    { code: 'auth/id-token-expired', message: 'plain object' },
  ])('rethrows an error outside the injected classes unchanged: %s', async (failure) => {
    verifyIdToken.mockRejectedValue(failure);
    await expect(verifier()(req('Bearer token'), REQUIRED)).rejects.toBe(failure);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('can retain the token error message in the log independently of response detail', async () => {
    verifyIdToken.mockRejectedValue(new TokenValidationError('expired'));
    const result = await verifier({ includeAuthErrorMessageInLog: true })(
      req('Bearer token'),
      REQUIRED,
    );
    expect(result).toMatchObject({
      error: { body: { error: 'Token inválido ou expirado (auth/id-token-expired).' } },
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[test/auth] verifyIdToken rejected: auth/id-token-expired - expired',
    );
  });

  it('can retain the Admin initialization message in the response', async () => {
    verifyIdToken.mockRejectedValue(new AdminInitializationError('bad credential'));
    expect(
      await verifier({ includeAdminErrorMessageInResponse: true })(req('Bearer token'), REQUIRED),
    ).toEqual({
      error: {
        status: 500,
        body: {
          error: 'Falha ao inicializar Firebase Admin (app/invalid-credential): bad credential',
          code: 'app/invalid-credential',
        },
      },
    });
  });
});
