import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import {
  MelhorEnvioReauthRequiredError,
  MelhorEnvioValidationError,
} from '@delfrance/integrations-freight-br';

// The route runs the REAL comprarEtiqueta pipeline against a mocked ME api
// (via loadMelhorEnvioContext) and a mocked pedidoCollection write.
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  addToCart: vi.fn(),
  getOrder: vi.fn(),
  checkout: vi.fn(),
  generate: vi.fn(),
  print: vi.fn(),
  pedidoGet: vi.fn(),
  pedidoUpdate: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  pedidoCollection: { docRef: () => ({ get: h.pedidoGet, update: h.pedidoUpdate }) },
}));

vi.mock('@/lib/freight/melhorEnvio', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/freight/melhorEnvio')>();
  return { ...actual, loadMelhorEnvioContext: h.loadCtx };
});

const { POST } = await import('./route');

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3001/api/freight/melhor-envio/comprar', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const WRITER = { uid: 'u1', permissions: (PERM.frete.read | PERM.frete.write).toString() };
const VALID_BODY = { intFreteId: 'int-1', pedidoId: 'ped-1', cartPayload: { service: 3 } };

beforeEach(() => {
  vi.clearAllMocks();
  h.pedidoGet.mockResolvedValue({ exists: true });
  h.addToCart.mockResolvedValue({ id: 'new-label' });
  h.checkout.mockResolvedValue({});
  h.generate.mockResolvedValue({});
  h.print.mockResolvedValue({ url: 'https://sandbox.melhorenvio.com.br/imprimir/abc' });
  h.getOrder.mockResolvedValue({ id: 'new-label', tracking: 'ME123BR' });
  h.loadCtx.mockResolvedValue({
    intFreteId: 'int-1',
    api: {
      addToCart: h.addToCart,
      getOrder: h.getOrder,
      checkout: h.checkout,
      generate: h.generate,
      print: h.print,
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/freight/melhor-envio/comprar', () => {
  it('returns 401 without an Authorization header', async () => {
    expect((await POST(req(VALID_BODY))).status).toBe(401);
  });

  it('returns 403 for a caller without frete.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.frete.read.toString() });
    expect((await POST(req(VALID_BODY, { authorization: 'Bearer t' }))).status).toBe(403);
  });

  it('returns 400 when the body is missing pedidoId', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await POST(
      req({ intFreteId: 'int-1', cartPayload: { service: 3 } }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 without touching Melhor Envio when the pedido does not exist', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    h.pedidoGet.mockResolvedValue({ exists: false });
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(404);
    // No label is bought for a pedido we can't persist to.
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.addToCart).not.toHaveBeenCalled();
  });

  it('buys the label, persists printLabelId before checkout, then writes estado/codRastreio', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      printLabelId: 'new-label',
      printUrl: 'https://sandbox.melhorenvio.com.br/imprimir/abc',
      tracking: 'ME123BR',
      estado: 'aguardandoPostagem',
    });

    // The anchor write happens before checkout spends balance.
    expect(h.pedidoUpdate).toHaveBeenNthCalledWith(1, { 'freteInicial.printLabelId': 'new-label' });
    expect(h.pedidoUpdate.mock.invocationCallOrder[0]!).toBeLessThan(
      h.checkout.mock.invocationCallOrder[0]!,
    );
    // The final write sets estado + tracking.
    expect(h.pedidoUpdate).toHaveBeenNthCalledWith(2, {
      'freteInicial.estado': 'aguardandoPostagem',
      'freteInicial.codRastreio': 'ME123BR',
    });
  });

  it('maps a canceled label to 409 ME_LABEL_TERMINAL and does not re-buy', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    h.getOrder.mockResolvedValue({ id: 'existing', canceled_at: '2026-06-17 09:00:00' });
    const res = await POST(
      req({ ...VALID_BODY, printLabelId: 'existing' }, { authorization: 'Bearer t' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ME_LABEL_TERMINAL');
    expect(h.checkout).not.toHaveBeenCalled();
  });

  it('maps a dead token to 409 ME_REAUTH', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    h.addToCart.mockRejectedValue(
      new MelhorEnvioReauthRequiredError('no_token', 'Conta não conectada.'),
    );
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ME_REAUTH');
  });

  it('maps a 422 from ME to 422', async () => {
    h.verifyIdToken.mockResolvedValue(WRITER);
    h.addToCart.mockRejectedValue(new MelhorEnvioValidationError('inválido', { to: ['x'] }, {}));
    const res = await POST(req(VALID_BODY, { authorization: 'Bearer t' }));
    expect(res.status).toBe(422);
  });
});
