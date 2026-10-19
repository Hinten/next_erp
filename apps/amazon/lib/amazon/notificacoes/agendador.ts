/**
 * The reads-queue PRODUCER, pure: what an enqueue onto `filaLeituraAmazon`
 * means, with the transport handed in.
 *
 * The queue itself is bound by a COMPOSITION ROOT, never here: the App Hosting
 * receiver's `lib/firebase/filaLeitura.ts` (PR 3-c) and the functions codebase's
 * `functions/src/agendador.ts` (PR 3-d, used by the step-4 poll). Each root
 * resolves the region, builds the queue path with {@link caminhoDaFilaAmazon},
 * reads the sweep-only valve and passes both in as {@link OpcoesAgendadorAmazon}.
 * Nothing in this module reads the process environment (`estrutura.test.ts`),
 * and nothing under `lib/amazon` calls `getFunctions(`.
 *
 * ⚠️ This is the ONE production module under `lib/amazon` that imports
 * `firebase-admin/functions` (`estrutura.test.ts`): the receiver and the poll
 * narrow an SDK failure through {@link ehFalhaDoSdkDeTarefasAmazon} and import
 * no SDK module of their own.
 *
 * ## What a rejection MEANS — part of the contract
 *
 * A producer decides on it, so a caller must be able to tell three cases apart:
 *
 * - {@link AmazonTarefasDesligadasError} — the sweep-only valve is closed. The
 *   caller persists the notification as `failed` and the 30-minute reprocess
 *   sweep drains it: never a silent drop.
 * - {@link AmazonTarefasTransitoriasError} — Cloud Tasks hiccupped. The caller
 *   persists, exactly as above.
 * - anything else, rethrown EXACTLY as it was thrown — a broken deploy (no queue
 *   in that region, a missing IAM role, an unresolvable project or service
 *   account), a root's `MissingRegionError`, a coding bug.
 *
 * ⚠️ So a test fake that rejects with a raw SDK error stands in for a producer
 * this module never builds: the real one never lets a transient one through
 * unnamed. `testing/falhaDeEnfileiramento.ts` builds the SDK's own classes and
 * runs them through {@link enfileirarNomeandoFalhaTransitoriaAmazon}.
 *
 * ## No task id, no `uri`
 *
 * The enqueue passes the payload ALONE.
 *
 * - No task id: duplicates are bounded by the failure document's deterministic
 *   id (`push:<NotificationId>`, `poll:…`) and the step-4 poll's `vistos`, and
 *   the step-5 importer must be idempotent (it re-fetches the order). A named
 *   task is refused by Cloud Tasks for a while after it ran, which would turn a
 *   deliberate re-enqueue of the same order into an enqueue failure.
 * - No `uri`: under the emulator the Admin SDK sends an empty URL that the
 *   emulator fills in, so a supplied one would ship the task to the deployed
 *   function instead (`webhook-notifications` skill).
 *
 * Why the classifier lives in this app and not in the shared notification core:
 * the core may only `import type` from the Admin SDK, and narrowing by class
 * needs the classes themselves at runtime.
 */
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';

import { FILA_LEITURA_AMAZON, type PayloadNotificacaoAmazon } from './notificacao';

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<PayloadNotificacaoAmazon>`, of which only `enqueue(data)` is used.
 */
export interface FilaLeituraAmazon {
  enqueue(payload: PayloadNotificacaoAmazon): Promise<void>;
}

/** The enqueue seam a producer depends on: a fake in tests, {@link criarAgendadorAmazon} for real. */
export interface AgendadorAmazon {
  enfileirar(payload: PayloadNotificacaoAmazon): Promise<void>;
}

export interface OpcoesAgendadorAmazon {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's
   * region guard then rejects that enqueue (rethrown untouched below) instead of
   * failing the whole module load, and the sweep-only mode never touches the
   * SDK at all.
   */
  readonly fila: () => FilaLeituraAmazon;
  /** The sweep-only valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/** A region id as a queue path may carry it: lowercase letters, digits and `-`, nothing a path could misread. */
const REGIAO = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * The region-qualified path of the reads queue. MANDATORY: without the
 * `locations/{region}/functions/` prefix the Admin SDK targets its own default
 * region and the task is silently dropped (#1108).
 *
 * @throws {TypeError} for a region outside {@link REGIAO} — a `/` would make it
 *   another path, and an empty one a well-formed path to nowhere.
 */
export function caminhoDaFilaAmazon(regiao: string): string {
  if (!REGIAO.test(regiao)) {
    throw new TypeError('caminhoDaFilaAmazon: região fora da gramática (minúsculas, dígitos, -)');
  }
  return `locations/${regiao}/functions/${FILA_LEITURA_AMAZON}`;
}

/**
 * The sweep-only valve is closed (`AMAZON_TASKS_DISABLED=1`): nothing was
 * enqueued, and the caller persists the notification for the sweep.
 *
 * A plain `Error`, not an `ErroAppAmazon`: it is about this deployment, never
 * about a conta, and a `catch` written for a conta's refusal must not swallow it.
 */
export class AmazonTarefasDesligadasError extends Error {
  constructor() {
    super(
      'AMAZON_TASKS_DISABLED=1 — a fila de leitura está desligada; ' +
        'persistindo a notificação para a varredura de reprocessamento',
    );
    this.name = 'AmazonTarefasDesligadasError';
  }
}

/**
 * Which Cloud Tasks enqueue failures are TRANSIENT, in the pinned
 * `firebase-admin` (14.5.0) — decided by the HTTP STATUS Cloud Tasks answered,
 * never by the SDK's code, which does not say what happened:
 *
 * - `TaskQueue.enqueue` turns EVERY 409 into `functions/task-already-exists`
 *   before its generic mapping runs (`functions-api-client-internal.js`), so
 *   `functions/aborted` never comes out of an enqueue. This producer never sends
 *   a task id, so the only 409 Cloud Tasks can answer is ABORTED (a concurrency
 *   conflict): transient, whatever the SDK calls it.
 * - The generic mapping knows nine `google.rpc` statuses. Everything else — a
 *   503 UNAVAILABLE, a 429 RESOURCE_EXHAUSTED, a 504 DEADLINE_EXCEEDED, but also
 *   a 400 OUT_OF_RANGE, and any non-JSON body — arrives as
 *   `functions/unknown-error`. The code alone would name a 400 transient.
 *
 * So a `FirebaseFunctionsError` is transient exactly when it carries an
 * `httpResponse` (Cloud Tasks ANSWERED — every HTTP path of the SDK sets it) whose
 * status is 409, 429 or 5xx; any other status — `permission-denied` 403,
 * `not-found` 404 (no queue in that region), `unauthenticated` 401, a 400 — is a
 * broken DEPLOY or a bad request, rethrown untouched. ⚠️ The SDK also throws
 * `functions/unknown-error` with NO response, before any request, when it
 * cannot resolve the project or the service account: a deterministic config
 * error, never a hiccup.
 *
 * ⚠️ A DEPARTURE from the step-3 plan, which pinned three `functions/*` codes:
 * read against the pinned SDK, one of them is unreachable and another names a
 * 400 transient.
 */
function statusTransitorioDoTasks(status: number): boolean {
  return status === 409 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * The SDK HTTP client's own failures that are TRANSIENT: a socket error or a
 * timeout, after its own retries — no response at all. Every other `app/*` code
 * (`invalid-credential`, …) is a broken deploy.
 */
const CODIGOS_TRANSITORIOS_DO_APP: ReadonlySet<string> = new Set([
  'app/network-error',
  'app/network-timeout',
]);

/**
 * Is `err` one of the two Cloud Tasks SDK classes — transient or not? The
 * receiver (3-c) and the poll (4-a) narrow a RAW SDK failure (a deploy-shaped
 * one this module rethrew untouched) through this, so neither imports an SDK
 * module of its own.
 */
export function ehFalhaDoSdkDeTarefasAmazon(
  err: unknown,
): err is FirebaseFunctionsError | FirebaseAppError {
  return err instanceof FirebaseFunctionsError || err instanceof FirebaseAppError;
}

/**
 * A transient enqueue failure, NAMED at the enqueue by
 * {@link enfileirarNomeandoFalhaTransitoriaAmazon} — so a caller contains THIS
 * class, and a Firebase error raised anywhere else is never contained by
 * accident.
 *
 * ⚠️ Its message is the original class, code and HTTP status ONLY — never the
 * SDK's message, which for a non-JSON answer quotes the response BODY verbatim,
 * while a caller writes `err.message` onto a failure document and into its log.
 * No `cause` either: a logger that serialises causes would print that body
 * anyway.
 */
export class AmazonTarefasTransitoriasError extends Error {
  readonly classe: 'FirebaseFunctionsError' | 'FirebaseAppError';
  readonly codigo: string;
  /** The status Cloud Tasks answered; `null` when no response arrived (a socket failure). */
  readonly httpStatus: number | null;

  constructor(
    classe: 'FirebaseFunctionsError' | 'FirebaseAppError',
    codigo: string,
    httpStatus: number | null,
  ) {
    const status = httpStatus === null ? '' : `, HTTP ${String(httpStatus)}`;
    super(`enqueue no Cloud Tasks falhou de forma transitória (${classe} ${codigo}${status})`);
    this.name = 'AmazonTarefasTransitoriasError';
    this.classe = classe;
    this.codigo = codigo;
    this.httpStatus = httpStatus;
  }
}

/**
 * Run ONE transport enqueue and name its transient failure as
 * {@link AmazonTarefasTransitoriasError}; anything else — a deploy-shaped code,
 * a root's `MissingRegionError`, a coding bug — is rethrown untouched (root
 * `CLAUDE.md` rule 6: narrowed by class, never by `Error`).
 */
export async function enfileirarNomeandoFalhaTransitoriaAmazon(
  enfileirar: () => Promise<void>,
): Promise<void> {
  try {
    await enfileirar();
  } catch (err) {
    // No `httpResponse` ⇒ no request was answered: the SDK's own config
    // failure (project id, service account), never a Cloud Tasks hiccup. With
    // one, the STATUS decides, never the code ({@link statusTransitorioDoTasks}).
    if (
      err instanceof FirebaseFunctionsError &&
      err.httpResponse !== undefined &&
      statusTransitorioDoTasks(err.httpResponse.status)
    ) {
      throw new AmazonTarefasTransitoriasError(
        'FirebaseFunctionsError',
        err.code,
        err.httpResponse.status,
      );
    }
    if (err instanceof FirebaseAppError && CODIGOS_TRANSITORIOS_DO_APP.has(err.code)) {
      throw new AmazonTarefasTransitoriasError('FirebaseAppError', err.code, null);
    }
    throw err;
  }
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link AmazonTarefasDesligadasError} and the queue is never resolved;
 * otherwise each enqueue resolves the queue, sends the payload ALONE (no
 * options: no task id, no `uri`) and names a transient failure.
 */
export function criarAgendadorAmazon(opcoes: OpcoesAgendadorAmazon): AgendadorAmazon {
  if (opcoes.desligado) {
    return {
      enfileirar() {
        return Promise.reject(new AmazonTarefasDesligadasError());
      },
    };
  }
  return {
    enfileirar: (payload) =>
      enfileirarNomeandoFalhaTransitoriaAmazon(() => opcoes.fila().enqueue(payload)),
  };
}
