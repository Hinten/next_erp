import { FieldValue } from 'firebase-admin/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import { LWA_CLIENT_SECRET_ENV } from '../../lib/amazon/env';
import { provedorDoLoteAmazon } from '../../lib/amazon/feeds/destinosLote';
import type { RegistroLoteAmazon } from '../../lib/amazon/feeds/incertoFeed';
import {
  type DepsProcessarLoteAmazon,
  processarLoteAmazon,
} from '../../lib/amazon/feeds/processarLote';
import { sanitizarFalhaDaTarefaAmazon } from '../../lib/amazon/notificacoes/notificacao';
import { criarAgendadorLotesAmazonDoAmbiente } from './agendadorEstoque';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The Secret Manager names the jobs queue binds: the LWA client secret, read by
 * the context loader for a refresh once the read switch is on — the env
 * reader's own constant, so the binding and the read cannot drift apart.
 * Without it the forced refresh after a 401/403 (on `createFeedDocument`,
 * `createFeed`, `getFeed` or `getFeedDocument`) could not run.
 *
 * ⚠️ A declared secret missing from Secret Manager fails the WHOLE deploy: it
 * is created before the functions deploy (`DEPLOY.md`).
 */
export const SEGREDOS_DOS_LOTES_AMAZON: readonly string[] = [LWA_CLIENT_SECRET_ENV];

/**
 * The attempts Cloud Tasks gives one feed task. No handler counts them: every
 * step a handler takes before a failure is idempotent (named enqueues, tier-1
 * writes, a successor rung enqueued first), so a retry re-runs it, and the
 * chains outlive the last attempt — a poll rung's successor is already durable,
 * a recovery's backstop is the next daily reconcile.
 */
export const TENTATIVAS_LOTE_AMAZON = 5;

/**
 * The dependencies of ONE jobs-queue dispatch, bound to the runtime — the one
 * place this codebase binds them:
 *
 * - `ambiente`: the process environment, WHOLE and live — the read switch
 *   (`AMAZON_CHAMADAS`), the LWA pair, each batch fluxo's valve and canary,
 *   read per dispatch, never cached.
 * - `agendador`: the jobs queue's producer for the handlers' OWN enqueues (the
 *   poll rungs, the uncertain wait, the recoveries, a turned-away batch's wait)
 *   — the functions codebase's stock root (`./agendadorEstoque`), built only
 *   when one is due.
 * - `provedorDe`: the seam table (`lib/amazon/feeds/destinosLote.ts`), read per
 *   run; both rows are empty until a fluxo fills its own.
 * - `fetch`: the global one, read at CALL time, handed to the context, the
 *   write client and both document transfers alike (the package never defaults
 *   it).
 * - `increment`: a tier-0 `FieldValue` for the aviso counter.
 * - `logger`: the app's ONE logger. Never `firebase-functions`' logger, never
 *   `console.*`.
 */
export function depsDosLotesAmazon(registro: RegistroLoteAmazon): DepsProcessarLoteAmazon {
  return {
    ambiente: process.env,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    increment: (by: number) => FieldValue.increment(by),
    agendador: criarAgendadorLotesAmazonDoAmbiente,
    provedorDe: provedorDoLoteAmazon,
    registro,
    fetch: (input, init) => globalThis.fetch(input, init),
  };
}

/**
 * The Amazon JOBS queue (step 12a, PR 12-c): ONE function — and so ONE Cloud
 * Tasks queue, auto-provisioned and named after it — for every task of the
 * `JSON_LISTINGS_FEED` core: a feed's send, its poll rungs and wake-ups, the
 * wait after a lost `createFeed` answer, and the recoveries. The body is
 * `lib/amazon/feeds/processarLote.ts`, which dispatches on the payload's
 * `tipo`. Its producers: the handlers' own enqueues (through `./agendadorEstoque`,
 * the functions runtime SA) and the push receiver's `FEED_PROCESSING_FINISHED`
 * wake-up (through `lib/firebase/filaLeitura.ts`, the App Hosting runtime SA).
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal
 * `FILA_LOTES_AMAZON` — the producers target that string. `index.ts` asserts
 * the pair at module load; rename both together, or every enqueue targets a
 * queue that does not exist (a silent drop).
 *
 * Options, each one deliberate (`index.test.ts` pins every value):
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`:
 *   ONE task at a time across the conta's feed work: one feed in flight per
 *   (fluxo, conta) is the lease's guard, and concurrency 1 additionally keeps
 *   two dispatches from interleaving their reads and writes of one lease or one
 *   record, and keeps the feeds' own rates (`getFeedDocument` refills one call
 *   every 45 s) out of reach.
 * - `retryConfig`: {@link TENTATIVAS_LOTE_AMAZON} attempts, backing off 30 s →
 *   300 s with up to three doublings: a transient report download or `getFeed`
 *   retries well inside its rung's own interval.
 * - `timeoutSeconds: 540`: a send's worst case is its build budget
 *   (`ORCAMENTO_MONTAGEM_LOTE_MS`, 240 s, shared by `membros` and `montar`) plus
 *   the submission twice under the forced-refresh rule — the LWA exchange,
 *   `createFeedDocument`, the upload and `createFeed`, each bounded by the
 *   package's `PRAZO_AMAZON_MS` — 460 s, read off the package by `index.test.ts`.
 * - `memory: '1GiB'`, the first in this codebase: the 256-MiB default cannot
 *   hold a report download (20 MiB compressed, 32 MiB inflated, its UTF-16
 *   decode and its parse tree), nor a catalogue-sized snapshot.
 * - `secrets`: {@link SEGREDOS_DOS_LOTES_AMAZON}.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and
 *   `roles/cloudtasks.enqueuer` on its queue, from `TASKS_INVOKER_SA` — the
 *   codebase-wide list that names BOTH runtime SAs.
 *
 * Every handler writes ONE dispatch line per run that returns (a refused
 * payload writes the dispatcher's ERROR line); a throw for the queue's retry
 * writes none (the runtime logs it, SANITIZED here: never a package error's
 * message).
 *
 * D11: nothing calls Amazon before the window — the context loader refuses
 * unless `AMAZON_CHAMADAS` is exactly `on`, a submission also needs the fluxo's
 * valve `on` and the canary list exactly `*`, and the seam is empty in this PR.
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text, and the untyped call keeps `req.data` at
// `unknown`, which the dispatcher parses (P0) instead of trusting a cast.
export const processAmazonListingsJob = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: 540,
    // ⚠️ A report download and its parse do not fit the 256-MiB default.
    memory: '1GiB',
    secrets: [...SEGREDOS_DOS_LOTES_AMAZON],
    retryConfig: {
      maxAttempts: TENTATIVAS_LOTE_AMAZON,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    // ⚠️ One task at a time: two dispatches never interleave on one lease or
    // one record.
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  },
  async (req) => {
    const registro: RegistroLoteAmazon = {
      tentativa: req.retryCount ?? 0,
      idTarefa: req.id ?? null,
    };
    try {
      await processarLoteAmazon(getDb(), req.data, depsDosLotesAmazon(registro));
    } catch (err) {
      // The queue's retry: a package error's message can carry a path with a
      // seller id, so it leaves through the app's sanitizing boundary.
      throw sanitizarFalhaDaTarefaAmazon(err);
    }
  },
);
