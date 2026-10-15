# Survey F: price, payments, messaging, returns, product types, fiscal data

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Scope: purchasable_offer, Product Pricing, Orders PAYMENT and Finances, Messaging/Solicitations, returns and claims, Product Type Definitions, and NF-e related tax data. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

# SP-API secondary capabilities for Amazon.com.br (A2Q3Y263D00KWC): documentation research as of 2026-10-14

**Citation prefixes used below**
- `D/` = https://developer-docs.amazon/sp-api/docs/
- `R/` = https://developer-docs.amazon/sp-api/reference/
- `M/` = https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/
- `S/` = https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/schemas/
- "upd" = the page's `updatedAt` value.

**How this was gathered.** Every page was read through WebFetch, which summarises pages. Quotes are as the tool returned them, and long JSON examples were cut down, so the JSON below is put together from field-level excerpts. The GitHub contents API started returning 403 partway through, so the `delivery-by-amazon` and `support-api-model` model files were never opened.

---

## 1. Price updates

### 1.1 `purchasable_offer` shape (patchListingsItem / JSON_LISTINGS_FEED)

**Mechanism**
- Use JSON Patch `op: "merge"` (or `replace`) on `path: "/attributes/purchasable_offer"`.
- Sources: `D/manage-purchasable-offer` (upd 2026-09-09) and `M/listings-items-api-model/listingsItems_2021-08-01.json definitions.PatchOperation.properties.op.enum` = add / replace / merge / delete.

**Selectors**
- "uniquely identified by `marketplace_id`, `currency`, and `audience`". The page also says "The API derives selectors from the Amazon store in the request", and `audience` defaults to `ALL` (`D/manage-purchasable-offer`).

**Sub-attributes, using the doc's example syntax**
- Doc examples use USD and ATVPDKIKX0DER. I swapped in the BR selectors below as an illustration; this BR version is not an Amazon sample.

```json
{"op":"merge","path":"/attributes/purchasable_offer","value":[{
  "marketplace_id":"A2Q3Y263D00KWC","currency":"BRL","audience":"ALL",
  "our_price":[{"schedule":[{"value_with_tax":99.90}]}],
  "discounted_price":[{"schedule":[{"start_at":"2026-11-01","end_at":"2026-11-30","value_with_tax":89.90}]}],
  "minimum_seller_allowed_price":[{"schedule":[{"value_with_tax":80.00}]}],
  "maximum_seller_allowed_price":[{"schedule":[{"value_with_tax":150.00}]}]}]}
```

- **Floors and ceilings:** `minimum_seller_allowed_price` is a "Price floor to prevent selling below a threshold". `maximum_seller_allowed_price` is a "Price ceiling…".
- **Other price fields:** `map_price` exists. `maximum_retail_price` is "Only available in the Amazon IN store". `start_at` / `end_at` set the offer's selling window, and an `end_at` in the past "soft-close[s] the offer".
- **Deleting:** set a sub-attribute to `null`. However, "The `our_price` sub-attribute cannot be deleted" (`D/manage-purchasable-offer`).
- **Business price / quantity discounts:** `quantity_discount_plan` is "Only available for Amazon Business offers" and uses `audience: "B2B"`. Its structure is "Refer to the product type definition schema". A merge can delete existing `quantity_discount_plan` values on B2B offers (`D/listings-items-api-v2021-08-01-use-case-guide`, upd 2026-09-09).
  - Whether Amazon Business exists on .com.br: **UNKNOWN**.
- **Currency BRL:** the docs only say "Currency codes match each Amazon store's requirements" (`D/update-price-for-multiple-amazon-stores`, upd 2026-09-09).
  - BRL appears as `currencyCode` in the BR sandbox order (`M/orders-api-model/orders_2026-01-01.json paths./orders/2026-01-01/orders.get.responses.200.x-amzn-api-sandbox.static[2]`).
  - No page has an explicit table of currency per store: **UNKNOWN** officially.
- **Tax inclusion:** only `value_with_tax` appears in the examples. Whether `value_without_tax` exists, and whether BR prices include tax: **UNKNOWN**.

**JSON_LISTINGS_FEED** (`S/feeds/listings-feed-schema-v2.json`)
- `header.version` = "2.0"; `messages.maxItems` = 25000.
- `messages.items.operationType` = UPDATE | PARTIAL_UPDATE | PATCH | DELETE.
- `messages.items.patches[].op` = add | replace | merge | delete. The same `purchasable_offer` patch goes inside `patches`.
- **Multi-store PATCH** (release note 2026-01-28) works only within one region. In the feed, UPDATE and PARTIAL_UPDATE "aren't supported and return a feed-level error" (`D/update-price-for-multiple-amazon-stores`).
  - The examples cover US, CA and MX only. Whether BR can be in the same multi-store feed: **UNKNOWN**.

### 1.2 How fast a change takes effect
- "There can be a delay because the Amazon backend updates every 15 minutes" and "every update might be delayed by 0-15 minutes". `getListingsItem` shows results "within 1-5 minutes" (`D/listings-apis-faq`, upd 2026-09-09).
- An `ACCEPTED` response only means "accepted for processing". Problems found after acceptance are not in the response; they show up in `getListingsItem` (`D/listings-items-api-v2021-08-01-use-case-guide`).
- Since 2026-02-23, a JSON_LISTINGS_FEED shows `DONE` only after all processing has finished (`D/sp-api-release-notes`, upd 2026-10-01).

### 1.3 Price-validation guardrails
Source: `D/manage-listings-issues` (upd 2026-09-09; added to the guides 2026-04-29). All use category `INVALID_PRICE`:

| Code | Severity | Message | Fix |
|---|---|---|---|
| 100708 | WARNING | "Not eligible to be the Featured Offer due to uncompetitive price" | Set the price at or below the Competitive External Price |
| 19038 | ERROR | Price "higher than your maximum price setting" | Adjust price or maximum |
| 19037 | ERROR | Price "lower than your minimum price setting" | Adjust price or minimum |
| 18701 | ERROR | "potential high pricing error" | Review, then confirm or update the price |

- 100708 only appears in `mode=VALIDATION_PREVIEW`. 19038, 19037 and 18701 "are also returned in the asynchronous Listings API workflow".
- WARNING issues do not block the update. ERROR issues do.
- VALIDATION_PREVIEW "has lower rate limits and is intended for testing a small number of listings" and is "not designed for production workflows".
- Price-driven *suppression* is not described anywhere: **UNKNOWN**.

### 1.4 Rate limits
- **Listings Items** (`listingsItems_2021-08-01.json` paths…):

  | Operation | Rate (rps) | Burst |
  |---|---|---|
  | patchListingsItem | 5 | 5 |
  | putListingsItem | 5 | 10 |
  | getListingsItem | 5 | 10 |
  | deleteListingsItem | 5 | 5 |
  | searchListingsItems | 5 | 5 |

- **createFeed:** 0.0083 rps, burst 15, but "The rate limit for the JSON_LISTINGS_FEED feed type differs" (`M/feeds-api-model/feeds_2021-06-30.json`).
- **JSON_LISTINGS_FEED:** "Five feeds submission per five minutes" (`D/building-listings-management-workflows-guide`, upd 2026-09-24). Up to "25,000 SKUs in a single request" (`D/listings-apis-faq`).
- **Removed:** POST_PRODUCT_PRICING_DATA and the flat-file price/quantity feeds were removed 2025-12-03. Listings Items v2020-09-01 is legacy (`D/sp-api-deprecations`, upd 2026-09-09; `D/sp-api-models`).

### 1.5 Product Pricing API (read-only)
- **v0** (`M/product-pricing-api-model/productPricingV0.json` paths…):

  | Operation | Rate (rps) | Burst |
  |---|---|---|
  | getPricing | 0.5 | 1 |
  | getCompetitivePricing | 0.5 | 1 |
  | getListingOffers | 1 | 2 |
  | getItemOffers | 0.5 | 1 |
  | getItemOffersBatch | 0.1 | 1 |
  | getListingOffersBatch | 0.5 | 1 |

  - None of these is marked deprecated in the model or on `D/sp-api-deprecations`.
- **v2022-05-01** (`productPricing_2022-05-01.json`): getFeaturedOfferExpectedPriceBatch and getCompetitiveSummary, both 0.033 rps, burst 1.
  - FOEP takes "up to 40 SKUs per request" (`D/price-adjustment-automation-workflows-guide`, upd 2026-09-09).
  - The CompetitivePriceThreshold reference price was removed 2025-09-30.
  - Recent additions: `promotions` (2026-07-29), `similarItems` (2026-04-01), CompetitivePrice (2025-06-25) (release notes).
- Role: Pricing. Regions: NA, EU, FE. Sandbox: Static (`D/product-pricing-api`, upd 2026-09-09). Support for the BR marketplace: **UNKNOWN**.

### 1.6 Pricing notifications
Source: `D/notification-type-values` (upd 2026-09-30).
- **ANY_OFFER_CHANGED**
  - Delivered via **SQS**, for sellers. Fires on changes to the top 20 offers, external prices, or the Buy Box.
  - eventFilter supports `aggregationSettings.aggregationTimePeriod` (FiveMinutes / TenMinutes) and `marketplaceIds` (`M/notifications-api-model/notifications.json definitions.AggregationTimePeriod.enum`, `definitions.EventFilter`).
  - `OfferChangeType` example values: Internal / External / FeaturedOffer (`S/notifications/AnyOfferChangedNotification.json`).
- **B2B_ANY_OFFER_CHANGED:** SQS.
- **PRICING_HEALTH**
  - Delivered via **SQS**. Sent when an offer is ineligible for the Featured Offer because its price is uncompetitive. Supports CEL `filterExpression` only.
  - Payload: `issueType` (example "BuyBoxDisqualification", no enum), `merchantOffer`, `offerChangeTrigger`, and `summary.referencePrice` {averageSellingPrice, competitivePriceThreshold, retailOfferPrice, msrpPrice} (`S/notifications/PricingHealthNotification.json`).
- Whether either notification fires for BR: **UNKNOWN**.

## 2. Payments

### 2.1 Order payment data (Orders v2026-01-01)
`includedData=PAYMENT` returns `Order.payment.paymentExecutions[]` (`orders_2026-01-01.json definitions.PaymentExecution`):
- `paymentMethod` is free text. Examples given: "CashOnDelivery, ConvenienceStore, CreditCard, Invoice, Pix".
- `paymentAmount`.
- `acquirerId`: "only available for orders in the Brazil (BR) marketplace when the `paymentMethod` is `CreditCard` or `Pix`".
- `cardBrand`: BR, CreditCard only.
- `authorizationCode`: BR, CreditCard or Pix.

The BR sandbox example (`…searchOrders…static[2]`) shows CreditCard, 1599.90 BRL, acquirerId "01.027.058/0001-91", cardBrand Visa.

The 2025-08-28 changelog (`https://developer-docs.amazon/sp-api/changelog/shipment-invoicing-and-orders-apis-to-provide-new-payment-data-for-the-brazil-marketplace`) adds:
- PaymentMethod values: CreditCard, Pix, Boleto, Rewards, Other.
- AcquirerId is the "Government ID of the payment acquirer (CNPJ format)".
- Scope is "Self Ship (MFN) and Easy Ship (DBA) orders", for issuing invoices that comply with SEFAZ.

**Installments (parcelas): not exposed.** The substring "installment" does not appear anywhere in `orders_2026-01-01.json` (both halves searched).

Other relevant points:
- `includedData=PROCEEDS` gives `proceeds.breakdowns[].type` (ITEM / SHIPPING / GIFT_WRAP / COD_FEE / TAX / DISCOUNT / DELIVERY_TIP / OTHER) with status PENDING / FINALIZED (`definitions.OrderProceedsBreakdown`).
- No Restricted Data Token is needed in v2026 (`D/orders-api-migration-guide`, upd 2026-09-09).
- Which role gates PAYMENT: **UNKNOWN**. `D/get-order-information` (upd 2026-09-30) lists roles but does not map them to includedData values.
- The v0 `PaymentMethods` query filter is gone in v2026.

**Verdict:** method, amount and the BR acquirer/brand/authorisation fields are enough for a "pagamento" record. Installments are not available.

### 2.2 Finances API

**v2024-06-19** (`M/finances-api-model/finances_2024-06-19.json`)
- Operations: listTransactions, listBalances (added 2026-07-29) and listSummary, each 0.5 rps, burst 10.
- Filters: `relatedIdentifierName` = ORDER_ID (2026-01-28), FINANCIAL_EVENT_GROUP_ID (2025-12-03) or SETTLEMENT_ID (2026-07-29). `transactionStatus` = DEFERRED / RELEASED / DEFERRED_RELEASED.
- `transactionType`: "Possible value: `Shipment`".
- `breakdownType` is "an open-ended string; Amazon does not publish a closed list" (`D/get-latest-transactions`, upd 2026-09-24). Up to 500 transactions per page.
- Contexts: ProductContext, PaymentsContext, DeferredContext, and others.
- Timing: "might not include orders from the last 48 hours". `postedAfter` must be more than 2 minutes in the past. A window over 180 days returns an empty response.
- Role: Finance and Accounting. Regions: NA, EU, FE (`D/finances-api-v2024-06-19-use-case-guide`, upd 2026-09-09).
- The only marketplace note is "MFN orders in the US store: omit marketplaceId". BR behaviour: **UNKNOWN**.

**v0** (`financesV0.json`)
- Operations: listFinancialEventGroups, listFinancialEventsByGroupId, listFinancialEventsByOrderId and listFinancialEvents, each 0.5 rps, burst 30.
- Event lists include ShipmentEventList, RefundEventList, GuaranteeClaimEventList, ChargebackEventList and others.
- ShipmentItem has ItemChargeList, ItemFeeList, ItemTaxWithheldList and PromotionList. ChargeType values include Principal, Tax, ShippingCharge, PaymentMethodFee and others. FeeType is open-ended.
- Timing: "Orders from the last 48 hours might not be included". Deferred events appear only once released. Group data is kept for 2 years.
- **Deprecated:** the three event operations were deprecated 2025-07-21 and will be **removed 2027-08-27**. listFinancialEventGroups is not on the list, and `D/determine-payment-transactions` still uses it to tie a payout to its transactions.

**Settlement reports** (`D/report-type-values-settlement`, upd 2026-09-09)
- They "cannot be requested or scheduled. They are automatically scheduled by Amazon", so you list them with getReports.
- **⚠ GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE and _XML: deprecated 2025-03-17, removed 2026-11-11, about four weeks from today** (`D/sp-api-deprecations`).
- Use **GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2**, which "replaces" them.
- BR availability: **UNKNOWN**.
- getReports is 0.0222 rps, burst 10; getReportDocument 0.0167 rps, burst 15 (`M/reports-api-model/reports_2021-06-30.json`).

**Payment notification**
- **TRANSACTION_UPDATE** (SQS, sellers) is sent "whenever there is a new transaction posted to the seller's account".
- Payload: SellingPartnerMetadata {SellingPartnerId, MarketplaceId, AccountType}, RelatedIdentifiers[], TransactionType, PostedDate, TotalAmount. No enums are defined; examples are "Shipment" and "OrderId" (`S/notifications/TransactionUpdateNotification.json`; `D/notification-type-values`).
- No notification for buyer payment authorisation is documented: **UNKNOWN**.

## 3. Buyer–seller messaging

**Messaging v1** (`M/messaging-api-model/messaging.json`), all 1 rps, burst 5:
- getMessagingActionsForOrder, confirmCustomizationDetails, createConfirmDeliveryDetails, createLegalDisclosure, createConfirmOrderDetails, createConfirmServiceDetails, CreateWarranty, GetAttributes, createDigitalAccessKey, createUnexpectedProblem.
- sendInvoice has no usage plan in the model, so its rate limit is **UNKNOWN**.
- `D/messaging-api` (upd 2026-09-09) also lists CreateAmazonMotors. I did not see it in the part of the model I read (the read was truncated).
- Role: Buyer Communication. Regions: NA, EU, FE, except createUnexpectedProblem (NA, FE only). Sellers only. Sandbox: Static.

**Which messages are allowed** depends on the order. getMessagingActionsForOrder "Returns a list of message types that are available for an order". Sending gets no reply: "There is no response. Instead, Amazon emails the seller's message to the buyer" (`D/send-a-message`, upd 2026-09-09).

**BR availability:** neither the docs nor the model mention Brazil: **UNKNOWN**.

**Solicitations v1** (`M/solicitations-api-model/solicitations.json`)
- getSolicitationActionsForOrder and createProductReviewAndSellerFeedbackSolicitation, both 1 rps, burst 5.
- "Currently only the productReviewAndSellerFeedbackSolicitation solicitation type is available."
- "Send only one productReviewAndSellerFeedback or free form proactive message per order."
- Allowed time window: **UNKNOWN**.

**Reading buyer messages:** no read or inbound operation exists in messaging.json.
- The Buyer Communication role is described as covering messaging "to and from Amazon buyers" (`D/roles-in-the-selling-partner-api`, upd 2026-10-13), but no inbound operation is documented.
- Whether replies reach the seller only by email: **UNKNOWN** from the docs.
- Release note 2026-01-28: BuyerEmail was removed from FBA orders, and sellers should use the Messaging API with the Buyer Communication role.

**Pre-sale Q&A API:** none found. Support API v2025-02-01 covers the seller's own support cases. Customer Feedback API v2024-06-01 gives review/return insights. Neither is buyer Q&A (`D/sp-api-models`). Verdict: **UNKNOWN**, with no evidence that one exists.

## 4. Returns, refunds, claims

**MFN returns reports** (`D/report-type-values-returns`, upd 2026-10-06)
- Six report types:
  - GET_XML_RETURNS_DATA_BY_RETURN_DATE / GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE
  - GET_XML_MFN_PRIME_RETURNS_REPORT / GET_CSV_MFN_PRIME_RETURNS_REPORT
  - GET_XML_MFN_SKU_RETURN_ATTRIBUTES_REPORT / GET_FLAT_FILE_MFN_SKU_RETURN_ATTRIBUTES_REPORT
- They "only cover seller-fulfilled order returns" and exclude returnless refunds. Each report covers up to 60 days.
- Fields include order_id, return_request_status, a_to_z_claim, refund_amount, resolution, return_reason_code, and SafeT claim fields.
- BR availability: **UNKNOWN**. createReport is 0.0167 rps, burst 15.

**Seller-issued refunds:** POST_PAYMENT_ADJUSTMENT_DATA (XML, OrderAdjustment schema, "Issues a refund adjustment for an order") and POST_FLAT_FILE_PAYMENT_ADJUSTMENT_DATA.
- Roles: Inventory and Order Tracking or Direct-to-Consumer Shipping (Restricted).
- No deprecation note on `D/order-feed-type-values` (upd 2026-09-30). Brazil is not mentioned.

**A-to-z claims:** no claims API found.
- Claim data only shows up in two places:
  - the `a_to_z_claim` column of the returns reports;
  - Finances v0 `GuaranteeClaimEventList`. ShipmentEvent is described as "A shipment, refund, guarantee claim, or chargeback" (`financesV0.json definitions.ShipmentEvent`).

**Buyer-requested cancellations**
- **ORDER_CHANGE notification** (SQS; `orderChangeTypes` filter = BuyerRequestedChange / DeliveryTipChange / OrderStatusChange):
  - `Payload.OrderChangeNotification.OrderChangeType` = "BuyerRequestedChange".
  - `Summary.OrderItems.IsBuyerRequestedCancel` (boolean).
  - `OrderChangeTrigger.ChangeReason` (example "Buyer Requested Cancel") (`S/notifications/OrderChangeNotification.json`).
- **Orders v2026 with `includedData=CANCELLATION`:**
  - `orderItems[].cancellation.cancellationRequest.requester` (enum BUYER) and `cancelReason`.
  - `cancellationExecution.cancelledBy` (BUYER / MERCHANT / AMAZON), added 2026-07-29.
  - `fulfillmentStatus` CANCELLED (`orders_2026-01-01.json definitions.ItemCancellationRequest` / `ItemCancellationExecution`).
- **v0 → v2026 mapping:** `IsBuyerRequestedCancel` becomes `cancellation.requester == BUYER`; `BuyerCancelReason` becomes `cancelReason` (`D/orders-api-migration-guide`).
- **Acting on it:** "To cancel an MFN order, use the POST_ORDER_ACKNOWLEDGEMENT_DATA feed" (`D/tutorial-subscribe-to-order-change-notification`, upd 2026-09-09). The flat-file variant "Cancels multiple orders at the same time".
- Response deadline: **UNKNOWN**.
- ORDER_STATUS_CHANGE was removed 2026-07-29, so use ORDER_CHANGE (`D/sp-api-deprecations`).

## 5. Product Type Definitions v2020-09-01 (overview)

**Model:** `M/product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json`. Both operations are 5 rps, burst 10.
- **searchDefinitionsProductTypes:** `keywords` or `itemName` (not both), `marketplaceIds`, `locale`, `searchLocale`.
- **getDefinitionsProductType:**
  - `marketplaceIds`: one marketplace only.
  - `sellerId`.
  - `productTypeVersion`: default LATEST; RELEASE_CANDIDATE is also mentioned.
  - `requirements`: LISTING / LISTING_PRODUCT_ONLY / LISTING_OFFER_ONLY.
  - `requirementsEnforced`: ENFORCED / NOT_ENFORCED.
  - `locale`: the enum **includes `pt_BR`**.
  - `parentageLevel`: NONE / CHILD / PARENT, added 2026-05-27.
- **Response:** `metaSchema` and `schema` (SchemaLink with an MD5 `checksum`), plus `propertyGroups`, `productTypeVersion` and the other definition fields.
- "The links provided are valid for seven days." Configure validators "to use a downloaded copy of the meta schema" (`D/retrieve-a-product-type-definition`, upd 2026-09-09).
- Validation against the custom vocabulary is "recommended but not required". Roles: Product Listing or Inventory and Order Tracking. Regions: NA, EU, FE. Sandbox: Static (`D/product-type-definitions-api`, upd 2026-09-09).

**Publishing**
- putListingsItem body `ListingsItemPutRequest`: {productType, requirements, attributes}, with productType and attributes required.
- Response `status` is ACCEPTED / INVALID / VALID; VALID is returned only with VALIDATION_PREVIEW.
- Issue severity is ERROR / WARNING / INFO (`listingsItems_2021-08-01.json definitions.*`).
- The payload must adhere "to the JSON Schema provided by the Selling Partner API for Product Type Definitions". Warning: "Existing attributes may be dropped if omitted" (`D/create-a-listing`, upd 2026-09-09).
- Bulk alternative: JSON_LISTINGS_FEED with UPDATE messages. Amazon recommends caching the schemas (`D/building-listings-management-workflows-guide`).

**Notifications**
- **PRODUCT_TYPE_DEFINITIONS_CHANGE:** **EventBridge**, sellers and vendors. Payload: AccountId, MarketplaceId, ProductTypeVersion, NewProductTypes (`S/notifications/ProductTypeDefinitionsChangeNotification.json`).
- **ITEM_PRODUCT_TYPE_CHANGE:** **EventBridge**, sellers who are verified brand owners in Amazon Registered Brands. Payload: MarketplaceId, Asin, PreviousProductType, CurrentProductType. The schema descriptions are placeholders.
- LISTINGS_ITEM_ISSUES_CHANGE payload 1.0 was removed 2026-08-26, so use version 2023-12-13.

## 6. Tax and fiscal (NF-e)

**Orders v2026 with `includedData=TAX`** (`definitions.OrderTaxRegistration`)
- `taxRegistrations[].entityType` = BUYER / MERCHANT / MARKETPLACE.
- `taxRegistrationType` = BUSINESS / VAT / CST / CPF / CNPJ.
- `D/get-tax-information` (upd 2026-09-09) adds:
  - You can get the buyer's CPF for BR orders.
  - MERCHANT entries return only `legalName`.
  - **The MARKETPLACE entry ("Amazon store tax registration information") returns only type and number, and only for BR orders that are pending or unshipped.**
  - Required role: Tax Remittance (Restricted) or Tax Invoicing (Restricted).
- The BR sandbox example has `MARKETPLACE`, `CNPJ`, `"15436940"`, which is 8 digits.
- **"Intermediador":** the word does not appear in any doc or model. Using the MARKETPLACE entry as the NF-e intermediary CNPJ is my inference.
  - Amazon's CNPJ is not published in the docs: **UNKNOWN**. Do not hard-code it from memory.
  - Any seller identifier at the intermediary: **UNKNOWN**.

**Item level**
- `taxCollections[].model` = MARKETPLACE_FACILITATOR, with `responsibleParty`. `taxCalculationBreakdowns[].reportingScheme` = UOSS / IOSS.
- **No NCM, CFOP or tax-code fields per item.** None of "ncm", "taxCode" or "fiscal" appears in the model.

**`tax.taxInvoicing.invoiceStatus`**
- Values: NOT_REQUIRED / NOT_FOUND / PROCESSING / ERRORED / ACCEPTED. "Only available for Easy Ship orders and orders in the Brazil marketplace."
- The guide says to schedule an EasyShip pickup only when the status is ACCEPTED.

**Seller sends its own NF-e:** Delivery by Amazon API (BR only, Restricted Availability).
- `submitInvoice` (POST /delivery/2022-07-01/invoice), with `programType` EasyShip or **SelfShip** (SelfShip added 2025-12-03) and `invoiceType` Outbound.
- The upload is the "XML file from an invoice approved on SEFAZ", Base64-encoded, plus `contentMD5Value`.
- `getInvoiceStatus` (GET …/invoice/status) gained an `invoiceId` parameter 2026-09-30.
- Role: Tax Invoicing (Restricted) (`D/submit-an-invoice-delivery-by-amazon-order`; `D/check-the-invoice-status-for-a-delivery-by-amazon-order`, upd 2026-09-30).
- Whether this is mandatory for SelfShip: **UNKNOWN**. Rate limits: **UNKNOWN** (model not located).

**Does Amazon issue the fiscal document itself?**
- The Invoices API (Brazil Only) v2024-06-19 "is only able to retrieve Brazilian FBA invoices" (`D/invoices-api`, upd 2026-09-09). Its `createGovernmentInvoice` is for FBA inbound shipments (2026-01-28). From 2026-07-15 the getInvoicesDocument ZIP for FBA shipments includes a cancellation XML "for previously issued NF-e invoices".
- The TAX_INVOICE_* notifications (SQS, BR and MX) list operations inbound / outbound-fba-offers / c-returns / removals, and report SUCCESS / ERROR with a `govResponse` field (`S/notifications/TaxInvoice*.json`).
- **For MFN orders, nothing says Amazon issues the NF-e.** The only MFN/SelfShip flow documented is the seller uploading its own SEFAZ-approved XML. Officially: **UNKNOWN**.
- Not checked: `D/report-type-values-tax`.

---

## Open questions only a live call settles

The SP-API sandbox cannot settle any of these. Listings, Pricing, Orders, Finances, Messaging, PTD, Notifications and Feeds have only the **static** sandbox, which "uses pattern matching to return static, mock responses" from the `x-amzn-api-sandbox` examples. None of them is in the dynamic-sandbox list (`D/the-selling-partner-api-sandbox`, upd 2026-09-09).

1. **Is Amazon Business (B2B audience, `quantity_discount_plan`) enabled on A2Q3Y263D00KWC?** Decides whether the ERP needs B2B price fields. Settled by live getDefinitionsProductType with `sellerId` for BR. Sandbox: no.
2. **How the BR product-type schema defines `purchasable_offer`** (`value_with_tax` vs `value_without_tax`, BRL decimals, discounted_price schedule rules). Needed for correct payloads. Settled by live getDefinitionsProductType with locale `pt_BR`. Sandbox: no (canned example data).
3. **Real price propagation time on .com.br and BR-specific validation** (does 18701 trigger, at what thresholds). Settled by live patchListingsItem with VALIDATION_PREVIEW plus getListingsItem. Sandbox: no.
4. **Do ANY_OFFER_CHANGED and PRICING_HEALTH fire for BR offers, and does Product Pricing v2022-05-01 accept the BR marketplace?** Needed for the repricing design. Live only. Sandbox: no.
5. **Orders v2026 PAYMENT in BR: installments anywhere? Split payments as several paymentExecutions? Exact Boleto/Pix strings? Which role gates PAYMENT and TAX?** Needed for the "pagamento" record and for the app's role request. Live only. Sandbox: no (the static BR example shows one CreditCard execution).
6. **Format of the MARKETPLACE CNPJ (8-digit root or 14-digit), and is it really absent once the order ships?** The docs restrict it to pending/unshipped, so the ERP may have to capture it before shipping. Live only. Sandbox: no.
7. **Does listTransactions with `marketplaceId=A2Q3Y263D00KWC` return MFN orders? Which BR breakdownTypes appear (commission, shipping, DBA fees)? How long from shipment to first transaction / TRANSACTION_UPDATE?** Needed for fee reconciliation and timing. Live only. Sandbox: no.
8. **Is GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 produced for BR sellers, and on what cycle?** Urgent, because the older flat-file and XML reports are removed 2026-11-11. Live getReports only. Sandbox: no.
9. **Which message types does getMessagingActionsForOrder return for BR MFN orders, and are Solicitations allowed in BR?** Decides whether messaging is worth building. Live only. Sandbox: no.
10. **Are the MFN returns reports and POST_PAYMENT_ADJUSTMENT_DATA accepted for BR, and which reason codes are valid?** Live createReport and createFeed. Sandbox: no.
11. **Is there a deadline or auto-cancel rule for BR buyer-requested cancellations?** Live order observation or Seller Central. Sandbox: no.
12. **Is SelfShip submitInvoice mandatory for BR MFN orders, does `invoiceStatus` gate anything for SelfShip, and what are DBA rate limits** (the `x-amzn-RateLimit-Limit` header)? Needs Restricted Availability access plus a live call. Sandbox: no.
13. **Does Amazon issue any fiscal document for MFN orders?** No API call answers this definitively. Ask Amazon BR seller support. Sandbox: no.
