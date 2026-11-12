/**
 * Feeds v2021-06-30 (`feeds_2021-06-30.json`) for ONE feed type,
 * `JSON_LISTINGS_FEED`: the four SP-API operations of a submission, the
 * document builder and the processing-report parser.
 *
 * - `createFeedDocument` — `POST /feeds/2021-06-30/documents`, through the WRITE
 *   client: {@link criarDocumentoFeedAmazon} (a document id and a pre-signed
 *   upload URL, valid 5 minutes). 0.5 requests per second, burst 15.
 * - `createFeed` — `POST /feeds/2021-06-30/feeds`, through the WRITE client:
 *   {@link criarFeedAmazon}. The model gives `createFeed` 0.0083 requests per
 *   second, burst 15, and says the rate limit of `JSON_LISTINGS_FEED` differs
 *   from it: the caller paces submissions, this module does not.
 * - `getFeed` — `GET /feeds/2021-06-30/feeds/{feedId}`, through the READ client:
 *   {@link lerFeedAmazon}. 2 requests per second, burst 15.
 * - `getFeedDocument` — `GET /feeds/2021-06-30/documents/{feedDocumentId}`,
 *   through the READ client: {@link lerDocumentoFeedAmazon} (the report's
 *   pre-signed download URL, valid 5 minutes). 0.0222 requests per second,
 *   burst 10.
 *
 * The document upload and the report download are not SP-API calls: they live
 * in `documentosFeed.ts`, with no credential and no observer event.
 *
 * Written from the model (printed by `node .master_plans/amazon/evidence/amazon-doc.mjs
 * op createFeed feeds`, and likewise for the other three), its sandbox examples
 * and Amazon's two published listings-feed JSON schemas (committed as test
 * fixtures), never from a live call (D11).
 *
 * ## One `feedId` grammar everywhere
 *
 * {@link FEED_ID_AMAZON_REGEX} is `^[0-9]{1,20}$`: digits only, at most 20.
 * The app's `redacao.test.ts` holds its log-redaction digit slot to exactly
 * this regex. The 202 schema applies it (a `createFeed` answer whose `feedId`
 * fails it is the client's `AmazonSchemaError`: the caller's uncertain path,
 * since the feed MAY have been created), and so does {@link lerFeedAmazon}
 * before anything is sent. A `feedId` that would break a document path or a
 * log line never enters the system.
 *
 * ## Every body is built from NAMED keys
 *
 * - `createFeedDocument`: EXACTLY `{ contentType }`, the constant
 *   {@link CONTENT_TYPE_FEED_JSON} (the upload must send the same value);
 * - `createFeed`: EXACTLY `{ feedType, marketplaceIds, inputFeedDocumentId }`,
 *   the feed type and the BR store being constants. No `feedOptions`, no second
 *   marketplace;
 * - the feed document: a `header` (`sellerId`, `version: '2.0'`,
 *   `issueLocale: 'pt_BR'`, no `report`: nothing reads the report's `items`) and
 *   one `PATCH` message per input, in the caller's order, `messageId` its 1-based
 *   position, minified and counted in UTF-8 BYTES. It is refused whole, never
 *   split: splitting is the caller's decision.
 *
 * ## The responses are TOLERANT where nothing is decided on them
 *
 * `getFeed` reads every field nullish and `processingStatus` as an OPEN string
 * ({@link STATUS_FEED_AMAZON} names the five the model lists). The two document
 * answers require their id and `url` (a document without either is unusable),
 * and the 202 requires its `feedId` under the grammar above. The processing
 * report requires its `summary` and the five counts (every number through
 * `wireInt()`); every issue field is optional (an issue may carry no
 * `messageId`, `sku` or `code`), and every object is `.passthrough()`.
 *
 * A write that failed its schema, a 5xx, a timeout or a dropped connection MAY
 * HAVE LANDED (`escrita.ts`): `createFeed` has no idempotency key, so the caller
 * never repeats it blindly.
 */
import { lerRespostaJson, wireInt } from '@delfrance/core/wire';
import { z } from 'zod';

import {
  MARKETPLACE_ID_BR,
  type RespostaSpApi,
  segmentoDeCaminho,
  type SpApiLeituraClient,
} from './client';
import type { SpApiEscritaClient } from './escrita';
import { AmazonConfigError, AmazonDocumentoFeedError } from './errors';
import { TIPO_PRODUTO_OFERTA } from './listings';

/** The model's `operationId`s, each call's label on the observer's event. */
export const OPERACAO_CRIAR_DOCUMENTO_FEED = 'createFeedDocument';
export const OPERACAO_CRIAR_FEED = 'createFeed';
export const OPERACAO_LER_FEED = 'getFeed';
export const OPERACAO_LER_DOCUMENTO_FEED = 'getFeedDocument';

/** The label a refused feed document reports: built here, nothing was sent. */
const OPERACAO_MONTAR_DOCUMENTO = 'montarDocumentoListingsFeed';

/** The documents path (`createFeedDocument`); `getFeedDocument` appends the id. */
export const CAMINHO_DOCUMENTOS_FEED = '/feeds/2021-06-30/documents';

/** The feeds path (`createFeed`); `getFeed` appends the id. */
export const CAMINHO_FEEDS = '/feeds/2021-06-30/feeds';

/** The one feed type this package submits. */
export const TIPO_FEED_LISTINGS = 'JSON_LISTINGS_FEED';

/** The feed document's content type: declared at `createFeedDocument`, sent on the upload. */
export const CONTENT_TYPE_FEED_JSON = 'application/json; charset=UTF-8';

/** The most messages one listings feed may carry (the schema's `messages.maxItems`). */
export const MAX_MENSAGENS_FEED = 25_000;

/** The most bytes a built document may have: under the 10 MB document limit, with a margin. */
export const MAX_BYTES_FEED = 9_500_000;

/** The listings feed specification version the header declares (the schema's `const`). */
export const VERSAO_FEED_LISTINGS = '2.0';

/** The locale the feed's issues are asked in. */
export const LOCALIDADE_ISSUES_FEED = 'pt_BR';

/** `processingStatus`, as the model lists it. An OPEN set: the schema reads any string. */
export const STATUS_FEED_AMAZON = {
  emFila: 'IN_QUEUE',
  emProcessamento: 'IN_PROGRESS',
  concluido: 'DONE',
  cancelado: 'CANCELLED',
  fatal: 'FATAL',
} as const satisfies Record<string, string>;

/**
 * The ONE `feedId` grammar (module header): digits only, 1 to 20. The app's
 * `redacao.test.ts` holds its log-redaction digit slot to exactly this regex.
 */
export const FEED_ID_AMAZON_REGEX = /^[0-9]{1,20}$/;

/* -------------------------------------------------------------------------- */
/*                                 The schemas                                */
/* -------------------------------------------------------------------------- */

/** `CreateFeedDocumentResponse` (201): the id and the pre-signed upload URL, both required. */
export const documentoFeedCriadoSchema = z
  .object({
    feedDocumentId: z.string().min(1),
    url: z.string().min(1),
  })
  .passthrough();

export type DocumentoFeedCriado = z.infer<typeof documentoFeedCriadoSchema>;

/** `CreateFeedResponse` (202): a `feedId` under {@link FEED_ID_AMAZON_REGEX}, or a schema error. */
export const feedCriadoSchema = z
  .object({
    feedId: z.string().regex(FEED_ID_AMAZON_REGEX),
  })
  .passthrough();

export type FeedCriado = z.infer<typeof feedCriadoSchema>;

/** `Feed` (200), tolerant (module header). */
export const feedAmazonSchema = z
  .object({
    feedId: z.string().nullish(),
    feedType: z.string().nullish(),
    marketplaceIds: z.array(z.string()).nullish(),
    processingStatus: z.string().nullish(),
    createdTime: z.string().nullish(),
    processingStartTime: z.string().nullish(),
    processingEndTime: z.string().nullish(),
    resultFeedDocumentId: z.string().nullish(),
  })
  .passthrough();

export type FeedAmazon = z.infer<typeof feedAmazonSchema>;

/** `FeedDocument` (200): the pre-signed download URL is required; `compressionAlgorithm` is open. */
export const documentoFeedSchema = z
  .object({
    feedDocumentId: z.string().nullish(),
    url: z.string().min(1),
    compressionAlgorithm: z.string().nullish(),
  })
  .passthrough();

export type DocumentoFeed = z.infer<typeof documentoFeedSchema>;

/** One processing-report issue: only `severity` and `message` are required in Amazon's schema. */
const issueRelatorioSchema = z
  .object({
    messageId: wireInt().nullish(),
    sku: z.string().nullish(),
    code: z.string().nullish(),
    severity: z.string().nullish(),
    message: z.string().nullish(),
    attributeName: z.string().nullish(),
  })
  .passthrough();

/** The listings feed processing report (module header): `summary` and its five counts required. */
export const relatorioProcessamentoListingsSchema = z
  .object({
    header: z
      .object({
        sellerId: z.string().nullish(),
        version: z.string().nullish(),
        feedId: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    issues: z.array(issueRelatorioSchema).nullish(),
    summary: z
      .object({
        errors: wireInt(),
        warnings: wireInt(),
        messagesProcessed: wireInt(),
        messagesAccepted: wireInt(),
        messagesInvalid: wireInt(),
      })
      .passthrough(),
  })
  .passthrough();

export type RelatorioProcessamentoListings = z.infer<typeof relatorioProcessamentoListingsSchema>;

/* -------------------------------------------------------------------------- */
/*                            The SP-API operations                           */
/* -------------------------------------------------------------------------- */

function recusarFeed(operacao: string): AmazonConfigError {
  return new AmazonConfigError('feed', { operacao, refCredencial: null });
}

/**
 * `createFeedDocument`, through the write client: body EXACTLY
 * `{ contentType: CONTENT_TYPE_FEED_JSON }`. Resolves with the document id and
 * the pre-signed upload URL. ⚠️ The URL is a bearer link: never stored, never
 * in an error, and kept out of every log line by the app's redaction.
 */
export async function criarDocumentoFeedAmazon(
  escritor: SpApiEscritaClient,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<DocumentoFeedCriado>> {
  return escritor.post({
    operacao: OPERACAO_CRIAR_DOCUMENTO_FEED,
    caminho: CAMINHO_DOCUMENTOS_FEED,
    corpo: JSON.stringify({ contentType: CONTENT_TYPE_FEED_JSON }),
    schema: documentoFeedCriadoSchema,
    sinal,
  });
}

/** What one `createFeed` submits: the uploaded document, nothing else. */
export interface EntradaCriacaoFeed {
  /** The `feedDocumentId` `createFeedDocument` answered, its document already uploaded. */
  readonly inputFeedDocumentId: string;
}

/**
 * `createFeed` of one `JSON_LISTINGS_FEED`, through the write client: body
 * EXACTLY `{ feedType, marketplaceIds: [BR], inputFeedDocumentId }`. A 202 whose
 * `feedId` fails {@link FEED_ID_AMAZON_REGEX} is `AmazonSchemaError` (module
 * header). An empty document id is `AmazonConfigError('feed')`, nothing sent.
 */
export async function criarFeedAmazon(
  escritor: SpApiEscritaClient,
  entrada: EntradaCriacaoFeed,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<FeedCriado>> {
  const { inputFeedDocumentId } = entrada;
  if (typeof inputFeedDocumentId !== 'string' || inputFeedDocumentId === '') {
    throw recusarFeed(OPERACAO_CRIAR_FEED);
  }
  return escritor.post({
    operacao: OPERACAO_CRIAR_FEED,
    caminho: CAMINHO_FEEDS,
    corpo: JSON.stringify({
      feedType: TIPO_FEED_LISTINGS,
      marketplaceIds: [MARKETPLACE_ID_BR],
      inputFeedDocumentId,
    }),
    schema: feedCriadoSchema,
    sinal,
  });
}

/**
 * `getFeed`, through the read client. A `feedId` outside
 * {@link FEED_ID_AMAZON_REGEX} is `AmazonConfigError('feed')`, nothing sent.
 */
export async function lerFeedAmazon(
  leitor: SpApiLeituraClient,
  feedId: string,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<FeedAmazon>> {
  if (typeof feedId !== 'string' || !FEED_ID_AMAZON_REGEX.test(feedId)) {
    throw recusarFeed(OPERACAO_LER_FEED);
  }
  return leitor.get({
    operacao: OPERACAO_LER_FEED,
    caminho: `${CAMINHO_FEEDS}/${feedId}`,
    schema: feedAmazonSchema,
    sinal,
  });
}

/**
 * `getFeedDocument`, through the read client: the report's pre-signed download
 * URL and its `compressionAlgorithm`. It does NOT send
 * `enableContentEncodingUrlHeader`: the download inflates a gzip itself, bounded
 * (`documentosFeed.ts`). A document id that cannot be one path segment is
 * `AmazonConfigError('feed')`, nothing sent.
 */
export async function lerDocumentoFeedAmazon(
  leitor: SpApiLeituraClient,
  feedDocumentId: string,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<DocumentoFeed>> {
  const segmento = segmentoDeCaminho(feedDocumentId);
  if (segmento === null) throw recusarFeed(OPERACAO_LER_DOCUMENTO_FEED);
  return leitor.get({
    operacao: OPERACAO_LER_DOCUMENTO_FEED,
    caminho: `${CAMINHO_DOCUMENTOS_FEED}/${segmento}`,
    schema: documentoFeedSchema,
    sinal,
  });
}

/* -------------------------------------------------------------------------- */
/*                             The feed document                              */
/* -------------------------------------------------------------------------- */

/** One JSON Patch operation of a listings message (the schema's four ops). */
export interface PatchListingAmazon {
  readonly op: 'add' | 'replace' | 'merge' | 'delete';
  readonly path: string;
  readonly value?: readonly Readonly<Record<string, unknown>>[];
}

/** One listings message as the caller hands it: the SKU and its patches. */
export interface MensagemListingsFeed {
  readonly sku: string;
  readonly patches: readonly PatchListingAmazon[];
}

/** What one feed document is built from. */
export interface EntradaDocumentoListingsFeed {
  /** The seller's id, as the document header declares it. */
  readonly sellerId: string;
  /** 1 to {@link MAX_MENSAGENS_FEED} messages, one per distinct SKU, in send order. */
  readonly mensagens: readonly MensagemListingsFeed[];
}

/** A built feed document: its UTF-8 bytes (minified JSON) and its message count. */
export interface DocumentoListingsFeed {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mensagens: number;
}

/**
 * The `JSON_LISTINGS_FEED` document (module header): the header, then one
 * `PATCH` message per input with `messageId` = its 1-based position and
 * `productType: 'PRODUCT'`, the patches copied by named keys. Refused whole
 * (`AmazonConfigError('feed')`): an empty `sellerId`, no message, more than
 * {@link MAX_MENSAGENS_FEED}, an empty or duplicate SKU, a message without
 * patches, or more than {@link MAX_BYTES_FEED} UTF-8 bytes once minified.
 */
export function montarDocumentoListingsFeed(
  entrada: EntradaDocumentoListingsFeed,
): DocumentoListingsFeed {
  const { sellerId, mensagens } = entrada;
  if (typeof sellerId !== 'string' || sellerId === '') throw recusarFeed(OPERACAO_MONTAR_DOCUMENTO);
  if (mensagens.length === 0 || mensagens.length > MAX_MENSAGENS_FEED) {
    throw recusarFeed(OPERACAO_MONTAR_DOCUMENTO);
  }
  const vistos = new Set<string>();
  const mensagensDoDocumento = mensagens.map((m, i) => {
    if (typeof m.sku !== 'string' || m.sku === '' || vistos.has(m.sku) || m.patches.length === 0) {
      throw recusarFeed(OPERACAO_MONTAR_DOCUMENTO);
    }
    vistos.add(m.sku);
    return {
      messageId: i + 1,
      sku: m.sku,
      operationType: 'PATCH',
      productType: TIPO_PRODUTO_OFERTA,
      patches: m.patches.map((p) => ({
        op: p.op,
        path: p.path,
        ...(p.value === undefined ? {} : { value: p.value }),
      })),
    };
  });

  const texto = JSON.stringify({
    header: { sellerId, version: VERSAO_FEED_LISTINGS, issueLocale: LOCALIDADE_ISSUES_FEED },
    messages: mensagensDoDocumento,
  });
  const bytes = new TextEncoder().encode(texto);
  if (bytes.byteLength > MAX_BYTES_FEED) throw recusarFeed(OPERACAO_MONTAR_DOCUMENTO);
  return { bytes, mensagens: mensagensDoDocumento.length };
}

/* -------------------------------------------------------------------------- */
/*                           The processing report                            */
/* -------------------------------------------------------------------------- */

/**
 * The listings feed processing report, from its decoded text: through the
 * shared JSON reader, then {@link relatorioProcessamentoListingsSchema}. Empty
 * or non-JSON text is `AmazonDocumentoFeedError('json-invalido')`; JSON that is
 * not a report is `'relatorio-invalido'`. Neither error carries a byte of the
 * text.
 */
export function lerRelatorioProcessamentoListings(texto: string): RelatorioProcessamentoListings {
  const leitura = lerRespostaJson(texto, relatorioProcessamentoListingsSchema);
  if (leitura.ok) return leitura.data;
  throw new AmazonDocumentoFeedError(
    leitura.motivo === 'formato' ? 'relatorio-invalido' : 'json-invalido',
  );
}
