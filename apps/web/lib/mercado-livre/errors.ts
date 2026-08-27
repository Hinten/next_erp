/**
 * Every `instanceof` narrowing for a FAILED Mercado Livre call, in one place —
 * the copy the operator reads AND whether repeating the call could plausibly
 * help.
 *
 * It replaces two near-duplicates that had drifted apart: the private
 * `reportableMessage` in `SizeChartEditorModal` and `mercadoLivreQueryErrorMessage`
 * in `canais/mercado-livre/_components/mercadoLivreJobErrors.ts`. The
 * `describe*StartError` pair stays where it is — those carry job-specific copy
 * and return `null` for "not mine" so the caller rethrows (root CLAUDE.md rule 6),
 * a different contract from this module's "always produce something to show".
 *
 * ⚠️ Reauth is keyed on the CODE, never on `status === 409`. A shared mapper
 * gives one meaning per status, and 409 is not one meaning: `sugerir-medidas`
 * answers 409 for `AI_DESATIVADA`, `AI_PROVEDOR_NAO_SUPORTADO` and
 * `AI_JA_EM_ANDAMENTO`, none of which are about the account connection. The old
 * `reportableMessage` keyed on the status and told the operator to reconnect a
 * perfectly healthy account.
 */
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';

const REAUTH_MESSAGE = 'Conta Mercado Livre não conectada — reconecte em Canais de venda.';
const DEFAULT_NETWORK_MESSAGE = 'Não foi possível contatar o Mercado Livre.';

/**
 * Failures the operator has to fix somewhere else. Repeating the request with
 * the same input cannot change the answer, so no retry is offered — a button
 * that cannot help is worse than no button.
 */
const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'ML_REAUTH_REQUIRED',
  'ML_PUBLISH_BLOCKED',
  'ML_IMPORT_BLOCKED',
  'ML_MASS_IMPORT_RUNNING',
  'ML_PRICE_SYNC_RUNNING',
  'SEM_TABELA_NORMAL',
  'ML_SELECAO_EXCEDE_LIMITE',
  'ML_CONTA_SEM_DEPOSITO',
  'ML_CONTA_PAUSADA',
  'ML_CONTA_MULTIORIGEM',
  // A 2xx whose body was not the shape this app claims. The same backend
  // answers the same way on a retry, so a button here only burns requests —
  // the fix is a deploy, which is what the message says.
  //
  // ⚠️ Listed explicitly even though the answer would come out `false` anyway:
  // `MercadoLivreClientRespostaInvalidaError` carries the real 2xx it arrived
  // on, and `retryableStatus` happens to reject those. Leaving it to that
  // coincidence means the decision lives in a function about SERVER faults and
  // silently flips if either side ever changes.
  'RESPOSTA_INVALIDA',
]);

export interface MercadoLivreFailureFallbacks {
  /** Copy when the request never reached the backend. */
  readonly network?: string;
  /** Copy for an error that is not a Mercado Livre client error at all. */
  readonly unknown: string;
}

export interface MercadoLivreFailure {
  /** What to show the operator. */
  readonly message: string;
  /** Whether repeating the SAME request could plausibly succeed. */
  readonly retryable: boolean;
}

/**
 * A transient HTTP answer: the backend (or Mercado Livre behind it) was
 * momentarily unable, not unwilling. 501 is excluded because
 * `<Channel>NotConfiguredError` is a permanent fact about the deployment.
 */
function retryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status !== 501;
}

/**
 * A request WE cancelled is not a failure. `client.ts` wraps the raw fetch
 * rejection, so an aborted `enviarEstoque`/`enviarPrecos` arrives here as a
 * `MercadoLivreClientNetworkError` whose `cause` is an `AbortError`. Retrying it
 * would restart exactly the work the operator just stopped.
 */
function wasAborted(err: MercadoLivreClientNetworkError): boolean {
  return err.cause instanceof DOMException && err.cause.name === 'AbortError';
}

/** The copy for a failed ML call, plus whether a retry is worth offering. */
export function describeMercadoLivreFailure(
  err: unknown,
  fallbacks: MercadoLivreFailureFallbacks,
): MercadoLivreFailure {
  if (err instanceof MercadoLivreClientHttpError) {
    if (err.code === 'ML_REAUTH_REQUIRED') {
      return { message: REAUTH_MESSAGE, retryable: false };
    }
    if (err.code != null && NON_RETRYABLE_CODES.has(err.code)) {
      return { message: err.message, retryable: false };
    }
    return { message: err.message, retryable: retryableStatus(err.status) };
  }
  if (err instanceof MercadoLivreClientNetworkError) {
    return {
      message: fallbacks.network ?? DEFAULT_NETWORK_MESSAGE,
      retryable: !wasAborted(err),
    };
  }
  return { message: fallbacks.unknown, retryable: false };
}

/** Message only — for the toast paths, which retry by letting the operator re-click. */
export function mercadoLivreErrorMessage(
  err: unknown,
  fallbacks: MercadoLivreFailureFallbacks,
): string {
  return describeMercadoLivreFailure(err, fallbacks).message;
}

/** Is this failure worth re-attempting automatically? Deny by default. */
export function isRetryableMercadoLivreError(err: unknown): boolean {
  return describeMercadoLivreFailure(err, { unknown: '' }).retryable;
}

/** Extra attempts a read query makes before the operator is shown the failure. */
export const ML_QUERY_MAX_RETRIES = 2;

/**
 * TanStack `retry` predicate for a READ query, so a one-off blip heals itself
 * and the operator never sees the alert.
 *
 * ⚠️ Reads only, and never on a poller. A query with a `refetchInterval` shorter
 * than the backoff ceiling stacks overlapping fetches against a backend that is
 * already down, multiplied by every card on screen — those keep `retry: false`
 * and rely on the next tick, which IS their retry.
 */
export function mercadoLivreQueryRetry(failureCount: number, err: unknown): boolean {
  return failureCount < ML_QUERY_MAX_RETRIES && isRetryableMercadoLivreError(err);
}
