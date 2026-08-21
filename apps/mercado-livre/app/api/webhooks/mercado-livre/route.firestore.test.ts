/**
 * The Mercado Livre webhook receiver against a REAL Firestore.
 *
 * The sibling `route.test.ts` mocks Firestore out entirely —
 * `vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: () => ({}) }))`
 * plus a three-method stub of the collection handle. It proves the route CALLS
 * something; it cannot prove a document lands. This file closes exactly that
 * gap, and is the acceptance criterion of #823 ("the receiver ... exercised
 * against a real Firestore").
 *
 * The enqueue path is driven through `MERCADO_LIVRE_TASKS_DISABLED=1`, which is
 * a PRODUCTION valve (sweep-only mode), not a test hook: it makes `enqueue()`
 * throw `MlTasksDisabledError`, which the route catches and routes into its real
 * fallback-persist branch through the real `getAdminFirestore()`. Nothing here
 * is mocked.
 *
 * ⚠️ This file covers the enqueue-OUTAGE path. The Cloud Tasks HAPPY path is
 * covered too, by `route.tasks.test.ts` under the sibling `test:tasks` lane —
 * it needs the functions + tasks emulators and a built functions artifact, which
 * is why the two are separate suites rather than one.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { __resetWebhookOriginState } from '@/lib/marketplace/notificacoes/webhookOrigin';

import { POST } from './route';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const NOTIF = 'notificacoesMercadoLivre';
/** Must match the body's `application_id`, or the origin gate 403s before any write. */
const APP_ID = 2_069_392_825_111_111;

function db() {
  return getAdminFirestore();
}

function req(body: unknown): Request {
  return new Request('http://localhost:3006/api/webhooks/mercado-livre', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function notification(over: Record<string, unknown> = {}) {
  return {
    _id: `N${randomUUID().replace(/-/g, '')}`,
    resource: `/orders/${Math.floor(Math.random() * 1e12)}`,
    topic: 'orders_v2',
    user_id: 468_424_240,
    application_id: APP_ID,
    attempts: 1,
    sent: '2026-08-11T16:19:20.129Z',
    received: '2026-08-11T16:19:20.106Z',
    ...over,
  };
}

beforeEach(async () => {
  __resetWebhookOriginState();
  vi.unstubAllEnvs();
  // Sweep-only mode: the real valve, read at call time inside
  // `createMlTaskScheduler()`, so stubbing it here reaches the route.
  vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '1');
  // Pin the origin gate rather than letting it fail open — a test must not
  // depend on an env var it does not own.
  vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', String(APP_ID));

  const refs = await db().collection(NOTIF).listDocuments();
  await Promise.all(refs.map((r) => r.delete()));
});

describe.skipIf(!EMULATED)('POST /api/webhooks/mercado-livre (Firestore emulator)', () => {
  it('persists a real failure document when the enqueue valve is closed, and still acks 200', async () => {
    const body = notification();

    const res = await POST(req(body));

    // ⚠️ `expect(res.status).toBe(200)` alone is VACUOUS here: the route returns
    // 200 from four places (unparseable JSON, a null parse, the ZodError drop,
    // and success), and `{ ok: true }` is common to all of them. `accepted` is
    // the only discriminator in the response — it is false on the three
    // do-nothing branches.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });

    const doc = await db().collection(NOTIF).doc(body._id).get();
    expect(doc.exists).toBe(true);

    const data = doc.data()!;
    expect(data).toMatchObject({
      resource: body.resource,
      topic: body.topic,
      user_id: body.user_id,
      status: 'failed',
      tentativas: 0,
    });
    // The string that separates "took the disabled-valve branch" from "tried a
    // real Cloud Tasks enqueue, failed on missing credentials, and persisted
    // anyway". Without it the test passes via a slow, network-dependent path
    // that proves something else entirely.
    expect(data.erro).toContain('MERCADO_LIVRE_TASKS_DISABLED=1');
    expect(data.erro).toContain('enqueue falhou');
    // `sent`/`received` arrive as ISO strings on the wire and must reach
    // Firestore as epoch millis, or the strict write parse would have rejected
    // the doc outright.
    expect(typeof data.sent).toBe('number');
    expect(data.processedAt).toBeGreaterThan(0);
  });

  it('a redelivery of the same notification id collapses onto ONE document', async () => {
    const body = notification();

    const first = await POST(req(body));
    const second = await POST(req(body));

    expect(await first.json()).toEqual({ ok: true, accepted: true });
    // ML redelivers for an hour; the ack must stay 200 either way or the topic
    // gets disabled.
    expect(await second.json()).toEqual({ ok: true, accepted: true });

    const snap = await db().collection(NOTIF).get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0]?.id).toBe(body._id);
  });

  it('a foreign application_id is rejected 403 BEFORE anything is written', async () => {
    const res = await POST(req(notification({ application_id: 1 })));

    expect(res.status).toBe(403);
    const snap = await db().collection(NOTIF).get();
    expect(snap.empty).toBe(true);
  });
});
