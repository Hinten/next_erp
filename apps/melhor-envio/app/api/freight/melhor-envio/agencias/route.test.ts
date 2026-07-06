import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { MelhorEnvioHttpError } from '@delfrance/integrations-freight-br';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  listServices: vi.fn(),
  listAgencies: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
});

const { GET } = await import('./route');

function req(params: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3005/api/freight/melhor-envio/agencias');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

const READER = { uid: 'u1', permissions: PERM.frete.read.toString() };
const PARAMS = { intFreteId: 'int-1', service: '3', state: 'RS', city: 'Caxias do Sul' };
const AGENCY = { id: 195, name: 'JADLOG CAXIAS DO SUL' };

beforeEach(() => {
  vi.clearAllMocks();
  h.listServices.mockResolvedValue([
    { id: 1, name: 'PAC', company: { id: 1, name: 'Correios' } },
    { id: 3, name: '.Package', company: { id: 2, name: 'Jadlog' } },
  ]);
  h.listAgencies.mockResolvedValue([AGENCY]);
  h.loadCtx.mockResolvedValue({
    intFreteId: 'int-1',
    api: { listServices: h.listServices, listAgencies: h.listAgencies },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/freight/melhor-envio/agencias', () => {
  it('returns 401 without an Authorization header', async () => {
    expect((await GET(req(PARAMS))).status).toBe(401);
  });

  it('returns 400 when any required param is missing or service is not numeric', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    for (const missing of Object.keys(PARAMS)) {
      const partial = Object.fromEntries(Object.entries(PARAMS).filter(([k]) => k !== missing));
      const res = await GET(req(partial, { authorization: 'Bearer t' }));
      expect(res.status, `missing ${missing}`).toBe(400);
    }
    const res = await GET(req({ ...PARAMS, service: 'abc' }, { authorization: 'Bearer t' }));
    expect(res.status).toBe(400);
  });

  it("returns the service's carrier agencies near the sender city", async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    const res = await GET(req(PARAMS, { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agencies: [AGENCY] });
    expect(h.listAgencies).toHaveBeenCalledTimes(1);
    expect(h.listAgencies).toHaveBeenCalledWith({
      company: 2,
      country: 'BR',
      state: 'RS',
      city: 'Caxias do Sul',
    });
  });

  it('falls back to a state-wide list when the city has no agencies', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    const stateWide = { id: 200, name: 'JADLOG PORTO ALEGRE' };
    h.listAgencies.mockResolvedValueOnce([]).mockResolvedValueOnce([stateWide]);

    const res = await GET(req(PARAMS, { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agencies: [stateWide] });
    expect(h.listAgencies).toHaveBeenNthCalledWith(2, { company: 2, country: 'BR', state: 'RS' });
  });

  it('returns an empty list without querying agencies when the carrier is unknown', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    const res = await GET(req({ ...PARAMS, service: '99' }, { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agencies: [] });
    expect(h.listAgencies).not.toHaveBeenCalled();
  });

  it('maps an upstream ME failure to 502', async () => {
    h.verifyIdToken.mockResolvedValue(READER);
    h.listServices.mockRejectedValue(new MelhorEnvioHttpError('ME caiu', 500, null));
    const res = await GET(req(PARAMS, { authorization: 'Bearer t' }));
    expect(res.status).toBe(502);
  });
});
