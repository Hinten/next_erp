import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreReauthRequiredError } from '@delfrance/integrations-mercado-livre';

// verifyCaller / the context loader / the ML client / the link read and the two
// fiscal modules are mocked; the route's own logic (body validation, ownership,
// the 409s, which operação it passes, error mapping) runs for real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  createApi: vi.fn(),
  docRef: vi.fn(),
  alvos: vi.fn(),
  enviar: vi.fn(),
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

vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createApi };
});

vi.mock('@delfrance/data/admin/collections', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data/admin/collections')>();
  return {
    ...actual,
    produtoMercadoLivreLinkCollection: {
      ...actual.produtoMercadoLivreLinkCollection,
      docRef: h.docRef,
    },
  };
});

vi.mock('@/lib/marketplace/anuncios/dadosFiscaisAlvos', () => ({
  alvosFiscaisArmazenados: h.alvos,
}));

vi.mock('@/lib/marketplace/anuncios/dadosFiscais', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/anuncios/dadosFiscais')>();
  return { ...actual, enviarDadosFiscais: h.enviar };
});

const { POST } = await import('./route');

const CONTA = 'int-1';
const PRODUTO = 'prod-1';
const LINK = 'link-1';

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/dados-fiscais', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = { integracaoId: CONTA, produtoId: PRODUTO, linkDocId: LINK };

function seedLink(data: Record<string, unknown> | null): void {
  h.docRef.mockReturnValue({
    get: async () => ({ exists: data !== null, data: () => data ?? undefined }),
  });
}

const RESUMO = { enviados: 1, omitidos: [], erros: [] };
const ALVO = { produtoId: PRODUTO, itemId: 'MLB111' };

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.resolveChannelContext.mockResolvedValue({ accessToken: 'AT' });
  h.loadCtx.mockResolvedValue({
    conta: { operacaoOuterRef: 'documents/operacao/op-venda' },
    resolveChannelContext: h.resolveChannelContext,
  });
  h.createApi.mockReturnValue({});
  h.alvos.mockResolvedValue([ALVO]);
  h.enviar.mockResolvedValue(RESUMO);
  seedLink({ contaOuterRef: `documents/integracao/${CONTA}`, id: 'MLB111' });
});

describe('POST /api/marketplace/mercado-livre/dados-fiscais (#745)', () => {
  it('rebuilds the SKUs from the stored links and sends them through the conta’s operação', async () => {
    const res = await POST(req(validBody));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dadosFiscais: RESUMO });
    expect(h.alvos).toHaveBeenCalledWith(expect.anything(), {
      produtoId: PRODUTO,
      linkDocId: LINK,
      link: expect.objectContaining({ id: 'MLB111' }),
    });
    expect(h.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ operacaoOuterRef: 'documents/operacao/op-venda' }),
      [ALVO],
    );
  });

  it('a conta with no operação passes null — the send reports it, the route does not refuse', async () => {
    h.loadCtx.mockResolvedValue({ conta: {}, resolveChannelContext: h.resolveChannelContext });
    const res = await POST(req(validBody));
    expect(res.status).toBe(200);
    expect(h.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ operacaoOuterRef: null }),
      expect.anything(),
    );
  });

  it.each([
    ['a missing id', { integracaoId: CONTA, produtoId: PRODUTO }],
    ['a non-string id', { ...validBody, linkDocId: 1 }],
    ['a separator-bearing id', { ...validBody, produtoId: 'a/b' }],
  ])('400 on %s — before any read', async (_caso, body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(h.docRef).not.toHaveBeenCalled();
  });

  it('404 when the link does not exist', async () => {
    seedLink(null);
    expect((await POST(req(validBody))).status).toBe(404);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it('404 when the link belongs to ANOTHER conta — never trust the body', async () => {
    seedLink({ contaOuterRef: 'documents/integracao/outra', id: 'MLB111' });
    expect((await POST(req(validBody))).status).toBe(404);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('409 when the anúncio was never published', async () => {
    seedLink({ contaOuterRef: `documents/integracao/${CONTA}`, id: null });
    expect((await POST(req(validBody))).status).toBe(409);
    expect(h.alvos).not.toHaveBeenCalled();
  });

  it('409 when no published SKU of the anúncio is held by this ERP — before any OAuth refresh', async () => {
    h.alvos.mockResolvedValue([]);
    expect((await POST(req(validBody))).status).toBe(409);
    expect(h.loadCtx).not.toHaveBeenCalled();
  });

  it('a dead credential maps through the ML responder (409), not a 500', async () => {
    h.resolveChannelContext.mockRejectedValue(
      new MercadoLivreReauthRequiredError('refresh_failed', 'reconecte'),
    );
    const res = await POST(req(validBody));
    expect(res.status).toBe(409);
  });
});
