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
  loggerInfo: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }));

vi.mock('firebase-functions/logger', () => ({ logger: { info: h.loggerInfo } }));

vi.mock('@/lib/marketplace/notificacoes/mlTasks', () => ({
  createMlTaskScheduler: () => ({ enqueue: h.enqueue }),
  // The receiver reports the region it targeted on every delivery line — that
  // field is the whole point of the log (a queue in the wrong region is the
  // silent drop `mlTasks.ts` warns about).
  mlTasksRegion: () => 'us-east1',
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
const { __resetWebhookOriginState } = await import('@/lib/marketplace/notificacoes/webhookOrigin');

/** Our registered ML application id, as `MERCADO_LIVRE_CLIENT_ID` would carry it. */
const APP_ID = 2069392825111111;

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3006/api/webhooks/mercado-livre', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The CLIENT_ID malformation warning is once-per-instance, so it leaks.
  __resetWebhookOriginState();
  vi.unstubAllEnvs();
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

  it('refetch-delay topics (orders/payments/shipments/claims/questions) enqueue with a 10s schedule delay', async () => {
    await POST(req({ _id: 'N2', resource: '/orders/2', topic: 'orders_v2', user_id: 1 }));
    expect(h.enqueue.mock.calls[0]![1]).toEqual({ scheduleDelaySeconds: 10 });

    h.enqueue.mockClear();
    await POST(req({ _id: 'N3', resource: '/payments/3', topic: 'payments', user_id: 1 }));
    expect(h.enqueue.mock.calls[0]![1]).toEqual({ scheduleDelaySeconds: 10 });

    h.enqueue.mockClear();
    await POST(req({ _id: 'N3c', resource: '/claims/4', topic: 'claims', user_id: 1 }));
    expect(h.enqueue.mock.calls[0]![1]).toEqual({ scheduleDelaySeconds: 10 });

    // ⚠️ #1322 — `post_purchase` is the spelling live traffic actually sends,
    // and it needs the delay MORE than the others: a claim's sub-resources
    // arrive as separate deliveries seconds apart (`…/actions-history`), so
    // the same claim is re-read several times and an unsettled first read
    // upserts an incidente from state ML has already moved past. Adding the
    // topic to TOPIC_DISPOSITION without adding it here would fail nothing.
    h.enqueue.mockClear();
    await POST(
      req({
        _id: 'N3p',
        resource: '/post-purchase/v1/claims/4',
        topic: 'post_purchase',
        user_id: 1,
      }),
    );
    expect(h.enqueue.mock.calls[0]![1]).toEqual({ scheduleDelaySeconds: 10 });

    // ⚠️ `questions` is load-bearing here and was NOT covered. The importer
    // reads `status`/`hold`/`suspected_spam` to decide whether a thread opens
    // at all, and ML's question GET is eventually consistent — without the
    // delay the first read can 404 or report a status that has not settled.
    // Dropping this entry would fail nothing else in the suite.
    h.enqueue.mockClear();
    await POST(req({ _id: 'N3q', resource: '/questions/5', topic: 'questions', user_id: 1 }));
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

  it('acks an IGNORED topic without enqueuing — the delivery never becomes a task (#813)', async () => {
    // The cost-saving half of the ignore list. The dispatch also drops these,
    // but only stopping here avoids paying for the enqueue, the function
    // invocation and the conta lookup — and `user-products-families` fires on
    // every family change for a User-Products seller.
    for (const topic of ['public_offers', 'public_candidates', 'user-products-families']) {
      h.enqueue.mockClear();
      const res = await POST(req({ _id: `ign-${topic}`, resource: '/x/1', topic, user_id: 1 }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accepted: false, ignored: true });
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    }
  });

  it('still enqueues an UNKNOWN topic, so a new ML topic parks and stays visible', async () => {
    await POST(req({ _id: 'N-new', resource: '/algo/1', topic: 'algum_topico_novo', user_id: 1 }));
    expect(h.enqueue).toHaveBeenCalledTimes(1);
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

// #811 — ML does not sign its notifications, so `application_id` is the only
// inbound origin check available. It must never be able to reject genuine
// traffic: ML disables a topic after ~1h of non-200 responses.
describe('POST /api/webhooks/mercado-livre — origin gate', () => {
  const notification = (application_id?: unknown) => ({
    _id: 'N10',
    resource: '/orders/10',
    topic: 'orders_v2',
    user_id: 55,
    ...(application_id === undefined ? {} : { application_id }),
  });

  it('refuses a foreign application_id with 403, without enqueuing or writing', async () => {
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', String(APP_ID));

    const res = await POST(req(notification(9999999999999)));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'application_id desconhecido' });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('enqueues when the application_id is ours', async () => {
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', String(APP_ID));

    const res = await POST(req(notification(APP_ID)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    expect(h.enqueue).toHaveBeenCalledOnce();
  });

  it('accepts a numeric-STRING application_id — the gate reads the raw body, not the payload', async () => {
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', String(APP_ID));

    const res = await POST(req(notification(` ${APP_ID} `)));

    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledOnce();
  });

  it('accepts (and warns about) a notification with no application_id', async () => {
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', String(APP_ID));

    const res = await POST(req(notification()));

    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('without application_id'));
  });

  it('fails OPEN when MERCADO_LIVRE_CLIENT_ID is unset — a misconfigured backend must not stall the stream', async () => {
    const res = await POST(req(notification(9999999999999)));

    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledOnce();
  });

  it('fails OPEN when MERCADO_LIVRE_CLIENT_ID is not a numeric application id', async () => {
    vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', 'not-an-id');

    const res = await POST(req(notification(9999999999999)));

    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledOnce();
  });

  it('acks 200 on an unparseable body, so ML stops retrying a body that will never parse', async () => {
    const res = await POST(req('not json'));

    expect(res.status).toBe(200);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

/**
 * The receiver is failures-only in Firestore, so before this log the SUCCESS
 * path was completely invisible: "delivered and enqueued" and "delivered and
 * deliberately ignored" produced the same empty collection and the same silent
 * log stream. These pin that every path now says which one it was.
 */
describe('POST /api/webhooks/mercado-livre — delivery log', () => {
  it('reports `enfileirado` with the queue and region on the happy path', async () => {
    const res = await POST(req({ topic: 'items', resource: '/items/MLB1' }));
    expect(res.status).toBe(200);
    expect(h.loggerInfo).toHaveBeenCalledWith(
      '[mercado-livre/webhook] entrega',
      expect.objectContaining({
        disposition: 'enfileirado',
        topic: 'items',
        resource: '/items/MLB1',
        regiao: 'us-east1',
      }),
    );
  });

  it('reports `ignorado` for a topic refused at the receiver (#813)', async () => {
    await POST(req({ topic: 'user-products-families', resource: '/user-products-families/1' }));
    expect(h.loggerInfo).toHaveBeenCalledWith(
      '[mercado-livre/webhook] entrega',
      expect.objectContaining({ disposition: 'ignorado', topic: 'user-products-families' }),
    );
  });

  it('reports `persistido` when the enqueue failed but the sweep now owns it', async () => {
    h.enqueue.mockRejectedValueOnce(new Error('IAM'));
    await POST(req({ topic: 'items', resource: '/items/MLB2' }));
    expect(h.loggerInfo).toHaveBeenCalledWith(
      '[mercado-livre/webhook] entrega',
      expect.objectContaining({ disposition: 'persistido' }),
    );
  });

  it('reports `ruido` for a body with no topic+resource', async () => {
    await POST(req({ hello: 'world' }));
    expect(h.loggerInfo).toHaveBeenCalledWith(
      '[mercado-livre/webhook] entrega',
      expect.objectContaining({ disposition: 'ruido', topic: null }),
    );
  });
});
