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
 * ⚠️ The task-SDK helpers — the transient naming, the SDK-class narrowing, the
 * region grammar — live in `core/filaTarefas.ts` (step 14, PR 14-c: MOVED there,
 * behaviour unchanged, so the NF-e producer can share them without reaching
 * this module's `./notificacao`), the ONE production module under `lib/amazon`
 * that imports `firebase-admin/functions` (`estrutura.test.ts`). This module
 * RE-EXPORTS them, so the receiver, the poll and this module's own suite import
 * them from here exactly as before; none of them imports an SDK module.
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
 * `core/filaTarefas.ts`'s header.
 */
import {
  AmazonTarefasTransitoriasError,
  type FalhaDoSdkDeTarefasAmazon,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
  enfileirarNomeandoFalhaTransitoriaAmazon,
  regiaoDaFilaValidaAmazon,
} from '../core/filaTarefas';
import { FILA_LEITURA_AMAZON, type PayloadNotificacaoAmazon } from './notificacao';

/**
 * The moved helpers (module header), re-exported so every caller of this module
 * — and its own suite — keeps importing them from here.
 */
export {
  AmazonTarefasTransitoriasError,
  ehFalhaDoSdkDeTarefasAmazon,
  enfileirarNomeandoFalhaTransitoriaAmazon,
  regiaoDaFilaValidaAmazon,
};

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

/**
 * The region-qualified path of the reads queue. MANDATORY: without the
 * `locations/{region}/functions/` prefix the Admin SDK targets its own default
 * region and the task is silently dropped (#1108).
 *
 * @throws {TypeError} for a region {@link regiaoDaFilaValidaAmazon} refuses — a `/`
 *   would make it another path, and an empty one a well-formed path to nowhere.
 */
export function caminhoDaFilaAmazon(regiao: string): string {
  if (!regiaoDaFilaValidaAmazon(regiao)) {
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

/** Every enqueue failure a producer CONTAINS (persists for the sweep) instead of rethrowing. */
export type FalhaDeEnfileiramentoAmazon =
  | AmazonTarefasDesligadasError
  | AmazonTarefasTransitoriasError
  | FalhaDoSdkDeTarefasAmazon;

/**
 * `<classe>[/<codigo>]` of a contained enqueue failure: what a producer writes
 * after `enfileiramento/` on the failure document and in its log line. The
 * class and the code ONLY — never the SDK's message, which can quote a
 * response body.
 */
export function descreverFalhaDeEnfileiramentoAmazon(err: FalhaDeEnfileiramentoAmazon): string {
  if (err instanceof AmazonTarefasDesligadasError) return 'AmazonTarefasDesligadasError';
  if (err instanceof AmazonTarefasTransitoriasError) {
    return `AmazonTarefasTransitoriasError/${err.codigo}`;
  }
  return descreverFalhaDoSdkDeTarefasAmazon(err);
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
