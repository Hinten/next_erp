import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MercadoLivreReauthRequiredError } from '@delfrance/integrations-mercado-livre';

import { TabelaDeMedidasNotFoundError } from '@/lib/marketplace/size-charts/sizeChartSync';

// verifyCaller / context loader / sync are mocked; the route's own logic
// (body validation, wiring, error mapping) runs real.
const h = vi.hoisted(() => ({
  verifyCaller: vi.fn(),
  loadCtx: vi.fn(),
  resolveChannelContext: vi.fn(),
  syncSizeCharts: vi.fn(),
  currentOperation: vi.fn(),
}));

vi.mock('@/lib/marketplace/size-charts/sizeChartOperation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/marketplace/size-charts/sizeChartOperation')>()),
  currentOperation: h.currentOperation,
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

vi.mock('@/lib/marketplace/size-charts/sizeChartSync', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/marketplace/size-charts/sizeChartSync')>();
  return { ...actual, syncSizeCharts: h.syncSizeCharts };
});

const { POST, GET } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/marketplace/mercado-livre/size-charts/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = {
  integracaoId: 'int-1',
  tabMediId: 'tm-1',
  operationId: '11111111-1111-4111-8111-111111111111',
  chartIndex: 0,
  chart: { nome: 'Chart', domain_id: 'MLB-PANTS' },
};

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
  h.syncSizeCharts.mockResolvedValue({ tabelas: [], validationErrors: [], updated: false });
  h.currentOperation.mockResolvedValue(null);
});

describe('POST /api/marketplace/mercado-livre/size-charts/sync', () => {
  it('returns only recovery fields through the permission-gated status endpoint', async () => {
    h.currentOperation.mockResolvedValue({
      kind: 'sync',
      id: VALID.operationId,
      chartIndex: 0,
      desired: VALID.chart,
      projected: { ...VALID.chart, id: '501' },
      status: 'unconfirmed',
      baseline: { privateReceipt: 'hidden' },
      owner: 'hidden',
    });
    const response = await GET(
      new Request('http://localhost/api/size-charts/sync?integracaoId=int-1&tabMediId=tm-1'),
    );
    expect(await response.json()).toEqual({
      operation: {
        operationId: VALID.operationId,
        chartIndex: 0,
        chart: VALID.chart,
        projected: { ...VALID.chart, id: '501' },
        status: 'unconfirmed',
        kind: 'sync',
      },
    });
    expect((await GET(new Request('http://localhost/api/size-charts/sync'))).status).toBe(400);
  });
  it('runs the sync and returns its result (validation errors are DATA, 200)', async () => {
    h.syncSizeCharts.mockResolvedValue({
      tabelas: [{ id: '1', nome: 'x', domain_id: 'MLB-PANTS' }],
      validationErrors: [{ chartIndex: 0, code: 'chart_name_unavailable', message: 'in use' }],
      updated: true,
    });
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(true);
    expect(body.validationErrors).toHaveLength(1);

    const [deps, tabMediId, tabelas] = h.syncSizeCharts.mock.calls[0]!;
    expect(deps).toMatchObject({ integracaoId: 'int-1' });
    expect(tabMediId).toBe('tm-1');
    expect(tabelas).toEqual({ operationId: VALID.operationId, chartIndex: 0, chart: VALID.chart });
  });

  it('400s on missing fields, invalid JSON and non-object bodies', async () => {
    expect((await POST(req({ integracaoId: 'int-1' }))).status).toBe(400);
    expect((await POST(req({ ...VALID, chart: 'not-a-chart' }))).status).toBe(400);
    expect((await POST(req('{nope'))).status).toBe(400);
    // Legal JSON that isn't an object must 400, not crash to a 500.
    expect((await POST(req('null'))).status).toBe(400);
    expect((await POST(req('[1,2]'))).status).toBe(400);
    expect(h.syncSizeCharts).not.toHaveBeenCalled();
  });

  it('404s when the tabMedi doc does not exist', async () => {
    h.syncSizeCharts.mockRejectedValue(new TabelaDeMedidasNotFoundError('tm-1'));
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
