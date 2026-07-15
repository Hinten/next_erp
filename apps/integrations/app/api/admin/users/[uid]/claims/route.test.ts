import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorCodes, FirebaseAppError } from 'firebase-admin/app';
import { AuthClientErrorCode, FirebaseAuthError } from 'firebase-admin/auth';
import { rulesClaimsFromBits } from '@delfrance/auth';

// Mock the firebase-admin singleton wrapper. The test exercises route logic
// only — we don't run against a real Firebase project. Set up the mock BEFORE
// importing the route so the route picks up our stubs.
const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  setCustomUserClaims: vi.fn(),
  usuarioGet: vi.fn(),
  cargoGet: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: mocks.verifyIdToken,
    setCustomUserClaims: mocks.setCustomUserClaims,
  }),
  getAdminFirestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: name === 'usuarios' ? () => mocks.usuarioGet(id) : () => mocks.cargoGet(id),
      }),
    }),
  }),
}));

const { POST } = await import('./route');

// The firebase-admin .d.ts only surfaces the constructor inherited from Error,
// but at runtime FirebaseAuthError takes an ErrorInfo and FirebaseAppError
// takes (code, message) — cast so the tests can build the real classes the
// catch narrows on.
const AuthErrorCtor = FirebaseAuthError as unknown as new (info: {
  code: string;
  message: string;
}) => FirebaseAuthError;
const AppErrorCtor = FirebaseAppError as unknown as new (
  code: string,
  message: string,
) => FirebaseAppError;

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3001/api/admin/users/target/claims', {
    method: 'POST',
    headers,
  });
}

function ctx(uid = 'target') {
  return { params: Promise.resolve({ uid }) };
}

// configuracoes.read|write — enough for the permission gate and to cover the
// empty-cargo recompute in the happy path.
const CALLER_CLAIM = {
  permissions: ((1n << 41n) | (1n << 40n)).toString(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/admin/users/[uid]/claims', () => {
  it('rejects requests without an Authorization header', async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects callers without configuracoes.write', async () => {
    mocks.verifyIdToken.mockResolvedValue({ permissions: (1n << 40n).toString() }); // only read
    const res = await POST(req({ authorization: 'Bearer t' }), ctx());
    expect(res.status).toBe(403);
  });

  it('maps FirebaseAuthError to 401', async () => {
    mocks.verifyIdToken.mockRejectedValue(new AuthErrorCtor(AuthClientErrorCode.ID_TOKEN_EXPIRED));
    const res = await POST(req({ authorization: 'Bearer t' }), ctx());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Token inválido ou expirado.' });
  });

  it('maps FirebaseAppError (admin init failure) to 500 with the app/ code', async () => {
    mocks.verifyIdToken.mockRejectedValue(
      new AppErrorCtor(AppErrorCodes.INVALID_CREDENTIAL, 'bad credential'),
    );
    const res = await POST(req({ authorization: 'Bearer t' }), ctx());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Falha ao inicializar Firebase Admin (app/invalid-credential).',
    });
  });

  it('rethrows errors that are not firebase-admin classes', async () => {
    mocks.verifyIdToken.mockRejectedValue(new TypeError('boom'));
    await expect(POST(req({ authorization: 'Bearer t' }), ctx())).rejects.toThrow('boom');
  });

  it('rethrows duck-typed errors carrying an auth/ code that are not FirebaseAuthError', async () => {
    const impostor = Object.assign(new Error('impostor'), { code: 'auth/id-token-expired' });
    mocks.verifyIdToken.mockRejectedValue(impostor);
    await expect(POST(req({ authorization: 'Bearer t' }), ctx())).rejects.toThrow('impostor');
  });

  it('returns 404 when the target usuario does not exist', async () => {
    mocks.verifyIdToken.mockResolvedValue(CALLER_CLAIM);
    mocks.usuarioGet.mockResolvedValue({ data: () => undefined });
    const res = await POST(req({ authorization: 'Bearer t' }), ctx());
    expect(res.status).toBe(404);
    expect(mocks.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it('recomputes and sets the claims on the happy path', async () => {
    mocks.verifyIdToken.mockResolvedValue(CALLER_CLAIM);
    mocks.usuarioGet.mockResolvedValue({
      data: () => ({
        nome: 'Alvo',
        email: 'alvo@example.com',
        cargos: [],
        colaborador: false,
        ativo: true,
        isSuperUser: false,
        jaFoiColaborador: false,
        jaFoiSuperUser: false,
        ultimoAcesso: null,
        timestamp: null,
      }),
    });
    mocks.setCustomUserClaims.mockResolvedValue(undefined);

    const res = await POST(req({ authorization: 'Bearer t' }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 'target', permissions: '0' });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('target', {
      permissions: '0',
      su: false,
      ...rulesClaimsFromBits(0n),
    });
  });
});
