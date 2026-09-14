import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown) => {}),
  create: vi.fn(async () => {}),
  parse: vi.fn((value: unknown) => value),
  docRef: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminApp: () => ({ __app: true }),
  getAdminFirestore: () => ({ __db: true }),
}));

vi.mock('@/lib/freight/meTasks', () => ({
  createMelhorEnvioTaskScheduler: () => ({ enqueue: h.enqueue }),
  isMelhorEnvioEnqueueError: (err: unknown) => err instanceof Error,
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  notificacaoMelhorEnvioCollection: {
    parse: h.parse,
    docRef: (...args: unknown[]) => {
      h.docRef(...args);
      return { create: h.create };
    },
    newDocId: () => 'auto-id',
  },
  pedidoCollection: {},
}));

const { POST } = await import('./route');

const SECRET = 'me-webhook-secret';

function req(body: unknown, opts: { sig?: string; raw?: string } = {}): Request {
  const raw = opts.raw ?? JSON.stringify(body);
  const signature = opts.sig ?? createHmac('sha256', SECRET).update(raw).digest('hex');
  return new Request('http://localhost:3005/api/webhooks/melhor-envio', {
    method: 'POST',
    body: raw,
    headers: { 'content-type': 'application/json', 'x-me-signature': signature },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MELHOR_ENVIO_CLIENT_SECRET', SECRET);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/melhor-envio', () => {
  it('returns 500 when the webhook secret is not configured', async () => {
    vi.stubEnv('MELHOR_ENVIO_CLIENT_SECRET', '');
    const res = await POST(req({ event: 'order.posted', data: { id: 'lbl-1' } }));
    expect(res.status).toBe(500);
  });

  it('returns 401 for a missing or invalid signature', async () => {
    const raw = JSON.stringify({ event: 'order.posted', data: { id: 'lbl-1' } });
    const missing = await POST(
      new Request('http://localhost:3005/api/webhooks/melhor-envio', {
        method: 'POST',
        body: raw,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(missing.status).toBe(401);

    const invalid = await POST(req({}, { sig: 'deadbeef' }));
    expect(invalid.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('keeps invalid JSON as a deterministic 400', async () => {
    const raw = '{not-json';
    const res = await POST(req(null, { raw }));
    expect(res.status).toBe(400);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([null, { ping: true }])('acks irrelevant JSON without enqueueing', async (body) => {
    const res = await POST(req(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: true });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues a normalized payload and acks without a Firestore write', async () => {
    const res = await POST(
      req({
        event: 'order.posted',
        data: { id: 'lbl-1', status: 'posted', tracking: 'ME123BR' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: true });
    expect(h.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        labelId: 'lbl-1',
        event: 'order.posted',
        providerStatus: 'posted',
        tracking: 'ME123BR',
      }),
    );
    expect(h.create).not.toHaveBeenCalled();
  });

  it('persists for the sweep when enqueue fails and still acks', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('cloudtasks permission denied'));
    const res = await POST(req({ event: 'order.posted', data: { id: 'lbl-1', status: 'posted' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: true });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.parse.mock.calls[0]![0]).toMatchObject({
      labelId: 'lbl-1',
      providerStatus: 'posted',
      status: 'failed',
    });
  });

  it('propagates only when enqueue and transient persistence both fail', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('enqueue down'));
    h.create.mockRejectedValueOnce(new Error('firestore down'));
    await expect(
      POST(req({ event: 'order.posted', data: { id: 'lbl-1', status: 'posted' } })),
    ).rejects.toThrow('firestore down');
  });

  it('acks a deterministic validation failure in the fallback', async () => {
    const { ZodError } = await import('zod');
    h.enqueue.mockRejectedValueOnce(new Error('enqueue down'));
    h.parse.mockImplementationOnce(() => {
      throw new ZodError([]);
    });
    const res = await POST(req({ event: 'order.posted', data: { id: 'lbl-1', status: 'posted' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: true });
  });
});
