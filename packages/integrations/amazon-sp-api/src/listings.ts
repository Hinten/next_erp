/**
 * Listings Items v2021-08-01 (`listingsItems_2021-08-01.json`): the three
 * listings operations the stock sync rides.
 *
 * - `getListingsItem` — `GET /listings/2021-08-01/items/{sellerId}/{sku}`,
 *   through the READ client: {@link lerListingAmazon}. 5 requests per second,
 *   burst 10.
 * - `searchListingsItems` — `GET /listings/2021-08-01/items/{sellerId}`, up to 20
 *   SKUs per call, through the READ client: {@link buscarListingsAmazon}. 5
 *   requests per second, burst 5.
 * - `patchListingsItem` — `PATCH /listings/2021-08-01/items/{sellerId}/{sku}`,
 *   through the WRITE client (`escrita.ts`): {@link enviarDisponibilidadeAmazon},
 *   the stock merge and nothing else. 5 requests per second, burst 5.
 *
 * Written from the model (printed by `node .master_plans/amazon/evidence/amazon-doc.mjs
 * op getListingsItem listings`, and likewise for the other two) and its own
 * sandbox examples, never from a live call (D11).
 *
 * ## The SKU travels in the path, so it must be ONE segment
 *
 * {@link segmentoSkuAmazon} is the reviewed segment encoder: `encodeURIComponent`,
 * and `null` for a SKU that is empty, holds `/` or `\`, contains `..`, equals
 * `.`, or whose encoded segment the client's own path check would refuse
 * (`segmentoDeCaminho` beside `caminhoValido` in `client.ts`, imported, never
 * copied). No escaping trick reaches Amazon unchanged for those SKUs, so a
 * helper refuses them with `AmazonConfigError('sku')` before anything is read or
 * sent. The `sellerId` is held to the same one-segment rule, and refused with
 * `AmazonConfigError('caminho')`.
 *
 * ## A search list is comma-delimited
 *
 * `identifiers` is ONE query value, the SKUs joined by `,`. So
 * {@link skuBuscavelAmazon} refuses a SKU holding a `,` (it would read as two),
 * a space (`URLSearchParams` sends it as `+`, and whether Amazon reads that back
 * as a space is unknown) or more than 40 code points (the app's SKU grammar);
 * such a SKU is read alone, with {@link lerListingAmazon}, whose path segment is
 * percent-encoded.
 *
 * ## Every query and body is built from NAMED keys
 *
 * - `includedData` is the caller's closed {@link DadoListingAmazon} list, joined
 *   from this module's constants (in their order), never the caller's strings;
 * - `issueLocale` is always `pt_BR` (the model: an unavailable locale falls back
 *   to `en_US`); `marketplaceIds` is always the BR store's;
 * - the stock body is EXACTLY one `merge` of `/attributes/fulfillment_availability`
 *   with `fulfillment_channel_code: 'DEFAULT'` and the quantity, under
 *   `productType: 'PRODUCT'`. Never `replace` (Amazon's `replace` drops every
 *   field the body omits, such as a lead time), never a lead time, never a
 *   `marketplace_id` inside `value`, never a `mode` (`VALIDATION_PREVIEW`), and
 *   `includedData` is left to the model's default (`issues`).
 *
 * ## The responses are TOLERANT
 *
 * Every number goes through `wireInt()`, every enum is an OPEN string, every
 * object is `.passthrough()`, and every field is `.nullish()` except the item's
 * `sku`. A `fulfillmentAvailability` entry without `quantity` parses (the model
 * marks it optional), and so do an unknown status and an unknown channel code:
 * deciding what they MEAN (an AFN listing, a variation parent) is the app's.
 * The search answer's paging tokens are read only as present or absent.
 *
 * ## What it is not
 *
 * No `putListingsItem`, no `deleteListingsItem`, no `purchasable_offer` body, no
 * `VALIDATION_PREVIEW`. A PATCH that failed its schema, a 5xx, a timeout or a
 * dropped connection MAY HAVE LANDED (`escrita.ts`): the caller re-reads the
 * listing before deciding anything.
 */
import { wireInt } from '@delfrance/core/wire';
import { z } from 'zod';

import {
  MARKETPLACE_ID_BR,
  type RespostaSpApi,
  segmentoDeCaminho,
  type SpApiLeituraClient,
} from './client';
import type { SpApiEscritaClient } from './escrita';
import { AmazonConfigError } from './errors';

/** The model's `operationId`s, each call's label on the observer's event. */
export const OPERACAO_LER_LISTING = 'getListingsItem';
export const OPERACAO_BUSCAR_LISTINGS = 'searchListingsItems';
export const OPERACAO_ENVIAR_LISTING = 'patchListingsItem';

/** The listings items path; the seller id and the SKU follow as segments. */
export const CAMINHO_LISTINGS = '/listings/2021-08-01/items';

/** `identifiers` of `searchListingsItems`: at most 20 (the model's `maxItems`). */
export const MAX_SKUS_POR_BUSCA = 20;

/** The merchant-fulfilled channel code (`DEFAULT` is MFN). Never a parameter. */
export const CANAL_MFN = 'DEFAULT';

/** The product type of an offer-only stock patch. Never a parameter. */
export const TIPO_PRODUTO_OFERTA = 'PRODUCT';

/** The attribute the stock patch merges. */
export const CAMINHO_ATRIBUTO_DISPONIBILIDADE = '/attributes/fulfillment_availability';

/** The locale every listings call asks its issues in. */
export const LOCALIDADE_ISSUES_LISTINGS = 'pt_BR';

/** A SKU's most code points in a search list (the app's SKU grammar). */
const MAX_CODIGOS_SKU_BUSCA = 40;

/** The datasets a listings read may ask for, by name. */
export const DADOS_LISTING_AMAZON = {
  resumos: 'summaries',
  disponibilidade: 'fulfillmentAvailability',
  relacoes: 'relationships',
  issues: 'issues',
} as const satisfies Record<string, string>;

/** One `includedData` value this module sends: a closed set, from the constants above. */
export type DadoListingAmazon = (typeof DADOS_LISTING_AMAZON)[keyof typeof DADOS_LISTING_AMAZON];

/** The constants in the order they are joined into `includedData`. */
const ORDEM_DADOS_LISTING: readonly DadoListingAmazon[] = Object.values(DADOS_LISTING_AMAZON);

/* -------------------------------------------------------------------------- */
/*                               The SKU checks                               */
/* -------------------------------------------------------------------------- */

/**
 * The SKU as its percent-encoded path segment (`'a b'` → `'a%20b'`, `'%'` →
 * `'%25'`), or `null` when no path can carry it: empty, holding `/` or `\`,
 * containing `..`, equal to `.`, or refused by the client's path check once
 * encoded (`segmentoDeCaminho`, `client.ts`).
 */
export function segmentoSkuAmazon(sku: string): string | null {
  return segmentoDeCaminho(sku);
}

/** Whether the SKU can travel in a listings path at all ({@link segmentoSkuAmazon}). */
export function skuTemCaminhoAmazon(sku: string): boolean {
  return segmentoDeCaminho(sku) !== null;
}

/**
 * Whether the SKU can ride a `searchListingsItems` `identifiers` list: a
 * non-empty string with no `,`, no space and at most 40 code points (module
 * header). Any other SKU is read alone with {@link lerListingAmazon}.
 */
export function skuBuscavelAmazon(sku: string): boolean {
  return (
    typeof sku === 'string' &&
    sku !== '' &&
    !sku.includes(',') &&
    !sku.includes(' ') &&
    [...sku].length <= MAX_CODIGOS_SKU_BUSCA
  );
}

function recusarSku(operacao: string): AmazonConfigError {
  return new AmazonConfigError('sku', { operacao, refCredencial: null });
}

/** The seller id as one segment, or `AmazonConfigError('caminho')`. */
function segmentoSellerId(sellerId: string, operacao: string): string {
  const segmento = segmentoDeCaminho(sellerId);
  if (segmento === null) {
    throw new AmazonConfigError('caminho', { operacao, refCredencial: null });
  }
  return segmento;
}

/** The SKU as one segment, or `AmazonConfigError('sku')`. */
function segmentoSku(sku: string, operacao: string): string {
  const segmento = segmentoDeCaminho(sku);
  if (segmento === null) throw recusarSku(operacao);
  return segmento;
}

/**
 * `includedData` as ONE value, joined from this module's constants: a value the
 * closed type does not name (a cast) never reaches the query. An empty result
 * is a wiring bug, thrown as such, never a request without the datasets.
 */
function dadosIncluidos(incluir: readonly DadoListingAmazon[]): string {
  const valor = ORDEM_DADOS_LISTING.filter((d) => incluir.includes(d)).join(',');
  if (valor === '') {
    throw new TypeError('listings: a lista incluir precisa de ao menos um dado conhecido.');
  }
  return valor;
}

/* -------------------------------------------------------------------------- */
/*                                 The schemas                                */
/* -------------------------------------------------------------------------- */

/** One `summaries[]` entry (`ItemSummaryByMarketplace`), only what is read. */
const resumoListingSchema = z
  .object({
    marketplaceId: z.string().nullish(),
    asin: z.string().nullish(),
    productType: z.string().nullish(),
    status: z.array(z.string()).nullish(),
  })
  .passthrough();

/** One `fulfillmentAvailability[]` entry: the channel, and the quantity (optional in the model). */
const disponibilidadeListingSchema = z
  .object({
    fulfillmentChannelCode: z.string().nullish(),
    quantity: wireInt().nullish(),
  })
  .passthrough();

/** One relationship (`ItemRelationship`): `VARIATION` or `PACKAGE_HIERARCHY`, an open string. */
const relacaoListingSchema = z
  .object({
    childSkus: z.array(z.string()).nullish(),
    parentSkus: z.array(z.string()).nullish(),
    type: z.string().nullish(),
  })
  .passthrough();

/** `ItemRelationshipsByMarketplace`. */
const relacoesPorMarketplaceSchema = z
  .object({
    marketplaceId: z.string().nullish(),
    relationships: z.array(relacaoListingSchema).nullish(),
  })
  .passthrough();

/** A listings `Issue`. */
const issueListingSchema = z
  .object({
    code: z.string().nullish(),
    message: z.string().nullish(),
    severity: z.string().nullish(),
    attributeNames: z.array(z.string()).nullish(),
    categories: z.array(z.string()).nullish(),
  })
  .passthrough();

/** One listings item (`Item`), tolerant (module header): only `sku` is required. */
export const listingAmazonSchema = z
  .object({
    sku: z.string(),
    summaries: z.array(resumoListingSchema).nullish(),
    fulfillmentAvailability: z.array(disponibilidadeListingSchema).nullish(),
    relationships: z.array(relacoesPorMarketplaceSchema).nullish(),
    issues: z.array(issueListingSchema).nullish(),
  })
  .passthrough();

export type ListingAmazon = z.infer<typeof listingAmazonSchema>;

/** `ItemSearchResults`, tolerant; the paging tokens are read only as present or absent. */
export const buscaListingsAmazonSchema = z
  .object({
    numberOfResults: wireInt().nullish(),
    items: z.array(listingAmazonSchema).nullish(),
    pagination: z
      .object({
        nextToken: z.string().nullish(),
        previousToken: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type BuscaListingsAmazon = z.infer<typeof buscaListingsAmazonSchema>;

/** `ListingsItemSubmissionResponse`, tolerant: `status` is an open string (`ACCEPTED`, `INVALID`). */
export const envioListingAmazonSchema = z
  .object({
    sku: z.string(),
    status: z.string().nullish(),
    submissionId: z.string().nullish(),
    issues: z.array(issueListingSchema).nullish(),
  })
  .passthrough();

export type EnvioListingAmazon = z.infer<typeof envioListingAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                                 The helpers                                */
/* -------------------------------------------------------------------------- */

/** What one `getListingsItem` reads. */
export interface EntradaLeituraListing {
  readonly sellerId: string;
  readonly sku: string;
  /** The datasets to include (`includedData`), from {@link DADOS_LISTING_AMAZON}. */
  readonly incluir: readonly [DadoListingAmazon, ...DadoListingAmazon[]];
}

/**
 * `getListingsItem` of ONE SKU, through the read client. A 404 is the client's
 * `AmazonNotFoundError` (an `AmazonHttpError` with status 404): the caller reads
 * it as "not listed".
 */
export async function lerListingAmazon(
  leitor: SpApiLeituraClient,
  entrada: EntradaLeituraListing,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<ListingAmazon>> {
  const operacao = OPERACAO_LER_LISTING;
  const vendedor = segmentoSellerId(entrada.sellerId, operacao);
  const sku = segmentoSku(entrada.sku, operacao);
  return leitor.get({
    operacao,
    caminho: `${CAMINHO_LISTINGS}/${vendedor}/${sku}`,
    query: {
      marketplaceIds: MARKETPLACE_ID_BR,
      includedData: dadosIncluidos(entrada.incluir),
      issueLocale: LOCALIDADE_ISSUES_LISTINGS,
    },
    schema: listingAmazonSchema,
    sinal,
  });
}

/** What one `searchListingsItems` reads: 1 to 20 distinct searchable SKUs. */
export interface EntradaBuscaListings {
  readonly sellerId: string;
  readonly skus: readonly string[];
  /** The datasets to include (`includedData`), from {@link DADOS_LISTING_AMAZON}. */
  readonly incluir: readonly [DadoListingAmazon, ...DadoListingAmazon[]];
}

/**
 * The search answer plus `truncada`: `true` when the page may not hold every
 * requested SKU — `numberOfResults` differs from the items' count, or a
 * `nextToken` is present. A SKU absent from a truncated page is unknown, never
 * "not listed".
 */
export type RespostaBuscaListings = RespostaSpApi<BuscaListingsAmazon> & {
  readonly truncada: boolean;
};

/**
 * `searchListingsItems` of up to 20 SKUs by `identifiers`, through the read
 * client: `identifiersType=SKU`, `pageSize=20`. Refused (`AmazonConfigError('sku')`,
 * nothing read or sent): an empty list, more than 20, a duplicate, or a SKU
 * that is not {@link skuBuscavelAmazon}.
 */
export async function buscarListingsAmazon(
  leitor: SpApiLeituraClient,
  entrada: EntradaBuscaListings,
  sinal?: AbortSignal,
): Promise<RespostaBuscaListings> {
  const operacao = OPERACAO_BUSCAR_LISTINGS;
  const { skus } = entrada;
  if (
    skus.length === 0 ||
    skus.length > MAX_SKUS_POR_BUSCA ||
    new Set(skus).size !== skus.length ||
    !skus.every((s) => skuBuscavelAmazon(s))
  ) {
    throw recusarSku(operacao);
  }
  const vendedor = segmentoSellerId(entrada.sellerId, operacao);
  const r = await leitor.get({
    operacao,
    caminho: `${CAMINHO_LISTINGS}/${vendedor}`,
    query: {
      marketplaceIds: MARKETPLACE_ID_BR,
      identifiers: skus.join(','),
      identifiersType: 'SKU',
      includedData: dadosIncluidos(entrada.incluir),
      pageSize: MAX_SKUS_POR_BUSCA,
      issueLocale: LOCALIDADE_ISSUES_LISTINGS,
    },
    schema: buscaListingsAmazonSchema,
    sinal,
  });
  const itens = r.dados.items ?? [];
  const proximo = r.dados.pagination?.nextToken;
  const truncada =
    r.dados.numberOfResults !== itens.length || (proximo !== undefined && proximo !== null);
  return { ...r, truncada };
}

/** What one stock patch sends: the SKU and its quantity, nothing else. */
export interface EntradaDisponibilidadeListing {
  readonly sellerId: string;
  readonly sku: string;
  /** A safe integer ≥ 0. */
  readonly quantidade: number;
}

/**
 * `patchListingsItem` with the stock merge (module header), through the write
 * client. The quantity is checked first (`AmazonConfigError('quantidade')`),
 * then the path; the body is built from named keys and sent once. A 2xx
 * resolves with the submission answer (`ACCEPTED` or `INVALID`, the app reads
 * which); anything else is the client's error.
 */
export async function enviarDisponibilidadeAmazon(
  escritor: SpApiEscritaClient,
  entrada: EntradaDisponibilidadeListing,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<EnvioListingAmazon>> {
  const operacao = OPERACAO_ENVIAR_LISTING;
  const { quantidade } = entrada;
  if (!Number.isSafeInteger(quantidade) || quantidade < 0) {
    throw new AmazonConfigError('quantidade', { operacao, refCredencial: null });
  }
  const vendedor = segmentoSellerId(entrada.sellerId, operacao);
  const sku = segmentoSku(entrada.sku, operacao);

  const corpo = JSON.stringify({
    productType: TIPO_PRODUTO_OFERTA,
    patches: [
      {
        op: 'merge',
        path: CAMINHO_ATRIBUTO_DISPONIBILIDADE,
        value: [{ fulfillment_channel_code: CANAL_MFN, quantity: quantidade }],
      },
    ],
  });

  return escritor.patch({
    operacao,
    caminho: `${CAMINHO_LISTINGS}/${vendedor}/${sku}`,
    query: { marketplaceIds: MARKETPLACE_ID_BR, issueLocale: LOCALIDADE_ISSUES_LISTINGS },
    corpo,
    schema: envioListingAmazonSchema,
    sinal,
  });
}
