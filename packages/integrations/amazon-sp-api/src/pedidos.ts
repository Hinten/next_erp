/**
 * Orders v2026-01-01: `searchOrders` — the ONE list read the backstop poll
 * makes (`apps/amazon/lib/amazon/pedidos/pollPedidos.ts`, step 4) — and
 * `getOrder` — the ONE order read the importer (step 5, PR 5-d) will make; its
 * section is at the end of this file. Written from the model
 * (`amzn/selling-partner-api-models`, `orders_2026-01-01.json`, printed by
 * `node .master_plans/amazon/evidence/amazon-doc.mjs op searchOrders` / `op
 * getOrder`) and the model's own sandbox examples — never from a live call
 * (D11).
 *
 * # `searchOrders`
 *
 * ## The response schema reads the PAGE, never a row
 *
 * {@link respostaSearchOrdersSchema} declares `orders` as an array of
 * `unknown`: each row is validated ONE BY ONE by the caller. The model's
 * `Order` requires `orderItems`, `salesChannel` and more, so a strict row
 * schema here would fail the whole PAGE — and so the whole poll — over one
 * item-less cancelled order. The caller reads the two fields it decides on
 * (`orderId`, `lastUpdatedTime`) and counts any row that lacks them.
 *
 * - `pagination.nextToken` present ⇒ another page; absent (or no `pagination`
 *   at all) ⇒ the last page. An EMPTY token is refused by the schema: read as
 *   "no more pages" it would end a drain early and advance a cursor past rows
 *   never read.
 * - `lastUpdatedBefore` and `createdBefore` are Amazon's echoes of the window it
 *   served. They are declared so the caller can see them; nothing here trusts
 *   them.
 * - Every object is `.passthrough()` (`types.ts`), and nothing here is a
 *   number (`integration-response-numbers-tolerant`): the page has none.
 *
 * ## The request sends EXACTLY four keys
 *
 * {@link buscarPedidosAtualizados} builds its query from four NAMED fields —
 * `lastUpdatedAfter`, `marketplaceIds`, `maxResultsPerPage` and, on a page
 * after the first, `paginationToken` — never a spread of the caller's object.
 * So `lastUpdatedBefore`, `includedData`, `fulfilledBy` and
 * `fulfillmentStatuses` can never ride along:
 *
 * - no `lastUpdatedBefore`: the window is open-ended by design, and the poll
 *   caps its own cursor instead;
 * - no `includedData`: the poll needs the two fields every row carries, and
 *   each extra block (buyer, recipient, …) is buyer data the poll must not
 *   fetch (D5);
 * - no `fulfilledBy` / `fulfillmentStatuses`: every order is listed, whatever
 *   its fulfilment; the importer (step 5) decides what to do with it.
 *
 * `marketplaceIds` is the caller's CSV string, which `client.ts` sends as one
 * query value (`URLSearchParams` encodes the comma). The model's own rule for
 * a paged read applies to the caller: every parameter but `maxResultsPerPage`
 * must be resent byte-identical with the token, which expires after 24 hours.
 *
 * Usage plan (the model's table): 0.0056 requests per second, burst 20.
 */
import { z } from 'zod';

import type { RespostaSpApi, SpApiLeituraClient } from './client';
import { pedidoWireAmazonSchema } from './types';

/** The operation's path: Orders v2026-01-01, the order LIST (no id segment). */
export const CAMINHO_SEARCH_ORDERS = '/orders/2026-01-01/orders';

/** The model's `operationId`, the call's label on the observer's event. */
export const OPERACAO_SEARCH_ORDERS = 'searchOrders';

/** One `searchOrders` page (module header): the rows unread, the paging read. */
export const respostaSearchOrdersSchema = z
  .object({
    orders: z.array(z.unknown()),
    pagination: z
      .object({
        nextToken: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    lastUpdatedBefore: z.string().optional(),
    createdBefore: z.string().optional(),
  })
  .passthrough();

export type RespostaSearchOrders = z.infer<typeof respostaSearchOrdersSchema>;

/** What one page request carries (module header) — nothing else can reach the query. */
export interface FiltroSearchOrders {
  /** ISO-8601 instant; resent byte-identical on every page of one drain. */
  readonly lastUpdatedAfter: string;
  /** The marketplace ids as ONE comma-separated string (`client.ts`). */
  readonly marketplaceIds: string;
  /** Rows per page; the model caps it at 100. */
  readonly maxResultsPerPage: number;
  /** The previous page's `pagination.nextToken`; absent or `null` on the first page. */
  readonly paginationToken?: string | null;
  /** The caller's cancellation, as `client.ts` takes it. */
  readonly sinal?: AbortSignal;
}

/**
 * One `searchOrders` page through the read-only client. The query is built
 * from the four named fields alone (module header); every error is the
 * client's (`errors.ts`).
 */
export function buscarPedidosAtualizados(
  cliente: SpApiLeituraClient,
  filtro: FiltroSearchOrders,
): Promise<RespostaSpApi<RespostaSearchOrders>> {
  const query: Record<string, string | number> = {
    lastUpdatedAfter: filtro.lastUpdatedAfter,
    marketplaceIds: filtro.marketplaceIds,
    maxResultsPerPage: filtro.maxResultsPerPage,
  };
  const token = filtro.paginationToken;
  if (token !== undefined && token !== null) query.paginationToken = token;
  return cliente.get({
    operacao: OPERACAO_SEARCH_ORDERS,
    caminho: CAMINHO_SEARCH_ORDERS,
    query,
    schema: respostaSearchOrdersSchema,
    sinal: filtro.sinal,
  });
}

/* -------------------------------------------------------------------------- */
/*                       getOrder (master plan step 5)                        */
/* -------------------------------------------------------------------------- */

/*
 * One order, re-fetched by id: the importer never trusts a push or a poll row
 * for data (D5), it reads THIS.
 *
 * ## The request sends EXACTLY one query key
 *
 * {@link buscarPedido} builds its query from ONE named key, `includedData` —
 * {@link DADOS_INCLUIDOS_GET_ORDER} joined with `,` into ONE value (the model
 * declares the parameter as an array with no `collectionFormat`, Swagger 2's
 * CSV; `client.ts` encodes the comma as `%2C`) — never a spread of the
 * caller's object. `getOrder` takes no `marketplaceIds`.
 *
 * ## The response schema
 *
 * `{ order }`, the order being `pedidoWireAmazonSchema` (`types.ts`, whose
 * section header says what is strict and why). The client reads it through
 * `lerRespostaJson`, so a 2xx outside it is the client's `AmazonSchemaError`
 * (field paths only, never a value).
 *
 * Usage plan (the model's table): 0.5 requests per second, burst 30.
 */

/** The model's `operationId`, the call's label on the observer's event. */
export const OPERACAO_GET_ORDER = 'getOrder';

/**
 * The datasets every production `getOrder` requests, in this order (the
 * master plan's eight; step 5–7 plan §3 decision 25). `FULFILLMENT_ORDERS`
 * (Easy Ship / Seller Flex only), `EXPENSE` (points) and `PROMOTION` (ids only)
 * stay out until a step reads them: each would add an unread dataset to every
 * call. A capture may request all eleven; production never does.
 */
export const DADOS_INCLUIDOS_GET_ORDER = Object.freeze([
  'BUYER',
  'RECIPIENT',
  'TAX',
  'PAYMENT',
  'PROCEEDS',
  'FULFILLMENT',
  'PACKAGES',
  'CANCELLATION',
] as const);

/**
 * The operation's path for one order. The id is encoded as one segment, so an
 * id carrying a `/`, a `?` or a `..` cannot leave it: `client.ts` refuses the
 * encoded separator (`AmazonConfigError('caminho')`) before anything is sent.
 * The 3-7-7 grammar itself is the app's to check.
 */
export function caminhoGetOrder(orderId: string): string {
  return `/orders/2026-01-01/orders/${encodeURIComponent(orderId)}`;
}

/** One `getOrder` response (section header). */
export const respostaGetOrderSchema = z
  .object({
    order: pedidoWireAmazonSchema,
  })
  .passthrough();

export type RespostaGetOrder = z.infer<typeof respostaGetOrderSchema>;

/** What one `getOrder` call may carry besides the order id: the caller's cancellation. */
export interface OpcoesGetOrder {
  readonly sinal?: AbortSignal;
}

/**
 * One `getOrder` through the read-only client: the fixed datasets, ONE query
 * key (section header). Every error is the client's (`errors.ts`), redirects
 * included (never followed).
 */
export function buscarPedido(
  cliente: SpApiLeituraClient,
  orderId: string,
  opts?: OpcoesGetOrder,
): Promise<RespostaSpApi<RespostaGetOrder>> {
  return cliente.get({
    operacao: OPERACAO_GET_ORDER,
    caminho: caminhoGetOrder(orderId),
    query: { includedData: DADOS_INCLUIDOS_GET_ORDER.join(',') },
    schema: respostaGetOrderSchema,
    sinal: opts?.sinal,
  });
}
