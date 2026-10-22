/**
 * Amazon wire schemas — RESPONSE shapes only, and only the ones something in
 * this package consumes today:
 *
 * - the LWA token response (both exchanges),
 * - the LWA error body (its `error` code only),
 * - the SP-API `errors[]` envelope (its `code`s only, for the observer),
 * - the Orders v2026-01-01 ORDER (step 5), which `pedidos.ts` wraps as the
 *   `getOrder` response.
 *
 * Every operation's own schema (Orders, Sellers, Listings, …) arrives with the
 * step that first consumes it, written from the models
 * (`amzn/selling-partner-api-models`) and checked against captured responses.
 *
 * ## Passthrough
 *
 * Every object is `.passthrough()`: Amazon adds fields without notice, and a
 * schema that stripped them would hide exactly the drift a later step needs to
 * see.
 *
 * ## Declare only what is read
 *
 * ⚠️ The LWA error declares `error` and nothing else; the SP-API envelope
 * declares `errors[].code` and nothing else. `error_description`, `message` and
 * `details` are free text that echoes request values, and must never reach an
 * error — a declared field is an invitation to carry it. They survive the parse
 * through passthrough only. The order follows the same rule (its own section
 * below lists what it leaves undeclared, and why).
 *
 * ## Numbers
 *
 * ⚠️ This is the ONLY file under `src/` that uses Zod for numbers, and every one
 * goes through `wireInt()` (or, for the one non-integer, `measurement.value`,
 * `wireNumber()`) from `@delfrance/core/wire`: a serializer that quotes a field
 * must not cost the whole token or the whole order (#1087). Enforced by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`,
 * which scans every file under `src/` and anchors on `expires_in` here.
 * ⚠️ Keep the anchored field on its own short line, so Prettier never wraps it
 * out of the guard's line-based scan.
 */
import { wireInt, wireNumber } from '@delfrance/core/wire';
import { z } from 'zod';

/**
 * A successful LWA token response [D:connecting-to-the-selling-partner-api]:
 * `{ access_token, token_type: 'bearer', expires_in: 3600, refresh_token }`.
 *
 * - `token_type` is a plain string, not a `'bearer'` literal: the access token
 *   travels in `x-amz-access-token`, where the type is never used, and a case
 *   change must not fail the exchange.
 * - `expires_in` is read, never assumed to be 3600 ("typically 3600").
 * - `refresh_token` is OPTIONAL here: the authorization-code exchange always
 *   returns it, while the docs disagree on whether a refresh exchange echoes
 *   it. `lwa.ts` requires it for the code exchange.
 */
export const lwaTokenRespostaSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string(),
    expires_in: wireInt(),
    refresh_token: z.string().min(1).optional(),
  })
  .passthrough();

export type LwaTokenResposta = z.infer<typeof lwaTokenRespostaSchema>;

/**
 * An unsuccessful LWA token response: `{ error, error_description, error_uri? }`.
 * Only `error` is declared; `lerCodigoErroLwa` (`errors.ts`) maps it to a closed
 * set.
 */
export const lwaErroSchema = z
  .object({
    error: z.string(),
  })
  .passthrough();

export type LwaErro = z.infer<typeof lwaErroSchema>;

/**
 * The SP-API error envelope: `{ errors: [{ code, message, details? }] }`.
 *
 * Both model generations put the list under a top-level `errors` key (newer
 * APIs as `ErrorList`, older ones as an optional `errors` on the response), so
 * one envelope covers both. Only `code` is declared, and it is free-form
 * (`'InvalidInput'`, `'Invalid Input'`, `'Unauthorized'`, `'400'`): the client
 * classifies by HTTP status, never by code, and hands the codes to the observer.
 *
 * ⚠️ The models' own sandbox answers some 400s with `{}` — no `errors` key —
 * so a failed parse here is normal, and reads as "no codes".
 */
export const spApiErrosSchema = z
  .object({
    errors: z.array(
      z
        .object({
          code: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type SpApiErros = z.infer<typeof spApiErrosSchema>;

/* -------------------------------------------------------------------------- */
/*                Orders v2026-01-01 — the order (step 5, 5-a)                */
/* -------------------------------------------------------------------------- */

/*
 * Written from the model (`orders_2026-01-01.json`, `GetOrderResponse` →
 * `Order`, printed by `node .master_plans/amazon/evidence/amazon-doc.mjs def
 * Order orders`) and checked against the model's own sandbox examples — never
 * against a live call (D11).
 *
 * ## Tolerant where Amazon is open or may drop a field, strict only where a key is built
 *
 * - Every optional leaf is `.nullish()`: how Amazon represents a withheld field
 *   (key absent, `''` or `null`) is undocumented, and the sandbox already sends
 *   `''`. The readers in `apps/amazon` treat all three as "absent".
 * - Every enum-like string is an OPEN `z.string()`, never `z.enum`:
 *   `fulfillmentStatus`, `fulfilledBy`, `programs[]`, `paymentMethod`,
 *   `cardBrand`, `packageStatus.status`, `detailedStatus`, `invoiceStatus`,
 *   `entityType`, `taxRegistrationType`, `addressType`, `measurement.unit` and
 *   the breakdowns' `type` / `subtype`. A closed enum would turn the first new
 *   value (the migration guide already names `INVOICE_UNCONFIRMED`) into a
 *   whole-order `ZodError`, which parks the notification.
 * - `orderItems` is OPTIONAL although the model requires it, and so are a
 *   line's `quantityOrdered`, `product` and `product.price`: an item-less
 *   cancelled order, or a cancelled line whose quantity Amazon dropped, must
 *   parse. A required parser would park the cancellation (D17).
 * - Money is `{ amount: unknown, currencyCode }`: the amount is read ONCE, by
 *   the app, through `parseWireDecimal`, which answers `null` (never 0) for
 *   anything unreadable. A `wireNumber()` here would park the whole order over
 *   one bad amount, where the app degrades that one leaf to "absent".
 * - Integers go through `wireInt().nullish()`: a quoted `"2"` reads as 2, while
 *   `"2.5"` still refuses (the model's type is integer).
 * - **Strict ONLY where a key is built from it:** `order.orderId` and
 *   `order.lastUpdatedTime` are required strings, and a line's `orderItemId` is
 *   a non-empty string. A line without one refuses the WHOLE order, never
 *   silently drops the line. Their GRAMMAR (the 3-7-7 id, an offset on the
 *   instant, no duplicate line id) is the app's to check: this package cannot
 *   import `@delfrance/schemas`.
 * - `packages[].packageReferenceId` is `z.string().nullish()` like any other
 *   leaf: a package without one is the app's freight fold's to report, never a
 *   parse refusal.
 *
 * ## Never declared (they survive through passthrough only)
 *
 * `buyer.buyerEmail` (an anonymized relay address the cliente never takes),
 * both `cancelReason`s (free text a buyer may type), `proceeds.grandTotal` (what
 * the SELLER receives, never what the buyer paid or the NF-e states), the
 * recipient's `phone` and `addressLine2`/`addressLine3`, the gift message,
 * `orderAliases`, `fulfillmentOrders` and every other leaf no step reads.
 */

/** A string leaf the model marks optional, or Amazon may withhold. */
const textoOpcional = () => z.string().nullish();

/**
 * `Money`: the amount stays unread here (section header).
 *
 * ⚠️ `.optional()` on the `unknown` is not decoration: in Zod 4 a bare
 * `z.unknown()` member still REQUIRES its key ("expected nonoptional"), so an
 * absent amount would refuse the whole order instead of reading as "absent".
 */
export const dinheiroWireAmazonSchema = z
  .object({
    amount: z.unknown().optional(),
    currencyCode: textoOpcional(),
  })
  .passthrough();

export type DinheiroWireAmazon = z.infer<typeof dinheiroWireAmazonSchema>;

/** `DateTimeRange` (the ship-by and deliver-by windows). */
const janelaWireAmazonSchema = z
  .object({
    earliestDateTime: textoOpcional(),
    latestDateTime: textoOpcional(),
  })
  .passthrough();

/** `ItemProceedsBreakdown`: `detailedBreakdowns` carries the DISCOUNT and TAX splits. */
const quebraDoItemWireAmazonSchema = z
  .object({
    type: textoOpcional(),
    subtotal: dinheiroWireAmazonSchema.nullish(),
    detailedBreakdowns: z
      .array(
        z
          .object({
            subtype: textoOpcional(),
            value: dinheiroWireAmazonSchema.nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/** `OrderProceedsBreakdown`: the categories aggregated across the order's lines. */
const quebraDoPedidoWireAmazonSchema = z
  .object({
    type: textoOpcional(),
    subtotal: dinheiroWireAmazonSchema.nullish(),
  })
  .passthrough();

/** `OrderItem`: one line. `orderItemId` is its one strict leaf (a key is built from it). */
export const itemPedidoWireAmazonSchema = z
  .object({
    orderItemId: z.string().min(1),
    quantityOrdered: wireInt().nullish(),
    measurement: z
      .object({
        unit: textoOpcional(),
        value: wireNumber().nullish(),
      })
      .passthrough()
      .nullish(),
    product: z
      .object({
        sellerSku: textoOpcional(),
        title: textoOpcional(),
        price: z
          .object({
            unitPrice: dinheiroWireAmazonSchema.nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    proceeds: z
      .object({
        breakdowns: z.array(quebraDoItemWireAmazonSchema).nullish(),
      })
      .passthrough()
      .nullish(),
    cancellation: z
      .object({
        cancellationRequest: z
          .object({
            requester: textoOpcional(),
          })
          .passthrough()
          .nullish(),
        cancellationExecution: z
          .object({
            cancelledBy: textoOpcional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    fulfillment: z
      .object({
        quantityFulfilled: wireInt().nullish(),
        quantityUnfulfilled: wireInt().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type ItemPedidoWireAmazon = z.infer<typeof itemPedidoWireAmazonSchema>;

/** `OrderPackage`: one Easy Ship package. Nothing here refuses (section header). */
export const pacoteWireAmazonSchema = z
  .object({
    packageReferenceId: z.string().nullish(),
    packageStatus: z
      .object({
        status: textoOpcional(),
        detailedStatus: textoOpcional(),
      })
      .passthrough()
      .nullish(),
    trackingNumber: textoOpcional(),
    packageItems: z
      .array(
        z
          .object({
            quantity: wireInt().nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

export type PacoteWireAmazon = z.infer<typeof pacoteWireAmazonSchema>;

/** `CustomerAddress`, as the recipient's delivery address. */
const enderecoEntregaWireAmazonSchema = z
  .object({
    name: textoOpcional(),
    addressLine1: textoOpcional(),
    city: textoOpcional(),
    stateOrRegion: textoOpcional(),
    postalCode: textoOpcional(),
    countryCode: textoOpcional(),
    addressType: textoOpcional(),
    extendedFields: z
      .object({
        streetName: textoOpcional(),
        streetNumber: textoOpcional(),
        complement: textoOpcional(),
        neighborhood: textoOpcional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

/** `PaymentExecution`. */
const execucaoPagamentoWireAmazonSchema = z
  .object({
    paymentMethod: textoOpcional(),
    paymentAmount: dinheiroWireAmazonSchema.nullish(),
    acquirerId: textoOpcional(),
    cardBrand: textoOpcional(),
    authorizationCode: textoOpcional(),
  })
  .passthrough();

/** `OrderTaxRegistration`. */
const registroFiscalWireAmazonSchema = z
  .object({
    entityType: textoOpcional(),
    legalName: textoOpcional(),
    taxRegistrationType: textoOpcional(),
    taxRegistrationNumber: textoOpcional(),
  })
  .passthrough();

/**
 * `Order` (Orders v2026-01-01), as `getOrder` returns it under the datasets
 * `pedidos.ts` requests. Strict only on `orderId`, `lastUpdatedTime` and each
 * line's `orderItemId`; everything else is tolerant (section header).
 */
export const pedidoWireAmazonSchema = z
  .object({
    orderId: z.string(),
    lastUpdatedTime: z.string(),
    createdTime: textoOpcional(),
    programs: z.array(z.string()).nullish(),
    associatedOrders: z
      .array(
        z
          .object({
            orderId: textoOpcional(),
            associationType: textoOpcional(),
          })
          .passthrough(),
      )
      .nullish(),
    salesChannel: z
      .object({
        channelName: textoOpcional(),
        marketplaceId: textoOpcional(),
      })
      .passthrough()
      .nullish(),
    buyer: z
      .object({
        buyerName: textoOpcional(),
        buyerCompanyName: textoOpcional(),
      })
      .passthrough()
      .nullish(),
    recipient: z
      .object({
        deliveryAddress: enderecoEntregaWireAmazonSchema.nullish(),
      })
      .passthrough()
      .nullish(),
    proceeds: z
      .object({
        breakdowns: z.array(quebraDoPedidoWireAmazonSchema).nullish(),
      })
      .passthrough()
      .nullish(),
    payment: z
      .object({
        paymentExecutions: z.array(execucaoPagamentoWireAmazonSchema).nullish(),
      })
      .passthrough()
      .nullish(),
    tax: z
      .object({
        taxRegistrations: z.array(registroFiscalWireAmazonSchema).nullish(),
        taxInvoicing: z
          .object({
            invoiceStatus: textoOpcional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
    fulfillment: z
      .object({
        fulfillmentStatus: textoOpcional(),
        fulfilledBy: textoOpcional(),
        shipByWindow: janelaWireAmazonSchema.nullish(),
        deliverByWindow: janelaWireAmazonSchema.nullish(),
      })
      .passthrough()
      .nullish(),
    orderItems: z.array(itemPedidoWireAmazonSchema).nullish(),
    packages: z.array(pacoteWireAmazonSchema).nullish(),
  })
  .passthrough();

export type PedidoWireAmazon = z.infer<typeof pedidoWireAmazonSchema>;
