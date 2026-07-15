import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// The receiver enqueues via the task scheduler and (only on enqueue failure)
// persists via the admin handle. Mock the scheduler + admin + collections so the
// route's own logic (signature, parse, enqueue, fallback, ack) runs real.
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown) => {}),
  create: vi.fn(async () => {}),
  docRef: vi.fn(),
  parse: vi.fn((f: unknown) => f),
  newDocId: vi.fn(() => 'auto-id'),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('@/lib/payments/mpTasks', () => ({
  createMpTaskScheduler: () => ({ enqueue: h.enqueue }),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  notificacaoMercadoPagoCollection: {
    docRef: (...args: unknown[]) => {
      h.docRef(...args);
      return { create: h.create };
    },
    parse: h.parse,
    newDocId: h.newDocId,
  },
  metodoPagamentoCollection: {},
  credenciaisMetodoPgtoCollection: {},
}));

const { POST } = await import('./route');

const WEBHOOK_SECRET = 'mp-webhook-secret';
const TS = '1700000000';

function signature(dataId: string, requestId: string, secret: string): string {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${TS};`;
  const v1 = createHmac('sha256', secret).update(manifest).digest('hex');
  return `ts=${TS},v1=${v1}`;
}

function req(
  body: unknown,
  opts: { dataId?: string; headers?: Record<string, string> } = {},
): Request {
  const url = new URL('http://localhost:3007/api/webhooks/mercado-pago');
  if (opts.dataId) url.searchParams.set('data.id', opts.dataId);
  return new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const paymentBody = (over: Record<string, unknown> = {}) => ({
  id: 'notif-1',
  type: 'payment',
  live_mode: true,
  user_id: 55,
  data: { id: 987 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/webhooks/mercado-pago', () => {
  it('enqueues a well-formed payment notification and acks 200 without a Firestore write', async () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', ''); // signature skipped
    const res = await POST(req(paymentBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(h.enqueue).toHaveBeenCalledOnce();
    // the lean payload is enqueued
    expect(h.enqueue.mock.calls[0]![0]).toMatchObject({
      id: 'notif-1',
      paymentId: '987',
      topic: 'payment',
      collectorUserId: 55,
      liveMode: true,
    });
    expect(h.create).not.toHaveBeenCalled(); // happy path writes nothing
  });

  it('acks without enqueuing on noise (missing topic/id) and on bad JSON', async () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', '');
    const noise = await POST(req({ type: 'payment' })); // no payment id
    expect(noise.status).toBe(200);
    expect(await noise.json()).toEqual({ received: true });
    expect((await POST(req('{not json'))).status).toBe(200);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('falls back to persisting the notification as failed when the enqueue fails, still acks 200', async () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', '');
    h.enqueue.mockRejectedValueOnce(new Error('permission denied on cloudtasks.enqueue'));
    const res = await POST(req(paymentBody({ id: 'notif-9' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.parse.mock.calls[0]![0]).toMatchObject({ id: 'notif-9', status: 'failed' });
  });

  it('propagates a 5xx only when BOTH the enqueue and a TRANSIENT persist fallback fail', async () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', '');
    h.enqueue.mockRejectedValueOnce(new Error('enqueue down'));
    h.create.mockRejectedValueOnce(new Error('firestore down'));
    await expect(POST(req(paymentBody()))).rejects.toThrow('firestore down');
  });

  it('drops (acks 200, never 5xx-loops) when the enqueue fails and the persist is a deterministic validation error', async () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', '');
    const { ZodError } = await import('zod');
    h.enqueue.mockRejectedValueOnce(new Error('enqueue down'));
    h.parse.mockImplementationOnce(() => {
      throw new ZodError([]);
    });
    const res = await POST(req(paymentBody()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  /* ------------------------------- signature ----------------------------- */

  it('accepts and enqueues when a valid x-signature is present and the secret is set', async () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    const res = await POST(
      req(paymentBody(), {
        dataId: '987',
        headers: {
          'x-signature': signature('987', 'rid-1', WEBHOOK_SECRET),
          'x-request-id': 'rid-1',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledOnce();
  });

  it('rejects with 401 (no enqueue) when the secret is set and the signature is invalid', async () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    const res = await POST(
      req(paymentBody(), {
        dataId: '987',
        headers: { 'x-signature': `ts=${TS},v1=deadbeef`, 'x-request-id': 'rid-1' },
      }),
    );
    expect(res.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the secret is set but the x-signature header is absent', async () => {
    vi.stubEnv('MERCADO_PAGO_WEBHOOK_SECRET', WEBHOOK_SECRET);
    const res = await POST(req(paymentBody(), { dataId: '987' }));
    expect(res.status).toBe(401);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
