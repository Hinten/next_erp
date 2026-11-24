/**
 * The task RUNGS every Amazon listings write task climbs the same way (step 13,
 * PR 13-b): ONE rule each, for every flow. The stock patch task
 * (`estoque/processarEstoque.ts`) binds all four.
 *
 * ## (1) The budget, with the write's credential IN HAND
 *
 * Cloud Tasks' concurrency 1 bounds DISPATCHES, not executions: a dispatch
 * past its timeout frees the slot while its code may still run, so a write
 * computed long ago must never go out after a fresher task's. The write client
 * awaits its credential getter outside any deadline (a Firestore read, an LWA
 * exchange when the token is stale) and then sends without another await, so
 * the check sits INSIDE that getter — and inside the forced refresh's, which
 * calls the same getter — never before it.
 * {@link contextoDaEscritaComOrcamentoListingAmazon} wraps the context's
 * getter: past the task's budget it throws the flow's own class (nothing was
 * sent); otherwise it hands the flow our clock at that instant (the outcome's
 * `emMs`, immediately before the write), then the credential.
 *
 * ## (2) The no-throw boundary
 *
 * Everything after a write that may have landed CONTAINS its named failures —
 * a Firestore error, a Cloud Tasks transient, a missing region, a raw task-SDK
 * failure, and the flow's own producer classes — and names the first one
 * (its CLASS, never its message): a throw there would read as the write
 * failing, and its retry would send again. An unnamed failure is a bug, and
 * crosses. {@link falhaContidaListingAmazon} builds a flow's classifier from
 * its producer's classes (never a built-in error class, which would contain
 * every unnamed failure); {@link contidoListingAmazon} runs ONE side effect
 * inside it; {@link classeDaFalhaListingAmazon} is the name a line carries.
 *
 * ## (3) The 429 pause
 *
 * A 429 was not processed: the task re-enqueues its own payload UNNAMED (its
 * producer's pause) and ends with NO throw, so no queue attempt is spent. The
 * re-enqueue itself failing with a contained class falls back to the queue's
 * OWN retry: nothing was sent, and a retry needs no enqueue — so the update is
 * kept at the cost of one attempt, never dropped. {@link pausarListingAmazon}
 * answers which; anything else crosses.
 *
 * ## (4) The write's own failure
 *
 * Every listings write is a `patchListingsItem`.
 * {@link envioTalvezAplicadoListingAmazon}: its OWN answer was a 5xx, a dropped
 * connection or a timeout, or a 2xx off its schema — the PATCH MAY HAVE LANDED
 * (never an LWA exchange's failure, never a 401/403 or a 429).
 * {@link envioRecusadoListingAmazon}, asked after the 429 and that one: its own
 * answer was any other HTTP failure — a definite refusal (a second 401/403
 * after the forced refresh included, a 3xx never followed). Anything else is
 * not the PATCH's answer: nothing was sent.
 */
import { MissingRegionError } from '@delfrance/core/region';
import { isGrpcStatusError } from '@delfrance/data/admin/grpcErrors';
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonSchemaError,
  AmazonThrottleError,
  OPERACAO_ENVIAR_LISTING,
} from '@delfrance/integrations-amazon-sp-api';

import type { ContextoAmazon } from '../core/contexto';
import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';

/* -------------------------------------------------------------------------- */
/*                         (1) the budget in the getter                        */
/* -------------------------------------------------------------------------- */

/** What a write context needs of the conta's context: its id and its credential getter. */
export type ContextoDaEscritaListingAmazon = Pick<ContextoAmazon, 'integracaoId' | 'obterAcesso'>;

/** The task's budget before its write (module header, rung 1). */
export interface OrcamentoDaEscritaListingAmazon {
  /** Now, in MILLISECONDS. */
  readonly agora: () => number;
  /** ms — when the dispatch began: the budget's origin. */
  readonly inicioMs: number;
  /** ms — the most the dispatch may have run when a write leaves. */
  readonly orcamentoMs: number;
  /** The flow's own class for a spent budget: nothing was sent. */
  readonly prazoEsgotado: () => Error;
  /** Our clock at the instant the credential is in hand: the outcome's `emMs`. */
  readonly carimbar: (agoraMs: number) => void;
}

/**
 * `contexto` with its credential getter wrapped (module header, rung 1): the
 * budget checked and the clock stamped with the credential IN HAND, before
 * every write the client sends.
 */
export function contextoDaEscritaComOrcamentoListingAmazon(
  contexto: ContextoDaEscritaListingAmazon,
  orcamento: OrcamentoDaEscritaListingAmazon,
): ContextoDaEscritaListingAmazon {
  return {
    integracaoId: contexto.integracaoId,
    obterAcesso: async (opcoes) => {
      const credencial = await contexto.obterAcesso(opcoes);
      const agoraMs = orcamento.agora();
      if (agoraMs - orcamento.inicioMs > orcamento.orcamentoMs) {
        throw orcamento.prazoEsgotado();
      }
      orcamento.carimbar(agoraMs);
      return credencial;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                          (2) the no-throw boundary                          */
/* -------------------------------------------------------------------------- */

/** A failure class a flow's producer rejects with (its queue valve, its region). */
export type ClasseDeFalhaListingAmazon = abstract new (...args: never[]) => Error;

/** The built-in error classes: an instance of one names no failure (module header, rung 2). */
const CLASSES_NATIVAS_DE_ERRO: readonly unknown[] = [
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
  AggregateError,
];

/**
 * The classifier of a flow's no-throw boundary (module header, rung 2): a
 * Firestore error, a Cloud Tasks transient, a missing region, a raw task-SDK
 * failure, or an instance of one of `doProdutor`. Anything else is an unnamed
 * bug.
 *
 * @throws {RangeError} a built-in error class in `doProdutor` (rule 6: it would
 *   contain every unnamed failure), nothing built.
 */
export function falhaContidaListingAmazon(
  doProdutor: readonly ClasseDeFalhaListingAmazon[],
): (err: unknown) => boolean {
  if (doProdutor.some((classe) => CLASSES_NATIVAS_DE_ERRO.includes(classe))) {
    throw new RangeError('escritaListing.ts: uma classe nativa de erro não nomeia uma falha');
  }
  return (err) =>
    isGrpcStatusError(err) ||
    err instanceof AmazonTarefasTransitoriasError ||
    doProdutor.some((classe) => err instanceof classe) ||
    err instanceof MissingRegionError ||
    ehFalhaDoSdkDeTarefasAmazon(err);
}

/** A failure's CLASS — its `name`, a Firestore one with its gRPC code, an SDK one described; never a message. */
export function classeDaFalhaListingAmazon(err: unknown): string {
  if (isGrpcStatusError(err)) return `Firestore/${String(err.code)}`;
  if (ehFalhaDoSdkDeTarefasAmazon(err)) return descreverFalhaDoSdkDeTarefasAmazon(err);
  const nome = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : null;
  return typeof nome === 'string' ? nome : 'desconhecido';
}

/**
 * ONE side effect inside the boundary (module header, rung 2): its value, or —
 * for a failure `ehContida` names — `null`, after `aoConter` received its
 * class. Anything else is rethrown untouched.
 */
export async function contidoListingAmazon<T>(
  fn: () => Promise<T>,
  ehContida: (err: unknown) => boolean,
  aoConter: (classe: string) => void,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (!ehContida(err)) throw err;
    aoConter(classeDaFalhaListingAmazon(err));
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                               (3) the 429 pause                             */
/* -------------------------------------------------------------------------- */

/** What the pause came to (module header, rung 3). */
export type PausaListingAmazon =
  /** The payload is back on the queue, unnamed: end with no throw. */
  | { readonly tipo: 'pausado' }
  /** The re-enqueue failed with a contained class: the queue's own retry, `causa` rethrown. */
  | { readonly tipo: 'retentar'; readonly causa: unknown; readonly classe: string };

/**
 * The 429 pause (module header, rung 3): `enfileirarPausa` (the flow's
 * producer re-enqueuing the payload UNNAMED), read by the flow's boundary
 * classifier.
 */
export async function pausarListingAmazon(
  enfileirarPausa: () => Promise<unknown>,
  ehContida: (err: unknown) => boolean,
): Promise<PausaListingAmazon> {
  try {
    await enfileirarPausa();
  } catch (err) {
    if (!ehContida(err)) throw err;
    return { tipo: 'retentar', causa: err, classe: classeDaFalhaListingAmazon(err) };
  }
  return { tipo: 'pausado' };
}

/* -------------------------------------------------------------------------- */
/*                          (4) the write's own failure                        */
/* -------------------------------------------------------------------------- */

/**
 * Whether the PATCH's OWN failure means it MAY HAVE LANDED (module header,
 * rung 4): a 5xx, a dropped connection or a timeout, or a 2xx off its schema —
 * each of the SP-API's answer to `patchListingsItem` itself, never an LWA
 * exchange's.
 */
export function envioTalvezAplicadoListingAmazon(err: unknown): boolean {
  if (err instanceof AmazonAuthError || err instanceof AmazonThrottleError) return false;
  if (err instanceof AmazonHttpError) {
    return err.transitorio && err.destino === 'sp-api' && err.operacao === OPERACAO_ENVIAR_LISTING;
  }
  if (err instanceof AmazonNetworkError || err instanceof AmazonSchemaError) {
    return err.destino === 'sp-api' && err.operacao === OPERACAO_ENVIAR_LISTING;
  }
  return false;
}

/**
 * Whether Amazon answered the PATCH with an HTTP failure (module header, rung
 * 4) — read after the 429 pause and {@link envioTalvezAplicadoListingAmazon},
 * a definite refusal.
 */
export function envioRecusadoListingAmazon(err: unknown): boolean {
  return (
    err instanceof AmazonHttpError &&
    err.destino === 'sp-api' &&
    err.operacao === OPERACAO_ENVIAR_LISTING
  );
}
