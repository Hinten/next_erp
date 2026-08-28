import { beforeEach, describe, expect, it, vi } from 'vitest';

// verifyCaller is mocked; the admin collection is a chainable fake that records
// the query it was handed, so the route's own logic (param validation, the
// limite ladder, ordering, projection) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  get: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  limit: vi.fn(),
  select: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@delfrance/data/admin/collections', () => {
  const ref = {
    where: (...args: unknown[]) => {
      h.where(args);
      return ref;
    },
    orderBy: (...args: unknown[]) => {
      h.orderBy(args);
      return ref;
    },
    limit: (...args: unknown[]) => {
      h.limit(args);
      return ref;
    },
    select: (...args: unknown[]) => {
      h.select(args);
      return ref;
    },
    get: h.get,
  };
  return {
    envioPrecoMercadoLivreCollection: {
      ref: () => ref,
      docPath: (_ctx: unknown, id: string) => `enviosPrecoMercadoLivre/${id}`,
      parseRead: (raw: unknown) => raw,
    },
  };
});

const { GET } = await import('./route');

function req(query: string): Request {
  return new Request(
    `http://localhost:3006/api/marketplace/mercado-livre/atualizar-precos/historico${query}`,
  );
}

/**
 * A FINISHED job — the population this route exists for, and the one
 * `jobs-em-andamento` can never return. `fila` is present here on purpose: the
 * projection must drop it.
 */
const JOB = {
  integracaoId: 'int-1',
  status: 'completed',
  baixarPreco: true,
  planejados: 40,
  enviados: 12,
  pulados: 20,
  naoEnumerados: 3,
  falhas: 1,
  pausas: 2,
  skips: [{ itemId: 'MLB9', produtoId: 'p1', code: 'PRECO_ANTIGO_IGUAL' }],
  failures: [{ itemId: 'MLB8', produtoId: 'p2', code: 'UPDATE_PRECO_ERROR', error: 'boom' }],
  startedAt: 1000,
  updatedAt: 2000,
  finishedAt: 3000,
  erro: null,
  fila: [{ kind: 'item', itemId: 'MLB7', produtoId: 'p3', linkDocId: 'l1', preco: 10 }],
  afterAnchorId: null,
  planejamentoConcluido: true,
  reconciliacaoConcluida: true,
  linksReconciliados: 5,
  reconciliacaoPaginas: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.get.mockResolvedValue({ docs: [{ id: 'env-1', data: () => JOB }] });
});

describe('GET /api/marketplace/mercado-livre/atualizar-precos/historico', () => {
  it('returns the conta runs, newest first, each tagged with its jobId', async () => {
    const res = await GET(req('?integracaoId=int-1'));

    expect(res.status).toBe(200);
    // Written out rather than spread. A spread over the stored fixture would
    // compare the projection against a document carrying the same shape, which
    // is exactly how #1361's missing `naoEnumerados` passed CI on the sibling
    // route. `toEqual` also fails on an EXTRA key, which is what pins `fila` as
    // dropped rather than merely untested.
    expect(await res.json()).toEqual({
      envios: [
        {
          jobId: 'env-1',
          integracaoId: 'int-1',
          status: 'completed',
          baixarPreco: true,
          planejados: 40,
          enviados: 12,
          pulados: 20,
          naoEnumerados: 3,
          falhas: 1,
          pausas: 2,
          skips: [{ itemId: 'MLB9', produtoId: 'p1', code: 'PRECO_ANTIGO_IGUAL' }],
          failures: [
            { itemId: 'MLB8', produtoId: 'p2', code: 'UPDATE_PRECO_ERROR', error: 'boom' },
          ],
          startedAt: 1000,
          updatedAt: 2000,
          finishedAt: 3000,
          erro: null,
        },
      ],
    });
  });

  it('queries by conta, sorted by startedAt DESC — the shape the composite index serves', async () => {
    await GET(req('?integracaoId=int-1'));

    expect(h.where.mock.calls.map(([a]) => a)).toEqual([['integracaoId', '==', 'int-1']]);
    expect(h.orderBy.mock.calls.map(([a]) => a)).toEqual([['startedAt', 'desc']]);
  });

  it('projects server-side, so `fila` never leaves Firestore', async () => {
    // Dropping `fila` from the response body alone still pulls up to 50
    // documents each carrying up to PLAN_PAGE_DRAFTS_CAP drafts across the wire.
    await GET(req('?integracaoId=int-1'));

    const campos = h.select.mock.calls[0]![0] as string[];
    expect(campos).not.toContain('fila');
    expect(campos).toContain('naoEnumerados');
    // The four the schema has no default for — omitting any would throw on parse.
    expect(campos).toEqual(
      expect.arrayContaining(['integracaoId', 'status', 'startedAt', 'updatedAt']),
    );
  });

  it('does not filter on status — a FINISHED run is the whole point', async () => {
    await GET(req('?integracaoId=int-1'));

    const campos = h.where.mock.calls.map(([a]) => (a as unknown[])[0]);
    expect(campos).not.toContain('status');
  });

  it('defaults to 20 runs', async () => {
    await GET(req('?integracaoId=int-1'));

    expect(h.limit.mock.calls.map(([a]) => a)).toEqual([[20]]);
  });

  it('honours an explicit limite', async () => {
    await GET(req('?integracaoId=int-1&limite=5'));

    expect(h.limit.mock.calls.map(([a]) => a)).toEqual([[5]]);
  });

  it('REFUSES a limite past the ceiling instead of silently clamping it', async () => {
    // Clamping would answer 50 to a request for 500, and the caller would read
    // the short page as "that is all the history there is".
    const res = await GET(req('?integracaoId=int-1&limite=500'));

    expect(res.status).toBe(400);
    expect(h.get).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', 'abc', '1.5'])('refuses limite=%s', async (limite) => {
    const res = await GET(req(`?integracaoId=int-1&limite=${limite}`));

    expect(res.status).toBe(400);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('requires integracaoId', async () => {
    const res = await GET(req(''));

    expect(res.status).toBe(400);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('propagates the auth refusal without querying', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });

    const res = await GET(req('?integracaoId=int-1'));

    expect(res.status).toBe(403);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('returns an empty list for a conta that never ran one', async () => {
    h.get.mockResolvedValue({ docs: [] });

    const res = await GET(req('?integracaoId=int-1'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ envios: [] });
  });
});
