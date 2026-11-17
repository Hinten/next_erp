import { FieldValue } from 'firebase-admin/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import { LWA_CLIENT_SECRET_ENV } from '../../lib/amazon/env';
import {
  type DepsProcessarNfeAmazon,
  type RegistroNfeAmazon,
  type ResultadoNfeAmazon,
  processarNfeAmazon,
  registrarDespachoNfeAmazon,
} from '../../lib/amazon/nfe/processarNfe';
import { TENTATIVAS_NFE_AMAZON } from '../../lib/amazon/nfe/tarefaNfe';
import { sanitizarFalhaDaTarefaAmazon } from '../../lib/amazon/notificacoes/notificacao';
import { criarAgendadorAgendamentoAmazonDoAmbiente } from './agendadorAgendamento';
import { criarAgendadorNfeAmazonDoAmbiente } from './agendadorNfe';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The Secret Manager names the NF-e queue binds: the LWA client secret, read by
 * the context loader for the refresh once the read switch is on — the env
 * reader's own constant, so the binding and the read cannot drift apart.
 *
 * ⚠️ A declared secret missing from Secret Manager fails the WHOLE deploy
 * (window item W1 creates it before the functions deploy, W9).
 */
export const SEGREDOS_DO_ENVIO_NFE_AMAZON: readonly string[] = [LWA_CLIENT_SECRET_ENV];

/**
 * The dependencies of ONE NF-e dispatch, bound to the runtime — the one place
 * this codebase binds them:
 *
 * - `ambiente`: the process environment, WHOLE and live — the read switch
 *   (`AMAZON_CHAMADAS`), the LWA pair, the NF-e valve and canary
 *   (`AMAZON_MODO_NFE`, `AMAZON_CANARIO_NFE`), read per dispatch, never cached.
 * - `agendador`: the NF-e queue's producer for the handler's OWN re-enqueues
 *   (the verification ladder, the one resubmit, the 429 pause) — the functions
 *   codebase's NF-e composition root (`./agendadorNfe`), built only when one is
 *   due. UNNAMED enqueues: only the trigger names its task.
 * - `agendamento`: the Easy Ship scheduling queue's producer (step 15, PR
 *   15-c) for the step-15 seam's ONE enqueue on the `aceita` path (E1) — the
 *   functions codebase's scheduling root (`./agendadorAgendamento`), built
 *   only when the seam runs. NAMED after this dispatch's own task id.
 * - `increment`: a tier-0 `FieldValue` for the aviso counter.
 * - `logger`: the app's ONE logger. Never `firebase-functions`' logger, never
 *   `console.*`.
 */
export function depsDoEnvioNfeAmazon(registro: RegistroNfeAmazon): DepsProcessarNfeAmazon {
  return {
    ambiente: process.env,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    increment: (by: number) => FieldValue.increment(by),
    agendador: criarAgendadorNfeAmazonDoAmbiente,
    agendamento: criarAgendadorAgendamentoAmazonDoAmbiente,
    registro,
  };
}

/**
 * The Amazon NF-e queue (master plan step 14, PR 14-c; step-14 plan §3 decision
 * 9): ONE function — and so ONE Cloud Tasks queue, auto-provisioned and named
 * after it — for the upload of an Amazon Delivery-by-Amazon order's NF-e. Its
 * producers: the trigger `onNfeAprovadaAmazon` (one NAMED task per CloudEvent),
 * this handler's own re-enqueues (the verification ladder, the one resubmit, the
 * 429 pause — UNNAMED), and the App Hosting re-drive route
 * `POST /api/marketplace/amazon/enviar-nfe` (PR 14-d; UNNAMED too). The body
 * is `lib/amazon/nfe/processarNfe.ts` (P0–P12).
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal
 * `FILA_NFE_AMAZON` — the producers target that string. `index.ts` asserts the
 * pair at module load; rename both together, or every enqueue targets a queue
 * that does not exist (a silent drop).
 *
 * Options, each one deliberate (`index.test.ts` pins every value):
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`:
 *   Amazon's rate is per OPERATION (Delivery 1.133 rps), and a queue of its own
 *   keeps a stock run from starving invoices. ⚠️ `maxConcurrentDispatches: 1` is
 *   also THE ORDERING GUARD of the step-14 plan's rule-7 table: between one
 *   order's own dispatches (a stamp derived from an older Amazon read vs a clear
 *   derived from a newer one, two raises of one aviso row) there is no event
 *   clock, so they must never interleave. Raising it requires an event-clock
 *   watermark on the stamp, the clear and the avisos first. It does NOT dedupe
 *   a duplicate inside the read-after-write lag.
 * - `retryConfig`: `maxAttempts` IS `TENTATIVAS_NFE_AMAZON` — the handler's
 *   last-attempt rule (P11) answers on the attempt that constant calls last, so
 *   a queue that gave up earlier would drop the upload with no aviso. Backoff
 *   10 s → 300 s with up to three doublings.
 * - `timeoutSeconds: 300`: the worst-case Amazon budget of ONE dispatch is
 *   220 s (an LWA refresh, `getOrder` twice, the status read twice, the submit
 *   twice and three forced refreshes, each bounded by the package's
 *   `PRAZO_AMAZON_MS`) — `index.test.ts` reads the arithmetic off the package.
 * - `secrets`: {@link SEGREDOS_DO_ENVIO_NFE_AMAZON}.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and
 *   `roles/cloudtasks.enqueuer` on its queue, from `TASKS_INVOKER_SA` — which
 *   must name BOTH runtime SAs (the functions one: the trigger and the
 *   self-re-enqueues; the App Hosting one: the re-drive route).
 *
 * ONE `evento: 'nfe'` dispatch line per run that returns
 * (`registrarDespachoNfeAmazon`); a throw for the queue's retry writes none (the
 * runtime logs it, SANITIZED here: never a package error's message).
 *
 * D11: nothing calls Amazon before the window — the context loader refuses
 * unless `AMAZON_CHAMADAS` is exactly `on`, and a submit also needs the NF-e
 * valve `on` and a canary hit.
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text, and the untyped call keeps `req.data` at
// `unknown`, which the body parses (P0) instead of trusting a cast.
export const processAmazonNfeUpload = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: 300,
    secrets: [...SEGREDOS_DO_ENVIO_NFE_AMAZON],
    retryConfig: {
      maxAttempts: TENTATIVAS_NFE_AMAZON,
      minBackoffSeconds: 10,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    // ⚠️ The ordering guard of the step-14 plan's rule-7 table: raising it
    // requires an event-clock watermark on the stamp, the clear and the avisos.
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  },
  async (req) => {
    const registro: RegistroNfeAmazon = {
      tentativa: req.retryCount ?? 0,
      idTarefa: req.id ?? null,
    };
    let r: ResultadoNfeAmazon;
    try {
      r = await processarNfeAmazon(getDb(), req.data, depsDoEnvioNfeAmazon(registro));
    } catch (err) {
      // The queue's retry: a package error's message can carry a path with a
      // seller id, so it leaves through the app's sanitizing boundary.
      throw sanitizarFalhaDaTarefaAmazon(err);
    }
    registrarDespachoNfeAmazon(LOGGER_STDOUT_AMAZON, r, registro);
  },
);
