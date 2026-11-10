import { FieldValue } from 'firebase-admin/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  type DepsProcessarAgendamentoAmazon,
  type RegistroAgendamentoAmazon,
  type ResultadoTarefaAgendamentoAmazon,
  processarAgendamentoAmazon,
  registrarDespachoAgendamentoAmazon,
} from '../../lib/amazon/agendamento/processarAgendamento';
import { TENTATIVAS_AGENDAMENTO_AMAZON } from '../../lib/amazon/agendamento/tarefaAgendamento';
import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import { LWA_CLIENT_SECRET_ENV } from '../../lib/amazon/env';
import { sanitizarFalhaDaTarefaAmazon } from '../../lib/amazon/notificacoes/notificacao';
import { criarAgendadorAgendamentoAmazonDoAmbiente } from './agendadorAgendamento';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The Secret Manager names the scheduling queue binds: the LWA client secret,
 * read by the context loader for a refresh once the read switch is on — the
 * env reader's own constant, so the binding and the read cannot drift apart.
 * Without it the forced refresh after a 401/403 (on `getOrder`, the token mint
 * or the bulk) could not run.
 *
 * ⚠️ A declared secret missing from Secret Manager fails the WHOLE deploy
 * (window item W1 creates it before the functions deploy, W9).
 */
export const SEGREDOS_DO_AGENDAMENTO_AMAZON: readonly string[] = [LWA_CLIENT_SECRET_ENV];

/**
 * The dependencies of ONE scheduling dispatch, bound to the runtime — the one
 * place this codebase binds them:
 *
 * - `ambiente`: the process environment, WHOLE and live — the read switch
 *   (`AMAZON_CHAMADAS`), the LWA pair, the scheduling valve and canary
 *   (`AMAZON_MODO_AGENDAMENTO`, `AMAZON_CANARIO_AGENDAMENTO`), read per
 *   dispatch, never cached.
 * - `agendamento`: the scheduling queue's producer for the handler's OWN
 *   re-enqueues (the `espera` and `pausa` rungs, UNNAMED) — the functions
 *   codebase's scheduling root (`./agendadorAgendamento`), built only when one
 *   is due.
 * - `increment`: a tier-0 `FieldValue` for the aviso counter.
 * - `logger`: the app's ONE logger. Never `firebase-functions`' logger, never
 *   `console.*`.
 */
export function depsDoAgendamentoAmazon(
  registro: RegistroAgendamentoAmazon,
): DepsProcessarAgendamentoAmazon {
  return {
    ambiente: process.env,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    increment: (by: number) => FieldValue.increment(by),
    agendamento: criarAgendadorAgendamentoAmazonDoAmbiente,
    registro,
  };
}

/**
 * The Amazon Easy Ship scheduling queue (master plan step 15, PR 15-c; step-15
 * plan §3 decision 1): ONE function — and so ONE Cloud Tasks queue,
 * auto-provisioned and named after it — that books the pickup of a
 * Delivery-by-Amazon order once Amazon has accepted its NF-e. Its producers, all
 * through the functions codebase's scheduling root (`./agendadorAgendamento`):
 * the NF-e task's acceptance seam (E1, named after the NF-e dispatch), the order
 * import (E2, named after the import's read) and this handler's own re-enqueues
 * (the `espera` and `pausa` rungs, UNNAMED). The body is
 * `lib/amazon/agendamento/processarAgendamento.ts` (A0–A9).
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal
 * `FILA_AGENDAMENTO_AMAZON` — the producers target that string. `index.ts`
 * asserts the pair at module load; rename both together, or every enqueue
 * targets a queue that does not exist (a silent drop).
 *
 * Options, each one deliberate (`index.test.ts` pins every value):
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`:
 *   Easy Ship's bulk allows 1 rps, burst 5, and a queue of its own keeps it off
 *   the NF-e upload's. ⚠️ `maxConcurrentDispatches: 1` also ORDERS this queue's
 *   avisos (a raise and a resolve of one order's row never interleave) and
 *   serialises the automatic schedules of one order: several tasks may exist
 *   for it (one per observation), and the second reads `ja-agendado` instead of
 *   racing the first to Amazon.
 * - `retryConfig`: `maxAttempts` IS `TENTATIVAS_AGENDAMENTO_AMAZON` — the
 *   handler's last-attempt rule answers on the attempt that constant calls last.
 *   ⚠️ `minBackoffSeconds: 60`, never the other queues' 10: a cut bulk may still
 *   be running at Amazon, and a retry must never come sooner than the label
 *   route asks the operator to wait before reprinting. 60 s → 300 s with up to
 *   three doublings (≈ 60, 120 and 240 s).
 * - `timeoutSeconds: 300`: the worst-case Amazon budget of ONE dispatch is
 *   220 s (an LWA refresh, `getOrder` twice with its forced refresh, the mint and
 *   the bulk, a forced refresh, the mint and the bulk again — each bounded by the
 *   package's `PRAZO_AMAZON_MS`) — `index.test.ts` reads the arithmetic off the
 *   package.
 * - `secrets`: {@link SEGREDOS_DO_AGENDAMENTO_AMAZON}.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and
 *   `roles/cloudtasks.enqueuer` on its queue, from `TASKS_INVOKER_SA` — the
 *   codebase-wide list that names BOTH runtime SAs (every producer of THIS queue
 *   is the functions runtime SA; the deploy applies the one list to every task
 *   function of the codebase).
 *
 * ONE `evento: 'agendamento'` dispatch line per run that returns
 * (`registrarDespachoAgendamentoAmazon`); a throw for the queue's retry writes
 * none (the runtime logs it, SANITIZED here: never a package error's message).
 *
 * D11: nothing calls Amazon before the window — the valve `off` reads nothing,
 * the context loader refuses unless `AMAZON_CHAMADAS` is exactly `on`, and a
 * schedule also needs the scheduling valve `on` and a canary hit.
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text, and the untyped call keeps `req.data` at
// `unknown`, which the body parses (A0) instead of trusting a cast.
export const processAmazonEasyShipSchedule = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: 300,
    secrets: [...SEGREDOS_DO_AGENDAMENTO_AMAZON],
    retryConfig: {
      maxAttempts: TENTATIVAS_AGENDAMENTO_AMAZON,
      // ⚠️ A cut bulk may still be running at Amazon: never retry sooner than
      // the label route asks the operator to wait.
      minBackoffSeconds: 60,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    // ⚠️ Orders this queue's avisos and serialises the automatic schedules of
    // one order.
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  },
  async (req) => {
    const registro: RegistroAgendamentoAmazon = {
      tentativa: req.retryCount ?? 0,
      idTarefa: req.id ?? null,
    };
    let r: ResultadoTarefaAgendamentoAmazon;
    try {
      r = await processarAgendamentoAmazon(getDb(), req.data, depsDoAgendamentoAmazon(registro));
    } catch (err) {
      // The queue's retry: a package error's message can carry a path with a
      // seller id, so it leaves through the app's sanitizing boundary.
      throw sanitizarFalhaDaTarefaAmazon(err);
    }
    registrarDespachoAgendamentoAmazon(LOGGER_STDOUT_AMAZON, r, registro);
  },
);
