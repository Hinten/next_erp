/**
 * Listings Items v2021-08-01 (`listingsItems_2021-08-01.json`): three listings
 * operations and two patch bodies, the stock merge and the offer merge.
 *
 * - `getListingsItem` — `GET /listings/2021-08-01/items/{sellerId}/{sku}`,
 *   through the READ client: {@link lerListingAmazon}. 5 requests per second,
 *   burst 10.
 * - `searchListingsItems` — `GET /listings/2021-08-01/items/{sellerId}`, up to 20
 *   SKUs per call, through the READ client: {@link buscarListingsAmazon}. 5
 *   requests per second, burst 5.
 * - `patchListingsItem` — `PATCH /listings/2021-08-01/items/{sellerId}/{sku}`,
 *   through the WRITE client (`escrita.ts`), with exactly two bodies:
 *   {@link enviarDisponibilidadeAmazon}, the stock merge, and
 *   {@link enviarOfertaAmazon}, the offer merge. 5 requests per second, burst 5.
 *
 * Both bodies come from PURE builders, {@link patchDisponibilidadeAmazon} and
 * {@link patchOfertaAmazon}, which a `JSON_LISTINGS_FEED` message carries too
 * (`feeds.ts`): one builder per body, whatever path sends it.
 *
 * Written from the model (printed by `node .master_plans/amazon/evidence/amazon-doc.mjs
 * op getListingsItem listings`, and likewise for the other two), its own
 * sandbox examples and Amazon's purchasable-offer guide, never from a live call
 * (D11).
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
 * - every patch is ONE `merge`, never `replace`: the model documents `replace`
 *   as "adds or replaces the target property" and `merge` as "merges the target
 *   property", so a `replace` drops what its body omits (a lead time, an offer
 *   element of another audience). `includedData` is left to the model's default
 *   (`issues`);
 * - the stock body merges `/attributes/fulfillment_availability` with
 *   `fulfillment_channel_code: 'DEFAULT'` and the quantity, under
 *   `productType: 'PRODUCT'`: never a lead time, never a `marketplace_id` inside
 *   `value`, never a `mode`;
 * - the offer body merges `/attributes/purchasable_offer` with ONE element: the
 *   three selectors that identify an offer element in Amazon's purchasable-offer
 *   guide (`marketplace_id` of the BR store, `currency: 'BRL'`,
 *   `audience: 'ALL'`) and the three prices, `our_price`,
 *   `minimum_seller_allowed_price` and `maximum_seller_allowed_price`, each
 *   `[{ schedule: [{ value_with_tax }] }]`. Nothing else: no `discounted_price`,
 *   no offer dates, no business (`B2B`) price, no `quantity_discount_plan`. It
 *   goes under the caller's `productType`, held to
 *   {@link TIPO_PRODUTO_LISTING_REGEX}, and with `mode=VALIDATION_PREVIEW`
 *   (Amazon validates without persisting) only when the caller asks for it.
 *
 * ## The responses are TOLERANT
 *
 * Every number goes through `wireInt()`, every enum is an OPEN string, every
 * object is `.passthrough()`, and every field is `.nullish()` except the item's
 * `sku`. A `fulfillmentAvailability` entry without `quantity` parses (the model
 * marks it optional), and so do an unknown status and an unknown channel code:
 * deciding what they MEAN (an AFN listing, a variation parent) is the app's.
 * The search answer's paging tokens are read only as present or absent.
 * `attributes` is free-form in the model, so the schema types it `unknown`.
 *
 * ## The offer read is FAIL-CLOSED
 *
 * {@link ofertaDoListingAmazon} reads our offer out of `attributes`, PURE and
 * total over `unknown`. Amazon publishes no example of a read `purchasable_offer`,
 * so the reader assumes the documented WRITE shape and never answers "no offer"
 * for something it could not read:
 *
 * - `ausente` only for an `attributes` object without `purchasable_offer` (or
 *   with an empty list), or whose elements ALL name another store, currency or
 *   audience. A selector names another only in the guide's code form, an
 *   upper-case code with no padding: a lower-case, padded or empty selector
 *   rules nothing out;
 * - `ilegivel` for a missing or non-object `attributes`, a `purchasable_offer`
 *   that is not a list, no element naming ours while some element's selectors
 *   cannot rule it out (the guide says the API derives selectors from the store
 *   in the request, so an element without them may be ours), or our element
 *   without a readable `our_price`;
 * - `ambigua` when two elements name ours, or one names ours beside one that
 *   may be ours too: no position decides between them;
 * - `lida` otherwise. Ours is chosen by its three selectors, never by its
 *   position (`audience` absent reads `ALL`, the guide's default).
 *
 * ## What it is not
 *
 * No `putListingsItem`, no `deleteListingsItem`, and nothing that sets a field
 * the two bodies above do not name. A PATCH that failed its schema, a 5xx, a
 * timeout or a dropped connection MAY HAVE LANDED (`escrita.ts`): the caller
 * re-reads the listing before deciding anything.
 */
import { parseIsoToMillis } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import { wireInt, wireNumber } from '@delfrance/core/wire';
import { z } from 'zod';

import {
  MARKETPLACE_ID_BR,
  type RespostaSpApi,
  segmentoDeCaminho,
  type SpApiLeituraClient,
} from './client';
import type { SpApiEscritaClient } from './escrita';
import { AmazonConfigError } from './errors';
import type { PatchListingAmazon } from './feeds';

/** The model's `operationId`s, each call's label on the observer's event. */
export const OPERACAO_LER_LISTING = 'getListingsItem';
export const OPERACAO_BUSCAR_LISTINGS = 'searchListingsItems';
export const OPERACAO_ENVIAR_LISTING = 'patchListingsItem';

/** The labels a refused builder reports: built here, nothing was sent. */
const OPERACAO_MONTAR_DISPONIBILIDADE = 'patchDisponibilidadeAmazon';
const OPERACAO_MONTAR_OFERTA = 'patchOfertaAmazon';

/** The Listings Items API version: the path's segment, and a feed report's `apiVersion`. */
export const VERSAO_API_LISTINGS = '2021-08-01';

/** The listings items path; the seller id and the SKU follow as segments. */
export const CAMINHO_LISTINGS = '/listings/2021-08-01/items';

/** `identifiers` of `searchListingsItems`: at most 20 (the model's `maxItems`). */
export const MAX_SKUS_POR_BUSCA = 20;

/** The merchant-fulfilled channel code (`DEFAULT` is MFN). Never a parameter. */
export const CANAL_MFN = 'DEFAULT';

/**
 * The product type of an offer-only stock patch, and of a feed message that
 * names none. Never a parameter of the stock patch.
 */
export const TIPO_PRODUTO_OFERTA = 'PRODUCT';

/**
 * The product types this package sends: an upper-case letter, then at most 63
 * upper-case letters, digits or `_` (`PRODUCT`, `LUGGAGE`). The model types the
 * field as a bare string; this is our grammar, so a lower-case or padded value
 * never reaches a body.
 */
export const TIPO_PRODUTO_LISTING_REGEX = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The attribute the stock patch merges. */
export const CAMINHO_ATRIBUTO_DISPONIBILIDADE = '/attributes/fulfillment_availability';

/** The attribute the offer patch merges. */
export const CAMINHO_ATRIBUTO_OFERTA = '/attributes/purchasable_offer';

/** `purchasable_offer` as a key of `attributes`: the last segment of {@link CAMINHO_ATRIBUTO_OFERTA}. */
const CHAVE_ATRIBUTO_OFERTA = 'purchasable_offer';

/** The `currency` selector of our offer element. */
export const MOEDA_OFERTA_BR = 'BRL';

/** The `audience` selector of our offer element: every buyer (the guide's default). */
export const PUBLICO_OFERTA_TODOS = 'ALL';

/** The `mode` a PATCH may ask for: Amazon validates the body without persisting it. */
export const MODO_ENVIO_LISTING_AMAZON = {
  validacao: 'VALIDATION_PREVIEW',
} as const satisfies Record<string, string>;

/** A `mode` this module sends: a closed set, from the constant above. */
export type ModoEnvioListingAmazon =
  (typeof MODO_ENVIO_LISTING_AMAZON)[keyof typeof MODO_ENVIO_LISTING_AMAZON];

/** The locale every listings call asks its issues in. */
export const LOCALIDADE_ISSUES_LISTINGS = 'pt_BR';

/** A SKU's most code points in a search list (the app's SKU grammar). */
const MAX_CODIGOS_SKU_BUSCA = 40;

/** The datasets a listings read may ask for, by name. */
export const DADOS_LISTING_AMAZON = {
  resumos: 'summaries',
  atributos: 'attributes',
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

/**
 * A listings `Issue`: on a listing, on a submission answer, and on a feed
 * processing report's item (`feeds.ts`).
 */
export const issueListingAmazonSchema = z
  .object({
    code: z.string().nullish(),
    message: z.string().nullish(),
    severity: z.string().nullish(),
    attributeNames: z.array(z.string()).nullish(),
    categories: z.array(z.string()).nullish(),
  })
  .passthrough();

export type IssueListingAmazon = z.infer<typeof issueListingAmazonSchema>;

/**
 * One listings item (`Item`), tolerant (module header): only `sku` is required.
 * `attributes` is the model's free-form `ItemAttributes`: {@link ofertaDoListingAmazon}
 * reads the one attribute this package reads.
 */
export const listingAmazonSchema = z
  .object({
    sku: z.string(),
    summaries: z.array(resumoListingSchema).nullish(),
    attributes: z.unknown().nullish(),
    fulfillmentAvailability: z.array(disponibilidadeListingSchema).nullish(),
    relationships: z.array(relacoesPorMarketplaceSchema).nullish(),
    issues: z.array(issueListingAmazonSchema).nullish(),
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
    issues: z.array(issueListingAmazonSchema).nullish(),
  })
  .passthrough();

export type EnvioListingAmazon = z.infer<typeof envioListingAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                             The patch builders                             */
/* -------------------------------------------------------------------------- */

/** An offer's three prices, in reais: what {@link patchOfertaAmazon} sends. */
export interface FaixaOfertaAmazon {
  /** `our_price`: the selling price. */
  readonly base: number;
  /** `minimum_seller_allowed_price`: the floor. */
  readonly minimo: number;
  /** `maximum_seller_allowed_price`: the ceiling. */
  readonly maximo: number;
}

function tipoProdutoValido(tipo: unknown): tipo is string {
  return typeof tipo === 'string' && TIPO_PRODUTO_LISTING_REGEX.test(tipo);
}

/** The stock merge, or `AmazonConfigError('quantidade')` labelled `operacao`. */
function patchDisponibilidade(quantidade: number, operacao: string): PatchListingAmazon {
  if (!Number.isSafeInteger(quantidade) || quantidade < 0) {
    throw new AmazonConfigError('quantidade', { operacao, refCredencial: null });
  }
  return {
    op: 'merge',
    path: CAMINHO_ATRIBUTO_DISPONIBILIDADE,
    value: [{ fulfillment_channel_code: CANAL_MFN, quantity: quantidade }],
  };
}

/**
 * The stock merge of one quantity (module header): `merge`,
 * `/attributes/fulfillment_availability`,
 * `[{ fulfillment_channel_code: 'DEFAULT', quantity }]`. PURE. A quantity that is
 * not a safe integer ≥ 0 is `AmazonConfigError('quantidade')`.
 */
export function patchDisponibilidadeAmazon(quantidade: number): PatchListingAmazon {
  return patchDisponibilidade(quantidade, OPERACAO_MONTAR_DISPONIBILIDADE);
}

/** A price this package sends: a finite number above zero with at most two decimals. */
function precoEnviavel(valor: unknown): valor is number {
  return (
    typeof valor === 'number' && Number.isFinite(valor) && valor > 0 && roundReais(valor) === valor
  );
}

/** One price sub-attribute as the guide writes it: ONE schedule with ONE value. */
function precoDaOferta(valor: number): readonly Readonly<Record<string, unknown>>[] {
  return [{ schedule: [{ value_with_tax: valor }] }];
}

/** The offer merge, or `AmazonConfigError('oferta')` labelled `operacao`. */
function patchOferta(faixa: FaixaOfertaAmazon, operacao: string): PatchListingAmazon {
  const { base, minimo, maximo } = faixa;
  if (
    !precoEnviavel(base) ||
    !precoEnviavel(minimo) ||
    !precoEnviavel(maximo) ||
    minimo > base ||
    base > maximo
  ) {
    throw new AmazonConfigError('oferta', { operacao, refCredencial: null });
  }
  return {
    op: 'merge',
    path: CAMINHO_ATRIBUTO_OFERTA,
    value: [
      {
        marketplace_id: MARKETPLACE_ID_BR,
        currency: MOEDA_OFERTA_BR,
        audience: PUBLICO_OFERTA_TODOS,
        our_price: precoDaOferta(base),
        minimum_seller_allowed_price: precoDaOferta(minimo),
        maximum_seller_allowed_price: precoDaOferta(maximo),
      },
    ],
  };
}

/**
 * The offer merge of one price range (module header): `merge`,
 * `/attributes/purchasable_offer`, ONE element with the three selectors and the
 * three prices as `value_with_tax`. PURE. Refused (`AmazonConfigError('oferta')`):
 * a price that is not a finite number above zero, a price with more than two
 * decimals (`roundReais` must give it back unchanged), `minimo > base` or
 * `base > maximo`. `minimo === base === maximo` is a valid range.
 */
export function patchOfertaAmazon(faixa: FaixaOfertaAmazon): PatchListingAmazon {
  return patchOferta(faixa, OPERACAO_MONTAR_OFERTA);
}

/* -------------------------------------------------------------------------- */
/*                               The offer read                               */
/* -------------------------------------------------------------------------- */

/** What {@link ofertaDoListingAmazon} answers (module header, "The offer read is FAIL-CLOSED"). */
export const TIPO_OFERTA_LISTING_AMAZON = {
  lida: 'lida',
  ausente: 'ausente',
  ambigua: 'ambigua',
  ilegivel: 'ilegivel',
} as const satisfies Record<string, string>;

export type TipoOfertaListingAmazon =
  (typeof TIPO_OFERTA_LISTING_AMAZON)[keyof typeof TIPO_OFERTA_LISTING_AMAZON];

/** What the reader saw beside the prices: counters for a log line, never a decision here. */
export interface IndicadoresOfertaAmazon {
  /** Our element carries a non-null `discounted_price`. */
  readonly temPrecoComDesconto: boolean;
  /** Some element names an `audience` other than `ALL` (an upper-case code): a business offer. */
  readonly temOfertaB2B: boolean;
  /** Our element's offer-level `end_at` is `{ value }` with a date already past. */
  readonly fechada: boolean;
}

/**
 * Our offer as read: `lida` with `base` (`our_price`), and the floor and the
 * ceiling, each `null` when absent or unreadable (an absent floor never equals a
 * sent one); or `ausente`, `ambigua` or `ilegivel`, with no price at all.
 */
export type OfertaListingAmazon = IndicadoresOfertaAmazon &
  (
    | {
        readonly tipo: typeof TIPO_OFERTA_LISTING_AMAZON.lida;
        readonly base: number;
        readonly minimo: number | null;
        readonly maximo: number | null;
      }
    | {
        readonly tipo: Exclude<TipoOfertaListingAmazon, typeof TIPO_OFERTA_LISTING_AMAZON.lida>;
      }
  );

/** How one `purchasable_offer` element relates to ours, by its selectors. */
const ELEMENTO_OFERTA = {
  nosso: 'nosso',
  outro: 'outro',
  incerto: 'incerto',
} as const satisfies Record<string, string>;

type ElementoOferta = (typeof ELEMENTO_OFERTA)[keyof typeof ELEMENTO_OFERTA];

/** The shared wire-number reader: a JSON number, or a decimal string that means one. */
const numeroDoFio = wireNumber();

/** A plain object: never `null`, never an array. */
function ehObjeto(valor: unknown): valor is object {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/** An OWN property: an inherited key never reads as present. */
function propria(objeto: object, chave: string): unknown {
  return Object.hasOwn(objeto, chave) ? (objeto as Record<string, unknown>)[chave] : undefined;
}

/** `audience` as read: absent or `null` is the guide's default, `ALL`. */
function publicoDoElemento(elemento: object): unknown {
  return propria(elemento, 'audience') ?? PUBLICO_OFERTA_TODOS;
}

/**
 * A selector value as Amazon documents one: an upper-case code (a store id such
 * as the BR store's, an ISO currency code, `ALL` or `B2B`), with no padding.
 */
const CODIGO_DE_SELETOR = /^[A-Z0-9][A-Z0-9_]*$/;

/**
 * A selector that NAMES a value other than ours: a string in the documented code
 * form that differs from `nosso`. A lower-case, padded or empty string is outside
 * that form, so it names nothing: it may be a rendering of ours.
 */
function nomeiaOutro(seletor: unknown, nosso: string): boolean {
  return typeof seletor === 'string' && CODIGO_DE_SELETOR.test(seletor) && seletor !== nosso;
}

/**
 * `outro` when an explicit selector names another store, currency or audience
 * (in the documented code form); `nosso` when all three name ours; `incerto`
 * otherwise (not an object, or a selector missing, not a string, or outside the
 * code form): it may be ours.
 */
function classificarElemento(elemento: unknown): ElementoOferta {
  if (!ehObjeto(elemento)) return ELEMENTO_OFERTA.incerto;
  const loja = propria(elemento, 'marketplace_id');
  const moeda = propria(elemento, 'currency');
  const publico = publicoDoElemento(elemento);
  if (
    nomeiaOutro(loja, MARKETPLACE_ID_BR) ||
    nomeiaOutro(moeda, MOEDA_OFERTA_BR) ||
    nomeiaOutro(publico, PUBLICO_OFERTA_TODOS)
  ) {
    return ELEMENTO_OFERTA.outro;
  }
  return loja === MARKETPLACE_ID_BR && moeda === MOEDA_OFERTA_BR && publico === PUBLICO_OFERTA_TODOS
    ? ELEMENTO_OFERTA.nosso
    : ELEMENTO_OFERTA.incerto;
}

/**
 * One price sub-attribute as the guide writes it: a list of exactly one object
 * whose `schedule` is a list of exactly one object, whose `value_with_tax` the
 * shared wire-number reader reads as a finite number above zero. Anything else
 * is `null`.
 */
function precoLido(atributo: unknown): number | null {
  if (!Array.isArray(atributo) || atributo.length !== 1) return null;
  const entrada: unknown = atributo[0];
  if (!ehObjeto(entrada)) return null;
  const agenda = propria(entrada, 'schedule');
  if (!Array.isArray(agenda) || agenda.length !== 1) return null;
  const item: unknown = agenda[0];
  if (!ehObjeto(item)) return null;
  const lido = numeroDoFio.safeParse(propria(item, 'value_with_tax'));
  if (!lido.success) return null;
  return Number.isFinite(lido.data) && lido.data > 0 ? lido.data : null;
}

/** Our element's offer-level `end_at` is `{ value }` with a date at or before `agoraMs`. */
function ofertaFechada(elemento: object, agoraMs: number): boolean {
  const fim = propria(elemento, 'end_at');
  if (!ehObjeto(fim)) return false;
  const valor = propria(fim, 'value');
  if (typeof valor !== 'string') return false;
  const fimMs = parseIsoToMillis(valor);
  return fimMs !== null && fimMs <= agoraMs;
}

/**
 * Our offer out of a listing's `attributes` (module header, "The offer read is
 * FAIL-CLOSED"). PURE and total: it never throws, and knows the time only as
 * `agoraMs` (ms since epoch, for `fechada`). Whether an `ausente` answer is
 * acceptable for a given listing is the caller's decision.
 */
export function ofertaDoListingAmazon(attributes: unknown, agoraMs: number): OfertaListingAmazon {
  const nenhum: IndicadoresOfertaAmazon = {
    temPrecoComDesconto: false,
    temOfertaB2B: false,
    fechada: false,
  };
  if (!ehObjeto(attributes)) return { tipo: TIPO_OFERTA_LISTING_AMAZON.ilegivel, ...nenhum };
  if (!Object.hasOwn(attributes, CHAVE_ATRIBUTO_OFERTA)) {
    return { tipo: TIPO_OFERTA_LISTING_AMAZON.ausente, ...nenhum };
  }
  const elementos = propria(attributes, CHAVE_ATRIBUTO_OFERTA);
  if (!Array.isArray(elementos)) return { tipo: TIPO_OFERTA_LISTING_AMAZON.ilegivel, ...nenhum };

  const semNosso: IndicadoresOfertaAmazon = {
    ...nenhum,
    temOfertaB2B: elementos.some(
      (e) => ehObjeto(e) && nomeiaOutro(publicoDoElemento(e), PUBLICO_OFERTA_TODOS),
    ),
  };
  const classes = elementos.map((e) => classificarElemento(e));
  const nossos = elementos.filter((_, i) => classes[i] === ELEMENTO_OFERTA.nosso);
  const incertos = classes.filter((c) => c === ELEMENTO_OFERTA.incerto).length;
  // Two of ours, or ours beside an element that may be ours too: no position decides.
  if (nossos.length > 1 || (nossos.length === 1 && incertos > 0)) {
    return { tipo: TIPO_OFERTA_LISTING_AMAZON.ambigua, ...semNosso };
  }
  const nosso: unknown = nossos[0];
  if (!ehObjeto(nosso)) {
    return incertos > 0
      ? { tipo: TIPO_OFERTA_LISTING_AMAZON.ilegivel, ...semNosso }
      : { tipo: TIPO_OFERTA_LISTING_AMAZON.ausente, ...semNosso };
  }

  const indicadores: IndicadoresOfertaAmazon = {
    temPrecoComDesconto: (propria(nosso, 'discounted_price') ?? null) !== null,
    temOfertaB2B: semNosso.temOfertaB2B,
    fechada: ofertaFechada(nosso, agoraMs),
  };
  const base = precoLido(propria(nosso, 'our_price'));
  if (base === null) return { tipo: TIPO_OFERTA_LISTING_AMAZON.ilegivel, ...indicadores };
  return {
    tipo: TIPO_OFERTA_LISTING_AMAZON.lida,
    base,
    minimo: precoLido(propria(nosso, 'minimum_seller_allowed_price')),
    maximo: precoLido(propria(nosso, 'maximum_seller_allowed_price')),
    ...indicadores,
  };
}

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
 * then the path; the body is {@link patchDisponibilidadeAmazon}'s patch under
 * `productType: 'PRODUCT'`, sent once. A 2xx resolves with the submission answer
 * (`ACCEPTED` or `INVALID`, the app reads which); anything else is the client's
 * error.
 */
export async function enviarDisponibilidadeAmazon(
  escritor: SpApiEscritaClient,
  entrada: EntradaDisponibilidadeListing,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<EnvioListingAmazon>> {
  const operacao = OPERACAO_ENVIAR_LISTING;
  const patch = patchDisponibilidade(entrada.quantidade, operacao);
  return enviarPatchListing(
    escritor,
    {
      operacao,
      sellerId: entrada.sellerId,
      sku: entrada.sku,
      tipoProduto: TIPO_PRODUTO_OFERTA,
      patch,
      modo: undefined,
    },
    sinal,
  );
}

/** What one offer patch sends: the SKU, its price range and the listing's product type. */
export interface EntradaOfertaListing {
  readonly sellerId: string;
  readonly sku: string;
  /** The three prices, held to {@link patchOfertaAmazon}'s rules. */
  readonly faixa: FaixaOfertaAmazon;
  /** The listing's product type, under {@link TIPO_PRODUTO_LISTING_REGEX}. */
  readonly tipoProduto: string;
  /** `VALIDATION_PREVIEW` to validate without persisting; absent, a real write. */
  readonly modo?: ModoEnvioListingAmazon;
}

/**
 * `patchListingsItem` with the offer merge (module header), through the write
 * client. The price range is checked first (`AmazonConfigError('oferta')`), then
 * the product type (`'tipo-produto'`), then the path; a `modo` outside
 * {@link MODO_ENVIO_LISTING_AMAZON} is a wiring bug, a `TypeError`. Nothing is
 * read or sent before all of them pass. The body is {@link patchOfertaAmazon}'s
 * patch under `tipoProduto`; the query adds `mode=VALIDATION_PREVIEW` only when
 * `modo` asks for it. It answers as {@link enviarDisponibilidadeAmazon} does: the
 * submission answer on a 2xx, the client's error otherwise.
 */
export async function enviarOfertaAmazon(
  escritor: SpApiEscritaClient,
  entrada: EntradaOfertaListing,
  sinal?: AbortSignal,
): Promise<RespostaSpApi<EnvioListingAmazon>> {
  const operacao = OPERACAO_ENVIAR_LISTING;
  const patch = patchOferta(entrada.faixa, operacao);
  const { tipoProduto, modo } = entrada;
  if (!tipoProdutoValido(tipoProduto)) {
    throw new AmazonConfigError('tipo-produto', { operacao, refCredencial: null });
  }
  if (modo !== undefined && modo !== MODO_ENVIO_LISTING_AMAZON.validacao) {
    throw new TypeError('listings: modo de envio desconhecido; nada foi enviado.');
  }
  return enviarPatchListing(
    escritor,
    { operacao, sellerId: entrada.sellerId, sku: entrada.sku, tipoProduto, patch, modo },
    sinal,
  );
}

/** What the one PATCH path takes: a checked patch, its product type and its mode. */
interface PatchDeListing {
  readonly operacao: string;
  readonly sellerId: string;
  readonly sku: string;
  readonly tipoProduto: string;
  readonly patch: PatchListingAmazon;
  readonly modo: ModoEnvioListingAmazon | undefined;
}

/**
 * The one `patchListingsItem` request both helpers send: the path checked
 * (`'caminho'`, `'sku'`), then `{ productType, patches: [patch] }` from named
 * keys, the BR store, `pt_BR`, and `mode` only when given.
 */
async function enviarPatchListing(
  escritor: SpApiEscritaClient,
  p: PatchDeListing,
  sinal: AbortSignal | undefined,
): Promise<RespostaSpApi<EnvioListingAmazon>> {
  const { operacao } = p;
  const vendedor = segmentoSellerId(p.sellerId, operacao);
  const sku = segmentoSku(p.sku, operacao);
  const corpo = JSON.stringify({ productType: p.tipoProduto, patches: [p.patch] });
  return escritor.patch({
    operacao,
    caminho: `${CAMINHO_LISTINGS}/${vendedor}/${sku}`,
    query: {
      marketplaceIds: MARKETPLACE_ID_BR,
      issueLocale: LOCALIDADE_ISSUES_LISTINGS,
      ...(p.modo === undefined ? {} : { mode: p.modo }),
    },
    corpo,
    schema: envioListingAmazonSchema,
    sinal,
  });
}
