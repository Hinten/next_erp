import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreReauthRequiredError } from '@delfrance/integrations-mercado-livre';

import { SizeChartNotFoundError } from '@/lib/marketplace/size-charts/sizeChartDelete';
import { TabelaDeMedidasNotFoundError } from '@/lib/marketplace/size-charts/sizeChartSync';

// verifyCaller / context loader / the delete op are mocked; the route's own
// logic (body validation, wiring, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  requestSizeChartDeletion: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/auth/verifyCaller', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/verifyCaller')>();
  return { ...actual, verifyCaller: h.verifyCaller };
});

vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});

vi.mock('@/lib/marketplace/size-charts/sizeChartDelete', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/marketplace/size-charts/sizeChartDelete')>();
  return { ...actual, requestSizeChartDeletion: h.requestSizeChartDeletion };
});

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/size-charts/excluir', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = { integracaoId: 'int-1', tabMediId: 'tm-1', chartId: '1594439' };

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
    resolveChannelContext: h.resolveChannelContext,
  });
  h.requestSizeChartDeletion.mockResolvedValue({ requested: true, message: null, tabelas: [] });
});

describe('POST /api/marketplace/mercado-livre/size-charts/excluir', () => {
  it('requests the deletion and returns ML’s ack', async () => {
    h.requestSizeChartDeletion.mockResolvedValue({
      requested: true,
      message: 'Before removing the size chart…',
      tabelas: [{ id: '1594439', exclusaoSolicitadaEm: 1 }],
    });
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requested).toBe(true);
    expect(body.message).toBe('Before removing the size chart…');
    // The guia is still on the doc — a 200 is an accepted REQUEST, not a delete.
    expect(body.tabelas).toHaveLength(1);

    const [deps, tabMediId, chartId] = h.requestSizeChartDeletion.mock.calls[0]!;
    expect(deps).toMatchObject({ integracaoId: 'int-1' });
    expect(tabMediId).toBe('tm-1');
    expect(chartId).toBe('1594439');
  });

  it('400s on missing fields, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({ integracaoId: 'int-1' }))).status).toBe(400);
    expect((await POST(req({ ...VALID, chartId: '' }))).status).toBe(400);
    expect((await POST(req('{nope'))).status).toBe(400);
    // Legal JSON that isn't an object must 400, not crash to a 500.
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[1,2]'))).status).toBe(400);
    expect(h.requestSizeChartDeletion).not.toHaveBeenCalled();
  });

  it('404s for an unknown tabMedi and for an unknown chart', async () => {
    h.requestSizeChartDeletion.mockRejectedValue(new TabelaDeMedidasNotFoundError('tm-1'));
    expect((await POST(req(VALID))).status).toBe(404);

    h.requestSizeChartDeletion.mockRejectedValue(new SizeChartNotFoundError('1594439'));
    expect((await POST(req(VALID))).status).toBe(404);
  });

  it('maps a dead credential to 409 via the shared error mapper', async () => {
    h.resolveChannelContext.mockRejectedValue(
      new MercadoLivreReauthRequiredError('no_token', 'não conectada'),
    );
    expect((await POST(req(VALID))).status).toBe(409);
  });

  it('propagates the auth failure from verifyCaller', async () => {
    const denied = { error: new (await import('next/server')).NextResponse(null, { status: 403 }) };
    h.verifyCaller.mockResolvedValue(denied);
    expect((await POST(req(VALID))).status).toBe(403);
  });
});
