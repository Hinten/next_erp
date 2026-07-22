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
  importacaoMercadoLivreCollection: {
    docRef: () => ({ get: h.get }),
    docPath: (_ctx: unknown, id: string) => `importacoesMercadoLivre/${id}`,
    parseRead: h.parseRead,
  },
}));

const { GET } = await import('./route');

function req(query: string): Request {
  return new Request(
    `http://localhost:3006/api/marketplace/mercado-livre/importar-todos/status${query}`,
  );
}

const JOB = {
  integracaoId: 'int-1',
  status: 'running',
  scanned: 40,
  imported: 12,
  created: 5,
  skipped: 20,
  failureCount: 1,
  failures: [{ itemId: 'MLB9', error: 'boom' }],
  startedAt: 1000,
  updatedAt: 2000,
  finishedAt: null,
  erro: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.get.mockResolvedValue({ exists: true, data: () => JOB });
  h.parseRead.mockImplementation((raw: unknown) => raw);
});

describe('GET /api/marketplace/mercado-livre/importar-todos/status', () => {
  it('returns the job progress fields', async () => {
    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'running',
      scanned: 40,
      imported: 12,
      created: 5,
      skipped: 20,
      failureCount: 1,
      failures: [{ itemId: 'MLB9', error: 'boom' }],
      startedAt: 1000,
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
