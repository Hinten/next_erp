/**
 * The Cloud Tasks SDK helpers every producer of this app shares (step 14, PR
 * 14-c: MOVED here, behaviour unchanged, out of the reads-queue producer
 * `notificacoes/agendador.ts`, which re-exports them so its callers stay as
 * they were).
 *
 * ⚠️ This is the ONE production module under `lib/amazon` that imports
 * `firebase-admin/functions` (`estrutura.test.ts`): every producer narrows an
 * SDK failure through {@link ehFalhaDoSdkDeTarefasAmazon} and imports no SDK
 * module of its own.
 *
 * ## Why the helpers moved — the NF-e trigger's closure
 *
 * The NF-e trigger (`functions/src/onNfeAprovadaAmazon.ts`) runs on EVERY
 * `nfev4` write of the project, so its import closure is pinned file by file
 * and may reach no context, conta read, valve or SP-API value
 * (`estrutura.test.ts`, D11 by construction). The reads-queue producer
 * reaches all of them by VALUE through `./notificacao` (`FILA_LEITURA_AMAZON`),
 * so the NF-e producer (`nfe/agendadorNfe.ts`) could not import the transient
 * naming from there. This module therefore has NO edge to `notificacoes/`, the
 * context, `env.ts` or the SP-API package — type edges included.
 *
 * ## What a rejection MEANS — part of every producer's contract
 *
 * - {@link AmazonTarefasTransitoriasError} — Cloud Tasks hiccupped, NAMED here
 *   ({@link enfileirarNomeandoFalhaTransitoriaAmazon}), so a caller contains
 *   THIS class and a Firebase error raised anywhere else is never contained by
 *   accident.
 * - anything else, rethrown EXACTLY as it was thrown — a broken deploy (no
 *   queue in that region, a missing IAM role, an unresolvable project or
 *   service account), a root's `MissingRegionError`, a coding bug.
 *
 * Each producer adds its OWN valve class (the reads queue's
 * `AmazonTarefasDesligadasError`, the NF-e queue's
 * `AmazonNfeTarefasDesligadasError`): the remedy differs per queue, so the
 * class does too.
 *
 * Why the classifier lives in this app and not in the shared notification core:
 * the core may only `import type` from the Admin SDK, and narrowing by class
 * needs the classes themselves at runtime.
 */
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';

/** A region id as a queue path may carry it: lowercase letters, digits and `-`, nothing a path could misread. */
const REGIAO = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Can `regiao` name a queue's region (every `caminhoDaFila…` accepts exactly
 * it)? The receiver checks it with its configuration, BEFORE reading a body,
 * so a malformed region answers 503 instead of failing every enqueue.
 */
export function regiaoDaFilaValidaAmazon(regiao: string): boolean {
  return REGIAO.test(regiao);
}

/**
 * Which Cloud Tasks enqueue failures are TRANSIENT, in the pinned
 * `firebase-admin` (14.5.0) — decided by the HTTP STATUS Cloud Tasks answered,
 * never by the SDK's code, which does not say what happened:
 *
 * - `TaskQueue.enqueue` turns EVERY 409 into `functions/task-already-exists`
 *   before its generic mapping runs (`functions-api-client-internal.js`), so
 *   `functions/aborted` never comes out of an enqueue. An UNNAMED enqueue
 *   sends no task id, so the only 409 Cloud Tasks can answer it is ABORTED (a
 *   concurrency conflict): transient, whatever the SDK calls it. A NAMED
 *   enqueue's ALREADY_EXISTS is told apart BEFORE this naming runs
 *   ({@link ehTarefaJaExistenteAmazon}).
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

/** The two Cloud Tasks SDK classes, as a TYPE a producer can name without importing the SDK. */
export type FalhaDoSdkDeTarefasAmazon = FirebaseFunctionsError | FirebaseAppError;

/**
 * Is `err` one of the two Cloud Tasks SDK classes — transient or not? The
 * receiver (3-c) and the poll (4-a) narrow a RAW SDK failure (a deploy-shaped
 * one a producer rethrew untouched) through this, so neither imports an SDK
 * module of its own.
 */
export function ehFalhaDoSdkDeTarefasAmazon(err: unknown): err is FalhaDoSdkDeTarefasAmazon {
  return err instanceof FirebaseFunctionsError || err instanceof FirebaseAppError;
}

/**
 * `<classe>/<codigo>` of a raw SDK failure: the class and the code ONLY — never
 * the SDK's message, which can quote a response body. What a producer writes
 * after `enfileiramento/` on a failure document and in its log line.
 */
export function descreverFalhaDoSdkDeTarefasAmazon(err: FalhaDoSdkDeTarefasAmazon): string {
  if (err instanceof FirebaseFunctionsError) return `FirebaseFunctionsError/${err.code}`;
  return `FirebaseAppError/${err.code}`;
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
  /**
   * The SDK class that failed — or `prazo`: the PRODUCER's own deadline answered
   * first while the enqueue kept running (the receiver's race, step-3 plan §3
   * decision 32; {@link AmazonTarefasTransitoriasError.porPrazo}).
   */
  readonly classe: 'FirebaseFunctionsError' | 'FirebaseAppError' | 'prazo';
  /** The SDK code (`functions/…`, `app/…`), or `prazo`. */
  readonly codigo: string;
  /** The status Cloud Tasks answered; `null` when no response arrived (a socket failure, a deadline). */
  readonly httpStatus: number | null;

  constructor(
    classe: 'FirebaseFunctionsError' | 'FirebaseAppError' | 'prazo',
    codigo: string,
    httpStatus: number | null,
  ) {
    const status = httpStatus === null ? '' : `, HTTP ${String(httpStatus)}`;
    super(
      classe === 'prazo'
        ? 'enqueue no Cloud Tasks não terminou dentro do prazo do produtor'
        : `enqueue no Cloud Tasks falhou de forma transitória (${classe} ${codigo}${status})`,
    );
    this.name = 'AmazonTarefasTransitoriasError';
    this.classe = classe;
    this.codigo = codigo;
    this.httpStatus = httpStatus;
  }

  /**
   * The enqueue lost the producer's deadline race. It may still land later: a
   * duplicate beside the persisted document, which the importer absorbs.
   */
  static porPrazo(): AmazonTarefasTransitoriasError {
    return new AmazonTarefasTransitoriasError('prazo', 'prazo', null);
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

/** The SDK's code for EVERY 409 of an enqueue (header). */
const TAREFA_JA_EXISTE = 'functions/task-already-exists';

/** The `google.rpc` status of a named create whose id Cloud Tasks already holds. */
const STATUS_JA_EXISTE = 'ALREADY_EXISTS';

/**
 * The `error.status` a Google API error body names, or `null` when the body is
 * not that shape (a non-JSON answer reaches the SDK as text).
 */
function statusDoCorpoDeErro(corpo: unknown): string | null {
  if (typeof corpo !== 'object' || corpo === null) return null;
  const erro = (corpo as { error?: unknown }).error;
  if (typeof erro !== 'object' || erro === null) return null;
  const status = (erro as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

/**
 * Did a NAMED enqueue fail because Cloud Tasks already holds that task id — the
 * task is already durable (rule 7 tier 0), so the caller answers "already
 * enqueued" instead of an error?
 *
 * The pinned SDK reports EVERY 409 as `functions/task-already-exists` (header),
 * so the code alone cannot tell ALREADY_EXISTS from ABORTED. When the answered
 * body NAMES a status, it decides: `ALREADY_EXISTS` only — an ABORTED is a
 * transient the caller's naming surfaces, never a silent "already there", which
 * would drop a task nobody created. When it names none (a body that is not
 * Google's error shape), the SDK's code is the only signal and is believed.
 *
 * `false` for anything else, a 409 with no response included (the SDK never
 * builds one: its 409 branch always carries the response).
 */
export function ehTarefaJaExistenteAmazon(err: unknown): boolean {
  if (!(err instanceof FirebaseFunctionsError) || err.code !== TAREFA_JA_EXISTE) return false;
  const resposta = err.httpResponse;
  if (resposta?.status !== 409) return false;
  const status = statusDoCorpoDeErro(resposta.data);
  return status === null || status === STATUS_JA_EXISTE;
}
