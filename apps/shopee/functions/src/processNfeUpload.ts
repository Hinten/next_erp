import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { ShopeeApiError } from '@delfrance/integrations-shopee';

import {
  NFE_SHOPEE_MAX_TENTATIVAS,
  SHOPEE_NFE_UPLOAD_QUEUE,
} from '../../lib/shopee/nfe/constantesNfe';
import { processarNfeShopee } from '../../lib/shopee/nfe/processarNfe';
import { codigoSeguro } from '../../lib/shopee/nfe/redacaoNfe';
import { createShopeeNfeUploadScheduler } from '../../lib/shopee/nfe/shopeeNfeUploadTasks';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/** The longest id the error line echoes — a Firestore document id, never text. */
const MAX_ID_NO_LOG = 128;

/**
 * `req.data[campo]` when it is a SAFE document id — a non-empty string of at
 * most {@link MAX_ID_NO_LOG} characters without `/` — else `undefined`. Not a
 * parse and no validity decision (the handler's schema owns both): it only lets
 * the error line name WHICH NF-e failed. Nothing else of the payload is read.
 */
function idSeguroDoPayload(dados: unknown, campo: 'pedidoId' | 'nfeId'): string | undefined {
  if (typeof dados !== 'object' || dados === null) return undefined;
  const valor = (dados as Record<string, unknown>)[campo];
  return typeof valor === 'string' &&
    valor.length > 0 &&
    valor.length <= MAX_ID_NO_LOG &&
    !valor.includes('/')
    ? valor
    : undefined;
}

/**
 * Cloud Tasks dispatcher for the Shopee NF-e XML upload (master plan step 14,
 * #1522) — the FIFTH queue of this codebase. The flow is
 * `lib/shopee/nfe/README.md`; this file is the queue's shape and the three
 * seams only the deployed dispatcher may supply.
 *
 * Its producers: the `onNfeAprovadaShopee` Firestore trigger and the handler's
 * own delayed re-enqueues (the SERPRO wait, the burst pause, the daily park,
 * the ~15-min recheck), all under the FUNCTIONS runtime SA, plus the
 * `/enviar-nfe` route under the App Hosting runtime SA — two identities. The
 * `enviar:nfe` CLI runs the handler IN-PROCESS and never enqueues.
 *
 * ⚠️ **The handler does everything else, ON PURPOSE.** `processarNfeShopee`
 * parses the payload itself (a `.strict()` schema; a refusal is ONE `error`
 * line naming field paths) and writes its OWN completion line — so this
 * dispatcher neither re-parses `req.data` nor logs a second line. A second
 * parse would be a second place deciding what a valid task is; a second line
 * would double every filter in the logs.
 *
 * ⚠️ **The clock is read HERE, once**, and handed down as `nowMs`: nothing
 * under `lib/shopee/nfe/` reads one (its discipline test).
 *
 * ⚠️ **`increment` must be the real `FieldValue.increment`** — the aviso
 * counter is tier 0 (rule 7), and a stub returning a number would turn
 * `ocorrencias` into a read-modify-write that loses a bump. **`jitterSec` is
 * where the randomness lives**: the handler's pauses add it so a fleet parked
 * on one limit does not resume on the same second.
 *
 * ⚠️ **A rethrown Shopee refusal never reaches the runtime log whole.** The
 * package formats a `ShopeeApiError`'s message as `Shopee <path> respondeu
 * <code> — <Shopee's sentence>`, and on THIS path that sentence may quote the
 * access key or the issuer's CNPJ. The runtime logs an uncaught error verbatim,
 * so the class that carries the provider's text — `ShopeeApiError` and its
 * three subclasses, the narrowest class that holds it — is caught, logged as
 * ONE line with the class name and the token-shaped code (the folder's ONE
 * gate, `nfe/redacaoNfe.ts`'s `codigoSeguro`), and replaced by a NEW error
 * whose message holds only those two (no `cause`: the runtime would print it).
 * Cloud Tasks still sees a failure and retries. Every other error — network,
 * HTTP, schema (whose messages are our own), Firestore, a bug — rethrows
 * untouched. On a non-final attempt the handler rethrows a transient WITHOUT a
 * line of its own, so this one is the attempt's only trace: it also names
 * `pedidoId` and `nfeId` when `req.data` holds them as safe document ids, and
 * nothing else of the payload.
 *
 * `retryConfig.maxAttempts` IS {@link NFE_SHOPEE_MAX_TENTATIVAS}: the handler
 * reads the same constant to decide that an attempt is the LAST one (and
 * finalizes a transient there instead of rethrowing), so the two can only
 * disagree if one stops naming it.
 *
 * ⚠️ `secrets` — the handler's P7 builds a Shop-signed client (whose HMAC uses
 * the PARTNER key) and the context load refreshes the shop token, so both
 * partner credentials must be bound; without them the conta arm throws
 * `ShopeeConfigError` and every delivery fails.
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST
 * equal {@link SHOPEE_NFE_UPLOAD_QUEUE}; `index.ts` asserts the pair at module
 * load. The hazard is the price job's: the handler re-enqueues onto this SAME
 * queue, so a half-rename breaks the SERPRO wait and the recheck while every
 * producer still reports success.
 */
export const processShopeeNfeUpload = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    //
    // ⚠️ TWO identities dispatch this one — the functions runtime SA (the
    // trigger and every self re-enqueue) and the App Hosting runtime SA (the
    // /enviar-nfe route). The list is AUTHORITATIVE: a deploy REPLACES both
    // bindings' members, so dropping either name breaks one leg invisibly.
    ...tasksInvokerOptions(),
    secrets: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'],
    // ⚠️ 120 — the stock push's number. The work's ceiling is three Shopee
    // round trips (the pre-read, the upload of ≤ 1 MiB, the read-back) plus a
    // handful of Firestore reads, and a budget far above that only hides a hung
    // dispatch for longer. It is also what keeps the ladder inside the
    // invariant `index.test.ts` pins for every queue here — `tentativas ×
    // timeout + (tentativas − 1) × maxBackoff ≤ 1800`: 4 × 120 + 3 × 300 = 1380.
    timeoutSeconds: 120,
    retryConfig: {
      maxAttempts: NFE_SHOPEE_MAX_TENTATIVAS,
      minBackoffSeconds: 60,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    // ⚠️ ONE dispatch at a time, and LITERAL (no deploy-shell knob, so
    // `tools/deploy-env/preflight.mjs` has nothing to print or drift-check).
    // It serialises every upload: a trigger task, a SERPRO re-enqueue and a
    // route re-drive of the same NF-e can never upload concurrently, so the
    // later one's pre-read runs after the earlier one's upload.
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    // ⚠️ No `region:` key: `options.ts` sets it globally from the build-time
    // inlined `FUNCTIONS_REGION`, and the enqueuer defaults to the same value. A
    // local override would let the two drift, and a queue path in the wrong
    // region drops every task while the enqueue still returns success (#1108).
  },
  async (req) => {
    const retryCount = req.retryCount ?? 0;
    try {
      // The handler logs its own completion line — see the module doc.
      await processarNfeShopee(
        {
          db: getDb(),
          scheduler: createShopeeNfeUploadScheduler(),
          // The dispatch's ONE clock read — see the module doc.
          nowMs: Date.now(),
          // The aviso counter seam — never a stub.
          increment: (by: number) => FieldValue.increment(by),
          // A pause's spread, an integer in [0, maxS] — see the module doc.
          jitterSec: (maxS: number) => Math.floor(Math.random() * (maxS + 1)),
          // `resolveClient` is DELIBERATELY absent: the handler's default builds
          // the SHOP client only after the conta gate passed.
        },
        // Verbatim — the handler parses it (see the module doc).
        req.data,
        retryCount,
      );
    } catch (err) {
      // Rule 6: the one package class whose message embeds Shopee's text (its
      // three subclasses included); everything else rethrows untouched.
      if (err instanceof ShopeeApiError) {
        const codigo = codigoSeguro(err.code);
        const pedidoId = idSeguroDoPayload(req.data, 'pedidoId');
        const nfeId = idSeguroDoPayload(req.data, 'nfeId');
        logger.error(
          '[shopee] envio de NF-e — recusa da Shopee relançada sem o texto do provedor',
          {
            queue: SHOPEE_NFE_UPLOAD_QUEUE,
            retryCount,
            ...(pedidoId !== undefined ? { pedidoId } : {}),
            ...(nfeId !== undefined ? { nfeId } : {}),
            classe: err.name,
            codigo,
            kind: err.kind,
          },
        );
        throw new Error(
          `[shopee] ${SHOPEE_NFE_UPLOAD_QUEUE}: ${err.name} ${codigo ?? '(código ilegível)'} ` +
            '— o texto da Shopee foi omitido deste erro.',
        );
      }
      throw err;
    }
  },
);
