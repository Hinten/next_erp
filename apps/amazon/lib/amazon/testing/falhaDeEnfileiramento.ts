/**
 * The REAL Cloud Tasks enqueue failures of the pinned `firebase-admin`
 * (14.5.0), built with the SDK's own exported classes and STRING codes — **for
 * tests only**, the same rule as `fakeDb.ts`: nothing outside a `*.test.ts`
 * imports this (`estrutura.test.ts`).
 *
 * It ships in the app tree rather than beside one suite because every producer
 * that enqueues (the receiver in 3-c, the poll in 4-a) needs the same shapes,
 * and a copy per suite is how a stand-in drifts. The stand-in to avoid is a
 * numeric gRPC error: `TaskQueue.enqueue` is a REST client that never throws
 * one, so a suite faking `grpc(14, …)` tests a failure production cannot
 * produce while the real one — a STRING code — goes unhandled (#1759).
 *
 * {@link rejeicaoDoTransporte} is what a fake producer's `enfileirar` returns:
 * the transport's rejection run through the SAME classifier the real producer
 * runs (`../notificacoes/agendador.ts`), so a suite drives the real naming.
 */
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';

import { enfileirarNomeandoFalhaTransitoriaAmazon } from '../notificacoes/agendador';

/**
 * A body the SDK quotes VERBATIM in its message for a non-JSON answer — so any
 * description built from that message leaks it. Tests assert it never reaches a
 * message, a document or a log line.
 */
export const CORPO_DA_RESPOSTA_DO_TASKS = 'corpo-da-resposta-tarefas-AMZ-0123456789';

/**
 * `TaskQueue.enqueue`'s HTTP failure as the SDK builds it for a non-JSON answer:
 * the message quotes the status AND the body, and `httpResponse` carries both.
 * `code` is UNPREFIXED, as the SDK passes it (the class adds `functions/`).
 *
 * ⚠️ Pair a code with a status the SDK really pairs it with (its nine-entry
 * `google.rpc` map, everything else `unknown-error`): a 409 is NEVER built here
 * — use {@link falhaDeConflitoDoTasks}, the SDK's own 409 branch.
 */
export function falhaDoFunctions(code: string, status = 503): FirebaseFunctionsError {
  return new FirebaseFunctionsError({
    code,
    message: `Unexpected response with status: ${String(status)} and body: ${CORPO_DA_RESPOSTA_DO_TASKS}`,
    httpResponse: { status, headers: {}, data: CORPO_DA_RESPOSTA_DO_TASKS },
  });
}

/**
 * `TaskQueue.enqueue`'s 409, as the pinned SDK builds it: EVERY 409 becomes
 * `task-already-exists` before the generic mapping runs, its message naming the
 * task id the caller passed — none here, so `undefined`. Without a task id the
 * only 409 Cloud Tasks answers is ABORTED, whose body `httpResponse` carries.
 */
export function falhaDeConflitoDoTasks(): FirebaseFunctionsError {
  return new FirebaseFunctionsError({
    code: 'task-already-exists',
    message: 'A task with ID undefined already exists',
    httpResponse: {
      status: 409,
      headers: {},
      data: { error: { code: 409, status: 'ABORTED', message: CORPO_DA_RESPOSTA_DO_TASKS } },
    },
  });
}

/**
 * The SDK's CONFIG failure, thrown before any request when it cannot resolve
 * the app's project or service account. The SAME `unknown-error` code as a 503 —
 * and NO `httpResponse`, which is the only thing that tells the two apart.
 */
export function falhaDeConfiguracaoDoFunctions(
  qual: 'projeto' | 'conta-de-servico',
): FirebaseFunctionsError {
  return new FirebaseFunctionsError({
    code: 'unknown-error',
    message:
      qual === 'projeto'
        ? 'Failed to determine project ID. Initialize the SDK with service account credentials or set project ID as an app option. Alternatively, set the GOOGLE_CLOUD_PROJECT environment variable.'
        : 'Failed to determine service account. Initialize the SDK with service account credentials or set service account ID as an app option.',
  });
}

/**
 * The SDK HTTP client's own failure — a socket error after its retries, or a
 * credential it could not mint. No response, so no `httpResponse`. `code` is
 * UNPREFIXED; the class adds `app/`.
 */
export function falhaDoApp(code: string): FirebaseAppError {
  return new FirebaseAppError({
    code,
    message: `Error while making request: socket hang up (${CORPO_DA_RESPOSTA_DO_TASKS}). Error code: ECONNRESET`,
  });
}

/** What the REAL producer rejects with when its transport throws `err`. */
export function rejeicaoDoTransporte(err: Error): Promise<void> {
  return enfileirarNomeandoFalhaTransitoriaAmazon(() => Promise.reject(err));
}
