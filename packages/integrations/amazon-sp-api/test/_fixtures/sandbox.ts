/**
 * Response fixtures, as TypeScript constants so they are linted and typechecked
 * like the code that reads them.
 *
 * ## Provenance
 *
 * The SP-API bodies are copied from the `x-amzn-api-sandbox` examples of
 * Amazon's own models (`amzn/selling-partner-api-models`), printed WITHOUT
 * calling the SP-API by
 * `node .master_plans/amazon/evidence/amazon-doc.mjs sandbox <operationId> <model>`:
 *
 *  - `erro400InvalidInput` — orders `getOrder` 400 static[0].
 *  - `erro400InvalidInputComDetails` — orders `searchOrders` 400 static[0]
 *    (the one that carries `details`).
 *  - `erro400CodigoComEspaco` — ordersV0 `confirmShipment` 400 static[0]: the
 *    code is `'Invalid Input'`, WITH a space.
 *  - `erro400Vazio` — ordersV0 `updateVerificationStatus` 400 static[4] and
 *    [5]: the body is `{}`, no `errors` key at all.
 *  - `erro403Forbidden`, `erro409Duplicado`, `erro429RateLimited`,
 *    `erro500InternalFailure`, `erro503ServiceUnavailable` — efReturns
 *    `listReturns` 403/409/429/500/503 static[0] (409's request value replaced
 *    by `rmaIdTeste`).
 *  - `participacoes200` — sellers `getMarketplaceParticipations` 200 static[0],
 *    the US example marketplace. `storeName` (Amazon's own placeholder) is
 *    dropped: the repo carries no store names.
 *  - `searchOrders200` — orders `searchOrders` 200 static[2], the BR example
 *    (`A2Q3Y263D00KWC`), REDUCED to a KEPT list: the envelope's `createdBefore`;
 *    per order `orderId`, `createdTime`, `lastUpdatedTime`, `programs`,
 *    `salesChannel`, `proceeds.grandTotal` and the three fulfillment status
 *    fields (`fulfillmentStatus`, `fulfilledBy`, `fulfillmentServiceLevel`);
 *    per item `orderItemId`, `quantityOrdered` and its `fulfillment`
 *    quantities. EVERYTHING else is dropped — among it the `buyer`,
 *    `recipient`, `tax`, `payment` and item `product` blocks (a buyer name, an
 *    address, a brand and a store name the repo never carries), `orderAliases`,
 *    the `shipByWindow` / `deliverByWindow` windows, `promiseCalculationInputs`
 *    (a carrier and a shipping-service name) and the item's `proceeds`. The
 *    order id and the order-item id take the sanitizer's FAKE shapes
 *    (`000-0000000-…`, `00000…`), as a committed fixture must. Every other
 *    value kept is the model's, byte for byte. The app's sanitized copy of the
 *    same example is `apps/amazon`'s `sb-searchorders-br.json`, which this
 *    package cannot read.
 *
 * The LWA token response is the shape of the example on
 * D:connecting-to-the-selling-partner-api (`token_type: 'bearer'`,
 * `expires_in: 3600`), with the example tokens REPLACED by the synthetic ones
 * from `_helpers/mockFetch.ts`.
 *
 * ⚠️ Everything under "Synthetic" is INVENTED: the models carry no LWA example
 * at all, and no error body for LWA is published beyond `invalid_client`'s.
 * They exist to drive the classifiers through the shapes LWA or a gateway could
 * plausibly send. The personal data in `corpo422ComDadosPessoais` is fake by
 * construction (`.invalid` domain, an all-zero CPF).
 */
import { ACCESS_TOKEN, REFRESH_TOKEN } from '../_helpers/mockFetch';

/* -------------------------------------------------------------------------- */
/*                     SP-API — from the models' sandbox                      */
/* -------------------------------------------------------------------------- */

export const erro400InvalidInput = {
  errors: [{ code: 'InvalidInput', message: 'Invalid Input' }],
} as const;

export const erro400InvalidInputComDetails = {
  errors: [{ code: 'InvalidInput', message: 'Invalid Input', details: 'Invalid Input' }],
} as const;

export const erro400CodigoComEspaco = {
  errors: [{ code: 'Invalid Input', message: 'Invalid Input' }],
} as const;

export const erro400Vazio = {} as const;

export const erro403Forbidden = {
  errors: [{ code: 'Forbidden', message: 'Request is forbidden' }],
} as const;

export const erro409Duplicado = {
  errors: [
    { code: 'DuplicateRequest', message: "Duplicate request found for 'rmaId' 'rmaIdTeste'" },
  ],
} as const;

export const erro429RateLimited = {
  errors: [
    {
      code: 'RateLimited',
      message: 'Temporary failure occurred, retry operation after some time.',
    },
  ],
} as const;

export const erro500InternalFailure = {
  errors: [
    { code: 'InternalFailure', message: 'Internal failure occurred, contact Amazon support' },
  ],
} as const;

export const erro503ServiceUnavailable = {
  errors: [{ code: 'ServiceUnavailable', message: 'Temporary failure occurred, retry operation' }],
} as const;

export const participacoes200 = {
  payload: [
    {
      marketplace: {
        id: 'ATVPDKIKX0DER',
        countryCode: 'US',
        name: 'Amazon.com',
        defaultCurrencyCode: 'USD',
        defaultLanguageCode: 'en_US',
        domainName: 'www.amazon.com',
      },
      participation: {
        isParticipating: true,
        hasSuspendedListings: false,
      },
    },
  ],
} as const;

export const searchOrders200 = {
  orders: [
    {
      orderId: '000-0000000-0000171',
      createdTime: '2024-12-22T15:30:00Z',
      lastUpdatedTime: '2024-12-23T10:00:00Z',
      programs: ['AMAZON_BUSINESS', 'DELIVERY_BY_AMAZON'],
      salesChannel: {
        channelName: 'AMAZON',
        marketplaceId: 'A2Q3Y263D00KWC',
        marketplaceName: 'Amazon.com.br',
      },
      proceeds: { grandTotal: { amount: '1599.90', currencyCode: 'BRL' } },
      fulfillment: {
        fulfillmentStatus: 'UNSHIPPED',
        fulfilledBy: 'MERCHANT',
        fulfillmentServiceLevel: 'STANDARD',
      },
      orderItems: [
        {
          orderItemId: '00000000000171',
          quantityOrdered: 1,
          fulfillment: { quantityFulfilled: 0, quantityUnfulfilled: 1 },
        },
      ],
    },
  ],
  createdBefore: '2024-12-22T16:00:00Z',
} as const;

/* -------------------------------------------------------------------------- */
/*                LWA — the documented shape, synthetic tokens                */
/* -------------------------------------------------------------------------- */

/** A refresh exchange's 200, echoing the refresh token as the docs' example does. */
export const tokenRefresh200 = {
  access_token: ACCESS_TOKEN,
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: REFRESH_TOKEN,
} as const;

/** The same, without the echo (the other pages' shape). */
export const tokenRefreshSemEco200 = {
  access_token: ACCESS_TOKEN,
  token_type: 'bearer',
  expires_in: 3600,
} as const;

/** The documented `invalid_client` body (lwa-credentials-faq). */
export const lwaInvalidClient = {
  error_description: 'Client authentication failed',
  error: 'invalid_client',
} as const;

/* -------------------------------------------------------------------------- */
/*                         Synthetic — NOT documented                         */
/* -------------------------------------------------------------------------- */

/** A marker that must never leave the parser: stands in for `error_description`. */
export const MARCADOR_DESCRICAO = 'MARCADOR-DESCRICAO-LWA-nao-pode-vazar';

export const lwaInvalidGrant = {
  error: 'invalid_grant',
  error_description: `${MARCADOR_DESCRICAO} The request has an invalid grant parameter`,
} as const;

export const lwaInvalidRequest = {
  error: 'invalid_request',
  error_description: `${MARCADOR_DESCRICAO} The request is missing a required parameter`,
} as const;

export const lwaUnauthorizedClient = {
  error: 'unauthorized_client',
  error_description: MARCADOR_DESCRICAO,
} as const;

/** The CamelCase spelling the LWA documentation table uses. */
export const lwaServerError = {
  error: 'ServerError',
  error_description: MARCADOR_DESCRICAO,
} as const;

export const lwaCodigoDesconhecido = {
  error: 'codigo_que_nao_existe',
  error_description: MARCADOR_DESCRICAO,
} as const;

/** A proxy's error page: not JSON at all. */
export const paginaHtmlDeProxy =
  '<html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1><p>MARCADOR-HTML</p></body></html>';

/** A 4xx echoing fake personal data: none of it may reach an error. */
export const corpo422ComDadosPessoais =
  '{"errors": [{"code": "InvalidInput", "message": "cliente fulano@exemplo.invalid, CPF 000.000.000-00"}]}';
export const EMAIL_FALSO = 'fulano@exemplo.invalid';
export const CPF_FALSO = '000.000.000-00';
