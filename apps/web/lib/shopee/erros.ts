/**
 * Every `instanceof` narrowing for a FAILED Shopee read of the `/medidas` tab
 * (#1526, step 18), in one place — the copy the operator reads AND whether
 * repeating the call could plausibly help. The `lib/mercado-livre/errors.ts`
 * shape, for this channel's client.
 *
 * ⚠️ Keyed on the backend's `code` and `kind`, NEVER on the status. A status is
 * not one meaning: a 404 is a stale template (`SHOPEE_TABELA_MEDIDAS_INEXISTENTE`),
 * a category gone from the tree (`SHOPEE_CATEGORIA_DESCONHECIDA`), a category
 * Shopee refuses for templates, or a backend that predates the route; a 502 is a
 * Shopee rate limit (`kind: 'burst'` / `'daily'`) and also a request Shopee will
 * never accept. Reading the status would give each of those one sentence, and
 * every one of them asks the operator for something different.
 *
 * ⚠️ No automatic retry of a 502, ever ({@link shopeeQueryRetry}). Today a rate
 * limit reaches the browser as a 502, and the template list fans out one Shopee
 * detail read per template — an automatic retry multiplies exactly the calls
 * that tripped the limit.
 */
import { ShopeeClientHttpError, ShopeeClientNetworkError } from './client';

/**
 * The backend codes this module gives their own copy. The strings are the
 * routes' (`apps/shopee/app/api/marketplace/shopee/{tabela-medidas,taxonomia}/…`
 * and `lib/shopee/core/respond.ts`); a caller that must BRANCH on one — the
 * manager offering "Trocar" on a stale template — reads it through
 * {@link codigoDaFalhaShopee} and this constant, never a retyped literal.
 */
export const CODIGO_FALHA_SHOPEE = {
  tabelaMedidasInexistente: 'SHOPEE_TABELA_MEDIDAS_INEXISTENTE',
  categoriaDesconhecida: 'SHOPEE_CATEGORIA_DESCONHECIDA',
  tabelaMedidasCategoriaInvalida: 'SHOPEE_TABELA_MEDIDAS_CATEGORIA_INVALIDA',
  reautenticar: 'SHOPEE_REAUTH_REQUIRED',
  contaSemShopId: 'SHOPEE_CONTA_SEM_SHOP_ID',
  respostaInvalida: 'RESPOSTA_INVALIDA',
} as const satisfies Record<string, string>;

/** Shopee's two rate-limit classes, as the backend's 502 body names them in `kind`. */
const KINDS_DE_LIMITE: ReadonlySet<string> = new Set(['burst', 'daily']);

/**
 * A stored template the shop no longer has. Exported because the tab's row
 * shows it WITHOUT calling {@link descreverFalhaShopee} (it branches on the
 * code first, to turn "Trocar" red) — one sentence, never a re-spelled twin.
 */
export const MENSAGEM_TABELA_INEXISTENTE = 'Esta tabela não existe mais na loja — escolha outra.';
/** A stored category the conta's tree no longer holds — the browser's note reads it too. */
export const MENSAGEM_CATEGORIA_DESCONHECIDA =
  'A categoria guardada não existe mais na árvore desta conta — escolha outra.';
const MENSAGEM_RECONECTAR = 'Reconecte a conta Shopee em Canais de venda.';
const MENSAGEM_LIMITE = 'A Shopee limitou as consultas — tente em alguns minutos.';
const MENSAGEM_REDE = 'Não foi possível contatar a integração com a Shopee.';

export interface FalhaShopee {
  /** What to show the operator — pt-BR, saying what to DO. */
  readonly mensagem: string;
  /** Whether offering "Tentar de novo" for the SAME request could plausibly help. */
  readonly repetivel: boolean;
}

/**
 * The backend's `code` on a failed call, or `null` — the one place a caller
 * reads it, so a branch on a code is written against {@link CODIGO_FALHA_SHOPEE}.
 * A network failure, a foreign error and an envelope with no code are all `null`.
 */
export function codigoDaFalhaShopee(err: unknown): string | null {
  return err instanceof ShopeeClientHttpError ? err.code : null;
}

/**
 * A request WE cancelled is not a failure to repeat: the client wraps the raw
 * fetch rejection, so an aborted read arrives as a `ShopeeClientNetworkError`
 * whose `cause` is the `AbortError` (the ML convention, `lib/mercado-livre/errors.ts`).
 */
function foiAbortada(err: ShopeeClientNetworkError): boolean {
  return err.cause instanceof DOMException && err.cause.name === 'AbortError';
}

/**
 * Whether an HTTP failure with NO copy of its own is worth a manual retry.
 * A 503 is transient by construction (`SHOPEE_NETWORK_ERROR`, the refresh lease);
 * a 502 only when the backend classified Shopee's failure as `transient` —
 * every other 502 is a refusal or a shape the same call will produce again;
 * 501 is a fact about the deployment.
 */
function statusRepetivel(err: ShopeeClientHttpError): boolean {
  if (err.status === 502) return err.kind === 'transient';
  if (err.status === 408 || err.status === 429) return true;
  return err.status >= 500 && err.status !== 501;
}

/**
 * The copy for a failed Shopee read, plus whether a manual retry is worth
 * offering. Always produces something to show: an error that is not a Shopee
 * client error at all gets `opts.desconhecido`, not repeatable.
 */
export function descreverFalhaShopee(
  err: unknown,
  opts: { readonly desconhecido: string },
): FalhaShopee {
  if (err instanceof ShopeeClientHttpError) {
    const { code } = err;
    if (code === CODIGO_FALHA_SHOPEE.tabelaMedidasInexistente) {
      return { mensagem: MENSAGEM_TABELA_INEXISTENTE, repetivel: false };
    }
    if (code === CODIGO_FALHA_SHOPEE.categoriaDesconhecida) {
      return { mensagem: MENSAGEM_CATEGORIA_DESCONHECIDA, repetivel: false };
    }
    if (code === CODIGO_FALHA_SHOPEE.reautenticar || code === CODIGO_FALHA_SHOPEE.contaSemShopId) {
      return { mensagem: MENSAGEM_RECONECTAR, repetivel: false };
    }
    if (
      // The backend's sentence names the category; it is already the copy.
      code === CODIGO_FALHA_SHOPEE.tabelaMedidasCategoriaInvalida ||
      // A 2xx in a shape this build does not know: the same backend answers
      // the same way again, and the message already names the deploy.
      code === CODIGO_FALHA_SHOPEE.respostaInvalida
    ) {
      return { mensagem: err.message, repetivel: false };
    }
    if (err.kind !== null && KINDS_DE_LIMITE.has(err.kind)) {
      return { mensagem: MENSAGEM_LIMITE, repetivel: false };
    }
    // A dead grant normally arrives as the 409 above; a Shopee failure the
    // backend classified `reauth` under any other code asks for the same act.
    if (err.kind === 'reauth') return { mensagem: MENSAGEM_RECONECTAR, repetivel: false };
    return { mensagem: err.message, repetivel: statusRepetivel(err) };
  }
  if (err instanceof ShopeeClientNetworkError) {
    return { mensagem: MENSAGEM_REDE, repetivel: !foiAbortada(err) };
  }
  return { mensagem: opts.desconhecido, repetivel: false };
}

/** Extra attempts a Shopee READ query makes before the operator sees the failure. */
export const SHOPEE_QUERY_MAX_RETRIES = 2;

/**
 * TanStack `retry` predicate for a Shopee READ query: a one-off network blip or
 * a 503 heals itself, NOTHING else is repeated — and never a 502 (module header).
 * Deny by default: an error this predicate does not recognise is not retried.
 */
export function shopeeQueryRetry(failureCount: number, err: unknown): boolean {
  if (failureCount >= SHOPEE_QUERY_MAX_RETRIES) return false;
  if (err instanceof ShopeeClientNetworkError) return !foiAbortada(err);
  return err instanceof ShopeeClientHttpError && err.status === 503;
}
