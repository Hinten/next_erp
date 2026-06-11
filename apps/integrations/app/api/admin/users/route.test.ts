import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPERUSER_MASK } from '@delfrance/schemas';

// Mock the firebase-admin singleton wrapper. The test exercises route logic
// only — we don't run against a real Firebase project. Set up the mock BEFORE
// importing the route so the route picks up our stubs.
const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  createUser: vi.fn(),
  setCustomUserClaims: vi.fn(),
  cargoGet: vi.fn(),
  usuarioSet: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: mocks.verifyIdToken,
    createUser: mocks.createUser,
    setCustomUserClaims: mocks.setCustomUserClaims,
  }),
  getAdminFirestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: name === 'cargos' ? () => mocks.cargoGet(id) : async () => ({ data: () => undefined }),
        set:
          name === 'usuarios'
            ? (data: unknown) => mocks.usuarioSet(id, data)
            : async () => undefined,
      }),
    }),
  }),
}));

const { POST } = await import('./route');

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3001/api/admin/users', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

const VALID_BODY = {
  email: 'novo@example.com',
  nome: 'Novo Usuário',
  senha: 'abc12345',
  cargos: ['admin'],
  colaborador: true,
  isSuperUser: false,
};

// Caller holds configuracoes.read|write AND cliente.read|write — enough to
// grant the cargo used in the happy-path test (which grants cliente.read|write).
const CALLER_CLAIM = {
  permissions: ((1n << 41n) | (1n << 40n) | (1n << 1n) | (1n << 0n)).toString(),
};

const SU_CLAIM = {
  permissions: SUPERUSER_MASK.toString(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/admin/users', () => {
  it('rejects requests without an Authorization header', async () => {
    const res = await POST(req(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('rejects invalid JSON bodies', async () => {
    const res = await POST(req('not json', { authorization: 'Bearer xyz' }));
    expect(res.status).toBe(400);
  });

  it('rejects bodies that fail schema validation', async () => {
    const res = await POST(
      req({ ...VALID_BODY, email: 'not-an-email' }, { authorization: 'Bearer xyz' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects callers without configuracoes.write', async () => {
    mocks.verifyIdToken.mockResolvedValue({
      permissions: (1n << 40n).toString(), // only read
    });
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
  });

  it('rejects callers trying to grant cargo bits beyond their own', async () => {
    mocks.verifyIdToken.mockResolvedValue({
      // Caller has configuracoes.read|write only — no cliente bits.
      permissions: ((1n << 41n) | (1n << 40n)).toString(),
    });
    mocks.cargoGet.mockResolvedValue({
      data: () => ({
        nome: 'Admin',
        // Cargo grants cliente.read|write — caller doesn't have these.
        permissoes: ((1n << 0n) | (1n << 1n)).toString(),
      }),
    });
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('rejects non-superusers trying to create a superuser', async () => {
    mocks.verifyIdToken.mockResolvedValue(CALLER_CLAIM);
    mocks.cargoGet.mockResolvedValue({ data: () => undefined });
    const res = await POST(
      req({ ...VALID_BODY, cargos: [], isSuperUser: true }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(403);
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('allows superusers to create superusers', async () => {
    mocks.verifyIdToken.mockResolvedValue(SU_CLAIM);
    mocks.cargoGet.mockResolvedValue({ data: () => undefined });
    mocks.createUser.mockResolvedValue({ uid: 'uid_su' });
    mocks.setCustomUserClaims.mockResolvedValue(undefined);
    mocks.usuarioSet.mockResolvedValue(undefined);

    const res = await POST(
      req({ ...VALID_BODY, cargos: [], isSuperUser: true }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(201);
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('uid_su', {
      permissions: SUPERUSER_MASK.toString(),
    });
  });

  it('creates user, sets claims, writes Firestore doc on happy path', async () => {
    mocks.verifyIdToken.mockResolvedValue(CALLER_CLAIM);
    mocks.cargoGet.mockResolvedValue({
      data: () => ({
        nome: 'Admin',
        permissoes: ((1n << 0n) | (1n << 1n)).toString(),
      }),
    });
    mocks.createUser.mockResolvedValue({ uid: 'uid_42' });
    mocks.setCustomUserClaims.mockResolvedValue(undefined);
    mocks.usuarioSet.mockResolvedValue(undefined);

    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as { uid: string };
    expect(json.uid).toBe('uid_42');

    expect(mocks.createUser).toHaveBeenCalledWith({
      email: VALID_BODY.email,
      password: VALID_BODY.senha,
      displayName: VALID_BODY.nome,
    });
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('uid_42', {
      permissions: ((1n << 0n) | (1n << 1n)).toString(),
    });
    expect(mocks.usuarioSet).toHaveBeenCalled();
  });

  it('maps email-already-exists to 409', async () => {
    mocks.verifyIdToken.mockResolvedValue(CALLER_CLAIM);
    mocks.cargoGet.mockResolvedValue({ data: () => undefined });
    // firebase-admin throws an Error subclass (FirebaseAuthError) with a
    // string `code` — mirror that shape so the route's narrowing catches it.
    const fbErr = Object.assign(new Error('Email exists'), {
      code: 'auth/email-already-exists',
    });
    mocks.createUser.mockRejectedValue(fbErr);

    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(409);
  });
});
