import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        get:
          name === 'cargos'
            ? () => mocks.cargoGet(id)
            : async () => ({ data: () => undefined }),
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
  grupoEconomico: 'ge_1',
};

const CALLER_CLAIM = {
  grupoEconomico: 'ge_1',
  permissions: ((1n << 41n) | (1n << 40n)).toString(),
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
    const res = await POST(
      req('not json', { authorization: 'Bearer xyz' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects bodies that fail schema validation', async () => {
    const res = await POST(
      req({ ...VALID_BODY, email: 'not-an-email' }, { authorization: 'Bearer xyz' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects callers whose grupoEconomico mismatches', async () => {
    mocks.verifyIdToken.mockResolvedValue({
      ...CALLER_CLAIM,
      grupoEconomico: 'ge_2',
    });
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
  });

  it('rejects callers without configuracoes.write', async () => {
    mocks.verifyIdToken.mockResolvedValue({
      grupoEconomico: 'ge_1',
      permissions: (1n << 40n).toString(), // only read
    });
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(403);
  });

  it('creates user, sets claims, writes Firestore doc on happy path', async () => {
    mocks.verifyIdToken.mockResolvedValue(CALLER_CLAIM);
    mocks.cargoGet.mockResolvedValue({
      data: () => ({
        nome: 'Admin',
        permissoes: ((1n << 0n) | (1n << 1n)).toString(),
        grupoEconomico: 'ge_1',
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
      grupoEconomico: 'ge_1',
      permissions: ((1n << 0n) | (1n << 1n)).toString(),
    });
    expect(mocks.usuarioSet).toHaveBeenCalled();
  });

  it('drops cargos that belong to another grupoEconomico', async () => {
    mocks.verifyIdToken.mockResolvedValue(CALLER_CLAIM);
    mocks.cargoGet.mockResolvedValue({
      data: () => ({
        nome: 'Outro',
        permissoes: '255',
        grupoEconomico: 'ge_OUTRO',
      }),
    });
    mocks.createUser.mockResolvedValue({ uid: 'uid_99' });

    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(201);
    expect(mocks.setCustomUserClaims).toHaveBeenCalledWith('uid_99', {
      grupoEconomico: 'ge_1',
      permissions: '0',
    });
    const setCall = mocks.usuarioSet.mock.calls[0]?.[1] as {
      cargos: string[];
    };
    expect(setCall.cargos).toEqual([]);
  });

  it('maps email-already-exists to 409', async () => {
    mocks.verifyIdToken.mockResolvedValue(CALLER_CLAIM);
    mocks.cargoGet.mockResolvedValue({ data: () => undefined });
    mocks.createUser.mockRejectedValue({ code: 'auth/email-already-exists' });

    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(409);
  });
});
