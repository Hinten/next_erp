/**
 * The `JSON_LISTINGS_FEED` submission's SIX package calls (step 12a, PR 12-c):
 * the ONE module of this app that calls `createFeedDocument`, the document
 * upload, `createFeed`, `getFeed`, `getFeedDocument` and the report download
 * (`estrutura.test.ts` pins the single caller across `lib/`, `app/`,
 * `functions/src` and `scripts/`). The feed handlers reach Amazon's feeds
 * through here and nowhere else, so no script can spend the conta's feed
 * budget beside them.
 *
 * ## The two pre-signed URLs never leave this module
 *
 * A document URL is a bearer link to the seller's feed. Each one is used here,
 * at once, by the call that needs it, and never returned, stored or logged:
 *
 * - {@link enviarDocumentoFeedNaAmazon} — `createFeedDocument`, then the PUT of
 *   the bytes to the URL it answered; it answers the document id alone.
 *   `emitidoEmMs` (our clock at the document's answer) is stamped here, so a
 *   403 from the storage reads `expirado` only past the URL's 5 minutes.
 * - {@link baixarRelatorioFeedNaAmazon} — `getFeedDocument`, then the bounded,
 *   verified download behind the URL it answered (the package's caps and gzip
 *   checks); it answers the parsed report alone.
 *
 * ## The two writes ride the ENGINE's refresh rule; the two reads their own
 *
 * - {@link enviarDocumentoFeedNaAmazon} and {@link criarFeedNaAmazon} run
 *   inside the batch entry's `escrever` (`core/escrita.ts`), through the write
 *   client the engine built, so the engine's forced-refresh-once rule already
 *   wraps them. ⚠️ They never wrap themselves in that rule a second time: two
 *   nested rules would turn one 401 into two refreshes and up to four
 *   submissions. A cut, 5xx or schema-failing `createFeed` MAY HAVE LANDED
 *   (`createFeed` has no idempotency key): its error is returned untouched for
 *   the caller's uncertain path, never repeated here.
 * - {@link lerFeedNaAmazon} and {@link baixarRelatorioFeedNaAmazon} read
 *   through the context's READ client under the forced-refresh-once rule
 *   (`core/renovacaoUnica.ts`): a 401/403 refreshes once and reads once more.
 *   The download itself carries no credential, so only `getFeedDocument` is
 *   ever re-run.
 *
 * ## `fetch` is REQUIRED
 *
 * The two transfers take the SAME `fetch` the caller handed its context (the
 * package's own rule: never defaulted to the global), so one scripted `fetch`
 * sees every request a test makes (D11). Both are gated TRANSITIVELY: their
 * URLs exist only in the answer of an SP-API call the read switch and the
 * valve already let through.
 *
 * Every failure is returned or thrown UNTOUCHED, with its own class — the
 * package's `AmazonDocumentoFeedError` (its closed `motivo`) for a transfer,
 * the client's classes for an SP-API call: what is transient, uncertain or
 * definitive is the handler's to decide.
 */
import {
  type FeedAmazon,
  type RelatorioProcessamentoListings,
  type SpApiEscritaClient,
  baixarRelatorioFeedAmazon,
  criarDocumentoFeedAmazon,
  criarFeedAmazon,
  enviarDocumentoFeedAmazon,
  lerDocumentoFeedAmazon,
  lerFeedAmazon,
} from '@delfrance/integrations-amazon-sp-api';

import type { ContextoAmazon } from '../core/contexto';
import { executarComRenovacaoUnica } from '../core/renovacaoUnica';

/** What the two reads need of a context: its read client and the access getter. */
export type ContextoDosFeedsAmazon = Pick<ContextoAmazon, 'cliente' | 'obterAcesso'>;

/** What the document's upload needs besides the bytes. */
export interface OpcoesEnvioDocumentoFeedNaAmazon {
  /** The SAME `fetch` the context received (module header). */
  readonly fetch: typeof globalThis.fetch;
  /** Now, in MILLISECONDS: stamps the document's answer. */
  readonly agora: () => number;
}

/**
 * `createFeedDocument`, then the upload of `bytes` to the URL it answered
 * (module header). Resolves with the document id once the storage answered
 * 2xx; the URL is never returned.
 */
export async function enviarDocumentoFeedNaAmazon(
  escritor: SpApiEscritaClient,
  bytes: Uint8Array<ArrayBuffer>,
  opcoes: OpcoesEnvioDocumentoFeedNaAmazon,
): Promise<{ readonly feedDocumentId: string }> {
  const { dados } = await criarDocumentoFeedAmazon(escritor);
  const emitidoEmMs = opcoes.agora();
  await enviarDocumentoFeedAmazon(dados.url, bytes, {
    fetch: opcoes.fetch,
    emitidoEmMs,
    agora: opcoes.agora,
  });
  return { feedDocumentId: dados.feedDocumentId };
}

/**
 * `createFeed` of the uploaded document, ONCE (module header): the `feedId`
 * Amazon answered, under the package's digits-only grammar. Its error is
 * thrown untouched.
 */
export async function criarFeedNaAmazon(
  escritor: SpApiEscritaClient,
  feedDocumentId: string,
): Promise<{ readonly feedId: string }> {
  const { dados } = await criarFeedAmazon(escritor, { inputFeedDocumentId: feedDocumentId });
  return { feedId: dados.feedId };
}

/** `getFeed`, under the forced-refresh-once rule (module header): Amazon's answer, read tolerantly. */
export async function lerFeedNaAmazon(
  contexto: ContextoDosFeedsAmazon,
  feedId: string,
): Promise<FeedAmazon> {
  const { dados } = await executarComRenovacaoUnica(contexto, () =>
    lerFeedAmazon(contexto.cliente, feedId),
  );
  return dados;
}

/** What the report's download needs: the SAME `fetch` the context received. */
export interface OpcoesDownloadRelatorioFeedNaAmazon {
  readonly fetch: typeof globalThis.fetch;
}

/**
 * `getFeedDocument` of the report under the forced-refresh-once rule, then the
 * download behind the URL it answered, with the compression it declared
 * (module header). Resolves with the parsed report; the URL is never returned.
 */
export async function baixarRelatorioFeedNaAmazon(
  contexto: ContextoDosFeedsAmazon,
  resultFeedDocumentId: string,
  opcoes: OpcoesDownloadRelatorioFeedNaAmazon,
): Promise<RelatorioProcessamentoListings> {
  const { dados } = await executarComRenovacaoUnica(contexto, () =>
    lerDocumentoFeedAmazon(contexto.cliente, resultFeedDocumentId),
  );
  return baixarRelatorioFeedAmazon(dados.url, {
    fetch: opcoes.fetch,
    compressao: dados.compressionAlgorithm,
  });
}
