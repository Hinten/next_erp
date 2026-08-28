import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  jobGet: vi.fn(),
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
      docRef: () => ({ get: h.jobGet }),
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

const { GET } = await import('./route');

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
  h.jobGet.mockResolvedValue({ exists: true, data: () => JOB });
  h.shardsGet.mockResolvedValue({
    docs: [{ id: '0000', data: () => ({ linhas: { k1: linha() } }) }],
  });
  h.getAll.mockResolvedValue([
    { id: 'p1', exists: true, data: () => ({ nome: 'Camiseta', sku: 'CAM-1' }) },
  ]);
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
    h.getAll.mockResolvedValue([{ id: 'p1', exists: false, data: () => undefined }]);

    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));
    const body = (await res.json()) as { linhas: Array<Record<string, unknown>> };

    expect(res.status).toBe(200);
    expect(body.linhas[0]).toMatchObject({ produtoNome: null, sku: null });
  });

  it('404s a jobId belonging to another conta, same as the status route', async () => {
    h.jobGet.mockResolvedValue({ exists: true, data: () => ({ ...JOB, integracaoId: 'outra' }) });

    const res = await GET(req('?integracaoId=int-1&jobId=job-1'));

    expect(res.status).toBe(404);
    expect(h.shardsGet).not.toHaveBeenCalled();
  });

  it('404s an unknown jobId', async () => {
    h.jobGet.mockResolvedValue({ exists: false });

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
    expect(h.jobGet).not.toHaveBeenCalled();
  });
});
