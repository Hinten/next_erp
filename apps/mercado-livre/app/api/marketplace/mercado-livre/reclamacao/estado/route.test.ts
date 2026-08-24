import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  ler: vi.fn(),
  resolveChannelContext: vi.fn(),
  loadCtx: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({ __db: true }) }));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/claims/claimResolve', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/claims/claimResolve')>();
  return { ...actual, lerReclamacaoMercadoLivre: h.ler };
});

const { GET } = await import('./route');

function req(qs: string): Request {
  return new Request(`http://localhost:3006/api/marketplace/mercado-livre/reclamacao/estado${qs}`, {
    method: 'GET',
  });
}

const OK = '?integracaoId=int-1&claimId=5204934310';

const ESTADO = {
  claimId: 5204934310,
  status: 'opened',
  stage: 'claim',
  tipo: 'mediations',
  reasonId: 'PDD9551',
  tipoReclamacao: 'PDD',
  acoesDisponiveis: ['refund'],
  prazos: [],
  podeEnviarMensagem: false,
  motivoSemMensagem: null,
  expectativas: [],
  expectativasIndisponiveis: false,
  ofertasParciais: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyCaller.mockResolvedValue({ caller: { uid: 'u1', permissions: undefined } });
  h.resolveChannelContext.mockResolvedValue({ accessToken: 'tok' });
  h.loadCtx.mockResolvedValue({
    conta: { user_id: 415458330 },
    resolveChannelContext: h.resolveChannelContext,
  });
  h.ler.mockResolvedValue(ESTADO);
});

describe('GET /reclamacao/estado — the permission gate', () => {
  it('is gated on incidenteResolucao-READ, not pedido-read', async () => {
    // ⚠️ The reason #1224 minted a dedicated domain: this GET reaches ML's API on
    // the seller's account and returns buyer-visible claim detail, so it is not
    // free just because it is a read. A regression to `pedido.read` would look
    // like an ordinary list query and ship green — hence the negative half, which
    // a bare "was called" assertion would not catch.
    const res = await GET(req(OK));
    expect(res.status).toBe(200);
    expect(h.verifyCaller).toHaveBeenCalledWith(expect.anything(), PERM.incidenteResolucao.read);
    expect(h.verifyCaller).not.toHaveBeenCalledWith(expect.anything(), PERM.pedido.read);
    expect(h.verifyCaller).not.toHaveBeenCalledWith(
      expect.anything(),
      PERM.incidenteResolucao.write,
    );
  });
});

describe('GET /reclamacao/estado — query validation', () => {
  it.each([
    ['', 'both missing'],
    ['?integracaoId=int-1', 'no claimId'],
    ['?claimId=5204934310', 'no integracaoId'],
    ['?integracaoId=int-1&claimId=0', 'zero'],
    ['?integracaoId=int-1&claimId=-3', 'negative'],
    ['?integracaoId=int-1&claimId=1.5', 'non-integer'],
    ['?integracaoId=int-1&claimId=abc', 'non-numeric'],
    ['?integracaoId=%20%20&claimId=5204934310', 'blank integracaoId'],
  ])('refuses %o (%s) with 400, before resolving any credential', async (qs) => {
    // ⚠️ The ordering half matters here too: a validation that ran after
    // `loadMercadoLivreContext` would still answer 400, so asserting the account
    // was never resolved is what pins it.
    const res = await GET(req(qs));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'ML_QUERY_INVALIDA' });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.ler).not.toHaveBeenCalled();
  });
});

describe('GET /reclamacao/estado — the happy path', () => {
  it('reaches the reader with the PARSED numeric claimId and echoes its result', async () => {
    const res = await GET(req(OK));
    expect(h.ler).toHaveBeenCalledWith(expect.anything(), { claimId: 5204934310 });
    // A string id would silently work here and break `claimIdNumerico` downstream.
    expect(h.ler.mock.calls[0]![1]).toEqual({ claimId: 5204934310 });
    expect(await res.json()).toMatchObject({ claimId: 5204934310, acoesDisponiveis: ['refund'] });
  });

  it('maps an ML failure through the shared error mapper', async () => {
    h.ler.mockRejectedValue(new MercadoLivreHttpError('boom', 500, null));
    const res = await GET(req(OK));
    expect(res.status).toBe(502);
  });
});
