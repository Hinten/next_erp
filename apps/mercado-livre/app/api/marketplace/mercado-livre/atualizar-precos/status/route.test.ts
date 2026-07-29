import { beforeEach, describe, expect, it, vi } from 'vitest';

// verifyCaller is mocked; the admin collection is a fake in-memory doc store so
// the route's own logic (query validation, 404s, field projection) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  get: vi.fn(),
  parseRead: vi.fn((raw: unknown) => raw),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@delfrance/data/admin/collections', () => ({
  envioPrecoMercadoLivreCollection: {
    docRef: () => ({ get: h.get }),
    docPath: (_ctx: unknown, id: string) => `enviosPrecoMercadoLivre/${id}`,
    parseRead: h.parseRead,
  },
}));

const { GET } = await import('./route');

function req(query: string): Request {
  return new Request(
    `http://localhost:3006/api/marketplace/mercado-livre/atualizar-precos/status${query}`,
  );
}

const JOB = {
  integracaoId: 'int-1',
  status: 'running',
  baixarPreco: false,
  planejados: 40,
  enviados: 12,
  pulados: 20,
  falhas: 1,
  pausas: 2,
  skips: [{ itemId: 'MLB9', produtoId: 'p1', code: 'PRECO_ANTIGO_IGUAL' }],
  failures: [{ itemId: 'MLB8', error: 'boom' }],
  startedAt: 1000,
  updatedAt: 2000,
  finishedAt: null,
  erro: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.get.mockResolvedValue({ exists: true, data: () => JOB });
  h.parseRead.mockImplementation((raw: unknown) => raw);
});

describe('GET /api/marketplace/mercado-livre/atualizar-precos/status', () => {
  it('returns the job progress fields', async () => {
    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'running',
      baixarPreco: false,
      planejados: 40,
      enviados: 12,
      pulados: 20,
      falhas: 1,
      pausas: 2,
      skips: [{ itemId: 'MLB9', produtoId: 'p1', code: 'PRECO_ANTIGO_IGUAL' }],
      failures: [{ itemId: 'MLB8', error: 'boom' }],
      startedAt: 1000,
      updatedAt: 2000,
      finishedAt: null,
      erro: null,
    });
  });

  it('400s when integracaoId or jobId is missing', async () => {
    expect((await GET(req('?jobId=job-1'))).status).toBe(400);
    expect((await GET(req('?integracaoId=int-1'))).status).toBe(400);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('404s when the job doc does not exist', async () => {
    h.get.mockResolvedValue({ exists: false, data: () => undefined });
    const res = await GET(req('?integracaoId=int-1&jobId=missing'));
    expect(res.status).toBe(404);
  });

  it('404s when the job exists but belongs to a different integração (no cross-account leak)', async () => {
    h.get.mockResolvedValue({ exists: true, data: () => ({ ...JOB, integracaoId: 'int-OTHER' }) });
    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    expect(res.status).toBe(404);
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    expect(res.status).toBe(403);
    expect(h.get).not.toHaveBeenCalled();
  });
});
