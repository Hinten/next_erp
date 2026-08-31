import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  jobSnap: null as unknown,
  produtoSnaps: [] as unknown[],
  shardsGet: vi.fn(),
  orderBy: vi.fn(),
  startAfter: vi.fn(),
  limit: vi.fn(),
  getAll: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({ getAll: h.getAll }),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@delfrance/data/admin/collections', () => {
  const q = {
    orderBy: (...a: unknown[]) => {
      h.orderBy(a);
      return q;
    },
    startAfter: (...a: unknown[]) => {
      h.startAfter(a);
      return q;
    },
    limit: (...a: unknown[]) => {
      h.limit(a);
      return q;
    },
    get: h.shardsGet,
  };
  return {
    envioPrecoMercadoLivreCollection: {
      docRef: () => ({ __job: true }),
      docPath: (_c: unknown, id: string) => `enviosPrecoMercadoLivre/${id}`,
      parseRead: (raw: unknown) => raw,
    },
    relatorioEnvioPrecoMercadoLivreCollection: {
      ref: () => q,
      docPath: (_c: unknown, id: string) => `relatorios/${id}`,
      parseRead: (raw: unknown) => raw,
    },
    produtoCollection: { docRef: (_db: unknown, _c: unknown, id: string) => ({ id }) },
  };
});

const { CAMPOS_JOB, GET } = await import('./route');

function req(query: string): Request {
  return new Request(
    `http://localhost:3006/api/marketplace/mercado-livre/atualizar-precos/relatorio${query}`,
  );
}

const JOB = {
  integracaoId: 'int-1',
  status: 'completed',
  relatorioLinhas: 2,
  relatorioShards: 1,
  relatorioCompleto: true,
  filaRestante: 0,
  planejados: 2,
  enviados: 1,
  pulados: 1,
  falhas: 0,
  startedAt: 1000,
  finishedAt: 3000,
};

function linha(over: Record<string, unknown> = {}) {
  return {
    produtoId: 'p1',
    variacaoProdutoId: null,
    anuncioId: 'MLB1',
    linkDocId: 'lnk-1',
    resultado: 'enviado',
    fase: 'envio',
    motivo: null,
    erro: null,
    preco: 50,
    precoAnterior: 40,
    variacoes: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.jobSnap = { exists: true, data: () => JOB };
  h.produtoSnaps = [{ id: 'p1', exists: true, data: () => ({ nome: 'Camiseta', sku: 'CAM-1' }) }];
  h.shardsGet.mockResolvedValue({
    docs: [{ id: '0000', data: () => ({ linhas: { k1: linha() } }) }],
  });
  // ONE fake for two callers: the job read passes the job ref (projected via
  // CAMPOS_JOB), the produto join passes N produto refs.
  h.getAll.mockImplementation(async (...args) => {
    const refs = args.filter((a) => a != null && typeof a === 'object' && !('fieldMask' in a));
    return (refs[0] as { __job?: boolean }).__job === true ? [h.jobSnap] : h.produtoSnaps;
  });
});

describe('GET /api/marketplace/mercado-livre/atualizar-precos/relatorio', () => {
  it('returns the rows with the produto join and the rendered message', async () => {
    h.shardsGet.mockResolvedValue({
      docs: [
        {
          id: '0000',
          data: () => ({
            linhas: { k1: linha({ resultado: 'pulado', motivo: 'PRECO_ANTIGO_IGUAL' }) },
          }),
        },
      ],
    });

    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    const body = (await res.json()) as { linhas: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    // ⭐ `produtoNome`/`sku` are JOINED, not stored — carrying them through
    // `fila` to the drain loop would cost ~0.8 GB of extra writes per run.
    expect(body.linhas[0]).toMatchObject({ produtoNome: 'Camiseta', sku: 'CAM-1' });
    // ⭐ `mensagem` is RENDERED from the code, so a wording fix applies to runs
    // already recorded.
    expect(body.linhas[0]!.mensagem).toContain('já está com este preço');
  });

  it('pages by document id, which needs no index', async () => {
    await GET(req('?integracaoId=int-1&jobId=job-1&depois=0003'));

    expect(h.orderBy).toHaveBeenCalledTimes(1);
    expect(h.startAfter.mock.calls[0]![0]).toEqual(['0003']);
    expect(h.limit.mock.calls[0]![0]).toEqual([4]);
  });

  it('reports the last page as proximoDepois null', async () => {
    // One shard back for a 4-shard request → there is no next page.
    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));

    expect(((await res.json()) as { proximoDepois: string | null }).proximoDepois).toBeNull();
  });

  it('hands back a cursor when the page came back full', async () => {
    h.shardsGet.mockResolvedValue({
      docs: ['0000', '0001', '0002', '0003'].map((id) => ({
        id,
        data: () => ({ linhas: { [id]: linha() } }),
      })),
    });

    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));

    expect(((await res.json()) as { proximoDepois: string | null }).proximoDepois).toBe('0003');
  });

  it('carries the job facts the CSV trailer needs', async () => {
    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    const body = (await res.json()) as Record<string, unknown>;

    // Without these a truncated report is indistinguishable from a clean one.
    expect(body).toMatchObject({
      status: 'completed',
      relatorioCompleto: true,
      relatorioShards: 1,
      filaRestante: 0,
      planejados: 2,
    });
  });

  it('⚠️ a produto that no longer exists is DATA, not a failed download', async () => {
    // The reconciliation phase exists precisely because a row can point at a
    // deleted produto; the columns blank out and the file still downloads.
    h.produtoSnaps = [{ id: 'p1', exists: false, data: () => undefined }];

    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    const body = (await res.json()) as { linhas: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(body.linhas[0]).toMatchObject({ produtoNome: null, sku: null });
  });

  it('404s a jobId belonging to another conta, same as the status route', async () => {
    h.jobSnap = { exists: true, data: () => ({ ...JOB, integracaoId: 'outra' }) };

    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));

    expect(res.status).toBe(404);
    expect(h.shardsGet).not.toHaveBeenCalled();
  });

  it('404s an unknown jobId', async () => {
    h.jobSnap = { exists: false };

    expect((await GET(req('?integracaoId=int-1&jobId=nope'))).status).toBe(404);
  });

  it('REFUSES a limite past the ceiling instead of clamping', async () => {
    const res = await GET(req('?integracaoId=int-1&jobId=job-1&limite=99'));

    expect(res.status).toBe(400);
    expect(h.shardsGet).not.toHaveBeenCalled();
  });

  it('requires both ids', async () => {
    expect((await GET(req('?integracaoId=int-1'))).status).toBe(400);
    expect((await GET(req('?jobId=job-1'))).status).toBe(400);
  });

  it('propagates the auth refusal without reading anything', async () => {
    h.verifyCaller.mockResolvedValue({ error: new Response(null, { status: 403 }) });

    expect((await GET(req('?integracaoId=int-1&jobId=job-1'))).status).toBe(403);
    expect(h.getAll).not.toHaveBeenCalled();
  });

  it('⭐ reads the job PROJECTED, so `fila` never crosses the wire', async () => {
    // `fila` holds up to PLAN_PAGE_DRAFTS_CAP (2000) drafts (~344 KB) and is NOT
    // empty on the jobs this download is for — `failJob` stamps `filaRestante`
    // without clearing it. Unprojected, that was re-read on EVERY page of the
    // loop, up to MAX_PAGINAS (100) times per download.
    await GET(req('?integracaoId=int-1&jobId=job-1'));

    const opts = h.getAll.mock.calls[0]!.at(-1) as { fieldMask: string[] };
    expect(opts.fieldMask).not.toContain('fila');
    expect(opts.fieldMask).toContain('relatorioCompleto');
    // ⚠️ The four the schema has no default for — omitting any makes parseRead
    // throw. `updatedAt` is masked in although the response never returns it.
    expect(opts.fieldMask).toEqual(
      expect.arrayContaining(['integracaoId', 'status', 'startedAt', 'updatedAt']),
    );
  });

  it('the projected key set is exactly what the response reads back', async () => {
    // A field added to the response but not to CAMPOS_JOB would read as its
    // schema DEFAULT — silently correct-looking, which is the hazard of a mask.
    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    const body = (await res.json()) as Record<string, unknown>;

    for (const campo of ['status', 'relatorioCompleto', 'filaRestante', 'planejados']) {
      expect(CAMPOS_JOB).toContain(campo);
      expect(body[campo]).toBe((JOB as Record<string, unknown>)[campo]);
    }
  });

  it('⭐ REFUSES a malformed `depois` with 400, never a 500', async () => {
    // The admin SDK throws SYNCHRONOUSLY on a `__name__` cursor containing a
    // slash, so an unvalidated value handed an authed caller a stack trace where
    // every other bad param here gets a 400.
    const res = await GET(req('?integracaoId=int-1&jobId=job-1&depois=a/b'));

    expect(res.status).toBe(400);
    expect(h.shardsGet).not.toHaveBeenCalled();
  });

  it.each(['abc', '12', '../x', ''])('refuses depois=%s or treats it as absent', async (v) => {
    const res = await GET(req(`?integracaoId=int-1&jobId=job-1&depois=${encodeURIComponent(v)}`));

    // An EMPTY value means "first page"; anything malformed is refused.
    expect(v === '' ? 200 : 400).toBe(res.status);
  });

  it('⚠️ still accepts a well-formed shard id', async () => {
    // The control: the validator is not simply rejecting everything.
    const res = await GET(req('?integracaoId=int-1&jobId=job-1&depois=0003'));

    expect(res.status).toBe(200);
    expect(h.startAfter.mock.calls[0]![0]).toEqual(['0003']);
  });
});
