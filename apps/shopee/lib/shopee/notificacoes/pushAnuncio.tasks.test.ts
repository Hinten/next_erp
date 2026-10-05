/**
 * The step-11 listing arm through the Cloud Tasks hop, end to end, against the
 * real emulators (`ci-shopee.yml`) — the THIRD `*.tasks.test.ts` of this
 * codebase and the second to drive the NOTIFICATION queue.
 *
 * What runs for real here, with nothing mocked:
 *
 *   POST /api/webhooks/shopee               the real route + the real push HMAC
 *     → createShopeeTaskScheduler().enqueue()  the real region-qualified queue
 *     → Cloud Tasks emulator → Functions emulator
 *     → processShopeeNotification           the real deployed onTaskDispatched
 *     → handleNotificationTask → processNotificationPayload
 *     → DISPATCH[16] === 'anuncio'          the seventh DestinoPush
 *     → await import('../anuncios/pushAnuncio')   the PARSER, resolved for real
 *     → findIntegracaoByShopId → null       ⇒ `sem-conta` ⇒ defer
 *     → a real `deferred` doc in notificacoesShopee
 *
 * ⚠️ NO new job, NO new check name, NO new row in the gate manifest.
 * `vitest.tasks.config.ts:19` includes every `.tasks.test.ts` under `app/`,
 * `lib/` and `functions/`, so this file joins the ONE existing `Shopee Cloud
 * Tasks round trip` job by its suffix alone — and `vitest.config.ts:42` excludes
 * that suffix, so `ci.yml`'s `CI test` does not try to run it offline.
 *
 * ⚠️ Why an unmapped shop, and why that is the ONLY code-16 case that can live
 * here. Every other code-16 path reaches `tratarPushDeAnuncio`, which re-reads
 * `get_item_base_info` and (on a real violation) pulls
 * `get_item_violation_info` — two Shopee calls. The lane's non-localhost `fetch`
 * kill-switch lives in the VITEST process and does NOT cover the dispatched
 * function, which runs in the emulator's own process (`vitest.tasks.setup.ts`
 * (4)), so either call would really leave the runner. A shop that maps to no
 * ACTIVE integração is refused by `findIntegracaoByShopId` before the handler is
 * ever invoked: no token, no secret, no client — zero Shopee calls by CALL
 * ORDER, not by a mock. And the outcome still PERSISTS, so the assertion is
 * about a document the dispatched function wrote, not about the absence of one.
 *
 * What it proves that no unit test can, in three layers:
 *
 *   (a) the DISPATCHED BUNDLE really carries `DISPATCH[16] = 'anuncio'`. Code 16
 *       had a `MOTIVO_PARADO` row before step 11, so a stale artifact PARKS this
 *       delivery where a current one defers it — `parked` ≠ `deferred` is the
 *       whole assertion. `notificacao.test.ts` can only prove the table in THIS
 *       process.
 *   (b) the dynamic `import('../anuncios/pushAnuncio')` really RESOLVES inside
 *       the built artifact. ⚠️ This is STRONGER than the design's own note,
 *       which said the lazy import "never even fires" on this path — that is
 *       true of the FRETE arm, whose conta resolution precedes its import, and
 *       false here: the anúncio arm imports the PARSER (`alvoDoPushDeAnuncio`)
 *       BEFORE `findIntegracaoByShopId`, so `anuncios/pushAnuncio.ts`'s entire
 *       static graph — `@delfrance/schemas`, `@delfrance/data/admin/collections`
 *       and `avisoAnuncio.ts`'s µs seam — is loaded for real in the functions
 *       process. A bundle that failed to carry that chunk THROWS at the import
 *       instead of deferring, which lands as `failed` with `tentativas`
 *       climbing — never as `deferred` / `tentativas: 0`.
 *   (c) the `sem-conta` defer survives the queue hop as a `deferred` row rather
 *       than a `failed` one. `failed` is the RECEIVER's own enqueue fallback,
 *       and that is exactly what a region mismatch looks like in the emulator
 *       (#1108) — see the note on the assertion below.
 *
 * ⚠️ NOT covered, and deliberately not asserted:
 *   - the handler itself. `tratarPushDeAnuncio` is never CALLED here (the lazy
 *     dep arrow in `defaultProcessDeps` never runs), by construction: calling it
 *     is what would cost a Shopee call. Its behaviour is pinned offline in
 *     `pushAnuncio.test.ts`, and the arm's wiring in `notificacao.test.ts`.
 *   - the HMAC. The signature below comes from the same helper the route
 *     verifies with, so a bug in it would cancel out; `guide 18`'s vectors are
 *     pinned offline in `notificacoes/pushSignature.test.ts`. This file proves
 *     the QUEUE HOP.
 *   - `retryConfig` / `rateLimits` / any `scheduleDelaySeconds`. Emulated or
 *     ignored (firebase-tools#8254), and cheaper to assert off `__endpoint` —
 *     `functions/src/processNotification.test.ts` does that.
 *   - the identity residual: two violation pushes about one `item_id` in the
 *     same second derive ONE doc id. Stated, not fixed — `identidadeDoPush`'s
 *     `16|22|27|7|8|9` row is shared with five other codes and code 16's
 *     `update_time` is per-detail, so there is nothing to lift. A fresh random
 *     shop per run is what keeps two runs inside one emulator session apart.
 *
 * ⚠️ The clock. This file reads the wall clock for exactly three TEST-LOCAL
 * purposes: the envelope stamp it signs, the two wire stamps inside the fixture
 * detail row, and the poll's own deadline. None is a production clock read — the
 * `anuncios/` folder reads no clock at all (`nowMs` is always a parameter), and
 * `statusAnuncio.test.ts`'s folder-discipline grep skips every `*.test.ts`,
 * which is why the name may appear here and in no source beside it.
 *
 * ⚠️ Fixture ids only, and none of them is real: the partner/shop credentials in
 * the job env are invented, the shop is a random `9xxxxx` that maps to nothing,
 * and `2500139861` is the step-11 fixture item id. There is NO `integracao`
 * seed at all — the absence of one IS the case.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { POST, __resetContadorDeEntregasParaTestes } from '../../../app/api/webhooks/shopee/route';
import { getAdminFirestore } from '../../firebase/admin';
import { shopeeConfig, shopeePushCallbackUrl } from '../env';
import { expectedPushSignature } from './pushSignature';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
/** The tasks emulator is the half this suite exists for — gate on it too. */
const TASKS = Boolean(process.env.CLOUD_TASKS_EMULATOR_HOST);

const NOTIF = 'notificacoesShopee';

/** `push_api_id 18` — `violation_item_push`. The step-11 arm's first code. */
const CODE_VIOLACAO = 16;

/** The step-11 fixture item id. Not a real listing. */
const ITEM_ID = 2500139861;

function db() {
  return getAdminFirestore();
}

/**
 * Poll for the document the DISPATCHED function writes.
 *
 * Verbatim the precedent's shape (`app/api/webhooks/shopee/route.tasks.test.ts`)
 * and for its reasons: the task travels receiver → tasks emulator → functions
 * emulator → handler, so there is no promise to await, only the effect — and
 * `emulators:exec` tears the suite down the moment the script exits, so waiting
 * on the effect is also what keeps an in-flight dispatch from being killed.
 *
 * ⚠️ Returning at all is this suite's POSITIVE existence assertion, which
 * `vitest.tasks.setup.ts` (3) requires of it: in the emulator a mis-targeted
 * `(default)` database silently auto-creates, so every "not found" / "empty"
 * assertion in this lane would pass against the wrong namespace. Only a row that
 * really exists proves the suite and the dispatched function met in one.
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
          'documento — ver a nota sobre `parked` e `failed` na asserção abaixo.',
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

describe.skipIf(!EMULATED || !TASKS)(
  'push de anúncio Shopee → Cloud Tasks → onTaskDispatched',
  () => {
    it('um code 16 de loja não mapeada ADIA — a função despachada grava `deferred`, sem chamar a Shopee', async () => {
      // Unique per run: the doc id is derived from the payload (Shopee ships no
      // event id), so a fresh shop id keeps two runs inside one emulator session
      // from colliding on the same row.
      const shopId = 900_000 + Math.floor(Math.random() * 90_000);
      // SECONDS on the wire — the receiver normalises to ms, which is what lands
      // in the doc id and in the stored `timestamp`.
      const timestampSegundos = Math.floor(Date.now() / 1000);

      // ⚠️ The body is a POINTER, not a payload, and this delivery is where that
      // shows: every field below travels and NONE of it decides anything.
      // `item_status: 'BANNED'` is never read as the status (the handler re-reads
      // `get_item_base_info`), and on this path the arm defers before even the
      // two detail readers are imported. The detail row exists only so the
      // delivery is the realistic shape `push 18` sends.
      const raw = JSON.stringify({
        code: CODE_VIOLACAO,
        shop_id: shopId,
        timestamp: timestampSegundos,
        data: {
          item_id: ITEM_ID,
          item_name: 'x',
          item_status: 'BANNED',
          deboost: false,
          item_status_details: [
            {
              violation_type: 'Spam',
              // Invented prose, not Shopee's and not a seller's: this suite
              // records no provider text.
              violation_reason: 'motivo de violação inventado para o teste',
              suggestion: 'sugestão inventada para o teste',
              // SECONDS on the wire, both of them.
              fix_deadline_time: timestampSegundos + 7 * 24 * 60 * 60,
              update_time: timestampSegundos,
            },
          ],
        },
      });

      // Signed with the SAME configuration the route reads, so a lane that
      // forgot SHOPEE_PUSH_CALLBACK_URL or SHOPEE_PARTNER_KEY fails here (or at
      // the 204 assertion below) instead of looking like a queue problem.
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
      // enqueues NOTHING, so the poll below would spend 45 seconds and then
      // blame the region — the one message that would send the reader to the
      // wrong place. `204` with an EMPTY body is also the only ack Shopee
      // counts.
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');

      // ⚠️ FOUR segments: code 16's entity is `<loja>:<item_id>` and its carimbo
      // is the ENVELOPE stamp, in MILLISECONDS. Code 16 carries no top-level
      // `update_time` (it is per violation detail), so `identidadeDoPush`'s
      // `16|22|27|7|8|9` row has no clock fallback to take and the doc id below
      // has to agree with that row or nothing is found.
      const docId = `${String(CODE_VIOLACAO)}:${String(shopId)}:${String(ITEM_ID)}:${String(
        timestampSegundos * 1000,
      )}`;
      const doc = await waitForDoc(docId);

      expect(doc).toMatchObject({
        code: CODE_VIOLACAO,
        shop_id: shopId,
        // ⚠️ `deferred` — and the two values it is NOT are what this row buys.
        //
        // `parked` means the dispatched bundle still routes code 16 to the
        // unbuilt-handler arm: a pre-step-11 artifact, whose `MOTIVO_PARADO`
        // still held rows for 16 and 27. That is the failure this whole file
        // exists for, and no offline test can see it.
        //
        // `failed` means the RECEIVER took its own enqueue fallback and the
        // queue hop never happened at all — the region mismatch of #1108, which
        // in the emulator surfaces in seconds (the tasks emulator refuses an
        // unknown queue) instead of the poll timing out. `failed` with
        // `tentativas` above zero would instead mean the dispatched function
        // THREW: on this path the only way to do that is the dynamic
        // `import('../anuncios/pushAnuncio')` failing to resolve in the built
        // artifact, which is layer (b) of the docblock.
        status: 'deferred',
        tentativas: 0,
      });
      // The shared, UNPREFIXED `sem-conta` reason, emitted verbatim by all four
      // arms that have one. It names the shop, which is what an operator acts
      // on: connect it. ⚠️ Deferring rather than acking is the point (C25) — a
      // deactivated conta still holds link documents, so a re-drive inside the
      // seven-day window lands the violation on a real produto.
      expect(String(doc.erro)).toContain(String(shopId));
      // Stamped by the handler inside the emulator, not by this process.
      expect(doc.processedAt).toBeGreaterThan(0);
    });
  },
);
