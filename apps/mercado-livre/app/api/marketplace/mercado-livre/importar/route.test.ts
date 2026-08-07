import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreReauthRequiredError } from '@delfrance/integrations-mercado-livre';

import { MercadoLivreImportError } from '@/lib/marketplace/importCore';

// verifyCaller / context loader / orchestrator are mocked; the route's own
// logic (body validation, deps wiring, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  importProduto: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
  getAdminBucket: () => ({ name: 'demo-erp.appspot.com' }),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/import', () => ({ importProduto: h.importProduto }));

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/importar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({
    integracaoId: 'int-1',
    accessToken: 'AT',
    account: {},
  });
  h.loadCtx.mockResolvedValue({
    integracaoId: 'int-1',
    conta: {
      user_id: 55,
      tabelaNormalOuterRef: 'documents/listaDePrecos/lista-1',
      depositoOuterRef: 'documents/depositos/dep-1',
    },
    resolveChannelContext: h.resolveChannelContext,
  });
  h.importProduto.mockResolvedValue({
    produtoId: 'prod-9',
    estado: 'p',
    nome: 'Camiseta',
    created: true,
    variations: { total: 0, created: 0 },
  });
});

describe('POST /api/marketplace/mercado-livre/importar', () => {
  it('imports and returns the produto id + estado; wires the seller_id + refs', async () => {
    const res = await POST(req({ integracaoId: 'int-1', itemId: 'MLB123' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      produtoId: 'prod-9',
      estado: 'p',
      nome: 'Camiseta',
      created: true,
      variations: { total: 0, created: 0 },
    });

    const [deps, itemId] = h.importProduto.mock.calls[0]!;
    expect(itemId).toBe('MLB123');
    expect(deps).toMatchObject({
      integracaoId: 'int-1',
      sellerUserId: 55,
      tabelaNormalOuterRef: 'documents/listaDePrecos/lista-1',
      depositoOuterRef: 'documents/depositos/dep-1',
    });
  });

  it('passes through the variations summary for a legacy variations[] listing (#520)', async () => {
    h.importProduto.mockResolvedValue({
      produtoId: 'prod-9',
      estado: 'p',
      nome: 'Camiseta',
      created: true,
      variations: { total: 2, created: 2 },
    });
    const res = await POST(req({ integracaoId: 'int-1', itemId: 'MLB123' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ variations: { total: 2, created: 2 } });
  });

  it('forwards only the known boolean option flags (incl. importarFotos, importarCategorias)', async () => {
    await POST(
      req({
        integracaoId: 'int-1',
        itemId: 'MLB123',
        options: {
          sobrescreverEstoque: true,
          importarPreco: false,
          importarFotos: false,
          importarCategorias: true,
          bogus: 'x',
        },
      }),
    );
    const [deps] = h.importProduto.mock.calls[0]!;
    expect(deps.options).toEqual({
      sobrescreverEstoque: true,
      importarPreco: false,
      importarFotos: false,
      importarCategorias: true,
    });
    // the Storage bucket is wired into the deps for photo import
    expect(deps.bucket).toBeDefined();
  });

  it('400s on a missing itemId, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({ integracaoId: 'int-1' }))).status).toBe(400);
    expect((await POST(req('{not json'))).status).toBe(400);
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[]'))).status).toBe(400);
    expect(h.importProduto).not.toHaveBeenCalled();
  });

  it('maps import issues to 422 ML_IMPORT_BLOCKED (e.g. a closed listing)', async () => {
    h.importProduto.mockRejectedValue(
      new MercadoLivreImportError(['anúncio MLB123 está encerrado (status closed)']),
    );
    const res = await POST(req({ integracaoId: 'int-1', itemId: 'MLB123' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('ML_IMPORT_BLOCKED');
    expect(body.issues).toHaveLength(1);
  });

  it('a User-Products (family_name) listing imports successfully, with the family fan-out summary passed through (#521)', async () => {
    h.importProduto.mockResolvedValue({
      produtoId: 'prod-family',
      estado: 'p',
      nome: 'Camiseta Família',
      created: true,
      variations: { total: 1, created: 1 },
      family: { total: 2, imported: 2, created: 2, capped: false, failures: [] },
    });
    const res = await POST(req({ integracaoId: 'int-1', itemId: 'MLB123' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      produtoId: 'prod-family',
      family: { total: 2, imported: 2, created: 2, capped: false, failures: [] },
    });
  });

  it('maps a dead credential to 409 via the shared error mapper', async () => {
    h.resolveChannelContext.mockRejectedValue(
      new MercadoLivreReauthRequiredError('no_token', 'não conectada'),
    );
    const res = await POST(req({ integracaoId: 'int-1', itemId: 'MLB123' }));
    expect(res.status).toBe(409);
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    const res = await POST(req({ integracaoId: 'int-1', itemId: 'MLB123' }));
    expect(res.status).toBe(403);
  });
});
