/**
 * The `usuarios-teste` route — above all, its gate.
 *
 * `POST` deletes every OAuth credential of the conta it runs on. That is the
 * intended behaviour, but it means the flag is not a convenience: on a backend
 * where it is unset, this route must be unreachable, and must not even admit it
 * exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USUARIO_TESTE_ROLE, type UsuarioTesteMercadoLivre } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  deleteAll: vi.fn(),
  criarUsuarioTeste: vi.fn(),
  getMe: vi.fn(),
  storeGet: vi.fn(),
  storePut: vi.fn(),
  storeList: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/conta/testUserStore', () => ({
  createTestUserStore: () => ({ get: h.storeGet, put: h.storePut, list: h.storeList }),
}));

vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return {
    ...actual,
    createMercadoLivreApi: () => ({
      criarUsuarioTeste: h.criarUsuarioTeste,
      getMe: h.getMe,
    }),
  };
});

const { GET, POST } = await import('./route');

const URL_BASE = 'http://localhost:3006/api/marketplace/mercado-livre/usuarios-teste';
const get = (qs = '?integracaoId=int-1') => new Request(`${URL_BASE}${qs}`);
const post = (qs = '?integracaoId=int-1') =>
  new Request(`${URL_BASE}${qs}`, { method: 'POST', body: '{}' });

function record(role: UsuarioTesteMercadoLivre['role']): UsuarioTesteMercadoLivre {
  return {
    role,
    id: 120506781,
    nickname: `TEST-${role}`,
    password: 'qatest328',
    site_id: 'MLB',
    site_status: 'active',
    email: null,
    createdAt: 1_700_000_000_000,
    createdByUserId: 999,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MERCADO_LIVRE_TEST_USERS_ENABLED = '1';
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ integracaoId: 'i', accessToken: 'AT', account: {} });
  h.loadCtx.mockResolvedValue({
    resolveChannelContext: h.resolveChannelContext,
    store: { deleteAll: h.deleteAll },
  });
  h.deleteAll.mockResolvedValue(2);
  h.getMe.mockResolvedValue({ id: 999, nickname: 'LOJA-REAL' });
  h.criarUsuarioTeste.mockResolvedValue({
    id: 120506781,
    nickname: 'TEST0548',
    password: 'qatest328',
    site_status: 'active',
  });
  h.storeGet.mockResolvedValue(null);
  h.storePut.mockResolvedValue(undefined);
  h.storeList.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.MERCADO_LIVRE_TEST_USERS_ENABLED;
});

describe('the MERCADO_LIVRE_TEST_USERS_ENABLED gate', () => {
  it.each([
    ['unset', undefined],
    ['0', '0'],
    ['true', 'true'],
  ])('404s on GET and POST when the flag is %s', async (_label, value) => {
    // Only the literal '1' opens it. `'true'` is included on purpose: a backend
    // configured with a plausible-looking value must still be closed, since the
    // failure mode is disconnecting a live seller.
    if (value === undefined) delete process.env.MERCADO_LIVRE_TEST_USERS_ENABLED;
    else process.env.MERCADO_LIVRE_TEST_USERS_ENABLED = value;

    expect((await GET(get())).status).toBe(404);
    expect((await POST(post())).status).toBe(404);
  });

  it('gates BEFORE auth, minting and any credential delete', async () => {
    // The 404 must be reachable without a token — it says "no such route", not
    // "you may not". And nothing may have happened on the way there.
    delete process.env.MERCADO_LIVRE_TEST_USERS_ENABLED;

    await POST(post());

    expect(h.verifyCaller).not.toHaveBeenCalled();
    expect(h.criarUsuarioTeste).not.toHaveBeenCalled();
    expect(h.deleteAll).not.toHaveBeenCalled();
  });

  it('is read per request, not frozen at import', async () => {
    // A module-scope constant would be baked at import and ignore the value a
    // test or an emulator run sets afterwards — the gate would then be untestable
    // and, worse, unchangeable without a redeploy.
    delete process.env.MERCADO_LIVRE_TEST_USERS_ENABLED;
    expect((await GET(get())).status).toBe(404);

    process.env.MERCADO_LIVRE_TEST_USERS_ENABLED = '1';
    expect((await GET(get())).status).toBe(200);
  });
});

describe('GET /api/marketplace/mercado-livre/usuarios-teste', () => {
  it('rejects an unauthorized caller', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    expect((await GET(get())).status).toBe(403);
  });

  it('requires integracaoId', async () => {
    expect((await GET(get(''))).status).toBe(400);
  });

  it('returns the stored records with their e-mail verification codes', async () => {
    h.storeList.mockResolvedValue([record(USUARIO_TESTE_ROLE.vendedor)]);

    const body = (await (await GET(get())).json()) as {
      usuarios: { nickname: string; codigosVerificacaoEmail: { quatro: string; seis: string } }[];
    };

    expect(body.usuarios[0]?.nickname).toBe('TEST-vendedor');
    // Derived from the id (120506781) — there is no inbox to read them from.
    expect(body.usuarios[0]?.codigosVerificacaoEmail).toEqual({
      quatro: '6781',
      seis: '506781',
    });
  });

  it('reads back without touching ML or the OAuth context', async () => {
    // The conta is deliberately disconnected by the time anyone reads these, so
    // resolving a channel context would make the route fail exactly when it is
    // most needed.
    await GET(get());

    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.getMe).not.toHaveBeenCalled();
  });
});

describe('POST /api/marketplace/mercado-livre/usuarios-teste', () => {
  it('rejects an unauthorized caller before minting anything', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });

    expect((await POST(post())).status).toBe(403);
    expect(h.criarUsuarioTeste).not.toHaveBeenCalled();
    expect(h.deleteAll).not.toHaveBeenCalled();
  });

  it('mints both roles, stores them and reports the disconnect', async () => {
    const res = await POST(post());
    const body = (await res.json()) as {
      criados: string[];
      credenciaisRemovidas: number;
      conta: { nickname: string };
      usuarios: { password: string }[];
    };

    expect(res.status).toBe(200);
    expect(h.criarUsuarioTeste).toHaveBeenCalledTimes(2);
    expect(h.storePut).toHaveBeenCalledTimes(2);
    expect(body.criados).toEqual(['vendedor', 'comprador']);
    expect(body.credenciaisRemovidas).toBe(2);
    expect(body.conta.nickname).toBe('LOJA-REAL');
    // The password reaches the browser exactly once — it is the only copy the
    // operator will ever see outside Firestore.
    expect(body.usuarios[0]?.password).toBe('qatest328');
  });

  it('maps the test-user guard to 409 ML_CONTA_JA_E_TESTE', async () => {
    h.getMe.mockResolvedValue({ id: 7, nickname: 'TETE8127263' });

    const res = await POST(post());

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ML_CONTA_JA_E_TESTE');
    expect(h.deleteAll).not.toHaveBeenCalled();
  });
});
