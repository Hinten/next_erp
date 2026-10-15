# Survey C: Orders API v2026-01-01 vs v0

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Scope: operations, includedData and PII gating, the field inventory an ERP import needs, Easy Ship status in v2026, the v0 migration guide and deprecation, and the static sandbox cases. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

# Orders API v2026-01-01 vs v0 for importing Amazon.com.br orders into the ERP (and issuing NF-e)

Research date: 2026-10-14. No live SP-API or AWS endpoint was called. The docs pages were read through the host's raw-markdown rendering (`<page>.md`), which shows each page's `updatedAt`. Docs text is paraphrased below, with one short quote.

## Source key (cited below by these tags)

| Tag | Source | Date |
|---|---|---|
| **M26** | `models/orders-api-model/orders_2026-01-01.json` (raw.githubusercontent.com/amzn/selling-partner-api-models/main/…) | Latest commit `3677bb9d96`, 2026-09-30 ("SPAPI September 2026 Release"). First added in `adc5701b25`, 2026-01-28. Later commits: 01-28, 04-29 (×2), 05-27 (×2, incl. "Prune Orders model"), 07-29 |
| **MV0** | `models/orders-api-model/ordersV0.json` | Latest commit `e584dcb641`, 2026-05-27 |
| **OAPI** | https://developer-docs.amazon/sp-api/docs/orders-api | updatedAt 2026-09-09T22:46:53Z |
| **MG** | …/docs/orders-api-migration-guide | 2026-09-09T09:03:16Z |
| **PII** | …/docs/access-orders-pii | 2026-09-30T21:33:02Z |
| **TAX** | …/docs/get-tax-information | 2026-09-09T22:47:37Z |
| **FILT** | …/docs/get-orders-with-filtering-criteria | 2026-09-30T21:33:06Z |
| **GOI** | …/docs/get-order-information | 2026-09-30T21:32:59Z |
| **RL** | …/docs/orders-api-rate-limits | 2026-09-09T22:36:21Z |
| **DEP** | …/docs/sp-api-deprecations | 2026-09-09T22:32:48Z |
| **RN** | …/docs/sp-api-release-notes | 2026-10-01T21:11:26Z |
| **REF** | …/reference/orders-v2026-01-01 (2026-09-09T09:08:36Z), …/reference/searchorders (2026-09-10T19:06:30Z), …/reference/getorder-3 | Generated from the model. Checked that they contain the Sept-2026 fields (`promiseCalculationInputs`, `labelPrintingWindow`, `cancellationExecution`, `purchasePrice`, `fulfillmentOrders`) |
| **CSS** | …/docs/confirm-the-shipment-status | 2026-09-30T21:32:48Z |
| **SBX** | …/docs/sp-api-sandbox | 2026-09-09T22:32:02Z |
| **ISO** | …/docs/iso-8601 | 2026-09-09T22:32:33Z |
| **ESAPI / ESM** | …/docs/easy-ship-api (2026-09-09T22:45:49Z) / `models/easy-ship-model/easyShip_2022-03-23.json` | |
| **DBA / DBAM** | …/docs/delivery-by-amazon-api (2026-09-09T22:42:29Z), …/docs/submit-an-invoice-delivery-by-amazon-order (2026-09-09T22:42:26Z) / `models/delivery-by-amazon/deliveryShipmentInvoiceV2022-07-01.json` | |
| **EFS / EFM** | …/docs/external-fulfillment-shipping (2026-09-09T22:49:23Z) / `models/external-fulfillment/externalFulfillmentShipments_2024-09-11.json` | |
| **AB** | …/docs/get-all-amazon-business-orders | 2026-09-30T21:32:46Z |

Model paths below are relative to the root of each model file. `P` = `paths./orders/2026-01-01/orders.get`. `G` = `paths./orders/2026-01-01/orders/{orderId}.get`.

---

## 1. Operations (v2026-01-01)

M26 has exactly **two paths**. Host is `sellingpartnerapi-na.amazon.com` (M26 `host`).

| operationId | Method + path | Default rate (rps) / burst | Source |
|---|---|---|---|
| `searchOrders` | GET `/orders/2026-01-01/orders` | **0.0056 / 20** | M26 `P.description`; RL |
| `getOrder` | GET `/orders/2026-01-01/orders/{orderId}` | **0.5 / 30** | M26 `G.description`; RL |

- 0.0056 rps works out to about one `searchOrders` call every ~179 s once the burst is spent (arithmetic from the table).
- v0 `getOrders` was 0.0167 / 20 (RL; MV0 `paths./orders/v0/orders.get.description`). So the sustained search rate is roughly 3× lower in v2026. The trade-off is that items come inline with each order.
- Both models say the `x-amzn-RateLimit-Limit` header carries the applied usage plan. A seller may get higher values than the default.

### searchOrders parameters (M26 `P.parameters`)

| Param | Type / constraints | Rules |
|---|---|---|
| `createdAfter` | date-time, ISO 8601 | Exactly one of `createdAfter` or `lastUpdatedAfter` is required. If `createdAfter` is used, neither `lastUpdated*` param may be sent. |
| `createdBefore` | date-time | Optional with `createdAfter`. Must be ≥ `createdAfter` and at least 2 minutes before the request time. |
| `lastUpdatedAfter` | date-time | Covers any change by Amazon or the seller, including status. Mutually exclusive with `created*`. |
| `lastUpdatedBefore` | date-time | Same ≥ / 2-minute rule as `createdBefore`. |
| `fulfillmentStatuses` | array, enum `PENDING_AVAILABILITY, PENDING, UNSHIPPED, PARTIALLY_SHIPPED, SHIPPED, CANCELLED, UNFULFILLABLE` | Replaces v0 `OrderStatuses`. |
| `marketplaceIds` | array, maxItems 50, **optional** | v0 `MarketplaceIds` was required (MV0 `paths./orders/v0/orders.get.parameters[MarketplaceIds].required=true`). |
| `fulfilledBy` | array, enum `MERCHANT, AMAZON` | Replaces v0 `FulfillmentChannels`. |
| `maxResultsPerPage` | integer 1–100, default 100 | |
| `paginationToken` | string | Pass the previous response's `pagination.nextToken`. |
| `includedData` | array, enum below | |

Pagination (M26 `definitions.Pagination`, `definitions.SearchOrdersResponse.properties.pagination`):
- The token expires after **24 h**.
- Every other parameter must stay the same between pages, except `maxResultsPerPage` and `includedData`.
- `pagination` is absent on the last page.
- The response also echoes `createdBefore` / `lastUpdatedBefore`.
- FILT says the same.

**v0 filters missing from v2026:**
- Not in M26 at all: `SellerOrderId`, `AmazonOrderIds`, `ElectronicInvoiceStatuses`, `StoreChainStoreId`, and the four `Earliest/LatestDeliveryDate*` filters. These are compared against MV0 `paths./orders/v0/orders.get.parameters`, and MG's parameter table does not mention them.
- Listed by MG as unavailable: `PaymentMethods`, `BuyerEmail`, `EasyShipShipmentStatuses`, `ActualFulfillmentSupplySourceId`, `IsISPU`.

### getOrder parameters (M26 `G.parameters`)

`orderId` (path, required) and `includedData` (same enum as searchOrders).

### includedData enum (M26 `P.parameters[includedData].items.enum`)

| Value | Adds (MG step 3; FILT; GOI; M26 enum descriptions) | Roles / conditions documented |
|---|---|---|
| `BUYER` | `Order.buyer` (`buyerName`, `buyerEmail`, `buyerCompanyName`, `buyerPurchaseOrderNumber`) | `buyerEmail`: Direct-to-Consumer Shipping (Restricted), FBM only, status UNSHIPPED / PARTIALLY_SHIPPED / SHIPPED. `buyerName`: Tax Invoicing or Tax Remittance (Restricted) for FBA or FBM, or DTC Shipping for FBM; same status condition (PII). `buyerCompanyName` and PO number are not in PII's list, so any extra role need is UNKNOWN. |
| `RECIPIENT` | `Order.recipient` (`deliveryAddress`, `deliveryPreference`) | Restricted parts (`name`, `addressLine1-3`, `extendedFields`): Tax Invoicing / Tax Remittance (FBA or FBM) or DTC Shipping (FBM); status UNSHIPPED / PARTIALLY_SHIPPED / SHIPPED. `phone`: DTC Shipping, FBM only, same statuses, and may be suppressed. `city` / `districtOrCounty` / `countryCode` have no conditions (PII). |
| `FULFILLMENT` | `Order.fulfillment`, `orderItems[].fulfillment` | `giftOption.giftMessage` needs DTC Shipping, FBM (PII). |
| `PROCEEDS` | `Order.proceeds` (incl. `breakdowns`), `orderItems[].proceeds` | None documented |
| `EXPENSE` | `orderItems[].expense` | None documented |
| `PROMOTION` | `orderItems[].promotion` | None documented |
| `CANCELLATION` | `orderItems[].cancellation` | None documented |
| `PACKAGES` | `Order.packages` (FBM only; M26 `definitions.Order.properties.packages`) | None documented |
| `TAX` | `Order.tax`, `orderItems[].tax` | `taxRegistrations[]` needs **Tax Invoicing (Restricted) or Tax Remittance (Restricted)** (TAX steps 1–4; PII tables). Whether `taxInvoicing.invoiceStatus` also needs them is UNKNOWN. |
| `PAYMENT` | `Order.payment` | None documented |
| `FULFILLMENT_ORDERS` | `Order.fulfillmentOrders[]` (Easy Ship and Seller Flex only; M26 `definitions.Order.properties.fulfillmentOrders`) | None documented. Added 2026-05-27 (RN). It is **missing from the includedData tables in MG, FILT and GOI.** |

Base roles for `searchOrders` / `getOrder` v2026 (OAPI): at least one of 12 roles (Amazon Fulfillment, Buyer Communication, Buyer Solicitation, DTC Shipping (R), Finance and Accounting, Inventory and Order Tracking, Pricing, Product Listing, Professional Services (R), Selling Partner Insights, Tax Invoicing (R), Tax Remittance (R)). Regions: NA, EU, FE.

Without `includedData`, the response has basic data only: `orderId`, `createdTime`, `salesChannel`, `programs`, `orderItemId`, `product` and similar (FILT; GOI).

### Ship confirmation, shipment status and order items: do they exist in v2026?

- **No ship-confirmation or status-update endpoints in v2026.** M26 has only the two GET paths above.
- **They stay in v0:**
  - `confirmShipment` — POST `/orders/v0/orders/{orderId}/shipmentConfirmation`, 2 / 10
  - `updateShipmentStatus` — POST `…/shipment`, 5 / 15; enum `ReadyForPickup, PickedUp, RefusedPickup`
  - `getOrderRegulatedInfo` and `updateVerificationStatus` — 0.5 / 30
  - Sources: MV0 paths; RL; MV0 `definitions.ShipmentStatus`.
- **Those four are not deprecated:** they have no `deprecated` flag in MV0 and are not on DEP's removal list. CSS (2026-09-30) still documents `confirmShipment` against Orders v0.
- **Order items:** in v2026 they are always inline. `orderItems` is required on `Order` (M26 `definitions.Order.required`), and MG maps `GetOrderItems` to `getOrder` with items always included.
- **No item-level pagination** exists in v2026, unlike v0 `getOrderItems`, which had `NextToken`. Whether very large orders are complete is UNKNOWN.

### Restricted Data Token in v2026

**Nothing documented needs an RDT.** PII access needs no RDT, only roles (PII note; MG step 2; FILT; GOI). No v2026 doc mentions an RDT for any other field.

---

## 2. v0 deprecation

**DEP, "Orders API" table:**

| Item | Value |
|---|---|
| Removed items | Orders v0 `getOrders`, `getOrder`, `getOrderBuyerInfo`, `getOrderAddress`, `getOrderItems`, `getOrderItemsBuyerInfo` |
| Deprecation date | **January 28, 2026** |
| Removal date | **March 27, 2027** — yes, 2027-03-27 is confirmed |

- **What happens after removal:** DEP defines "Deprecated" as no longer in active development, and "Removed" as the point when "calls to the resources fail as of the removal date".
- **The model agrees:** MV0 marks exactly those six as `deprecated: true` (`paths./orders/v0/orders.get.deprecated`, `…/{orderId}.get.deprecated`, `…/buyerInfo.get.deprecated`, `…/address.get.deprecated`, `…/orderItems.get.deprecated`, `…/orderItems/buyerInfo.get.deprecated`).
- **Not scheduled for removal:** `confirmShipment`, `updateShipmentStatus`, `getOrderRegulatedInfo`, `updateVerificationStatus`.
- **OAPI** says Orders v0 is deprecated and points to MG. Its version table lists v2026-01-01 as current, v0 as legacy, sellers only, static sandbox.
- **RN 2026-01-28:** launched v2026 ("ten operations into two") and pointed to DEP. The same release removed `BuyerEmail` from v0 FBA orders; MFN orders now need the DTC Shipping role for it.
- **Related removal, already past:** the `ORDER_STATUS_CHANGE` notification was deprecated June 21, 2023 and removed **July 29, 2026** (DEP, Notifications table).
- **Timing:** today is 2026-10-14, so about 5.5 months remain before the v0 read operations are removed.

---

## 3. Field inventory for the ERP import (v2026 path ↔ v0)

Paths are under `Order` (M26 `definitions.*`). The "Inc" column is the `includedData` value MG says is required; "—" means none is required.

| Data | v2026 path | Inc | v0 equivalent (MV0) | Notes |
|---|---|---|---|---|
| Order id | `orderId` | — | `AmazonOrderId` | |
| Seller order id | `orderAliases[aliasType=SELLER_ORDER_ID].aliasId` | — | `SellerOrderId` | `aliasType` only possible value: `SELLER_ORDER_ID` (M26 `definitions.Alias`) |
| Order status | `fulfillment.fulfillmentStatus` | FULFILLMENT (see open question 1) | `OrderStatus` | Enum below. MG's table has no includedData note on this row, but MG and FILT put all of `Order.fulfillment` under FULFILLMENT. |
| Fulfillment channel | `fulfillment.fulfilledBy` (`AMAZON`, `MERCHANT`) | FULFILLMENT | `FulfillmentChannel` (`MFN`, `AFN`) | MG: MFN→MERCHANT, AFN→AMAZON |
| Sales channel | `salesChannel.marketplaceName`; also `.channelName` (`AMAZON` / `NON_AMAZON`) and `.marketplaceId` | — | `SalesChannel`, `MarketplaceId` | `OrderChannel`: Deprecated, no equivalent (MG) |
| Purchase time | `createdTime` | — | `PurchaseDate` | v2026: `format: date-time`, ISO 8601. v0 `PurchaseDate` is plain `type: string`. Timezone: UNKNOWN. ISO allows `Z` or `±hh:mm`; every M26 sandbox example uses `Z`. |
| Last update | `lastUpdatedTime` | — | `LastUpdateDate` | Same format notes |
| Prime / Business / Premium | `programs[]` contains `PRIME`, `AMAZON_BUSINESS`, `PREMIUM` | — | `IsPrime`, `IsBusinessOrder`, `IsPremiumOrder` | Full order-level list: `AMAZON_BAZAAR, AMAZON_BUSINESS, AMAZON_EASY_SHIP, AMAZON_HAUL, DELIVERY_BY_AMAZON, FBM_SHIP_PLUS, INVOICE_BY_AMAZON, IN_STORE_PICK_UP, PREMIUM, PREORDER, PRIME` (M26 `definitions.Order.properties.programs`, free string with "Possible values") |
| Replacement / exchange | `associatedOrders[].orderId` with `associationType` `REPLACEMENT_ORIGINAL_ID` or `EXCHANGE_ORIGINAL_ID` | — | `IsReplacementOrder`, `ReplacedOrderId` | |
| Preorder | `programs[]` contains `PREORDER` | — | `OrderType=Preorder` | `LongLeadTimeOrder`, `SourcingOnDemandOrder`, `BackOrder` not available (MG) |
| Shipping service category | `fulfillment.fulfillmentServiceLevel` (`EXPEDITED, FREE_ECONOMY, NEXT_DAY, PRIORITY, SAME_DAY, SECOND_DAY, SCHEDULED, STANDARD`) | FULFILLMENT | `ShipmentServiceLevelCategory` | `ShipServiceLevel`: Deprecated, no equivalent (MG) |
| Carrier / service behind the promise | `fulfillment.promiseCalculationInputs.transitTime.details.{carrier,shippingService}` and `.dataSource` (`AMAZON_AUTOMATED`, `SELLER_SET`, `THIRD_PARTY_INTEGRATOR`) | FULFILLMENT | none (closest: `AutomatedShippingSettings`, which MG lists as "Under consideration") | New 2026-09-30 (RN). Model examples: `Correios` / `SEDEX` |
| Ship-by window | `fulfillment.shipByWindow.{earliestDateTime,latestDateTime}` | FULFILLMENT | `EarliestShipDate` / `LatestShipDate` | |
| Deliver-by window | `fulfillment.deliverByWindow.*` | FULFILLMENT | `EarliestDeliveryDate` / `LatestDeliveryDate` | |
| Label print window | `fulfillment.labelPrintingWindow.earliestDateTime` | FULFILLMENT | none | New 2026-07-29 (RN). No `latestDateTime`; blank means print any time |
| Items shipped / unshipped | none at order level; per item `orderItems[].fulfillment.quantityFulfilled` / `quantityUnfulfilled` | FULFILLMENT | `NumberOfItemsShipped` / `NumberOfItemsUnshipped` | MG: not supported, "Under consideration". Summing per item is the ERP's own derivation. |
| Order total | `proceeds.grandTotal` (`Money`: `amount` is a decimal string, `currencyCode`) | PROCEEDS | `OrderTotal` | **Meaning differs:** v0 says "the total charge for this order"; v2026 says the total amount the seller receives (M26 `definitions.OrderProceeds`). The model has no fee category, so whether fees are deducted is UNKNOWN. |
| Order-level breakdowns | `proceeds.breakdowns[].{type,subtotal,status}`; types `ITEM, SHIPPING, GIFT_WRAP, COD_FEE, TAX, DISCOUNT, DELIVERY_TIP, OTHER`; `status` `PENDING` / `FINALIZED` (only for `DELIVERY_TIP`) | PROCEEDS | none | Added 2026-05-27 (RN) |
| Payment method | `payment.paymentExecutions[].paymentMethod` (free string; model examples: CashOnDelivery, ConvenienceStore, CreditCard, Invoice, Pix) | PAYMENT | `PaymentMethod` (`COD, CVS, Other`), `PaymentMethodDetails` (list of strings), `PaymentExecutionDetail[]` (sub-methods `COD, GC, PointsAccount, Invoice, CreditCard, Pix, Other`) | **Boleto: UNKNOWN** — appears in neither model. **Installments: UNKNOWN** — no field in either model. |
| Payment amount | `payment.paymentExecutions[].paymentAmount` | PAYMENT | `PaymentExecutionDetail[].Payment` | |
| Card / Pix details (BR) | `payment.paymentExecutions[].acquirerId`, `.cardBrand`, `.authorizationCode` | PAYMENT | `PaymentExecutionDetail[].AcquirerId` / `CardBrand` / `AuthorizationCode` | BR only. `acquirerId` and `authorizationCode` for CreditCard or Pix; `cardBrand` for CreditCard only. v0 calls AcquirerId the processor's CNPJ; the v2026 description does not say CNPJ. |
| Buyer name | `buyer.buyerName` | BUYER | `BuyerInfo.BuyerName` | PII (roles in section 1) |
| Buyer email | `buyer.buyerEmail` | BUYER | `BuyerInfo.BuyerEmail` | Described as **anonymized** email, FBM only (M26 `definitions.Buyer`) |
| Buyer company | `buyer.buyerCompanyName` | BUYER | `OrderAddress.BuyerCompanyName` | |
| Buyer PO | `buyer.buyerPurchaseOrderNumber` | BUYER | `BuyerInfo.PurchaseOrderNumber` | |
| Buyer county | none | — | `BuyerInfo.BuyerCounty` (BR only) | MG: **Deprecated**, no replacement |
| Shipping address | `recipient.deliveryAddress.{name, companyName, addressLine1-3, city, districtOrCounty, stateOrRegion, municipality, postalCode, countryCode, phone, addressType, extendedFields}` | RECIPIENT | `ShippingAddress` | `addressType` adds `PICKUP_POINT`, which replaces `IsAccessPointOrder` (MG). v0 `GeoCoordinates` is not in v2026 `AddressExtendedFields` and MG does not mention it. |
| BR address parts | `recipient.deliveryAddress.extendedFields.{streetName, streetNumber, complement, neighborhood}` | RECIPIENT | `ShippingAddress.ExtendedFields.*` | BR only (M26 `definitions.AddressExtendedFields`); PII |
| Delivery preferences | `recipient.deliveryPreference` | RECIPIENT | `OrderAddress.DeliveryPreferences` | |
| **Buyer CPF / CNPJ** | `tax.taxRegistrations[entityType=BUYER].taxRegistrationType` (possible values `BUSINESS, VAT, CST, CPF, CNPJ`) + `.taxRegistrationNumber` | **TAX**, plus **Tax Invoicing or Tax Remittance (Restricted)** | `BuyerInfo.BuyerTaxInfo.TaxClassifications[].Name/Value` (v0 limits this to business orders in BR, MX, IN) | TAX: "You can also get the buyer CPF … for Brazil orders". CNPJ for BR buyers is not stated; the BR sandbox business buyer comes back as `VAT` / `1234567890`. **Under DTC Shipping alone, `taxRegistrations` is "No" for every fulfillment channel** (PII table for non-US/JP/SG). |
| Buyer legal / company name | `tax.taxRegistrations[BUYER].legalName` | TAX + Tax role | `BuyerTaxInfo.CompanyLegalName` | |
| Inscrição Estadual (IE) | **UNKNOWN** — no documented field | | none documented | |
| Buyer tax address | `tax.taxRegistrations[BUYER].taxRegistrationAddress` | TAX | `BuyerTaxInformation.BuyerBusinessAddress` (TR) | TAX: Türkiye only |
| Taxing region | `salesChannel.marketplaceId` | — | `BuyerTaxInfo.TaxingRegion` | This is MG's own mapping |
| Marketplace (Amazon) tax id | `tax.taxRegistrations[entityType=MARKETPLACE].taxRegistrationType` / `.taxRegistrationNumber` | TAX + Tax role | `MarketplaceTaxInfo.TaxClassifications` | **BR only, and only while the order is PENDING or UNSHIPPED** (TAX step 4; same rule in MV0 `definitions.Order.properties.MarketplaceTaxInfo`) |
| Seller display / legal name | `tax.taxRegistrations[entityType=MERCHANT].legalName` | TAX + Tax role | `SellerDisplayName` | **BR only, PENDING or UNSHIPPED only** (TAX step 3) |
| Electronic-invoice status | `tax.taxInvoicing.invoiceStatus` (`NOT_REQUIRED, NOT_FOUND, PROCESSING, ERRORED, ACCEPTED`) | TAX | `ElectronicInvoiceStatus` (`NotRequired…Accepted`) | Scope differs between sources; see sections 4 and 8 |
| Invoice by Amazon | `programs[]` contains `INVOICE_BY_AMAZON` | — | `IsIBA` | |
| Order item id | `orderItems[].orderItemId` | — | `OrderItemId` | |
| ASIN / SKU / title | `orderItems[].product.asin`, `.sellerSku`, `.title` | — | `ASIN`, `SellerSKU`, `Title` | |
| Quantity ordered / shipped | `orderItems[].quantityOrdered`; `orderItems[].fulfillment.quantityFulfilled` | qty shipped: FULFILLMENT | `QuantityOrdered`, `QuantityShipped` | |
| Measurement | `orderItems[].measurement.{unit,value}` | — | `Measurement` | |
| Unit price | `orderItems[].product.price.unitPrice` | — | none (new) | Single-unit price, as shown on the retail site (MG) |
| Line item price | `orderItems[].proceeds.breakdowns[type=ITEM].subtotal` | PROCEEDS | `ItemPrice` (v0: unit × qty) | MG: tax-exclusive when tax is shown separately, otherwise tax-inclusive. Which one BR uses is UNKNOWN. |
| Shipping price | `…breakdowns[type=SHIPPING].subtotal` | PROCEEDS | `ShippingPrice` | |
| Gift wrap price / tax | `…breakdowns[type=GIFT_WRAP].subtotal`; `…[type=TAX].detailedBreakdowns[subtype=GIFT_WRAP]` | PROCEEDS | `BuyerInfo.GiftWrapPrice` / `GiftWrapTax` | |
| Gift message / wrap level | `orderItems[].fulfillment.packing.giftOption.{giftMessage, giftWrapLevel}` | FULFILLMENT | `IsGift`, `BuyerInfo.GiftMessageText` / `GiftWrapLevel` | MG writes `packing.giftMessage`; the model path includes `giftOption` (see 5c). `giftMessage` is PII. |
| Promotion discount | `…breakdowns[type=DISCOUNT].subtotal`; shipping discount at `…[type=DISCOUNT].detailedBreakdowns[subtype=SHIPPING]` | PROCEEDS | `PromotionDiscount`, `ShippingDiscount` | Sign convention not in the model. MG's example has DISCOUNT `3.00` with total `29.16` = 25 + 5 − 3 + 2.16, so the amount appears positive and is subtracted. |
| Promotion ids | `orderItems[].promotion.breakdowns[].promotionId` | PROMOTION | `PromotionIds` | |
| Item taxes | `…breakdowns[type=TAX].subtotal` and `detailedBreakdowns[subtype ITEM / SHIPPING / DISCOUNT / GIFT_WRAP]` | PROCEEDS | `ItemTax`, `ShippingTax`, `PromotionDiscountTax`; `ShippingDiscountTax` is folded into PromotionDiscountTax (MG) | Which Brazilian taxes are represented: UNKNOWN |
| COD fee | `…[type=COD_FEE]`; discount at `…[type=DISCOUNT]…[subtype=COD_FEE]` | PROCEEDS | `CODFee`, `CODFeeDiscount` | |
| Tax collection | `orderItems[].tax.taxCollections[].{model,responsibleParty}`; `taxCalculationBreakdowns[].reportingScheme` | TAX | `TaxCollection`, `DeemedResellerCategory` | |
| Condition | `orderItems[].product.condition.{conditionType, conditionSubtype, conditionNote}` | — | `ConditionId`, `ConditionSubtypeId`, `ConditionNote` | Values are now UPPER_SNAKE (M26 `definitions.ItemCondition`) |
| Serial numbers | `orderItems[].product.serialNumbers[]` ("typically provided for FBA"); requirement flag at `orderItems[].fulfillment.packing.serialNumberRequirement.requirementType` = `REQUIRED` | requirement: FULFILLMENT | `SerialNumbers` (FBA only); `SerialNumberRequired` (Easy Ship only in v0) | |
| Item programs | `orderItems[].programs[]` (`TRANSPARENCY`, `SUBSCRIBE_AND_SAVE`) | — | `IsTransparency`, `AmazonPrograms` | `FBM_SHIP_PLUS` moved to order level (MG) |
| Customization | `orderItems[].product.customization.customizedUrl` | — | `BuyerInfo.BuyerCustomizedInfo.CustomizedURL` | PII: DTC Shipping, FBM |
| Buyer-requested cancel | `orderItems[].cancellation.cancellationRequest.{requester (BUYER), cancelReason}` | CANCELLATION | `BuyerRequestedCancel.{IsBuyerRequestedCancel, BuyerCancelReason}` | MG's path omits `cancellationRequest` (see 5c) |
| Cancellation executed | `orderItems[].cancellation.cancellationExecution.{cancelledBy (BUYER / MERCHANT / AMAZON), cancelReason}` | CANCELLATION | none | New 2026-07-29 (RN) |
| Points / expense | `orderItems[].expense.pointsCost.pointsGranted.{pointsNumber, pointsMonetaryValue}` | EXPENSE | `PointsGranted` | Only expense type in the model |
| Amazon fees / commissions | **none in Orders API** (UNKNOWN beyond absence) | | none | |
| Associated items | `orderItems[].associatedOrderItems[].{orderId, orderItemId, associationType (VALUE_ADD_SERVICE / WARRANTY), asin, purchasePrice}` | — | `AssociatedItems` | `asin`, `purchasePrice` and `WARRANTY` added 2026-09-30 (RN) |
| Shipping constraints | `orderItems[].fulfillment.shipping.shippingConstraints.{palletDelivery, cashOnDelivery, signatureConfirmation, recipientIdentityVerification, recipientAgeVerification}` = `MANDATORY` | FULFILLMENT | `ShippingConstraints` | `cashOnDelivery` is new. `palletDelivery` guidance in AB. |
| Scheduled delivery | `orderItems[].fulfillment.shipping.scheduledDeliveryWindow` | FULFILLMENT | `ScheduledDeliveryStartDate` / `EndDate` | |
| Packages / tracking | `packages[].{packageReferenceId, createdTime, packageStatus.{status, detailedStatus}, carrier, shipTime, shippingService, trackingNumber, shipFromAddress, packageItems[].{orderItemId, quantity, transparencyCodes}}` | PACKAGES | none in v0 reads | FBM only |
| Fulfillment orders (Easy Ship) | `fulfillmentOrders[].fulfillmentOrderId` | FULFILLMENT_ORDERS | none | Same value as the External Fulfillment Shipment ID |
| Regulated items | none | | `HasRegulatedItems` | MG: "Under consideration"; `getOrderRegulatedInfo` stays in v0 |
| Default ship-from, FulfillmentInstruction, AutomatedShippingSettings, StoreChainStoreId, ProductInfo.NumberOfItems | none | | v0 fields | MG: not supported, "Under consideration" |

**Order status values.** v2026 (M26 `definitions.FulfillmentStatus.x-docgen-enum-table-extension`), paraphrased:

| Value | Meaning |
|---|---|
| `PENDING_AVAILABILITY` | Pre-orders only: placed, payment not authorized, release date in the future |
| `PENDING` | Placed, not ready to ship. Initial status for standard orders; pre-orders move here when payment authorization begins |
| `UNSHIPPED` | Ready to ship, nothing shipped yet |
| `PARTIALLY_SHIPPED` | At least one item shipped, but not all |
| `SHIPPED` | All items shipped |
| `CANCELLED` | Cancelled, will not be fulfilled |
| `UNFULFILLABLE` | Cannot be fulfilled. Only for Amazon-fulfilled orders not placed on Amazon's retail site |

v0 (MV0 `definitions.Order.properties.OrderStatus`) has eight values: `Pending, Unshipped, PartiallyShipped, Shipped, Canceled, Unfulfillable, InvoiceUnconfirmed, PendingAvailability`. `InvoiceUnconfirmed` means everything shipped but the seller has not confirmed to Amazon that the invoice was shipped to the buyer. v0 `Pending` also states that payment is not authorized.

**Discrepancy:** MG maps `InvoiceUnconfirmed`→`INVOICE_UNCONFIRMED`, but that value is **absent** from M26 `definitions.FulfillmentStatus.enum` and from `P.parameters[fulfillmentStatuses]`.

**PII and NF-e timing (from the docs):**
- Buyer name and the restricted address parts are only returned in UNSHIPPED, PARTIALLY_SHIPPED or SHIPPED (PII).
- MERCHANT and MARKETPLACE tax registrations are only returned while PENDING or UNSHIPPED (TAX).
- So UNSHIPPED is the only status where both sets are documented as available.

---

## 4. Easy Ship / DBA in v2026

**Identifying an Easy Ship order:**
- `programs[]` contains `AMAZON_EASY_SHIP` (M26 `definitions.Order.properties.programs`; MG lists it as "New in v2026-01-01").
- `fulfillmentOrders[]`, returned with `includedData=FULFILLMENT_ORDERS`, is only available for Easy Ship and Seller Flex (M26 `definitions.FulfillmentOrder`).
- v0 signal: `EasyShipShipmentStatus` was only present on Easy Ship orders (MV0 `definitions.Order.properties.EasyShipShipmentStatus`).
- `DELIVERY_BY_AMAZON` is a separate program (MG: new). The model never defines what it means. The BR sandbox case pairs it with `fulfilledBy: MERCHANT`. Its relation to Easy Ship is UNKNOWN.

**Shipment status:**
- MG maps `EasyShipShipmentStatus` → `packages[].packageStatus.detailedStatus`, which requires `includedData=PACKAGES`.
- `detailedStatus` is a **free string** with "Possible values" listed in its description, not a JSON enum (M26 `definitions.PackageStatus.properties.detailedStatus`).
- `packageStatus.status` **is** an enum: `PENDING, IN_TRANSIT, SHIPPED, DELIVERED, CANCELLED, UNDELIVERABLE`.

| v0 `EasyShipShipmentStatus` (MV0 `definitions.EasyShipShipmentStatus.enum`) | v2026 `detailedStatus` value (M26) | Meaning (paraphrased from M26) |
|---|---|---|
| PendingSchedule | PENDING_SCHEDULE | Waiting for pickup to be scheduled |
| PendingPickUp | PENDING_PICK_UP | Ready for the carrier to collect from the seller |
| PendingDropOff | PENDING_DROP_OFF | Waiting for the seller to drop off at the carrier |
| LabelCanceled | **LABEL_CANCELLED** (spelling change) | Seller cancelled the label |
| PickedUp | PICKED_UP | Carrier collected from the seller |
| DroppedOff | DROPPED_OFF | Seller handed it to the carrier |
| AtOriginFC | AT_ORIGIN_FC | At the origin fulfillment center |
| AtDestinationFC | AT_DESTINATION_FC | At the destination fulfillment center |
| Delivered | DELIVERED | Delivered |
| RejectedByBuyer | REJECTED_BY_BUYER | Refused by the recipient |
| Undeliverable | UNDELIVERABLE | Address or access problem |
| ReturningToSeller | RETURNING_TO_SELLER | On the way back to the seller |
| ReturnedToSeller | RETURNED_TO_SELLER | Back with the seller |
| Lost | LOST | Lost |
| OutForDelivery | OUT_FOR_DELIVERY | Out for delivery |
| Damaged | DAMAGED | Damaged in transit |

- The 1:1 pairing of values is my alignment by name. MG maps only the field, not each value.
- Whether non-Easy-Ship FBM packages also get `detailedStatus` is UNKNOWN.
- v2026 has **no server-side filter** by Easy Ship status (MG: `EasyShipShipmentStatuses` is replaced by `includedData=PACKAGES`), so the ERP has to filter on its side.
- For comparison, the separate Easy Ship API uses another enum (ESM `definitions.PackageStatus.enum`): `ReadyForPickup, PickedUp, AtOriginFC, AtDestinationFC, Delivered, Rejected, Undeliverable, ReturnedToSeller, LostInTransit, LabelCanceled, DamagedInTransit, OutForDelivery`.

**BR Easy Ship / DBA specifics:**
- **Brazil is not in the Easy Ship API v2022-03-23 store-support table.** The table lists MX, IN, TR, AU, SG, JP, NL, PL (ESAPI "Amazon store support").
- **NF-e status gates pickup:** TAX step 5 says to use `tax.taxInvoicing.invoiceStatus` to control Brazil Easy Ship pickup scheduling, and to schedule only when it is `ACCEPTED`.
- **Submitting the NF-e XML:** the BR-only Delivery by Amazon API `submitInvoice` (POST `/delivery/2022-07-01/invoice`) takes the SEFAZ-approved XML, Base64-encoded, with `programType` `EasyShip` or `SelfShip` (DBA; DBAM `definitions.ProgramType.enum` = `EasyShip, FbaOnSite, SelfShip`). It is in Restricted Availability (DBA).
- **Linking to External Fulfillment:** `fulfillmentOrders[].fulfillmentOrderId` "is identical to the Shipment ID required by External Fulfillment APIs" (M26 `definitions.FulfillmentOrder.properties.fulfillmentOrderId`). The EF `Shipment` object has no order-id field (EFM `definitions.Shipment`, `definitions.MarketplaceAttributes`), so this id is the documented link.
- `fulfillment.labelPrintingWindow` gives the earliest label-print time (M26 `definitions.OrderFulfillment`).

---

## 5. Migration guide v0 → v2026 (MG, updated 2026-09-09)

**a. Operation mapping**

| v0 | v2026 |
|---|---|
| GetOrders | searchOrders |
| GetOrder | getOrder |
| GetOrderItems | getOrder (items always included) |
| GetOrderBuyerInfo | getOrder + BUYER |
| GetOrderAddress | getOrder + RECIPIENT |
| GetOrderItemsBuyerInfo | getOrder + BUYER |

`searchOrders` also accepts `includedData`, which suits bulk sync.

**b. Behaviour changes**
- **PII without RDT:** roles replace Restricted Data Tokens (MG step 2; PII).
- **Pagination:** `NextToken` becomes `paginationToken`; MG flags this as a breaking change and the token expires after 24 h. The query parameter is `paginationToken` and the response field is `pagination.nextToken`.
- **Renamed enums:**
  - Status values become UPPER_SNAKE, with `Canceled`→`CANCELLED` (double L).
  - `MFN`→`MERCHANT`, `AFN`→`AMAZON`.
  - Address type `Residential` / `Commercial` → `RESIDENTIAL` / `COMMERCIAL` / `PICKUP_POINT` (MV0 vs M26 `definitions.CustomerAddress.addressType`).
- **Boolean flags become `programs[]`:** IsPrime, IsBusinessOrder, IsPremiumOrder, IsISPU, OrderType=Preorder, IsIBA, item-level FBM_SHIP_PLUS (moved to order level), IsTransparency.
- **Pricing:** flat Money fields become `proceeds.breakdowns[]` / `detailedBreakdowns[]`, plus the new `unitPrice`.
- **Parameter renames:** camelCase; `OrderStatuses`→`fulfillmentStatuses`; `FulfillmentChannels`→`fulfilledBy`.
- **Removed parameters:** `PaymentMethods`, `BuyerEmail`, `ActualFulfillmentSupplySourceId`, `EasyShipShipmentStatuses` (use PACKAGES), `IsISPU` (use programs).
- **Marked "Deprecated":** OrderChannel, ShipServiceLevel, CbaDisplayableShippingLabel, IsGlobalExpressEnabled, PromiseResponseDueDate, IsEstimatedShipDateSet, IsSoldByAB, BuyerInfo.BuyerCounty.
- **Marked "Not supported / under consideration":** NumberOfItemsShipped, NumberOfItemsUnshipped, HasRegulatedItems, DefaultShipFromLocationAddress, FulfillmentInstruction, AutomatedShippingSettings, StoreChainStoreId, ProductInfo, ProductInfo.NumberOfItems.
- **Suggested rollout:** run v0 and v2026 side by side, compare the same orders, then roll out in stages.

**c. Places where the docs and the model disagree**
1. `INVOICE_UNCONFIRMED` appears in MG but not in the M26 enums.
2. MG's cancellation paths `Order.orderItems.cancellation.requester` / `.cancelReason` vs the model's `cancellation.cancellationRequest.requester` / `.cancelReason` and `cancellationExecution` (M26 `definitions.ItemCancellation`).
3. MG's gift paths `fulfillment.packing.giftMessage` / `giftWrapLevel` vs the model's `fulfillment.packing.giftOption.*`. The PII page uses the model path.
4. The includedData tables in MG, FILT and GOI omit `FULFILLMENT_ORDERS`.
5. `invoiceStatus` scope: the model says "Easy Ship orders and orders in the Brazil marketplace"; TAX step 5 says Brazil Easy Ship only.
6. v0 `OrderTotal` ("total charge") is mapped to `proceeds.grandTotal` ("amount the seller receives").
7. Sandbox type: OAPI lists the sandbox as "Static"; SBX lists Orders as "Static, AI".
8. v0 `AddressExtendedFields.GeoCoordinates` (MV0 commit 2026-04-29) has no v2026 counterpart and MG does not mention it.

---

## 6. v2026 sandbox (static `x-amzn-api-sandbox` cases in M26)

| Operation / code | Request match | What comes back |
|---|---|---|
| searchOrders 200 #0 (`P.responses.200.x-amzn-api-sandbox.static[0]`) | createdAfter `2024-12-25T00:00:00Z`; marketplaceIds `[A1VC38T7YXB528]`; includedData BUYER, RECIPIENT, PROCEEDS, EXPENSE, PROMOTION, CANCELLATION, FULFILLMENT, PACKAGES | JP, AFN, SHIPPED, PRIME; `serialNumbers`, points, `promotionId`, `pagination.nextToken`, `createdBefore` echo |
| searchOrders 200 #1 | createdAfter `2024-12-23T00:00:00Z`; `[A1F83G8C2ARO7P]`; same includedData; paginationToken `9ZhB4RmVyc2lvbiAxLjAgb2YgdGhl` | UK, MERCHANT, SHIPPED; `substitutionPreference`; `packages[]` with `status` IN_TRANSIT / `detailedStatus` OUT_FOR_DELIVERY, `transparencyCodes` |
| **searchOrders 200 #2** | createdAfter `2024-12-20T00:00:00Z`; **`[A2Q3Y263D00KWC]`**; includedData BUYER, RECIPIENT, PROCEEDS, FULFILLMENT, **TAX, PAYMENT** | **BR B2B**, MERCHANT, UNSHIPPED; programs `AMAZON_BUSINESS` + `DELIVERY_BY_AMAZON`; buyer company and PO; address with `extendedFields`; `taxRegistrations` BUYER (`VAT`, `1234567890`), MARKETPLACE (`CNPJ`, `15436940`), MERCHANT (`legalName`); `invoiceStatus` PROCESSING; payment CreditCard with acquirerId `01.027.058/0001-91`, cardBrand Visa, authorizationCode; `promiseCalculationInputs` Correios / SEDEX / THIRD_PARTY_INTEGRATOR; `priceDesignation` BUSINESS_PRICE |
| searchOrders 400 | createdAfter `TEST_CASE_400` | `InvalidInput` error |
| **getOrder 200 #0** (`G.responses.200…static[0]`) | orderId `171-9876543-2109876`; includedData BUYER, RECIPIENT, PROCEEDS, EXPENSE, PROMOTION, CANCELLATION, FULFILLMENT, PACKAGES | **BR B2C**, PRIME, MERCHANT, UNSHIPPED; `extendedFields`; `labelPrintingWindow`; `giftOption` (message + STANDARD); `promotionId` |
| getOrder 200 #1 | orderId `028-1234567-8901234`; BUYER, RECIPIENT, PROCEEDS, FULFILLMENT, TAX | TR; BUSINESS tax registration with TAX_OFFICE; `buyerInvoicePreference` BUSINESS; IOSS; MARKETPLACE_FACILITATOR |
| getOrder 200 #2 | orderId `114-9876543-1234567`; RECIPIENT, PROCEEDS, FULFILLMENT | US `IN_STORE_PICK_UP`; TAX breakdown; `associatedOrderItems` VALUE_ADD_SERVICE |
| getOrder 400 | orderId `TEST_CASE_400` | `InvalidInput` |

**How matching works:**
- The static sandbox uses pattern matching on the listed parameters, and all required parameters must still be valid (SBX).
- NA sandbox endpoint: `https://sandbox.sellingpartnerapi-na.amazon.com`. Sandbox throttle: 5 rps, burst 15 (SBX).
- SBX also lists a local "Sample AI sandbox" for Orders. It is a GitHub sample that calls Amazon Bedrock. I did not use it.

**What the static cases can test:**
- Deserializing every v2026 object, including the BR-specific fields.
- Following the pagination token.
- The 400 error path.

**What they cannot test:**
- Role-based PII redaction.
- Real formats of CPF, CNPJ and acquirer ids.
- Status changes over time.
- BR `packages`, cancellation or `fulfillmentOrders` — no case requests `FULFILLMENT_ORDERS`.
- Rate limits.
- Whether `fulfillmentStatus` is returned without FULFILLMENT, since every case includes it.

---

## 7. Multi-order shipments / order consolidation

- **No field in v2026 links several orders to one package.**
  - `packages[]` is per order, and `packageItems` reference `orderItemId` only, with no `orderId` (M26 `definitions.OrderPackage`, `definitions.PackageItem`).
  - `fulfillmentOrders[]` goes the other way: one order → many fulfillment units, since each entry is "one fulfillment unit created by Amazon for this order" (M26 `definitions.Order.properties.fulfillmentOrders`).
- v0 `confirmShipment` handles one order → many packages by sending repeated calls with different `packageReferenceId` values (CSS). Nothing describes sharing one tracking number across orders.
- None of the pages read (OAPI, MG, PII, TAX, FILT, GOI, ESAPI, EFS, DBA) says whether Amazon ever ships several MFN or Easy Ship BR orders as one package. **UNKNOWN.**
- The word "consolidated" in the ORDER_CHANGE tutorial (…/docs/tutorial-subscribe-to-order-change-notification) refers to notification payloads at order level, not to shipments.

---

## 8. BR-specific behaviour in v2026

1. `recipient.deliveryAddress.extendedFields` (street name, number, complement, neighborhood) exists only for Brazil addresses (M26 `definitions.AddressExtendedFields`). It is PII.
2. `payment.paymentExecutions[].acquirerId` / `cardBrand` / `authorizationCode` exist only for BR, and only for CreditCard or Pix (M26 `definitions.PaymentExecution`).
3. `taxRegistrationType` includes `CPF` and `CNPJ` (M26 `definitions.OrderTaxRegistration`).
   - The buyer's CPF is documented for BR orders (TAX).
   - MERCHANT `legalName` and MARKETPLACE type/number are BR-only and only returned while PENDING or UNSHIPPED (TAX steps 3–4).
   - All of these need Tax Invoicing or Tax Remittance (Restricted) plus `includedData=TAX`.
4. `tax.taxInvoicing.invoiceStatus` is for Brazil (scope conflict noted in 5c). Use it to gate Easy Ship pickup on `ACCEPTED` (TAX).
5. **PII redaction for BR** follows PII's "non-US/JP/SG" table:

   | Data | DTC Shipping, FBM | Tax Invoicing or Tax Remittance (FBA or FBM) | No restricted role |
   |---|---|---|---|
   | email, phone, gift message, customizedUrl | Yes | No | No |
   | buyer name, address name / lines / extendedFields | Yes | Yes | No |
   | postalCode | Yes | Yes | Yes |
   | `taxRegistrations` | **No** | Yes | No |

   So getting the buyer's CPF and the full address for an NF-e needs **both** the Tax Invoicing (or Remittance) role and DTC Shipping. Phone and email need DTC Shipping.
6. v0 `BuyerCounty` (BR-only) is deprecated with no replacement (MG).
7. The model's example for transit-time carrier and service is `Correios` / `SEDEX` (M26 `definitions.TransitTimeInputDetails`).
8. BR uses the NA host (M26 `host`; SBX endpoint table lists Amazon Brazil under NA).
9. Related BR-only APIs, outside Orders: Delivery by Amazon `submitInvoice` / `getInvoiceStatus` (DBA, DBAM). Brazil is absent from the Easy Ship API store table (ESAPI).

---

## Open questions only a live call settles

| # | Question | Why it matters | Can the static sandbox settle it? |
|---|---|---|---|
| 1 | Is `fulfillment.fulfillmentStatus` (and `fulfilledBy`) returned without `includedData=FULFILLMENT`? | It is the core order status. MG and FILT disagree on whether FULFILLMENT is needed. | No — every static case includes FULFILLMENT |
| 2 | For BR business buyers, is `taxRegistrationType` `CNPJ`, `VAT` or `BUSINESS`? What is the number format (digits only or punctuated, full length)? | Drives NF-e destinatário CNPJ vs CPF | No — sandbox shows a mock `VAT` / `1234567890` |
| 3 | Is a buyer Inscrição Estadual (IE) or tax classification returned anywhere? | Needed for B2B NF-e | No |
| 4 | Is the MARKETPLACE CNPJ the full 14-digit number or the 8-digit root (sandbox shows `15436940`)? | NF-e intermediary data (ERP-side inference) | No |
| 5 | Is the buyer CPF also returned in SHIPPED, CANCELLED or FBA states, or only UNSHIPPED? And is the MERCHANT/MARKETPLACE "PENDING or UNSHIPPED" rule strict? | Decides when the ERP must snapshot fiscal data | No |
| 6 | Are production timestamps always UTC `Z`, or can they carry an offset? | dhEmi and SLA calculations | No — sandbox examples are mocks |
| 7 | For BR, is the ITEM proceeds amount tax-inclusive or tax-exclusive? Is a TAX breakdown present, and what does it cover? | NF-e vProd / tax values | No |
| 8 | What is the sign convention for DISCOUNT and detailed-breakdown amounts? | Line totals | No |
| 9 | Does `proceeds.grandTotal` equal what the buyer paid (v0 OrderTotal), or is it net of anything? | Reconciliation and NF-e vNF | No |
| 10 | What are the real BR `paymentMethod` strings? Is Boleto represented? Are installments exposed? | NF-e payment section (detPag) | No |
| 11 | Is `INVOICE_UNCONFIRMED` ever returned by v2026? | Status mapping in the ERP | No |
| 12 | Does `invoiceStatus` appear for non-Easy-Ship BR FBM orders? | NF-e upload workflow | No |
| 13 | For BR Easy Ship / DBA orders: does `programs[]` carry `AMAZON_EASY_SHIP`, `DELIVERY_BY_AMAZON` or both? Are `packages[].packageStatus.detailedStatus` and `fulfillmentOrders[]` populated? Do non-Easy-Ship FBM packages get `detailedStatus`? | Easy Ship detection and status tracking | No — no BR packages case, no FULFILLMENT_ORDERS case |
| 14 | Is `orderItems[]` complete for very large orders, given there is no item pagination? | Data completeness | No |
| 15 | What happens when `marketplaceIds` is omitted (all of the seller's marketplaces)? | Query design | No |
| 16 | What usage plan does this seller actually get (`x-amzn-RateLimit-Limit`)? | Sync cadence at 0.0056 rps | No — sandbox throttle is a flat 5 / 15 |
| 17 | Is the phone really withheld for BR FBM when the app holds only Tax Invoicing and not DTC Shipping? | Role request scope | No |
| 18 | Do several orders ever share one package or tracking number for MFN or Easy Ship in BR? | Shipment and NF-e grouping | No |
| 19 | Does the static sandbox still match if the request adds parameters beyond those in a case (for example, extra `includedData` values)? | Test harness design | Yes — this is sandbox behaviour itself |
