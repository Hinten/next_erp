/**
 * The Cloud Tasks hop, end to end, against the real emulators.
 *
 * #823 listed "any Cloud Tasks path" among the things CI had never executed, and
 * the first cut of this lane documented it as unfixable — wrongly. A `tasks`
 * emulator does exist, and the URI-format bug that would have blocked us
 * (`firebase-admin-node#2725`, where the emulator 404'd
 * `locations/<region>/functions/<name>`) was fixed in firebase-admin 12.7.0. This
 * repo pins 14.2.0, so the region-qualified name that production requires is also
 * the one the emulator resolves. No production code changed for this test.
 *
 * What runs for real here, with nothing mocked:
 *
 *   POST /api/webhooks/mercado-livre        the real route + origin gate
 *     → createMlTaskScheduler().enqueue()   the real region-qualified queue name
 *     → Cloud Tasks emulator → Functions emulator
 *     → processMercadoLivreNotification     the real deployed onTaskDispatched
 *     → handleNotificationTask → processNotificationPayload
 *     → resolveIntegracaoByUserId → no-account → defer
 *     → a real `deferred` doc in notificacoesMercadoLivre
 *
 * ⚠️ Why a seller with NO integração: that outcome returns at
 * `notificacao.ts`'s `if (!integracaoId) return { kind: 'no-account' }`, BEFORE
 * `isKnownTopic` and before any import runner is invoked. So the path needs no ML
 * API call, no token refresh and no real secret, and — the reason it is viable at
 * all — it executes only classic Firestore reads/writes. The Pipelines API does
 * not run in the emulator, and `bulkEstoquePlan.ts` (this app's only user of it)
 * is bundled into the same `index.js` but never executed on this path. Bundling
 * is not executing.
 *
 * ⚠️ NOT covered, and deliberately not asserted: the 10s `scheduleDelaySeconds`
 * the receiver sets for the order-family topics. The emulator's dispatch loop is
 * pure FIFO with no `scheduleTime` predicate (`firebase-tools#8254`, open —
 * triaged upstream as a feature request). `mlTasks.test.ts` pins that option
 * statically instead. This test uses a topic with NO delay so it never depends on
 * the broken behaviour.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { __resetWebhookHeaderLog } from '@/lib/marketplace/webhookOrigin';

import { POST } from './route';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesMercadoLivre';
const APP_ID = 2_069_392_825_111_111;

function db() {
  return getAdminFirestore();
}

/**
 * Poll for the document the DISPATCHED function writes. The task travels
 * receiver → tasks emulator → functions emulator → handler, so there is no
 * promise to await — only the effect. `emulators:exec` tears the suite down as
 * soon as the script exits, so waiting on the effect (rather than a fixed sleep)
 * is also what keeps an in-flight dispatch from being killed.
 */
async function waitForDoc(
  docId: string,
  timeoutMs = 45_000,
): Promise<FirebaseFirestore.DocumentData> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db().collection(NOTIF).doc(docId).get();
    if (snap.exists) return snap.data()!;
    if (Date.now() > deadline) {
      const all = await db().collection(NOTIF).get();
      throw new Error(
        `notification ${docId} never arrived within ${timeoutMs}ms. ` +
          `Collection holds ${all.size} doc(s): ${all.docs.map((d) => d.id).join(', ') || '<empty>'}. ` +
          `A silent drop here is the us-central1 hazard mlTasks.ts warns about — check ` +
          `that MERCADO_LIVRE_TASKS_REGION matches the FUNCTIONS_REGION inlined into the bundle.`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeEach(async () => {
  __resetWebhookHeaderLog();
  vi.unstubAllEnvs();
  // NOT setting MERCADO_LIVRE_TASKS_DISABLED — the whole point is that the real
  // scheduler runs. Pin the origin gate so the test owns its own outcome.
  vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', String(APP_ID));

  const refs = await db().collection(NOTIF).listDocuments();
  await Promise.all(refs.map((r) => r.delete()));
});

describe.skipIf(!EMULATED || !TASKS)('ML webhook → Cloud Tasks → onTaskDispatched', () => {
  it('enqueues on the real region-qualified queue and the dispatched function writes Firestore', async () => {
    // A seller nobody has connected. Unique per run: the ML `_id` becomes the
    // Firestore doc id AND the payload identity, and a repeated task name inside
    // one emulator session is rejected 409.
    const id = `N${randomUUID().replace(/-/g, '')}`;
    const body = {
      _id: id,
      // `stock-location` is a known topic with NO refetch delay, so this test
      // never leans on `scheduleDelaySeconds` (broken in the emulator).
      resource: `/user-products/${Math.floor(Math.random() * 1e12)}/stock`,
      topic: 'stock-location',
      user_id: 7_000_000 + Math.floor(Math.random() * 1e6),
      application_id: APP_ID,
      attempts: 1,
      sent: '2026-08-13T16:19:20.129Z',
      received: '2026-08-13T16:19:20.106Z',
    };

    const res = await POST(
      new Request('http://localhost:3006/api/webhooks/mercado-livre', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    // The receiver acks fast and writes NOTHING on the happy path — the enqueue
    // succeeding is precisely why there is no failure document here.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: true });

    // …and then the task actually lands. This is the assertion the whole lane is
    // for: it can only pass if the region-qualified queue name resolved, the
    // tasks emulator dispatched to the functions emulator, and the REAL
    // `processMercadoLivreNotification` ran `handleNotificationTask` against a
    // real Firestore.
    const doc = await waitForDoc(id);
    expect(doc).toMatchObject({
      resource: body.resource,
      topic: body.topic,
      user_id: body.user_id,
      // No integração exists for this seller, so #808's deferred lane claims it
      // rather than burning the hourly retries.
      status: 'deferred',
      tentativas: 0,
    });
    // The reason the handler wrote embeds the seller id it looked up, so this
    // also proves the payload survived the queue hop intact rather than arriving
    // as an empty or default-filled task.
    expect(String(doc.erro)).toContain(String(body.user_id));
    // Stamped by the handler inside the emulator, not by this process.
    expect(doc.processedAt).toBeGreaterThan(0);
  });
});
