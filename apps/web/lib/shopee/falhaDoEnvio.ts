/**
 * The ONE catch ladder the three Shopee push providers share — stock, price and
 * pause/reactivate (`lib/marketplace/{estoque,preco,anuncioStatus}/providers/shopee.ts`,
 * #1529 step 21).
 *
 * All three call one conta-scoped route with the whole selection, and all three
 * can fail the same four ways BEFORE any per-listing row exists: the operator
 * cancelled, Shopee's daily quota paused the conta, the backend refused the conta
 * (a 400 / 409 / 422 with its own sentence), or the backend was unreachable. Each
 * provider turns the verdict into one row per requested produto — the shape the
 * Mercado Livre providers' HTTP arm already gives a conta-level refusal — so this
 * ladder is written once instead of three times.
 *
 * ⚠️ Narrowed by CLASS only (root `CLAUDE.md` rule 6). Anything this does not
 * recognise is `null`, and the caller rethrows it — never a generic catch.
 *
 * ⚠️ A cancel is told apart by `signal.aborted`, never by the error's shape: the
 * client turns an in-flight abort into a {@link ShopeeClientNetworkError} whose
 * `cause` is the `DOMException`, and a body-read abort rethrows the
 * `DOMException` itself (`client.ts`, `lerCorpo`). Reading the signal covers
 * both — and keeps a REAL network failure that happens while nobody cancelled
 * from being swallowed as a cancel.
 */
import { parseIsoToMillis } from '@delfrance/core/datetime';
import { FUSO_FISCAL } from '@delfrance/schemas';

import { ShopeeClientHttpError, ShopeeClientNetworkError } from './client';
import { CODIGO_FALHA_SHOPEE } from './erros';

/** What a conta-level failure of a push turned into. */
export type FalhaDoEnvio =
  /** The operator hit Cancelar. No rows: the run reports the cancellation itself. */
  | { tipo: 'cancelado' }
  /** One row per requested produto, all carrying this verdict. */
  | {
      tipo: 'conta';
      /** `nao-tentado` for a quota pause (nothing was attempted), `falha` otherwise. */
      outcome: 'falha' | 'nao-tentado';
      motivo: string;
      /** Operator copy — the backend's own sentence whenever it sent one. */
      mensagem: string;
      /** ISO-8601 the pause ends, for the channel result; `null` unless paused. */
      pausadoAte: string | null;
    };

/** The network copy — the Mercado Livre providers' sentence, naming this channel. */
const MENSAGEM_REDE = 'Não foi possível contatar o serviço da Shopee.';

/**
 * The pause's end, as the operator reads it.
 *
 * ⚠️ In {@link FUSO_FISCAL} (São Paulo), with an EXPLICIT zone: the sentence is
 * the same on every operator's machine, never the browser's ambient zone.
 */
const FORMATO_PAUSA = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO_FISCAL,
  dateStyle: 'short',
  timeStyle: 'short',
});

/**
 * ` A pausa vence em <data e hora>.` — or `''` when the body carried no instant
 * or one this build cannot read (the backend's sentence then stands alone,
 * which is still true).
 */
function sufixoDaPausa(pausadoAte: string | null): string {
  if (pausadoAte === null) return '';
  const ms = parseIsoToMillis(pausadoAte);
  if (ms === null) return '';
  return ` A pausa vence em ${FORMATO_PAUSA.format(ms)}.`;
}

/**
 * Classify a failed Shopee push call. `null` ⇒ not ours: the caller rethrows.
 *
 * - **cancelled** — `signal.aborted` and the failure is the abort itself (either
 *   shape, see the module doc);
 * - **paused** — 409 `SHOPEE_CONTA_PAUSADA`: `nao-tentado`, with the backend's
 *   sentence plus when the pause ends;
 * - **any other backend refusal** — `falha`, keeping the verdict's own slug when
 *   the body names one (`detalhes.motivo`, e.g. a 422 `SHOPEE_PRECO_CONTA_RECUSADA`
 *   `regiao-nao-br`), else the code. `ShopeeClientRespostaInvalidaError` is a
 *   subclass and lands here too, with its own message;
 * - **unreachable** — `falha` / `rede`.
 */
export function classificarFalhaDoEnvioShopee(
  err: unknown,
  signal: AbortSignal | undefined,
): FalhaDoEnvio | null {
  const cancelou = signal?.aborted === true;
  if (
    cancelou &&
    (err instanceof ShopeeClientNetworkError ||
      (err instanceof DOMException && err.name === 'AbortError'))
  ) {
    return { tipo: 'cancelado' };
  }
  if (err instanceof ShopeeClientHttpError) {
    const { pausadoAte, motivo } = err.detalhes;
    if (err.code === CODIGO_FALHA_SHOPEE.contaPausada) {
      return {
        tipo: 'conta',
        outcome: 'nao-tentado',
        motivo: 'conta-pausada',
        mensagem: err.message + sufixoDaPausa(pausadoAte),
        pausadoAte,
      };
    }
    // The backend's sentence is already operator copy; a 422 verdict keeps its slug.
    return {
      tipo: 'conta',
      outcome: 'falha',
      motivo: motivo ?? err.code ?? 'erro-http',
      mensagem: err.message,
      pausadoAte: null,
    };
  }
  if (err instanceof ShopeeClientNetworkError) {
    return {
      tipo: 'conta',
      outcome: 'falha',
      motivo: 'rede',
      mensagem: MENSAGEM_REDE,
      pausadoAte: null,
    };
  }
  return null;
}
