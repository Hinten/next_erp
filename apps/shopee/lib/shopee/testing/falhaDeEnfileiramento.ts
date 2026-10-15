/**
 * The REAL Cloud Tasks enqueue failures of the pinned `firebase-admin`
 * (14.2.0), built with the SDK's own exported classes — **for tests only**.
 *
 * ⚠️ Nothing under `lib/shopee/**` outside a `*.test.ts` may import this module
 * (the `fakeDb.ts` / `fakeBucket.ts` precedent). It ships in the app tree rather
 * than beside one suite because every per-conta sweep that enqueues needs the
 * same three shapes, and a copy per suite is exactly how a stand-in drifts.
 *
 * ⚠️ It exists because the stand-in these suites used was WRONG. They rejected
 * their fake scheduler with a numeric `grpc(14, 'UNAVAILABLE')`, which the
 * per-conta boundary contains — while `TaskQueue.enqueue` is a REST client that
 * never throws one. The real failure carries a STRING code
 * (`functions/unknown-error`), the boundary's gRPC check never matched it, and
 * one 503 on any conta failed the whole tick while every suite read green.
 *
 * {@link rejeicaoDoTransporte} is what a fake's `enqueue` returns: the
 * transport's rejection run through the SAME shared classifier the real
 * schedulers run (`../shopeeTasks.ts`), so a suite drives the real naming, not
 * a hand-picked class. `shopeeTasks.test.ts` and `shopeeStockTasks.test.ts` pin
 * that both real schedulers do call it.
 */
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';

import { enfileirarNomeandoFalhaTransitoria } from '../shopeeTasks';

/**
 * A body the SDK quotes VERBATIM in its message for a non-JSON answer — so any
 * description built from that message leaks it. Tests assert it never reaches a
 * `lastError`, a log line or a result.
 */
export const CORPO_DA_RESPOSTA_DO_TASKS = 'corpo-da-resposta-SN-260930ABCDEF';

/**
 * `TaskQueue.enqueue`'s HTTP failure exactly as the SDK's `toFirebaseError`
 * builds it for a non-JSON answer: the message quotes the status AND the body,
 * and `httpResponse` carries both. `code` is UNPREFIXED, as the SDK passes it
 * (the class adds `functions/`).
 */
export function falhaDoFunctions(code: string, status = 503): FirebaseFunctionsError {
  return new FirebaseFunctionsError({
    code,
    message: `Unexpected response with status: ${String(status)} and body: ${CORPO_DA_RESPOSTA_DO_TASKS}`,
    httpResponse: { status, headers: {}, data: CORPO_DA_RESPOSTA_DO_TASKS },
  });
}

/**
 * The SDK's CONFIG failure, thrown before any request when `getProjectId()` /
 * `getServiceAccount()` cannot resolve the app's project or service account
 * (`functions-api-client-internal.js`, verbatim messages). The SAME
 * `unknown-error` code as a 503 — and NO `httpResponse`, which is the only
 * thing that tells the two apart.
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
 * UNPREFIXED (`AppErrorCode.NETWORK_ERROR`); the class adds `app/`.
 */
export function falhaDoApp(code: string): FirebaseAppError {
  return new FirebaseAppError({
    code,
    message: `Error while making request: socket hang up (${CORPO_DA_RESPOSTA_DO_TASKS}). Error code: ECONNRESET`,
  });
}

/** What the REAL scheduler rejects with when its transport throws `err`. */
export function rejeicaoDoTransporte(err: Error): Promise<void> {
  return enfileirarNomeandoFalhaTransitoria(() => Promise.reject(err));
}
