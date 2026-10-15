/**
 * Every `instanceof` narrowing for the two Mercado Livre bulk jobs
 * ("Importar todos os anúncios" #621, "Atualizar preços" Step 11 PR-D), in one
 * place so the fan-out (`startJobsForContas`) stays pure and the hooks stay
 * thin.
 *
 * This module is Mercado Livre's implementation of the channel-neutral
 * `JobErrorDescription` port (`lib/marketplace/contaJobs/types.ts`) — it lives
 * here, next to the client whose error classes it narrows, while the fan-out
 * and the hook that consume it are shared (#1430).
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
import { mercadoLivreErrorMessage } from '@/lib/mercado-livre/errors';
import type { JobErrorDescription } from '@/lib/marketplace/contaJobs/types';

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
 * `POST /importar-todos/cancelar` failures.
 *
 * Job-specific copy first, then `mercadoLivreErrorMessage` for everything else —
 * so unlike the `describe*StartError` pair above this ALWAYS returns something.
 * That contract is deliberate: the caller is an async click handler that must
 * never rethrow (a throw there is an unhandled promise rejection React does not
 * catch), so "not mine" cannot mean "let it bubble" here.
 *
 * `ML_MASS_IMPORT_NOT_RUNNING` and a 404 are both benign races — the job
 * finished, or somebody else already cancelled it, between the card's last poll
 * and the click. Neither is worth alarming copy; the next poll shows the real
 * terminal state either way. Neither is retryable either, and both are already
 * non-retryable by status in the shared mapper, so no code needs adding to
 * `NON_RETRYABLE_CODES`.
 */
export function describeMassImportCancelError(err: unknown): string {
  if (err instanceof MercadoLivreClientHttpError) {
    if (err.code === 'ML_MASS_IMPORT_NOT_RUNNING') return 'Esta importação já foi finalizada.';
    if (err.status === 404) return 'Importação não encontrada.';
  }
  return mercadoLivreErrorMessage(err, {
    network: 'Falha de rede ao cancelar a importação.',
    unknown: 'Não foi possível cancelar a importação.',
  });
}

/**
 * `POST /atualizar-precos/cancelar` failures (#1144) — the price-sync twin of
 * the helper above, with the same always-returns-copy contract and for the same
 * reason: its caller is an async click handler that must never rethrow.
 *
 * ⚠️ The code is `ML_PRICE_SYNC_NOT_RUNNING`, one word from the start route's
 * `ML_PRICE_SYNC_RUNNING` and the opposite condition. Matching the wrong one
 * here shows "já existe um envio em andamento" to an operator whose envio has
 * just finished.
 */
export function describePriceSyncCancelError(err: unknown): string {
  if (err instanceof MercadoLivreClientHttpError) {
    if (err.code === 'ML_PRICE_SYNC_NOT_RUNNING') return 'Este envio de preços já foi finalizado.';
    if (err.status === 404) return 'Envio de preços não encontrado.';
  }
  return mercadoLivreErrorMessage(err, {
    network: 'Falha de rede ao cancelar o envio de preços.',
    unknown: 'Não foi possível cancelar o envio de preços.',
  });
}
