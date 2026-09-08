/**
 * The Cloud Tasks hop, end to end, against the real emulators (`ci-shopee.yml`).
 *
 * What runs for real here, with nothing mocked:
 *
 *   POST /api/webhooks/shopee               the real route + the real push HMAC
 *     → createShopeeTaskScheduler().enqueue()  the real region-qualified queue
 *     → Cloud Tasks emulator → Functions emulator
 *     → processShopeeNotification           the real deployed onTaskDispatched
 *     → handleNotificationTask → processNotificationPayload
 *     → an UNKNOWN push_code → `park`
 *     → a real `parked` doc in notificacoesShopee
 *
 * ⚠️ Why an unknown four-digit code. Every other destino either writes nothing
 * (`ack`) or needs a Shopee call: the three conta arms (1 / 2 / 12) resolve a
 * shop against `integracao` and then sign a Public `get_shops_by_partner`, which
 * this lane's fetch kill-switch refuses on purpose. `desconhecido` reaches
 * `motivoDoParque` with no network, no seed and no credential, and it is the one
 * outcome that PERSISTS — so the assertion is about a document the dispatched
 * function wrote, not about the absence of one. Shopee's codes are one and two
 * digits, so a four-digit code cannot collide with a real one, today or after a
 * new code is added to the table.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - the HMAC itself. The signature below is produced by the same helper the
 *     route verifies with, so a bug in it would cancel out. `guide 18`'s vectors
 *     are pinned offline in `pushSignature.test.ts`; this file proves the QUEUE
 *     HOP.
 *   - `retryConfig` / `rateLimits`. Emulated, but cheaper to assert off
 *     `__endpoint` — `functions/src/processNotification.test.ts` does that.
 *   - any `scheduleDelaySeconds`. This channel sets none, and the emulator
 *     ignores it anyway (firebase-tools#8254).
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { shopeeConfig, shopeePushCallbackUrl } from '@/lib/shopee/env';
import { expectedPushSignature } from '@/lib/shopee/notificacoes/pushSignature';

import { POST, __resetContadorDeEntregasParaTestes } from './route';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesShopee';

/** Two digits at most on the wire; four cannot be a real Shopee push code. */
const CODIGO_DESCONHECIDO = 9137;

function db() {
  return getAdminFirestore();
}

/**
 * Poll for the document the DISPATCHED function writes.
 *
 * The task travels receiver → tasks emulator → functions emulator → handler, so
 * there is no promise to await, only the effect. A fixed sleep would be both
 * flaky and wrong in the other direction: `emulators:exec` tears the suite down
 * the moment the script exits, so waiting on the effect is also what keeps an
 * in-flight dispatch from being killed.
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
        `a notificação ${docId} não chegou em ${String(timeoutMs)}ms. ` +
          `A coleção tem ${String(all.size)} doc(s): ${all.docs.map((d) => d.id).join(', ') || '<vazia>'}. ` +
          'Nada chegar significa que o Cloud Tasks aceitou a tarefa e nunca a ' +
          'entregou — o descarte silencioso de região que shopeeTasks.ts descreve. ' +
          'Confira que SHOPEE_TASKS_REGION é igual ao FUNCTIONS_REGION embutido no ' +
          'bundle (.github/workflows/ci-shopee.yml define os dois com o mesmo valor) ' +
          'e que prepare-deploy.mjs rodou antes do emulators:exec. ' +
          '⚠️ Se o id ACIMA aparece na lista, o problema é outro: leia o `status` do ' +
          'documento — ver a nota sobre `failed` na asserção abaixo.',
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeEach(async () => {
  __resetContadorDeEntregasParaTestes();
  const refs = await db().collection(NOTIF).listDocuments();
  await Promise.all(refs.map((r) => r.delete()));
});

describe.skipIf(!EMULATED || !TASKS)('webhook Shopee → Cloud Tasks → onTaskDispatched', () => {
  it('enfileira na fila real e a função despachada grava o parked no Firestore', async () => {
    // Unique per run: the doc id is derived from the payload (Shopee ships no
    // event id), so a fresh shop id keeps two runs inside one emulator session
    // from colliding on the same row.
    const shopId = 900_000 + Math.floor(Math.random() * 90_000);
    // SECONDS on the wire — the receiver normalises to ms, which is what lands
    // in the doc id and in the stored `timestamp`.
    const timestampSegundos = Math.floor(Date.now() / 1000);
    const sonda = randomUUID();

    const raw = JSON.stringify({
      code: CODIGO_DESCONHECIDO,
      shop_id: shopId,
      timestamp: timestampSegundos,
      data: { sonda },
    });

    // Signed with the SAME configuration the route reads, so a lane that forgot
    // SHOPEE_PUSH_CALLBACK_URL or SHOPEE_PARTNER_KEY fails here (or at the 204
    // assertion below) instead of looking like a queue problem.
    const assinatura = expectedPushSignature(raw, {
      partnerKey: shopeeConfig().partnerKey,
      callbackUrl: shopeePushCallbackUrl(),
    });

    const res = await POST(
      new Request('http://localhost:3009/api/webhooks/shopee', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: assinatura },
        body: raw,
      }),
    );

    // ⚠️ ASSERTED BEFORE ANY POLLING, and that order is the point. A 503 (no
    // callback url / no partner key) or a 401 (the wrong url string signed)
    // enqueues NOTHING, so the poll below would spend 45 seconds and then blame
    // the region — the one message that would send the reader to the wrong
    // place. `204` with an EMPTY body is also the only ack Shopee counts.
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    // …and then the task actually lands. This is the assertion the whole lane is
    // for: it can only pass if the region-qualified queue name resolved, the
    // tasks emulator dispatched to the functions emulator, and the REAL
    // `processShopeeNotification` ran `handleNotificationTask` against a real
    // Firestore.
    const docId = `${String(CODIGO_DESCONHECIDO)}:${String(shopId)}:-:${String(timestampSegundos * 1000)}`;
    const doc = await waitForDoc(docId);

    expect(doc).toMatchObject({
      code: CODIGO_DESCONHECIDO,
      shop_id: shopId,
      // SECONDS in, MILLISECONDS stored — the receiver's `* 1000` survived the
      // hop rather than the handler re-deriving it.
      timestamp: timestampSegundos * 1000,
      // ⚠️ `parked` is doing TWO jobs, and the second is why this row is not
      // redundant with the doc simply existing.
      //
      // (a) An unbuilt handler PARKS (terminal, visible); it never defers,
      //     which would burn the daily re-drives on a code no one will handle.
      // (b) `parked` is written by the DISPATCHED FUNCTION. `failed` is written
      //     by the RECEIVER's fallback when the enqueue itself threw — and that
      //     is exactly what a region mismatch looks like in the emulator, where
      //     the tasks emulator refuses an unknown queue instead of accepting
      //     and dropping it the way production does (#1108). MEASURED: with the
      //     bundle on us-east1 and the enqueuer on us-central1 this assertion
      //     fails with `status: 'failed'`, in seconds, instead of the poll
      //     timing out. So the same run distinguishes "the queue hop worked"
      //     from "the receiver quietly took its own fallback".
      status: 'parked',
      tentativas: 0,
    });
    // `data` survived the queue hop intact rather than arriving empty or
    // default-filled.
    expect(doc.data).toEqual({ sonda });
    // The parked reason names the code, so an operator reading the dead-letter
    // row learns which push_code appeared.
    expect(String(doc.erro)).toContain(String(CODIGO_DESCONHECIDO));
    // Stamped by the handler inside the emulator, not by this process.
    expect(doc.processedAt).toBeGreaterThan(0);
  });
});
