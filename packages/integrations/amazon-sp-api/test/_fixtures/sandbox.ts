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
 *  - `getOrder200` — orders `getOrder` 200 static[0], the BR example (step 5),
 *    REDUCED by the same rule to a KEPT list: per order `orderId`,
 *    `createdTime`, `lastUpdatedTime`, `programs`, `salesChannel`,
 *    `proceeds.grandTotal` and the `fulfillment` block (status fields and the
 *    three windows); per item `orderItemId`, `quantityOrdered`, the `product`'s
 *    `sellerSku`, `condition` and `price`, the item `proceeds` and its
 *    `fulfillment` quantities. Dropped: `orderAliases`, the `buyer` and
 *    `recipient` blocks, the item's `asin`, `title` (a brand), `promotion` and
 *    `packing` (a gift message). The order id, the order-item id and the SKU
 *    take the SAME fakes the app's sanitizer gave this example in
 *    `sb-getorder-br.json` (`000-0000000-2412538`, `00000253581152`,
 *    `SKU-Z3b3175ec`).
 *  - `searchOrders200ComPacotes` — orders `searchOrders` 200 static[1], a UK
 *    example and the ONLY model example carrying `packages` (step 5's package
 *    rows), reduced the same way: per order the fields `searchOrders200` keeps;
 *    per item `orderItemId`, `quantityOrdered`, `measurement`, the `product`'s
 *    `condition` and `price` and the `fulfillment` quantities; per package
 *    `packageReferenceId`, `createdTime`, `packageStatus`, `shipTime`,
 *    `trackingNumber` and `packageItems` (id and quantity). Dropped: the
 *    `buyer` / `recipient` blocks, the product `asin` / `title` / `sellerSku`
 *    (brands), the substitution options, the carrier and service names, the
 *    ship-from address and the transparency codes. Every id is a FAKE shape
 *    (order, line, package reference, tracking number).
 *  - `statusNotaFiscal200` — delivery `getInvoiceStatus` 200 static[0], the
 *    model's example as printed: its order id, shipment id and `invoices[].id`
 *    (a 44-digit key shape, all zeros after `352`) are the model's own
 *    placeholders.
 *  - `erro400StatusInvalidInput` — delivery `getInvoiceStatus` 400 static[0].
 *  - `envioNotaFiscal200` — delivery `submitInvoice` 200 static[0]: `{}`.
 *  - `erro400EnvioEntityNotFound` — delivery `submitInvoice` 400 static[0].
 *  - `agendamentoEasyShip200` — easyShip `createScheduledPackageBulk` 200
 *    static[0]: three orders, two scheduled and one rejected with
 *    `InvalidInput`. The three order ids (also inside the rejection's `message`
 *    and `details`) take the FAKE 3-7-7 shape (`000-0000000-…`); every other
 *    value is the model's own, byte for byte — units `IN` and `ounces` and the
 *    `printableDocumentsUrl` `https://www.amazon.com/documents.zip`, all of them
 *    outside what the model declares or what the download accepts.
 *  - `erro400AgendamentoInvalidInput` — easyShip `createScheduledPackageBulk`
 *    400 static[0].
 *  - `statusNotaFiscalSemRemessa` — NOT a sandbox example: the KEY shape of the
 *    owner's one read-only status capture (C2; `apps/amazon`'s
 *    `c2-status-aceita.json`, which this package cannot read): no
 *    `amazonShipmentId`, keys in the order Amazon sent them. Every value is a
 *    placeholder.
 *  - `listing200` — listings `getListingsItem` 200 static[0], REDUCED to a KEPT
 *    list: `sku`; per summary `marketplaceId`, `asin`, `productType`,
 *    `conditionType`, `status`, `createdDate` and `lastUpdatedDate`; the
 *    `fulfillmentAvailability` list; the first two `issues`, whole. Dropped: the
 *    summaries' `itemName` and `mainImage`, the `offers`, the other three issues.
 *    ⚠️ The ASIN takes the FAKE shape (`B0ZZTESTE1`, the app sanitizer's
 *    `B0ZZ…` range), as a committed fixture's must; every other value kept is
 *    the model's, byte for byte (its SKU is the model's own placeholder).
 *  - `buscaListings200` — listings `searchListingsItems` 200 static[0]: its
 *    `numberOfResults: 3`, its `pagination` (the model's placeholder tokens) and
 *    its ONE item, reduced like `listing200`. The request asked `pageSize: 1`.
 *  - `envioListing200Aceito` — listings `patchListingsItem` 200 static[0], as
 *    printed (`ACCEPTED`).
 *  - `envioListing200Invalido` — listings `patchListingsItem` 200 static[2], as
 *    printed: a `VALIDATION_PREVIEW` answer (`INVALID`, issue `90000900`), a
 *    mode this package never sends; it stands in for the shape of an `INVALID`
 *    submission.
 *  - `documentoFeedCriado201` — feeds `createFeedDocument` 201 static[0]. ⚠️ The
 *    sandbox's `url` is a CloudFront host, which the pre-signed URL guard
 *    refuses: it is REPLACED by the S3-shaped fake {@link URL_DOCUMENTO_FEED_FALSA}.
 *    The original is kept as {@link URL_CLOUDFRONT_DO_SANDBOX}, for the test
 *    that shows the guard refusing it. The `feedDocumentId` is the model's.
 *  - `feedCriado202` — feeds `createFeed` 202 static[0], as printed (its
 *    `feedId` is already digits). `feedCriado202NaoDigitos` — static[1], as
 *    printed: a non-digit `feedId`, kept only to show the 202 schema refusing it.
 *  - `feed200Concluido` — feeds `getFeed` 200 static[1] (`DONE`). ⚠️ Its
 *    non-digit `feedId` is REPLACED by the digit id of `feedCriado202`
 *    (`3485934`); every other value is the model's, byte for byte.
 *  - `documentoFeed200` — feeds `getFeedDocument` 200 static[0]. ⚠️ Its CloudFront
 *    `url` is REPLACED by {@link URL_DOCUMENTO_FEED_FALSA}; the `feedDocumentId`
 *    is the model's. The sandbox sends no `compressionAlgorithm`.
 *
 * The two listings-feed JSON schemas beside this file are Amazon's PUBLISHED
 * schemas (`amzn/selling-partner-api-models`, Apache-2.0), committed VERBATIM —
 * never reformatted (`.prettierignore`), never hand-edited — and read only by
 * the feeds tests. Each was written byte for byte by
 * `node .master_plans/amazon/evidence/amazon-doc.mjs esquema schemas/feeds/<nome>.json --saida <file>`
 * (the cache or raw.githubusercontent.com, never the SP-API):
 *
 *  - `listings-feed-schema-v2.json` — `schemas/feeds/listings-feed-schema-v2.json`,
 *    sha256 `9f6c00a109f086c269427ae1bc4afe1f9ba49ff8df46de9de939fa2c9f00e1ef`.
 *  - `listings-feed-processing-report-schema-v2.json` —
 *    `schemas/feeds/listings-feed-processing-report-schema-v2.json`,
 *    sha256 `03daac9d3fa97d729efb3f3c2836c664036a8ef32a9829363d8026bb097178fd`.
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

export const statusNotaFiscal200 = {
  amazonShipmentId: '1111111111111',
  amazonOrderId: '000-0000000-0000000',
  invoiceStatus: 'Accepted',
  orderInvoicingStatus: 'Accepted',
  invoices: [{ id: '35200000000000000000000000000000000000000000', status: 'Accepted' }],
} as const;

export const erro400StatusInvalidInput = {
  errors: [
    {
      code: 'InvalidInput',
      message: 'Invalid Shipment Id',
      details: "'BadIDForShipment' is an invalid shipment Id",
    },
  ],
} as const;

export const envioNotaFiscal200 = {} as const;

export const erro400EnvioEntityNotFound = {
  errors: [
    { code: 'EntityNotFound', message: 'Entity (ShipmentId, BadIDForShipment) was not found' },
  ],
} as const;

export const agendamentoEasyShip200 = {
  scheduledPackages: [
    {
      scheduledPackageId: {
        amazonOrderId: '000-0000000-0000301',
        packageId: '1ab0f06a-9149-87e0-aba9-7098117872d6',
      },
      packageTimeSlot: {
        slotId: 'AQc48yxSAAAAADZG0qQAAAAA6kkAAAAAAAA=',
        startTime: '2022-03-09T10:00:00+09:00',
        endTime: '2022-03-10T10:00:00+09:00',
        handoverMethod: 'PICKUP',
      },
      packageIdentifier: '1ab0f06a-9149-87e0-aba9-7098117872d6',
      invoice: {
        invoiceNumber: 'IN-456',
        invoiceDate: '2022-03-09T10:00:00+09:00',
      },
      packageDimensions: {
        length: 5.905511805,
        width: 3.6220472404,
        height: 3.4645669256,
        unit: 'IN',
        identifier: 'IN_SuggestedContainerDimension',
      },
      packageWeight: {
        value: 11.466,
        unit: 'ounces',
      },
      packageItems: [
        {
          orderItemId: '6195931986885',
          orderItemSerialNumbers: ['ABCDE1234', '56789FGHI'],
        },
      ],
      packageStatus: 'ReadyForPickup',
      trackingDetails: {
        trackingId: '1652969339691',
      },
    },
    {
      scheduledPackageId: {
        amazonOrderId: '000-0000000-0000302',
        packageId: '80c06e53-3d96-f13f-30ca-85b50b1cb4ce',
      },
      packageTimeSlot: {
        slotId: 'AQef4K2CAAAAAGdIAEAAAAAA6kkAAAAAAAA=',
        startTime: '2022-05-21T10:00:00+09:00',
        endTime: '2022-05-21T10:00:00+09:00',
      },
      invoice: {
        invoiceNumber: 'IN-456',
        invoiceDate: '2022-05-21T10:00:00+09:00',
      },
      packageDimensions: {
        length: 5.905511805,
        width: 3.6220472404,
        height: 3.4645669256,
        unit: 'IN',
        identifier: 'IN_SuggestedContainerDimension',
      },
      packageWeight: {
        value: 11.466,
        unit: 'ounces',
      },
      packageStatus: 'ReadyForPickup',
      trackingDetails: {
        trackingId: '1652969339693',
      },
    },
  ],
  rejectedOrders: [
    {
      amazonOrderId: '000-0000000-0000303',
      error: {
        code: 'InvalidInput',
        details: "Couldn't find the order details for 000-0000000-0000303",
        message: "Couldn't find the order details for 000-0000000-0000303",
      },
    },
  ],
  printableDocumentsUrl: 'https://www.amazon.com/documents.zip',
} as const;

export const erro400AgendamentoInvalidInput = {
  errors: [
    {
      code: 'InvalidInput',
      message: 'Request has missing or invalid parameters and cannot be parsed.',
    },
  ],
} as const;

export const statusNotaFiscalSemRemessa = {
  invoices: [{ id: 'ID-DA-FATURA-FALSO', status: 'Accepted' }],
  amazonOrderId: '000-0000000-0000000',
  orderInvoicingStatus: 'Accepted',
  invoiceStatus: 'Accepted',
} as const;

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

export const getOrder200 = {
  order: {
    orderId: '000-0000000-2412538',
    createdTime: '2024-12-24T20:30:00Z',
    lastUpdatedTime: '2024-12-25T08:15:00Z',
    programs: ['PRIME'],
    salesChannel: {
      channelName: 'AMAZON',
      marketplaceId: 'A2Q3Y263D00KWC',
      marketplaceName: 'Amazon.com.br',
    },
    proceeds: { grandTotal: { amount: '299.90', currencyCode: 'BRL' } },
    fulfillment: {
      fulfillmentStatus: 'UNSHIPPED',
      fulfilledBy: 'MERCHANT',
      fulfillmentServiceLevel: 'STANDARD',
      shipByWindow: {
        earliestDateTime: '2024-12-26T00:00:00Z',
        latestDateTime: '2024-12-27T23:59:59Z',
      },
      deliverByWindow: {
        earliestDateTime: '2024-12-28T00:00:00Z',
        latestDateTime: '2024-12-31T23:59:59Z',
      },
      labelPrintingWindow: { earliestDateTime: '2024-12-26T17:00:00Z' },
    },
    orderItems: [
      {
        orderItemId: '00000253581152',
        quantityOrdered: 1,
        product: {
          sellerSku: 'SKU-Z3b3175ec',
          condition: { conditionType: 'NEW', conditionSubtype: 'NEW', conditionNote: '' },
          price: { unitPrice: { amount: '299.90', currencyCode: 'BRL' } },
        },
        proceeds: {
          proceedsTotal: { amount: '299.90', currencyCode: 'BRL' },
          breakdowns: [{ type: 'ITEM', subtotal: { amount: '299.90', currencyCode: 'BRL' } }],
        },
        fulfillment: { quantityFulfilled: 0, quantityUnfulfilled: 1 },
      },
    ],
  },
} as const;

export const searchOrders200ComPacotes = {
  orders: [
    {
      orderId: '000-0000000-0000202',
      createdTime: '2024-12-24T14:20:00Z',
      lastUpdatedTime: '2024-12-24T18:45:00Z',
      programs: ['PRIME'],
      salesChannel: {
        channelName: 'AMAZON',
        marketplaceId: 'A1F83G8C2ARO7P',
        marketplaceName: 'Amazon.co.uk',
      },
      proceeds: { grandTotal: { amount: '34.99', currencyCode: 'GBP' } },
      fulfillment: {
        fulfillmentStatus: 'SHIPPED',
        fulfilledBy: 'MERCHANT',
        fulfillmentServiceLevel: 'STANDARD',
      },
      orderItems: [
        {
          orderItemId: '00000000000202',
          quantityOrdered: 1,
          measurement: { unit: 'COUNT', value: 1 },
          product: {
            condition: { conditionType: 'NEW', conditionSubtype: 'NEW', conditionNote: '' },
            price: { unitPrice: { amount: '34.99', currencyCode: 'GBP' } },
          },
          fulfillment: { quantityFulfilled: 1, quantityUnfulfilled: 0 },
        },
      ],
      packages: [
        {
          packageReferenceId: 'PKG-Z00000202',
          createdTime: '2024-12-24T19:00:00Z',
          packageStatus: { status: 'IN_TRANSIT', detailedStatus: 'OUT_FOR_DELIVERY' },
          shipTime: '2024-12-25T14:00:00Z',
          trackingNumber: 'TRKZ0000000202',
          packageItems: [{ orderItemId: '00000000000202', quantity: 1 }],
        },
      ],
    },
  ],
  createdBefore: '2024-12-24T15:00:00Z',
} as const;

/* -------------------------------------------------------------------------- */
/*                   Listings and feeds — from the sandbox                    */
/* -------------------------------------------------------------------------- */

export const listing200 = {
  sku: 'GM-ZDPI-9B4E',
  summaries: [
    {
      marketplaceId: 'ATVPDKIKX0DER',
      asin: 'B0ZZTESTE1',
      productType: 'LUGGAGE',
      conditionType: 'new_new',
      status: ['BUYABLE'],
      createdDate: '2021-02-01T00:00:00Z',
      lastUpdatedDate: '2021-03-01T00:00:00Z',
    },
    {
      marketplaceId: 'A2EUQ1WTGCTBG2',
      asin: 'B0ZZTESTE1',
      productType: 'LUGGAGE',
      conditionType: 'new_new',
      status: [],
      createdDate: '2021-02-02T01:00:00Z',
      lastUpdatedDate: '2021-03-05T00:00:00Z',
    },
  ],
  fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 100 }],
  issues: [
    {
      code: '90220',
      message: "'size' is required but not supplied.",
      severity: 'ERROR',
      attributeNames: ['size'],
      categories: ['MISSING_ATTRIBUTE', 'LISTING'],
      marketplaceIds: ['ATVPDKIKX0DER'],
    },
    {
      code: '18027',
      message:
        'We believe the main image has text, logo, graphic, or watermark that is not permitted for this product type. Submit a compliant image to lift the suppression. Also refer to Product image requirements.',
      severity: 'ERROR',
      categories: ['INVALID_IMAGE', 'LISTING'],
      enforcements: {
        actions: [{ action: 'SEARCH_SUPPRESSED' }],
        exemption: { status: 'EXEMPT_UNTIL_EXPIRY_DATE', expiryDate: '2025-05-28T00:36:48.914Z' },
      },
      marketplaceIds: ['ATVPDKIKX0DER', 'A2EUQ1WTGCTBG2'],
    },
  ],
} as const;

export const buscaListings200 = {
  numberOfResults: 3,
  pagination: {
    nextToken: 'xsdflkj324lkjsdlkj3423klkjsdfkljlk2j34klj2l3k4jlksdjl234',
    previousToken: 'ilkjsdflkj234lkjds234234lkjl234lksjdflkj234234lkjsfsdflkj333d',
  },
  items: [listing200],
} as const;

export const envioListing200Aceito = {
  sku: 'GM-ZDPI-9B4E',
  status: 'ACCEPTED',
  submissionId: 'f1dc2914-75dd-11ea-bc55-0242ac130003',
  issues: [],
} as const;

export const envioListing200Invalido = {
  sku: 'VALIDATION_INVALID',
  status: 'INVALID',
  submissionId: 'a1c562c2-1695-11ee-be56-0242ac120002',
  identifiers: [],
  issues: [
    {
      code: '90000900',
      message: 'The attributes are invalid.',
      severity: 'ERROR',
      attributeNames: ['fake_attribute'],
      categories: ['INVALID_ATTRIBUTE', 'LISTING'],
      enforcements: {
        actions: [{ action: 'ATTRIBUTE_SUPPRESSED' }],
        exemption: { status: 'NOT_EXEMPT' },
      },
    },
  ],
} as const;

/** The sandbox's own document URL (a CloudFront host): kept only to show the guard refusing it. */
export const URL_CLOUDFRONT_DO_SANDBOX =
  'https://d34o8swod1owfl.cloudfront.net/Feed_101__POST_PRODUCT_DATA_.xml';

/** The S3-shaped fake that replaces the sandbox's CloudFront URLs (no region, no real bucket). */
export const URL_DOCUMENTO_FEED_FALSA =
  'https://bucket-teste.s3.amazonaws.com/documento-feed-teste?X-Amz-Signature=0000';

export const documentoFeedCriado201 = {
  feedDocumentId: '3d4e42b5-1d6e-44e8-a89c-2abfca0625bb',
  url: URL_DOCUMENTO_FEED_FALSA,
} as const;

export const feedCriado202 = { feedId: '3485934' } as const;

export const feedCriado202NaoDigitos = {
  feedId: 'POST_FLAT_FILE_FBA_CREATE_REMOVAL_feed_01_SUCCESS',
} as const;

export const feed200Concluido = {
  feedId: '3485934',
  feedType: 'POST_FLAT_FILE_FBA_CREATE_REMOVAL',
  createdTime: '2024-03-11T13:16:24.630Z',
  processingStatus: 'DONE',
  processingStartTime: '2024-03-11T13:16:24.630Z',
  processingEndTime: '2024-03-11T13:16:24.630Z',
  resultFeedDocumentId: 'POST_FLAT_FILE_FBA_CREATE_REMOVAL_resultDoc_success_01',
} as const;

export const documentoFeed200 = {
  feedDocumentId: '0356cf79-b8b0-4226-b4b9-0ee058ea5760',
  url: URL_DOCUMENTO_FEED_FALSA,
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
