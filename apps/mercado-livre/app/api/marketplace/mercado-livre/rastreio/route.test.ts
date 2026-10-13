import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PERM } from '@delfrance/auth';
import { INTEGRACAO_FRETE } from '@delfrance/schemas';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  MercadoLivreValidationError,
} from '@delfrance/integrations-mercado-livre';

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  get: vi.fn(),
  context: vi.fn(),
  carrier: vi.fn(),
  factory: vi.fn(),
}));
vi.mock('@/lib/auth/verifyCaller', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/auth/verifyCaller')>()),
  verifyCaller: h.auth,
}));
vi.mock('@/lib/firebase/admin', () => ({
  getAdminFirestore: () => ({
    collection: () => ({ doc: () => ({ get: h.get }) }),
  }),
}));
vi.mock('@/lib/marketplace/core/mercadoLivre', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/marketplace/core/mercadoLivre')>()),
  loadMercadoLivreContext: h.context,
}));
vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/integrations-mercado-livre')>()),
  createMercadoLivreApi: h.factory,
}));

import { GET } from './route';

const URL_TRACK = 'http://carrier.example/track?pedido=01&nfiscal=1';
const freight = (over: Record<string, unknown> = {}) => ({
  externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre,
  externalId: '555',
  ...over,
});
function seed(
  freteInicial: unknown = freight(),
  integracaoPedidoOuterRef: string | null = 'documents/integracao/a',
) {
  h.get.mockResolvedValue({
    exists: true,
    data: () => ({ freteInicial, integracaoPedidoOuterRef }),
  });
}
const request = (query = '?pedidoId=p1') =>
  new Request(`http://localhost:3006/api/marketplace/mercado-livre/rastreio${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ caller: { uid: 'u1' } });
  seed();
  h.context.mockResolvedValue({
    conta: { ativo: true },
    resolveChannelContext: async () => ({ accessToken: 'ml-token' }),
  });
  h.factory.mockReturnValue({ getShipmentCarrier: h.carrier });
  h.carrier.mockResolvedValue({ name: 'Carrier', url: URL_TRACK });
});

describe('Mercado Livre tracking route', () => {
  it.each([401, 403])(
    'requires PERM.frete.read and propagates HTTP %s before any read',
    async (status) => {
      h.auth.mockResolvedValue({ error: new NextResponse(null, { status }) });
      expect((await GET(request())).status).toBe(status);
      expect(h.auth).toHaveBeenCalledWith(expect.any(Request), PERM.frete.read);
      expect(h.get).not.toHaveBeenCalled();
      expect(h.carrier).not.toHaveBeenCalled();
    },
  );

  it.each(['', '?pedidoId='])('rejects missing pedido IDs: %s', async (query) => {
    const res = await GET(request(query));
    expect(res.status).toBe(400);
    expect(h.get).not.toHaveBeenCalled();
  });

  it('returns the validated link without writes and resolves the stored shipment/account', async () => {
    const res = await GET(request('?pedidoId=p1&shipmentId=999'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ name: 'Carrier', url: URL_TRACK });
    expect(h.carrier).toHaveBeenCalledExactlyOnceWith('555');
    expect(h.context).toHaveBeenCalledWith(expect.anything(), 'a');
    const config = h.factory.mock.calls[0]![0] as { getAccessToken: () => Promise<string> };
    expect(await config.getAccessToken()).toBe('ml-token');
  });

  it('returns pedido-not-found without consulting ML', async () => {
    h.get.mockResolvedValue({ exists: false });
    expect((await GET(request())).status).toBe(404);
    expect(h.carrier).not.toHaveBeenCalled();
  });

  it.each([null, freight({ externalOptionIntegracao: INTEGRACAO_FRETE.shopee })])(
    'rejects non-ML freight: %j',
    async (frete) => {
      seed(frete);
      const res = await GET(request());
      expect(await res.json()).toMatchObject({ code: 'FRETE_NAO_MERCADO_LIVRE' });
      expect(h.carrier).not.toHaveBeenCalled();
    },
  );

  it.each([null, '', '   '])('rejects a missing shipment ID: %s', async (externalId) => {
    seed(freight({ externalId }));
    const res = await GET(request());
    expect(await res.json()).toMatchObject({ code: 'FRETE_SEM_EXTERNAL_ID' });
    expect(h.context).not.toHaveBeenCalled();
  });

  it('rejects a missing marketplace account', async () => {
    seed(freight(), null);
    expect((await GET(request())).status).toBe(409);
    expect(h.context).not.toHaveBeenCalled();
  });

  it('rejects an inactive account', async () => {
    h.context.mockResolvedValue({ conta: { ativo: false } });
    expect(await (await GET(request())).json()).toMatchObject({ code: 'ML_CONTA_INATIVA' });
    expect(h.carrier).not.toHaveBeenCalled();
  });

  it.each([null, '', '   '])('returns tracking-unavailable for an empty URL: %s', async (url) => {
    h.carrier.mockResolvedValue({ name: null, url });
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Rastreamento ainda indisponível.',
      code: 'ML_RASTREIO_INDISPONIVEL',
    });
  });

  it('maps a carrier 404 to unavailable, but preserves an account lookup 404 as an error', async () => {
    h.carrier.mockRejectedValueOnce(new MercadoLivreHttpError('missing', 404, {}));
    expect(await (await GET(request())).json()).toMatchObject({ code: 'ML_RASTREIO_INDISPONIVEL' });
    h.context.mockRejectedValueOnce(new MercadoLivreHttpError('missing account', 404, {}));
    expect(await (await GET(request())).json()).toMatchObject({ code: 'ML_HTTP_ERROR' });
  });

  it.each(['javascript:alert(1)', '/tracking', 'file:///tmp/a'])(
    'rejects unsafe URL %s',
    async (url) => {
      h.carrier.mockResolvedValue({ name: null, url });
      const res = await GET(request());
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'ML_BAD_RESPONSE' });
    },
  );

  it.each([
    [new MercadoLivreHttpError('upstream', 500, {}), 502, 'ML_HTTP_ERROR'],
    [new MercadoLivreNetworkError('network'), 503, 'ML_NETWORK_ERROR'],
    [new MercadoLivreReauthRequiredError('no_token', 'reconnect'), 409, 'ML_REAUTH_REQUIRED'],
    [new MercadoLivreValidationError('invalid body', []), 502, 'ML_BAD_RESPONSE'],
  ] as const)('preserves known errors: %s', async (error, status, code) => {
    h.carrier.mockRejectedValueOnce(error);
    const res = await GET(request());
    expect(res.status).toBe(status);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ code });
  });

  it('rethrows unrelated failures', async () => {
    const error = new TypeError('bug');
    h.carrier.mockRejectedValueOnce(error);
    await expect(GET(request())).rejects.toBe(error);
  });
});
