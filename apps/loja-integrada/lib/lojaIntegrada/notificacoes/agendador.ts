/**
 * The reads-queue PRODUCER, pure: what an enqueue onto
 * `filaLeituraLojaIntegrada` means, with the transport handed in.
 *
 * The queue itself is bound by a COMPOSITION ROOT, never here: the functions
 * codebase's `functions/src/agendador.ts` today (the order poller enqueues), and
 * from step 4 an App Hosting root beside the inbound webhook. Each root resolves
 * the region-qualified queue path, reads the sweep-only valve and passes both in
 * as {@link OpcoesAgendadorLi}. Nothing in this module reads the process
 * environment (`estrutura.test.ts`).
 *
 * ## What a rejection MEANS — part of the contract
 *
 * The poller decides on it, so a caller must be able to tell three cases apart:
 *
 * - {@link LiTarefasDesligadasError} — the sweep-only valve is closed. The
 *   caller persists the notification as `failed` and the 30-minute reprocess
 *   sweep drains it: never a silent drop.
 * - {@link LiTarefasTransitoriasError} — Cloud Tasks hiccupped; the next tick
 *   clears it. The caller persists, exactly as above.
 * - anything else, rethrown EXACTLY as it was thrown — a broken deploy (no queue
 *   in that region, a missing IAM role, an unresolvable project or service
 *   account), the region guard's `MissingRegionError`, a coding bug. It must
 *   fail the tick loudly instead of reading as N identical contained outages.
 *
 * ⚠️ So a test fake that rejects with a raw SDK error stands in for a producer
 * this module never builds: the real one never lets a transient one through
 * unnamed. `testing/falhaDeEnfileiramento.ts` builds the SDK's own classes and
 * runs them through {@link enfileirarNomeandoFalhaTransitoriaLi}.
 *
 * ## No task id, no `uri`
 *
 * The enqueue passes the payload ALONE.
 *
 * - No task id: duplicates are bounded by the poller's `vistos` and by the
 *   failure document's deterministic id, and the step-5 importer must be
 *   idempotent (it re-fetches the order). A named task is refused by Cloud Tasks
 *   for a while after it ran, which would turn a deliberate re-enqueue of the
 *   same change into an enqueue failure.
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

import type { PayloadNotificacaoLi } from './notificacao';

/**
 * The transport, as a root binds it — structurally, the Admin SDK's
 * `TaskQueue<PayloadNotificacaoLi>`, of which only `enqueue(data)` is used.
 */
export interface FilaLeituraLi {
  enqueue(payload: PayloadNotificacaoLi): Promise<void>;
}

/** The enqueue seam a producer depends on: a fake in tests, {@link criarAgendadorLi} for real. */
export interface AgendadorLi {
  enfileirar(payload: PayloadNotificacaoLi): Promise<void>;
}

export interface OpcoesAgendadorLi {
  /**
   * The queue, resolved PER ENQUEUE and only when the valve is open: a root's
   * region guard then rejects that enqueue (rethrown untouched below) instead of
   * failing the whole module load, and the sweep-only mode never touches the
   * SDK at all.
   */
  readonly fila: () => FilaLeituraLi;
  /** The sweep-only valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/**
 * The sweep-only valve is closed (`LOJA_INTEGRADA_TASKS_DISABLED=1`): nothing
 * was enqueued, and the caller persists the notification for the sweep.
 *
 * A plain `Error`, not a `LiAppError`: it is about this deployment, never about
 * a conta, and a `catch` written for a conta's refusal must not swallow it.
 */
export class LiTarefasDesligadasError extends Error {
  constructor() {
    super(
      'LOJA_INTEGRADA_TASKS_DISABLED=1 — a fila de leitura está desligada; ' +
        'persistindo a notificação para a varredura de reprocessamento',
    );
    this.name = 'LiTarefasDesligadasError';
  }
}

/**
 * The Cloud Tasks enqueue failures that are TRANSIENT — each an outcome of
 * `TaskQueue.enqueue` in the pinned `firebase-admin` (14.2.0) that a later
 * attempt can clear.
 *
 * ⚠️ `TaskQueue.enqueue` is a REST client, not a gRPC one: it throws
 * `FirebaseFunctionsError` / `FirebaseAppError` with STRING codes, never a
 * numeric gRPC status. The SDK maps only nine Cloud Tasks statuses to a code of
 * its own, so a 503, a 429, a 504 and a non-JSON body all arrive as
 * `functions/unknown-error` — there is no `functions/unavailable`. A socket
 * failure, after the SDK's own retries, is `app/network-error` or
 * `app/network-timeout`.
 *
 * Everything else those two classes carry — `permission-denied`,
 * `unauthenticated`, `not-found` (no queue in that region), `invalid-argument`,
 * `failed-precondition`, `invalid-credential` — is a broken DEPLOY.
 *
 * ⚠️ A `functions/*` code is transient only when Cloud Tasks actually ANSWERED
 * (`httpResponse` present — every HTTP path of the SDK sets it). The SDK also
 * throws `functions/unknown-error` with NO response, before any request, when it
 * cannot resolve the project or the service account: a deterministic config
 * error, never a hiccup.
 */
const CODIGOS_TRANSITORIOS_DO_ENFILEIRAMENTO: ReadonlySet<string> = new Set([
  'functions/unknown-error',
  'functions/internal-error',
  'functions/aborted',
  'app/network-error',
  'app/network-timeout',
]);

/**
 * A transient enqueue failure, NAMED at the enqueue by
 * {@link enfileirarNomeandoFalhaTransitoriaLi} — so a caller contains THIS
 * class, and a Firebase error raised anywhere else is never contained by
 * accident.
 *
 * ⚠️ Its message is the original class, code and HTTP status ONLY — never the
 * SDK's message, which for a non-JSON answer quotes the response BODY verbatim,
 * while a caller writes `err.message` onto a failure document and into its log.
 * No `cause` either: a logger that serialises causes would print that body
 * anyway.
 */
export class LiTarefasTransitoriasError extends Error {
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
    this.name = 'LiTarefasTransitoriasError';
    this.classe = classe;
    this.codigo = codigo;
    this.httpStatus = httpStatus;
  }
}

/**
 * Run ONE transport enqueue and name its transient failure as
 * {@link LiTarefasTransitoriasError}; anything else — a deploy-shaped code, a
 * root's `MissingRegionError`, a coding bug — is rethrown untouched (root
 * `CLAUDE.md` rule 6: narrowed by class, never by `Error`).
 */
export async function enfileirarNomeandoFalhaTransitoriaLi(
  enfileirar: () => Promise<void>,
): Promise<void> {
  try {
    await enfileirar();
  } catch (err) {
    // No `httpResponse` ⇒ no request was answered: the SDK's own config
    // failure (project id, service account), never a Cloud Tasks hiccup.
    if (
      err instanceof FirebaseFunctionsError &&
      err.httpResponse !== undefined &&
      CODIGOS_TRANSITORIOS_DO_ENFILEIRAMENTO.has(err.code)
    ) {
      throw new LiTarefasTransitoriasError(
        'FirebaseFunctionsError',
        err.code,
        err.httpResponse.status,
      );
    }
    if (err instanceof FirebaseAppError && CODIGOS_TRANSITORIOS_DO_ENFILEIRAMENTO.has(err.code)) {
      throw new LiTarefasTransitoriasError('FirebaseAppError', err.code, null);
    }
    throw err;
  }
}

/**
 * The producer: with the valve closed, every enqueue rejects with
 * {@link LiTarefasDesligadasError} and the queue is never resolved; otherwise
 * each enqueue resolves the queue, sends the payload ALONE (no options: no task
 * id, no `uri`) and names a transient failure.
 */
export function criarAgendadorLi(opcoes: OpcoesAgendadorLi): AgendadorLi {
  if (opcoes.desligado) {
    return {
      async enfileirar() {
        throw new LiTarefasDesligadasError();
      },
    };
  }
  return {
    enfileirar: (payload) =>
      enfileirarNomeandoFalhaTransitoriaLi(() => opcoes.fila().enqueue(payload)),
  };
}
