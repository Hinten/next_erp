import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// verifyCaller / the context loader / the ML client / the orchestrator are
// mocked; the route's OWN logic (body validation, the action vocabulary, the
// selection cap, the single-listing coupling) runs for real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  createApi: vi.fn(),
  definirStatusAnunciosManual: vi.fn(),
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

vi.mock('@/lib/marketplace/anuncios/anuncioStatusManual', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/marketplace/anuncios/anuncioStatusManual')>();
  return { ...actual, definirStatusAnunciosManual: h.definirStatusAnunciosManual };
});

vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createApi };
});

const { POST } = await import('./route');
const { ANUNCIO_STATUS_MAX_PRODUTOS } =
  await import('@/lib/marketplace/anuncios/anuncioStatusManual');

const CONTA = 'int-1';

function post(body: unknown): Request {
  return new Request('http://localhost/api/marketplace/mercado-livre/anuncio-status', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const RESPOSTA_VAZIA = {
  canal: 'mercado-livre',
  integracaoId: CONTA,
  acao: 'pausar',
  solicitados: 1,
  familias: 1,
  resumo: { aplicados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [],
  produtosSemAnuncio: [],
  pausadoAte: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ uid: 'u1' });
  h.loadCtx.mockResolvedValue({
    conta: { nome: 'Loja' },
    resolveChannelContext: () => Promise.resolve({ accessToken: 'tok' }),
  });
  h.createApi.mockReturnValue({ updateItem: vi.fn() });
  h.definirStatusAnunciosManual.mockResolvedValue(RESPOSTA_VAZIA);
});

describe('POST /anuncio-status — auth and body', () => {
  it('propagates the permission refusal without touching ML', async () => {
    h.verifyCaller.mockResolvedValue({
      error: NextResponse.json({ error: 'nope' }, { status: 403 }),
    });
    const res = await POST(post({ integracaoId: CONTA, produtoIds: ['p1'], acao: 'pausar' }));
    expect(res.status).toBe(403);
    expect(h.definirStatusAnunciosManual).not.toHaveBeenCalled();
  });

  it('400s a non-object body', async () => {
    const res = await POST(post(['nope']));
    expect(res.status).toBe(400);
  });

  it('400s an unknown acao — the vocabulary is closed', async () => {
    const res = await POST(post({ integracaoId: CONTA, produtoIds: ['p1'], acao: 'encerrar' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'ML_ACAO_INVALIDA' });
  });

  it('400s an empty or non-string selection', async () => {
    expect((await POST(post({ integracaoId: CONTA, produtoIds: [], acao: 'pausar' }))).status).toBe(
      400,
    );
    const res = await POST(post({ integracaoId: CONTA, produtoIds: [7], acao: 'pausar' }));
    expect(await res.json()).toMatchObject({ code: 'ML_SELECAO_INVALIDA' });
  });

  it('REJECTS an oversize selection rather than truncating it', async () => {
    const ids = Array.from({ length: ANUNCIO_STATUS_MAX_PRODUTOS + 1 }, (_, i) => `p${String(i)}`);
    const res = await POST(post({ integracaoId: CONTA, produtoIds: ids, acao: 'pausar' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'ML_SELECAO_EXCEDE_LIMITE',
      limite: ANUNCIO_STATUS_MAX_PRODUTOS,
    });
    // A truncated run under a green summary is the failure this guards against.
    expect(h.definirStatusAnunciosManual).not.toHaveBeenCalled();
  });

  it('counts the cap over DISTINCT ids, so duplicates do not trip it', async () => {
    const ids = Array.from({ length: ANUNCIO_STATUS_MAX_PRODUTOS + 5 }, () => 'p1');
    const res = await POST(post({ integracaoId: CONTA, produtoIds: ids, acao: 'pausar' }));
    expect(res.status).toBe(200);
  });
});

describe('POST /anuncio-status — the single-listing form', () => {
  it('passes linkDocId through for a one-produto run', async () => {
    const res = await POST(
      post({ integracaoId: CONTA, produtoIds: ['p1'], acao: 'reativar', linkDocId: 'link1' }),
    );
    expect(res.status).toBe(200);
    const [, input] = h.definirStatusAnunciosManual.mock.calls[0]!;
    expect(input).toMatchObject({ acao: 'reativar', linkDocId: 'link1' });
  });

  it('400s a linkDocId sent with more than one produto', async () => {
    // A link doc lives under exactly ONE anchor, so a wider selection would
    // silently mean something other than what the caller asked for.
    const res = await POST(
      post({ integracaoId: CONTA, produtoIds: ['p1', 'p2'], acao: 'pausar', linkDocId: 'link1' }),
    );
    expect(res.status).toBe(400);
    expect(h.definirStatusAnunciosManual).not.toHaveBeenCalled();
  });

  it('400s a separator-bearing linkDocId before it reaches `.doc()`', async () => {
    const res = await POST(
      post({ integracaoId: CONTA, produtoIds: ['p1'], acao: 'pausar', linkDocId: 'a/b' }),
    );
    expect(res.status).toBe(400);
  });

  it('treats an absent linkDocId as the bulk form', async () => {
    await POST(post({ integracaoId: CONTA, produtoIds: ['p1', 'p2'], acao: 'pausar' }));
    const [, input] = h.definirStatusAnunciosManual.mock.calls[0]!;
    expect(input.linkDocId).toBeNull();
  });
});

describe('POST /anuncio-status — outcomes', () => {
  it('answers 200 with the envelope', async () => {
    const res = await POST(post({ integracaoId: CONTA, produtoIds: ['p1'], acao: 'pausar' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ canal: 'mercado-livre', acao: 'pausar' });
  });

  it('answers 200 even when every listing failed — per-listing failure is DATA', async () => {
    h.definirStatusAnunciosManual.mockResolvedValue({
      ...RESPOSTA_VAZIA,
      resumo: { aplicados: 0, pulados: 0, falhas: 1, naoTentados: 0 },
      listings: [{ produtoId: 'p1', outcome: 'falha', motivo: 'erro-mercado-livre' }],
    });
    const res = await POST(post({ integracaoId: CONTA, produtoIds: ['p1'], acao: 'pausar' }));
    expect(res.status).toBe(200);
    expect((await res.json()).resumo.falhas).toBe(1);
  });
});
