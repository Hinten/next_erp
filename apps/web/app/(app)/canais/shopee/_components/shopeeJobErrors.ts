/**
 * Every `instanceof` narrowing for the two Shopee account-wide jobs (#1529, step
 * 21-5) — "Importar todos os anúncios" and "Atualizar preços" — in one place, so
 * the shared fan-out (`lib/marketplace/contaJobs`) stays channel-free and the
 * hooks stay thin. Shopee's implementation of the `JobErrorDescription` port,
 * beside the cards that use it; Mercado Livre's twin is
 * `canais/mercado-livre/_components/mercadoLivreJobErrors.ts`.
 *
 * Keyed on the backend's `code` (through `CODIGO_FALHA_SHOPEE`), never on a
 * status: a 409 here is "already running", "paused on the quota" or "already
 * finished", and each asks the operator for something different.
 *
 * The start describers return `null` for anything that is not a Shopee client
 * failure — root `CLAUDE.md` rule 6: the fan-out commits the contas that did
 * start, then rethrows it.
 */
import { parseIsoToMillis } from '@delfrance/core/datetime';

import type { ErrosDoCliente } from '@/components/contaJobs/JobCardShell';
import type { JobErrorDescription } from '@/lib/marketplace/contaJobs/types';
import { ShopeeClientHttpError, ShopeeClientNetworkError } from '@/lib/shopee/client';
import { CODIGO_FALHA_SHOPEE, descreverFalhaShopee } from '@/lib/shopee/erros';
import { formatarInstanteJob } from './cadenciaJobsShopee';

/**
 * The Shopee client's own classes, handed to the shared `JobCardShell` with every
 * cancel: a cancel that fails with one of them is already described by the
 * cancel describers below; anything else also reaches the console under
 * `[shopee]`.
 */
export const ERROS_DO_CLIENTE_SHOPEE: ErrosDoCliente = {
  tagLog: '[shopee]',
  classes: [ShopeeClientHttpError, ShopeeClientNetworkError],
};

/**
 * The running job a busy start answered with — the 409 carries its id since
 * step 21 — or `null`. `codigo` is the flow's OWN "already running" code.
 *
 * ⚠️ Matches the code EXACTLY. `SHOPEE_CONTA_PAUSADA` is also a 409, and
 * `…_NOT_RUNNING` (the cancel's) is one word from `…_RUNNING` with the opposite
 * meaning; a body that happened to carry a `jobId` under either must never
 * attach a card to it.
 */
export function jobIdDoJobEmAndamento(err: unknown, codigo: string): string | null {
  return err instanceof ShopeeClientHttpError && err.code === codigo ? err.detalhes.jobId : null;
}

/** Appended when a busy start names no job — an older backend's 409. */
const SEM_JOB_PARA_ACOMPANHAR = ' Não foi possível identificar o job para acompanhá-lo daqui.';

/** The per-flow half of {@link descreverFalhaAoIniciar}. */
interface FluxoDeInicio {
  readonly codigoEmAndamento: string;
  readonly codigoNaoEnfileirado: string;
  readonly rede: string;
  readonly desconhecido: string;
}

/**
 * The quota pause as the operator reads it, or the backend's own sentence when
 * the body carried no instant this build can read (still true on its own).
 */
function textoDaPausa(err: ShopeeClientHttpError): string {
  const { pausadoAte } = err.detalhes;
  const ms = pausadoAte === null ? null : parseIsoToMillis(pausadoAte);
  if (ms === null) return err.message;
  return `A cota de chamadas da Shopee está esgotada até ${formatarInstanteJob(ms)} — tente depois disso.`;
}

function descreverFalhaAoIniciar(err: unknown, fluxo: FluxoDeInicio): JobErrorDescription | null {
  if (err instanceof ShopeeClientHttpError) {
    const { code } = err;
    if (code === fluxo.codigoEmAndamento) {
      // Yellow: a state, not a fault. With a `jobId` the action hooks attach
      // instead and this arm is never reached; without one, say so.
      return {
        color: 'yellow',
        message: err.message + (err.detalhes.jobId === null ? SEM_JOB_PARA_ACOMPANHAR : ''),
      };
    }
    if (code === fluxo.codigoNaoEnfileirado) {
      // The backend's own sentence (the closed valve, or the class that stopped
      // the first dispatch) — the operator's only clue to what is missing.
      return { color: 'red', message: err.message };
    }
    if (code === CODIGO_FALHA_SHOPEE.contaSemTabelaNormal) {
      return {
        color: 'red',
        message: 'Configure a tabela de preços normal da conta antes de enviar.',
      };
    }
    if (code === CODIGO_FALHA_SHOPEE.contaPausada) {
      return { color: 'yellow', message: textoDaPausa(err) };
    }
    if (code === CODIGO_FALHA_SHOPEE.precoContaRecusada) {
      // Already operator copy (`errosPreco.ts`'s table on the backend).
      return { color: 'red', message: err.message };
    }
    return {
      color: 'red',
      message: descreverFalhaShopee(err, { desconhecido: fluxo.desconhecido }).mensagem,
    };
  }
  if (err instanceof ShopeeClientNetworkError) {
    return { color: 'red', message: fluxo.rede };
  }
  return null;
}

/** `POST …/importar-todos` failures. */
export function descreverFalhaAoIniciarImportacao(err: unknown): JobErrorDescription | null {
  return descreverFalhaAoIniciar(err, {
    codigoEmAndamento: CODIGO_FALHA_SHOPEE.importacaoEmAndamento,
    codigoNaoEnfileirado: CODIGO_FALHA_SHOPEE.importacaoNaoEnfileirada,
    rede: 'Falha de rede ao iniciar a importação.',
    desconhecido: 'Não foi possível iniciar a importação.',
  });
}

/** `POST …/atualizar-precos` failures. */
export function descreverFalhaAoIniciarAtualizacaoPrecos(err: unknown): JobErrorDescription | null {
  return descreverFalhaAoIniciar(err, {
    codigoEmAndamento: CODIGO_FALHA_SHOPEE.envioPrecoEmAndamento,
    codigoNaoEnfileirado: CODIGO_FALHA_SHOPEE.envioPrecoNaoEnfileirado,
    rede: 'Falha de rede ao iniciar a atualização de preços.',
    desconhecido: 'Não foi possível iniciar a atualização de preços.',
  });
}

/**
 * `POST …/importar-todos/cancelar` failures. ALWAYS returns copy: the caller is
 * an async click handler that must never rethrow (Mercado Livre's contract).
 * A finished job and a 404 are both benign races — the next poll shows the real
 * terminal state.
 */
export function descreverFalhaAoCancelarImportacao(err: unknown): string {
  if (err instanceof ShopeeClientHttpError) {
    if (err.code === CODIGO_FALHA_SHOPEE.importacaoNaoEmAndamento) {
      return 'Esta importação já foi finalizada.';
    }
    if (err.status === 404) return 'Importação não encontrada.';
  }
  return descreverFalhaShopee(err, { desconhecido: 'Não foi possível cancelar a importação.' })
    .mensagem;
}

/**
 * `POST …/atualizar-precos/cancelar` failures — the twin above, same contract.
 *
 * ⚠️ `SHOPEE_PRICE_SYNC_NOT_RUNNING`, one word from the start's
 * `SHOPEE_PRICE_SYNC_RUNNING` and the opposite condition.
 */
export function descreverFalhaAoCancelarAtualizacaoPrecos(err: unknown): string {
  if (err instanceof ShopeeClientHttpError) {
    if (err.code === CODIGO_FALHA_SHOPEE.envioPrecoNaoEmAndamento) {
      return 'Esta atualização de preços já foi finalizada.';
    }
    if (err.status === 404) return 'Atualização de preços não encontrada.';
  }
  return descreverFalhaShopee(err, {
    desconhecido: 'Não foi possível cancelar a atualização de preços.',
  }).mensagem;
}
