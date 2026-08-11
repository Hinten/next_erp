/**
 * Every `instanceof` narrowing for the two Mercado Livre bulk jobs
 * ("Importar todos os anúncios" #621, "Atualizar preços" Step 11 PR-D), in one
 * place so the fan-out (`startJobsForContas`) stays pure and the hooks stay
 * thin.
 *
 * The `describe*StartError` pair returns `null` for anything that is NOT a
 * known Mercado Livre client failure — root `CLAUDE.md` rule 6: narrow, and
 * rethrow everything else. A `null` here means "not mine", and the caller
 * rethrows it AFTER committing the outcomes of the contas that did start.
 */
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';

/** How a contained per-conta failure is rendered: a colour plus its copy. */
export interface JobErrorDescription {
  readonly color: 'yellow' | 'red';
  readonly message: string;
}

/**
 * `POST /importar-todos` failures. `ML_MASS_IMPORT_RUNNING` is yellow, not red:
 * the conta already has a job running, which the panel then re-attaches to via
 * the running-job lookup — a state, not an error.
 */
export function describeMassImportStartError(err: unknown): JobErrorDescription | null {
  if (err instanceof MercadoLivreClientHttpError) {
    if (err.code === 'ML_MASS_IMPORT_RUNNING') {
      return { color: 'yellow', message: 'Já existe uma importação em andamento.' };
    }
    return { color: 'red', message: err.message };
  }
  if (err instanceof MercadoLivreClientNetworkError) {
    return { color: 'red', message: 'Falha de rede ao iniciar a importação.' };
  }
  return null;
}

/**
 * `POST /atualizar-precos` failures. `SEM_TABELA_NORMAL` (400) is a
 * configuration problem on that one conta and gets its own actionable copy —
 * with a multi-conta selection it is exactly the case a single toast could not
 * attribute to an account.
 */
export function describePriceSyncStartError(err: unknown): JobErrorDescription | null {
  if (err instanceof MercadoLivreClientHttpError) {
    if (err.code === 'ML_PRICE_SYNC_RUNNING') {
      return { color: 'yellow', message: 'Já existe um envio de preços em andamento.' };
    }
    if (err.code === 'SEM_TABELA_NORMAL') {
      return {
        color: 'red',
        message: 'Configure a tabela de preços normal da conta antes de enviar.',
      };
    }
    return { color: 'red', message: err.message };
  }
  if (err instanceof MercadoLivreClientNetworkError) {
    return { color: 'red', message: 'Falha de rede ao iniciar o envio de preços.' };
  }
  return null;
}

/**
 * Read-path counterpart: the message for a failed status/lookup query. Unlike
 * the start path this never returns `null` — a poll that fails is displayed,
 * not rethrown, because the job itself is unaffected by our inability to read
 * it. The two fallbacks stay distinct so "the backend is unreachable" never
 * reads as "the job is in an unknown state".
 */
export function mercadoLivreQueryErrorMessage(
  err: unknown,
  fallbacks: { readonly network: string; readonly unknown: string },
): string {
  if (err instanceof MercadoLivreClientHttpError) return err.message;
  if (err instanceof MercadoLivreClientNetworkError) return fallbacks.network;
  return fallbacks.unknown;
}
