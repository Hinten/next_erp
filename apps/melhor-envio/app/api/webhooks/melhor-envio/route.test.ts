import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Firestore seam: a fake pedidoCollection whose query returns a
// configurable snapshot and whose docRef captures the update patch.
const h = vi.hoisted(() => ({ query: vi.fn(), update: vi.fn() }));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@delfrance/data/admin/collections', () => ({
  pedidoCollection: {
    ref: () => ({ where: () => ({ limit: () => ({ get: h.query }) }) }),
    docRef: () => ({ update: h.update }),
  },
}));

const { POST, meStatusToEstadoFrete } = await import('./route');

const SECRET = 'me-webhook-secret';

function req(body: unknown, opts: { sig?: string } = {}): Request {
  const raw = JSON.stringify(body);
  const signature = opts.sig ?? createHmac('sha256', SECRET).update(raw).digest('hex');
  return new Request('http://localhost:3005/api/webhooks/melhor-envio', {
    method: 'POST',
    body: raw,
    headers: { 'content-type': 'application/json', 'x-me-signature': signature },
  });
}

/** A snapshot with one pedido at the given freteInicial.estado/codRastreio. */
function pedidoSnap(estado: string, codRastreio: string | null = null) {
  return {
    docs: [
      {
        id: 'ped-1',
        data: () => ({ freteInicial: { estado, codRastreio, printLabelId: 'lbl-1' } }),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MELHOR_ENVIO_CLIENT_SECRET', SECRET);
  h.query.mockResolvedValue(pedidoSnap('aguardandoPostagem'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('meStatusToEstadoFrete', () => {
  it('maps the legacy ME statuses', () => {
    expect(meStatusToEstadoFrete('delivered')).toBe('entregue');
    expect(meStatusToEstadoFrete('posted')).toBe('postado');
    expect(meStatusToEstadoFrete('released')).toBe('postado');
    expect(meStatusToEstadoFrete('received')).toBe('postado');
    expect(meStatusToEstadoFrete('canceled')).toBe('cancelado');
    expect(meStatusToEstadoFrete('cancelled')).toBe('cancelado');
    expect(meStatusToEstadoFrete('suspended')).toBe('suspenso');
    expect(meStatusToEstadoFrete('paused')).toBe('suspenso');
    expect(meStatusToEstadoFrete('undelivered')).toBe('falhaNaEntrega');
    expect(meStatusToEstadoFrete('created')).toBeNull();
    expect(meStatusToEstadoFrete(null)).toBeNull();
  });
});

describe('POST /api/webhooks/melhor-envio', () => {
  it('returns 500 when the webhook secret is not configured', async () => {
    vi.stubEnv('MELHOR_ENVIO_CLIENT_SECRET', '');
    const res = await POST(req({ event: 'order.posted', data: { id: 'lbl-1' } }));
    expect(res.status).toBe(500);
  });

  it('returns 401 for a missing signature header', async () => {
    const raw = JSON.stringify({ event: 'order.posted', data: { id: 'lbl-1' } });
    const res = await POST(
      new Request('http://localhost:3005/api/webhooks/melhor-envio', {
        method: 'POST',
        body: raw,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(401);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('returns 401 for a signature from the wrong secret', async () => {
    const body = { event: 'order.posted', data: { id: 'lbl-1' } };
    const wrong = createHmac('sha256', 'not-the-secret').update(JSON.stringify(body)).digest('hex');
    const res = await POST(req(body, { sig: wrong }));
    expect(res.status).toBe(401);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('acks without writing for an unmapped event (no query)', async () => {
    const res = await POST(req({ event: 'order.created', data: { id: 'lbl-1' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(false);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('acks without writing when no pedido matches the label', async () => {
    h.query.mockResolvedValue({ docs: [] });
    const res = await POST(
      req({ event: 'order.posted', data: { id: 'unknown', status: 'posted' } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(false);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('updates estado + codRastreio when the status maps and differs', async () => {
    const res = await POST(
      req({ event: 'order.posted', data: { id: 'lbl-1', status: 'posted', tracking: 'ME9BR' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: true, estado: 'postado' });
    expect(h.update).toHaveBeenCalledWith({
      'freteInicial.estado': 'postado',
      'freteInicial.codRastreio': 'ME9BR',
    });
  });

  it('is idempotent — no write when the pedido is already in the target estado', async () => {
    h.query.mockResolvedValue(pedidoSnap('postado'));
    const res = await POST(req({ event: 'order.posted', data: { id: 'lbl-1', status: 'posted' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(false);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('persists codRastreio on a retry that adds tracking to an already-applied estado', async () => {
    h.query.mockResolvedValue(pedidoSnap('postado')); // estado matches, no codRastreio yet
    const res = await POST(
      req({ event: 'order.posted', data: { id: 'lbl-1', status: 'posted', tracking: 'ME9BR' } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).applied).toBe(true);
    // Only codRastreio is written — estado is unchanged.
    expect(h.update).toHaveBeenCalledWith({ 'freteInicial.codRastreio': 'ME9BR' });
  });

  it('derives the status from the event suffix when data.status is absent', async () => {
    h.query.mockResolvedValue(pedidoSnap('postado'));
    const res = await POST(req({ event: 'order.delivered', data: { id: 'lbl-1' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).estado).toBe('entregue');
    expect(h.update).toHaveBeenCalledWith({ 'freteInicial.estado': 'entregue' });
  });
});
