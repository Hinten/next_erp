/**
 * The Listings Items calls of this app (step 12, PR 12-e1; the offer patch since
 * step 13): the ONE module that calls the package's listing read
 * (`lerListingAmazon`, `getListingsItem`), listing search
 * (`buscarListingsAmazon`, `searchListingsItems`), availability patch
 * (`enviarDisponibilidadeAmazon`) and offer patch (`enviarOfertaAmazon`, both
 * `patchListingsItem`), across `lib/`, `app/`, `functions/src` and `scripts/`.
 * The stock sync reaches Amazon's listings through here and nowhere else, and so
 * does every price send, so no script can spend the seller's per-seller listings
 * budget beside them.
 *
 * ## The two reads ride their own refresh rule; the patches ride the engine's
 *
 * - {@link lerListingNaAmazon} and {@link buscarListingsNaAmazon} read through
 *   the context's READ client under the forced-refresh-once rule
 *   (`core/renovacaoUnica.ts`): a 401/403 refreshes once and reads once more.
 * - {@link enviarDisponibilidadeNaAmazon} and {@link enviarOfertaNaAmazon} are a
 *   write engine's `escrever` (`core/escrita.ts`): each runs through the write
 *   client the engine built, inside the engine's own forced-refresh-once rule.
 *   ⚠️ Neither ever wraps itself in that rule a second time: two nested rules
 *   would turn one 401 into two refreshes and up to four PATCHes.
 *
 * ## "Not listed"
 *
 * A 404 on the read of ONE listing (`getListingsItem`, the SP-API's own answer
 * to that operation) is Amazon saying it has no listing of that SKU for this
 * seller: {@link lerListingNaAmazon} answers {@link NAO_LISTADO_AMAZON}. Any
 * other failure — an LWA exchange's 404 included — is thrown untouched, with its
 * own class: what is transient, a pause or a refusal is the caller's to decide.
 * A SKU absent from a SEARCH answer is not "not listed" here (a page may be
 * truncated): the search answers what it got, and `truncada`.
 *
 * ## The rate an answer carried
 *
 * {@link lerListingComTaxaNaAmazon} and {@link enviarOfertaComTaxaNaAmazon}
 * (step 13, PR 13-d) answer what {@link lerListingNaAmazon} and
 * {@link enviarOfertaNaAmazon} answer, plus `x-amzn-RateLimit-Limit` of the
 * answer (`limiteTaxa`, requests per second, `null` when it carried none or
 * when the read answered "not listed"), so a task logs the plan Amazon really
 * applies. The two shorter forms are those, minus the rate.
 *
 * ## Thin on purpose
 *
 * The SKU checks, the query keys, the bodies, the price range, the product type
 * and the mode checks, and the tolerant response schemas are the package's; this
 * module adds the context, the refresh rule and the 404 reading, and returns
 * Amazon's parsed answer. A PATCH that failed its schema, a 5xx, a timeout or a
 * dropped connection MAY HAVE LANDED: its error is thrown untouched, and never
 * repeated here.
 */
import {
  AmazonNotFoundError,
  DADOS_LISTING_AMAZON,
  type EntradaBuscaListings,
  type EntradaDisponibilidadeListing,
  type EntradaLeituraListing,
  type EntradaOfertaListing,
  type EnvioListingAmazon,
  type ListingAmazon,
  OPERACAO_LER_LISTING,
  type SpApiEscritaClient,
  buscarListingsAmazon,
  enviarDisponibilidadeAmazon,
  enviarOfertaAmazon,
  lerListingAmazon,
} from '@delfrance/integrations-amazon-sp-api';

import type { ContextoAmazon } from '../core/contexto';
import { executarComRenovacaoUnica } from '../core/renovacaoUnica';

/** What the two reads need of a context: its read client and the access getter. */
export type ContextoDosListingsAmazon = Pick<ContextoAmazon, 'cliente' | 'obterAcesso'>;

/**
 * The datasets every live read of a price send asks for (step 13), one listing
 * read or a search alike: the BR summaries (the status and the listing's own
 * product type), the attributes (the offer, read by the package's
 * `ofertaDoListingAmazon`), the issues (Amazon's price refusals) and the
 * relationships (a variation parent is never priced). Never the availability: a
 * price read decides nothing on stock.
 */
export const INCLUIR_LEITURA_PRECO = [
  DADOS_LISTING_AMAZON.resumos,
  DADOS_LISTING_AMAZON.atributos,
  DADOS_LISTING_AMAZON.issues,
  DADOS_LISTING_AMAZON.relacoes,
] as const satisfies EntradaLeituraListing['incluir'];

/** The read's answer when Amazon has no listing of the SKU for this seller (module header). */
export const NAO_LISTADO_AMAZON = 'nao-listado';

/** What one listing read answers: the listing, or that Amazon has none. */
export type LeituraListingNaAmazon = ListingAmazon | typeof NAO_LISTADO_AMAZON;

/** One listing read, and the rate its answer carried (module header). */
export interface LeituraComTaxaListingNaAmazon {
  readonly leitura: LeituraListingNaAmazon;
  /** `x-amzn-RateLimit-Limit`, requests per second; `null` when absent, or for "not listed". */
  readonly limiteTaxa: number | null;
}

/** One offer patch's submission answer, and the rate it carried (module header). */
export interface EnvioComTaxaListingNaAmazon {
  readonly resposta: EnvioListingAmazon;
  /** `x-amzn-RateLimit-Limit`, requests per second; `null` when absent. */
  readonly limiteTaxa: number | null;
}

/** What one search answers: the listings it got, and whether the page may lack some. */
export interface BuscaListingsNaAmazon {
  readonly itens: readonly ListingAmazon[];
  /** The package's reading: a requested SKU absent from a truncated page is UNKNOWN. */
  readonly truncada: boolean;
  /**
   * The rate Amazon applied to this answer (`x-amzn-RateLimit-Limit`, requests
   * per second), or `null` when the answer carried none: a caller pacing its
   * searches logs it, so the plan Amazon really applies is observed.
   */
  readonly limiteTaxa: number | null;
}

/** Whether `err` is the SP-API's own 404 to `getListingsItem` (module header). */
function ehListingAusente(err: unknown): boolean {
  return (
    err instanceof AmazonNotFoundError &&
    err.destino === 'sp-api' &&
    err.operacao === OPERACAO_LER_LISTING
  );
}

/**
 * `getListingsItem` of ONE SKU, under the forced-refresh-once rule (module
 * header): Amazon's listing, read tolerantly, or {@link NAO_LISTADO_AMAZON} on
 * that operation's 404. Every other failure is thrown untouched.
 */
export async function lerListingNaAmazon(
  contexto: ContextoDosListingsAmazon,
  entrada: EntradaLeituraListing,
): Promise<LeituraListingNaAmazon> {
  return (await lerListingComTaxaNaAmazon(contexto, entrada)).leitura;
}

/**
 * {@link lerListingNaAmazon}, plus the rate its answer carried (module header,
 * "The rate an answer carried").
 */
export async function lerListingComTaxaNaAmazon(
  contexto: ContextoDosListingsAmazon,
  entrada: EntradaLeituraListing,
): Promise<LeituraComTaxaListingNaAmazon> {
  try {
    const { dados, limiteTaxa } = await executarComRenovacaoUnica(contexto, () =>
      lerListingAmazon(contexto.cliente, entrada),
    );
    return { leitura: dados, limiteTaxa };
  } catch (err) {
    // Rule 6: only the read's own 404 is a reading; anything else is the caller's.
    if (ehListingAusente(err)) return { leitura: NAO_LISTADO_AMAZON, limiteTaxa: null };
    throw err;
  }
}

/**
 * `searchListingsItems` of up to 20 SKUs, under the forced-refresh-once rule
 * (module header): the listings Amazon answered, `truncada`, and the rate the
 * answer carried. The package refuses an invalid SKU list before anything is
 * sent.
 */
export async function buscarListingsNaAmazon(
  contexto: ContextoDosListingsAmazon,
  entrada: EntradaBuscaListings,
): Promise<BuscaListingsNaAmazon> {
  const resposta = await executarComRenovacaoUnica(contexto, () =>
    buscarListingsAmazon(contexto.cliente, entrada),
  );
  return {
    itens: resposta.dados.items ?? [],
    truncada: resposta.truncada,
    limiteTaxa: resposta.limiteTaxa,
  };
}

/**
 * ONE `patchListingsItem` with the stock merge (module header): a write
 * engine's `escrever`, through the write client the engine built. Amazon's
 * parsed submission answer (`ACCEPTED` or `INVALID`, the caller reads which);
 * any failure thrown untouched.
 */
export async function enviarDisponibilidadeNaAmazon(
  escritor: SpApiEscritaClient,
  entrada: EntradaDisponibilidadeListing,
): Promise<EnvioListingAmazon> {
  const { dados } = await enviarDisponibilidadeAmazon(escritor, entrada);
  return dados;
}

/**
 * ONE `patchListingsItem` with the offer merge (module header): a write
 * engine's `escrever`, through the write client the engine built, under the
 * caller's `tipoProduto` and, only when `modo` asks for it, Amazon's validation
 * preview (nothing persisted). The package refuses a price range, a product type
 * or a mode it does not send before anything is sent. Amazon's parsed submission
 * answer (`ACCEPTED`, `VALID` or `INVALID`, the caller reads which); any failure
 * thrown untouched.
 */
export async function enviarOfertaNaAmazon(
  escritor: SpApiEscritaClient,
  entrada: EntradaOfertaListing,
): Promise<EnvioListingAmazon> {
  return (await enviarOfertaComTaxaNaAmazon(escritor, entrada)).resposta;
}

/**
 * {@link enviarOfertaNaAmazon}, plus the rate its answer carried (module
 * header, "The rate an answer carried"): the price task's `escrever`.
 */
export async function enviarOfertaComTaxaNaAmazon(
  escritor: SpApiEscritaClient,
  entrada: EntradaOfertaListing,
): Promise<EnvioComTaxaListingNaAmazon> {
  const { dados, limiteTaxa } = await enviarOfertaAmazon(escritor, entrada);
  return { resposta: dados, limiteTaxa };
}
