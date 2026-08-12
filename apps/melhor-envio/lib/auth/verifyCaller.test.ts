import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorCode, FirebaseAppError } from 'firebase-admin/app';
import { AuthErrorCode, FirebaseAuthError } from 'firebase-admin/auth';
import { PERM } from '@delfrance/auth';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
}));

const { verifyCaller } = await import('./verifyCaller');

const REQUIRED = PERM.frete.read;
const CALLER = { uid: 'u1', permissions: REQUIRED.toString() };

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3005/api/freight/melhor-envio/conta', { headers });
}

function expectError(result: Awaited<ReturnType<typeof verifyCaller>>) {
  if (!('error' in result)) throw new Error('expected an error result');
  return result.error;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('verifyCaller', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const error = expectError(await verifyCaller(req(), REQUIRED));
    expect(error.status).toBe(401);
    expect(await error.json()).toEqual({ error: 'Authorization Bearer token ausente.' });
  });

  it('returns 401 for a non-Bearer Authorization header', async () => {
    const error = expectError(await verifyCaller(req({ authorization: 'Basic abc' }), REQUIRED));
    expect(error.status).toBe(401);
    expect(h.verifyIdToken).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller lacks the required permission', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    const error = expectError(await verifyCaller(req({ authorization: 'Bearer t' }), REQUIRED));
    expect(error.status).toBe(403);
  });

  it('returns the caller for a valid token with the required permission', async () => {
    h.verifyIdToken.mockResolvedValue(CALLER);
    const result = await verifyCaller(req({ authorization: 'Bearer t' }), REQUIRED);
    expect(result).toEqual({ caller: CALLER });
    expect(h.verifyIdToken).toHaveBeenCalledWith('t');
  });

  it('maps FirebaseAuthError to 401 with the auth/ code in the body', async () => {
    h.verifyIdToken.mockRejectedValue(
      new FirebaseAuthError({
        code: AuthErrorCode.ID_TOKEN_EXPIRED,
        message: 'The provided Firebase ID token is expired.',
      }),
    );
    const error = expectError(await verifyCaller(req({ authorization: 'Bearer t' }), REQUIRED));
    expect(error.status).toBe(401);
    expect(await error.json()).toEqual({
      error: 'Token inválido ou expirado (auth/id-token-expired).',
      code: 'auth/id-token-expired',
    });
  });

  it('maps FirebaseAppError to 500 with the app/ code', async () => {
    h.verifyIdToken.mockRejectedValue(
      new FirebaseAppError({ code: AppErrorCode.INVALID_CREDENTIAL, message: 'bad credential' }),
    );
    const error = expectError(await verifyCaller(req({ authorization: 'Bearer t' }), REQUIRED));
    expect(error.status).toBe(500);
    expect(await error.json()).toEqual({
      error: 'Falha ao inicializar Firebase Admin (app/invalid-credential).',
      code: 'app/invalid-credential',
    });
  });

  it('rethrows errors that are not firebase-admin classes', async () => {
    h.verifyIdToken.mockRejectedValue(new TypeError('boom'));
    await expect(verifyCaller(req({ authorization: 'Bearer t' }), REQUIRED)).rejects.toThrow(
      'boom',
    );
  });

  it('rethrows duck-typed errors carrying an auth/ code that are not FirebaseAuthError', async () => {
    const impostor = Object.assign(new Error('impostor'), { code: 'auth/id-token-expired' });
    h.verifyIdToken.mockRejectedValue(impostor);
    await expect(verifyCaller(req({ authorization: 'Bearer t' }), REQUIRED)).rejects.toThrow(
      'impostor',
    );
  });
});
