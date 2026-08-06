import { beforeEach, describe, expect, it, vi } from 'vitest';

// The receiver enqueues via the task scheduler and (only on enqueue failure)
// persists via the admin handle. Mock the scheduler + admin + collection so the
// route's own logic (parse, enqueue, fallback, ack) runs real.
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown, _opts?: { scheduleDelaySeconds?: number }) => {}),
  create: vi.fn(async () => {}),
  docRef: vi.fn(),
  parse: vi.fn((f: unknown) => f),
  newDocId: vi.fn(() => 'auto-id'),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/marketplace/mlTasks', () => ({
  createMlTaskScheduler: () => ({ enqueue: h.enqueue }),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  notificacaoMercadoLivreCollection: {
    docRef: (...args: unknown[]) => {
      h.docRef(...args);
      return { create: h.create };
    },
    parse: h.parse,
    newDocId: h.newDocId,
  },
  integracaoCollection: {},
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
  it('enqueues a well-formed notification and acks 200 without a Firestore write', async () => {
    const res = await POST(
      req({ _id: 'N1', resource: '/orders/123', topic: 'orders_v2', user_id: 55 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    expect(h.enqueue).toHaveBeenCalledOnce();
    // the lean payload is enqueued (no local resilience fields)
    expect(h.enqueue.mock.calls[0]![0]).toMatchObject({
      id: 'N1',
      resource: '/orders/123',
      topic: 'orders_v2',
      user_id: 55,
    });
    expect(h.create).not.toHaveBeenCalled(); // happy path writes nothing
  });

  it('refetch-delay topics (orders_v2/orders/payments/shipments/claims) enqueue with a 10s schedule delay', async () => {
    await POST(req({ _id: 'N2', resource: '/orders/2', topic: 'orders_v2', user_id: 1 }));
    expect(h.enqueue.mock.calls[0]![1]).toEqual({ scheduleDelaySeconds: 10 });

    h.enqueue.mockClear();
    await POST(req({ _id: 'N3', resource: '/payments/3', topic: 'payments', user_id: 1 }));
    expect(h.enqueue.mock.calls[0]![1]).toEqual({ scheduleDelaySeconds: 10 });

    h.enqueue.mockClear();
    await POST(req({ _id: 'N3c', resource: '/claims/4', topic: 'claims', user_id: 1 }));
    expect(h.enqueue.mock.calls[0]![1]).toEqual({ scheduleDelaySeconds: 10 });
  });

  it('non-refetch-delay topics (items, and items_prices since #803) enqueue with no schedule delay', async () => {
    await POST(req({ _id: 'N4', resource: '/items/MLB1', topic: 'items', user_id: 1 }));
    expect(h.enqueue.mock.calls[0]![1]).toBeUndefined();

    // #803 removed the items_prices handler; with no GET to race, the delay
    // only postponed an ack-and-drop.
    h.enqueue.mockClear();
    await POST(
      req({ _id: 'N4b', resource: '/items/MLB1/prices', topic: 'items_prices', user_id: 1 }),
    );
    expect(h.enqueue.mock.calls[0]![1]).toBeUndefined();
  });

  it('acks without enqueuing on noise (missing topic/resource) and on bad JSON', async () => {
    const noise = await POST(req({ topic: 'orders_v2' }));
    expect(noise.status).toBe(200);
    expect(await noise.json()).toMatchObject({ accepted: false });
    expect((await POST(req('{not json'))).status).toBe(200);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('falls back to persisting the notification as failed when the enqueue fails, still acks 200', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('permission denied on cloudtasks.enqueue'));
    const res = await POST(
      req({ _id: 'N9', resource: '/orders/9', topic: 'orders_v2', user_id: 1 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.parse.mock.calls[0]![0]).toMatchObject({ id: 'N9', status: 'failed' });
  });

  it('propagates a 5xx only when BOTH the enqueue and a TRANSIENT persist fallback fail', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('enqueue down'));
    h.create.mockRejectedValueOnce(new Error('firestore down'));
    await expect(
      POST(req({ _id: 'N7', resource: '/orders/7', topic: 'orders_v2', user_id: 1 })),
    ).rejects.toThrow('firestore down');
  });

  it('drops (acks 200, never 5xx-loops) when the enqueue fails and the persist is a deterministic validation error', async () => {
    const { ZodError } = await import('zod');
    h.enqueue.mockRejectedValueOnce(new Error('enqueue down'));
    h.parse.mockImplementationOnce(() => {
      throw new ZodError([]);
    });
    const res = await POST(
      req({ _id: 'N5', resource: '/orders/5', topic: 'orders_v2', user_id: 1 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: false });
  });
});
