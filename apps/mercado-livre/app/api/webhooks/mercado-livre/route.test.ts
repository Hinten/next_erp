import { beforeEach, describe, expect, it, vi } from 'vitest';

// The receiver persists blind via the admin handle; mock the handle + admin so
// the route's own logic (parse, dedup doc id, ack) runs real.
const h = vi.hoisted(() => ({
  set: vi.fn(),
  docRef: vi.fn(),
  parse: vi.fn((f: unknown) => f),
  newDocId: vi.fn(() => 'auto-id'),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@delfrance/data/admin/collections', () => ({
  notificacaoMercadoLivreCollection: {
    docRef: (...args: unknown[]) => {
      h.docRef(...args);
      return { set: h.set };
    },
    parse: h.parse,
    newDocId: h.newDocId,
  },
}));

const { POST } = await import('./route');

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/webhooks/mercado-livre', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/webhooks/mercado-livre', () => {
  it('persists a well-formed notification keyed by _id and acks 200', async () => {
    const res = await POST(
      req({ _id: 'N1', resource: '/orders/123', topic: 'orders_v2', user_id: 55 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    // doc id = ML _id (natural dedup); the persisted body carries status pending
    expect(h.docRef).toHaveBeenCalledWith(expect.anything(), {}, 'N1');
    expect(h.set).toHaveBeenCalledOnce();
    expect(h.parse.mock.calls[0]![0]).toMatchObject({
      id: 'N1',
      resource: '/orders/123',
      topic: 'orders_v2',
      user_id: 55,
      status: 'pending',
    });
    expect(h.newDocId).not.toHaveBeenCalled();
  });

  it('mints an auto id when the notification carries no id', async () => {
    await POST(req({ resource: '/items/MLB1', topic: 'items' }));
    expect(h.newDocId).toHaveBeenCalledOnce();
    expect(h.docRef).toHaveBeenCalledWith(expect.anything(), {}, 'auto-id');
  });

  it('acks without persisting on noise (missing topic/resource) and on bad JSON', async () => {
    const noise = await POST(req({ topic: 'orders_v2' }));
    expect(noise.status).toBe(200);
    expect(await noise.json()).toMatchObject({ accepted: false });
    expect((await POST(req('{not json'))).status).toBe(200);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('propagates a persist failure (→ 5xx) so ML redelivers', async () => {
    h.set.mockRejectedValueOnce(new Error('firestore down'));
    await expect(
      POST(req({ _id: 'N2', resource: '/orders/9', topic: 'orders_v2', user_id: 1 })),
    ).rejects.toThrow('firestore down');
  });
});
