import { beforeEach, describe, expect, it, vi } from 'vitest';

// verifyCaller is mocked; both admin collections are fake query builders that
// record the filters they were handed, so the route's own logic (param
// validation, chunking, projection) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  importacaoGet: vi.fn(),
  envioGet: vi.fn(),
  importacaoWhere: vi.fn(),
  envioWhere: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

/** Chainable `.where().where().get()` that records every filter it received. */
function fakeRef(record: (f: [string, string, unknown]) => void, get: () => unknown) {
  const ref = {
    where(field: string, op: string, value: unknown) {
      record([field, op, value]);
      return ref;
    },
    get,
  };
  return ref;
}

vi.mock('@delfrance/data/admin/collections', () => ({
  importacaoMercadoLivreCollection: {
    ref: () => fakeRef((f) => h.importacaoWhere(f), h.importacaoGet),
    docPath: (_ctx: unknown, id: string) => `importacoesMercadoLivre/${id}`,
    parseRead: (raw: unknown) => raw,
  },
  envioPrecoMercadoLivreCollection: {
    ref: () => fakeRef((f) => h.envioWhere(f), h.envioGet),
    docPath: (_ctx: unknown, id: string) => `enviosPrecoMercadoLivre/${id}`,
    parseRead: (raw: unknown) => raw,
  },
}));

const { GET } = await import('./route');

function req(query: string): Request {
  return new Request(
    `http://localhost:3006/api/marketplace/mercado-livre/jobs-em-andamento${query}`,
  );
}

const IMPORT_JOB = {
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

const PRICE_JOB = {
  integracaoId: 'int-2',
  status: 'running',
  baixarPreco: false,
  planejados: 9,
  enviados: 3,
  pulados: 1,
  naoEnumerados: 1,
  falhas: 0,
  pausas: 0,
  skips: [],
  failures: [],
  startedAt: 1000,
  updatedAt: 2000,
  finishedAt: null,
  erro: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.importacaoGet.mockResolvedValue({ docs: [{ id: 'imp-1', data: () => IMPORT_JOB }] });
  h.envioGet.mockResolvedValue({ docs: [{ id: 'env-1', data: () => PRICE_JOB }] });
});

describe('GET /api/marketplace/mercado-livre/jobs-em-andamento', () => {
  it('returns the running jobs of both flows, each tagged with its jobId and conta', async () => {
    const res = await GET(req('?integracaoIds=int-1,int-2'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      // Written out rather than spread: this pins the projection, including
      // that `updatedAt` is NOT part of the mass-import shape (same as the
      // by-jobId status route, which the UI switches to once it has an id).
      importacoes: [
        {
          jobId: 'imp-1',
          integracaoId: 'int-1',
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
        },
      ],
      // Written out for the same reason as the block above, and this half is
      // why it matters: it used to be `{ jobId: 'env-1', ...PRICE_JOB }`, which
      // compares the projection against a fixture carrying the SAME omission.
      // `naoEnumerados` was missing from both, so the assertion passed while
      // apps/web could not parse the response at all.
      enviosPreco: [
        {
          jobId: 'env-1',
          integracaoId: 'int-2',
          status: 'running',
          baixarPreco: false,
          planejados: 9,
          enviados: 3,
          pulados: 1,
          naoEnumerados: 1,
          falhas: 0,
          pausas: 0,
          skips: [],
          failures: [],
          startedAt: 1000,
          updatedAt: 2000,
          finishedAt: null,
          erro: null,
        },
      ],
    });
  });

  // The projection and `priceSyncStatusSchema` in apps/web are two halves of one
  // contract, and only this half can be asserted here (a spec about apps/web
  // runs nowhere on a web-only PR — see apps/mercado-livre/CLAUDE.md). So pin
  // the key set: a field dropped from the projection reds this, whether or not
  // the web schema tolerates it.
  it('sends every key the apps/web price-sync schema requires', async () => {
    const res = await GET(req('?integracaoIds=int-2'));
    const body = (await res.json()) as { enviosPreco: Array<Record<string, unknown>> };
    expect(Object.keys(body.enviosPreco[0]!).sort()).toEqual(
      [
        'baixarPreco',
        'enviados',
        'erro',
        'falhas',
        'failures',
        'finishedAt',
        'integracaoId',
        'jobId',
        'naoEnumerados',
        'pausas',
        'planejados',
        'pulados',
        'skips',
        'startedAt',
        'status',
        'updatedAt',
      ].sort(),
    );
  });

  it('filters on exactly the contas the caller named, and only running jobs', async () => {
    await GET(req('?integracaoIds=int-1,int-2'));
    expect(h.importacaoWhere.mock.calls.map(([f]) => f)).toEqual([
      ['integracaoId', 'in', ['int-1', 'int-2']],
      ['status', '==', 'running'],
    ]);
    expect(h.envioWhere.mock.calls.map(([f]) => f)).toEqual([
      ['integracaoId', 'in', ['int-1', 'int-2']],
      ['status', '==', 'running'],
    ]);
  });

  it('chunks past Firestore’s 30-value `in` cap instead of throwing', async () => {
    const ids = Array.from({ length: 31 }, (_, i) => `int-${i}`);
    h.importacaoGet.mockResolvedValue({ docs: [] });
    h.envioGet.mockResolvedValue({ docs: [] });

    const res = await GET(req(`?integracaoIds=${ids.join(',')}`));
    expect(res.status).toBe(200);

    const inFilters = h.importacaoWhere.mock.calls
      .map(([f]) => f)
      .filter(([field]) => field === 'integracaoId');
    expect(inFilters).toHaveLength(2);
    expect((inFilters[0]![2] as string[]).length).toBe(30);
    expect(inFilters[1]![2]).toEqual(['int-30']);
  });

  it('de-duplicates and trims the id list', async () => {
    await GET(req('?integracaoIds=int-1,%20int-1%20,int-2'));
    expect(h.importacaoWhere.mock.calls[0]![0][2]).toEqual(['int-1', 'int-2']);
  });

  it('400s without integracaoIds (no unfiltered "every running job" mode)', async () => {
    expect((await GET(req(''))).status).toBe(400);
    expect((await GET(req('?integracaoIds='))).status).toBe(400);
    expect((await GET(req('?integracaoIds=,,'))).status).toBe(400);
    expect(h.importacaoGet).not.toHaveBeenCalled();
  });

  it('400s past the per-request account cap', async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `int-${i}`);
    const res = await GET(req(`?integracaoIds=${ids.join(',')}`));
    expect(res.status).toBe(400);
    expect(h.importacaoGet).not.toHaveBeenCalled();
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await GET(req('?integracaoIds=int-1'));
    expect(res.status).toBe(403);
    expect(h.importacaoGet).not.toHaveBeenCalled();
  });
});
