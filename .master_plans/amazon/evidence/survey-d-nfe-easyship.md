# Survey D: NF-e upload, Easy Ship (DBA) scheduling and labels in Brazil

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Scope: every invoice path (Delivery by Amazon, Shipment Invoicing, Invoices, Feeds, External Fulfillment), invoice status, the Easy Ship API v2022-03-23, self-ship confirmation, and which events notify. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

# Amazon SP-API research for Brazil: NF-e upload, Easy Ship/DBA pickup scheduling and ZPL labels (as of 2026-10-14)

**How citations work.** `D:/docs/<slug>` and `D:/reference/<slug>` mean `https://developer-docs.amazon/sp-api/docs/<slug>` and `.../sp-api/reference/<slug>`. Model files are `models/<dir>/<file>` at `https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/`. Dates after a page are its `dateModified` meta tag. The sidebar shows a single bulk timestamp (2026-10-13T19:51:07Z) on almost every page, so I did not use it. Nothing was fetched from live SP-API or AWS endpoints, and no sign-in was used.

**Bottom line**
- The documented way to upload an NF-e for a Brazilian Easy Ship/DBA order is the **Delivery by Amazon API v2022-07-01**: `POST /delivery/2022-07-01/invoice?orderId=…` with `programType=EasyShip`. This is the "submit invoice by order ID" operation the task asked about. It is current, in Restricted Availability, and Brazil-only.
- The docs do **not** list Brazil as a supported store for Easy Ship API v2022-03-23. No document describes BR pickup scheduling or BR label retrieval.

---

## 1. Every SP-API path that accepts an NF-e or invoice for a seller-fulfilled order in Brazil

### 1a. Delivery by Amazon API v2022-07-01 — the current mechanism
Model: `models/delivery-by-amazon/deliveryShipmentInvoiceV2022-07-01.json`. Host `sellingpartnerapi-na.amazon.com` (`host`).

**What the model and docs say about scope**
- Title: "Selling Partner API for Delivery Shipment Invoicing". It covers shipment invoices "in the Brazil Amazon store for a selling partner's orders" (`info.title`, `info.description`).
- The API is in Restricted Availability and "only available in the Brazil (BR) Amazon store" (D:/docs/delivery-by-amazon-api, 2026-09-09).
- Both operations require the **Tax Invoicing (Restricted)** role, Regions = BR (same page).

**`POST /delivery/2022-07-01/invoice` (operationId `submitInvoice`)**
- Query parameters: `orderId` (optional) and `shipmentId` (optional). "You must specify either an `orderId` or `shipmentId`… `orderId` takes precedence" (`paths./delivery/2022-07-01/invoice.post.description`, `.parameters`).
- Body `SubmitInvoiceRequest`. Required fields: `invoiceContent` (Blob, `format: byte`), `contentMD5Value`, `invoiceType` (enum `Outbound`), `programType`, `marketplaceId` (`definitions.SubmitInvoiceRequest`).
- `ProgramType` enum (`definitions.ProgramType`):
  - `EasyShip` — "also known as DBA in Brazil - Delivered By Amazon"
  - `FbaOnSite`
  - `SelfShip` — "sellers directly deliver orders to customers"
- Response: `SubmitInvoiceResponse`, which contains only `errors` (`definitions.SubmitInvoiceResponse`).
- Tutorial (D:/docs/submit-an-invoice-delivery-by-amazon-order, 2026-09-09):
  - Prerequisite: "The XML file from an invoice approved on SEFAZ".
  - Base64-encode the XML.
  - `contentMD5Value` is the **Base64-encoded MD5** of the file.
  - Sample request: `POST /delivery/2022-07-01/invoice?orderId=952-2412493-8803068` with `"programType": "EasyShip"`, `"marketplaceId": "A2Q3Y263D00KWC"`.

**`GET /delivery/2022-07-01/invoice/status` (operationId `getInvoiceStatus`)** — covered in §2.

**History and status**
- Added 2025-12-03, commit `748b8bc029` "Add the Delivery Shipment Invoicing API". That first version already had `orderId`, `shipmentId` and the `EasyShip`/`FbaOnSite`/`SelfShip` enum.
- Updated 2026-09-30, commit `3677bb9d96`: added the `invoiceId` query parameter plus `orderInvoicingStatus` and `invoices[]`.
- Release notes: Dec 3 2025 "Added the SelfShip value to the ProgramType enum"; Sep 30 2026 "Added the invoiceId query parameter" (D:/docs/sp-api-release-notes, 2026-10-01).
- **Not deprecated.** It is absent from D:/docs/sp-api-deprecations (2026-09-09), and no operation has `deprecated: true`.

**Discrepancy.** The overview table says "Current version v2021-12-28", but its own Reference and Model links are v2022-07-01 (D:/docs/delivery-by-amazon-api).

**Search for a "submitInvoiceByOrderId"-style operation.**
- No operation ID containing `ByOrder` + invoice exists in the current models.
- I listed every invoice-related operation across all models that mention invoices. Results:
  - Delivery by Amazon: `submitInvoice`, `getInvoiceStatus`
  - Shipment Invoicing: `submitInvoice`, `getInvoiceStatus`
  - External Fulfillment: `generateInvoice`, `retrieveInvoice`
  - Invoices API: 10 operations
  - Finances: `getInvoiceHeaders`, `getInvoice`
  - Messaging: `sendInvoice` ("Sends a message providing the buyer an invoice", `messaging.json`)
  - Vendor APIs: various
- The order-ID-based NF-e upload is therefore `deliveryShipmentInvoice submitInvoice?orderId=`.

### 1b. Shipment Invoicing API v0 — FBA Onsite only, not usable here
Model: `models/shipment-invoicing-api-model/shipmentInvoicingV0.json`.
- Description: "retrieve shipment invoice information in the Brazil marketplace for a selling partner's Fulfillment by Amazon (FBA) orders" (`info.description`).
- Operations:
  - `GET /fba/outbound/brazil/v0/shipments/{shipmentId}` → `getShipmentDetails`
  - `POST …/{shipmentId}/invoice` → `submitInvoice`. Body requires `ContentMD5Value` and `InvoiceContent`; `MarketplaceId` is optional (`definitions.SubmitInvoiceRequest`).
  - `GET …/{shipmentId}/invoice/status` → `getInvoiceStatus`
- All operations are keyed by `shipmentId`. There is **no orderId operation**, and the first model version (commit `913d0a69f2`, 2021-04-06) and the `4ca23c0fc5` version (2023-01-11) had the same three shipmentId paths.
- Docs: "This API can only submit invoices for Brazilian FBA Onsite Orders. You cannot use this API… with other fulfillment programs" (D:/docs/shipment-invoicing-api, 2026-09-09). The `shipmentId` comes from the FBA_OUTBOUND_SHIPMENT_STATUS notification (`paths./fba/outbound/brazil/v0/shipments/{shipmentId}.get.parameters`).

### 1c. Invoices API v2024-06-19 (Brazil Only) — retrieves and exports, does not accept seller NF-e
Model: `models/invoices-api-model/InvoicesApiModel_2024-06-19.json`.
- Operations: `getInvoicesAttributes`, `getInvoicesDocument`, `createInvoicesExport`, `getInvoicesExports`, `getInvoicesExport`, `getInvoices`, `getInvoice`, `createGovernmentInvoice`, `getGovernmentInvoiceStatus`, `getGovernmentInvoiceDocument` (`paths./tax/invoices/2024-06-19/...`).
- Docs: "This API is only able to retrieve Brazilian FBA invoices. You cannot use this API for any other invoice types" (D:/docs/invoices-api, 2026-09-09).
- Government-invoice operations: added Jan 28 2026 "for inbound shipments… only the Amazon Brazil store" (D:/docs/sp-api-release-notes).
- `warehouseCode` added Sep 30 2026 "to retrieve invoices on behalf of vendors" (same).
- **It is not an upload path for seller-fulfilled NF-e.**

### 1d. Feeds API — no NF-e feed type exists
- The Feed Type Values table lists Invoicing = `UPLOAD_VAT_INVOICE` only (D:/docs/feed-type-values, 2026-09-09). That feed is "only available in the EU store (VAT program)" (D:/docs/invoicing-feed-type-values, 2026-09-09).
- `POST_EASYSHIP_DOCUMENTS` requests documents; it does not upload them. It is "only available in the India and Singapore Amazon stores" (D:/docs/easy-ship-feed-type-values, 2026-09-30).
- Order feeds include `POST_INVOICE_CONFIRMATION_DATA` ("Confirms an invoice", fields `AmazonOrderID`, `InvoiceSentDate`…). It carries no document content. Whether it is used in BR is **UNKNOWN** (D:/docs/order-feed-type-values, 2026-09-30).
- **No feed type mentions Brazil or NF-e.**

### 1e. Easy Ship API v2022-03-23 — no invoice field in any request
- `CreateScheduledPackageRequest` has only `amazonOrderId`, `marketplaceId` and `packageDetails` (`packageItems`, `packageTimeSlot`, `packageIdentifier`). The same is true of `CreateScheduledPackagesRequest`, `UpdateScheduledPackagesRequest` and `ListHandoverSlotsRequest` (`easyShip_2022-03-23.json definitions.*`).
- `InvoiceData` (`invoiceNumber` required, `invoiceDate`) appears **only in the response** `Package.invoice`. There is no access-key (chave) field (`definitions.InvoiceData`, `definitions.Package`).

### 1f. Merchant Fulfillment v0 and Shipping API v2 — no BR invoice path
- No Brazil mention anywhere in `merchantFulfillmentV0.json` or `shippingV2.json` (full-text search).
- Shipping v2 `Item.invoiceDetails` is only `invoiceNumber` + `invoiceDate`, and "Only applies to certain regions" (`shippingV2.json definitions.InvoiceDetails`).
- The Merchant Fulfillment docs mention neither Brazil nor NF-e (D:/docs/merchant-fulfillment-api, 2026-09-09).

### 1g. External Fulfillment Shipments v2024-09-11 — generates invoices, does not accept them
- `POST /externalFulfillment/2024-09-11/shipments/{shipmentId}/invoice` (`generateInvoice`) and `GET …/invoice` (`retrieveInvoice`) are Amazon-generated documents, returned as `InvoiceResponse.document` (`externalFulfillmentShipments_2024-09-11.json`).
- Both are "not supported for the Easy Ship channel, except in the Amazon India store" (D:/docs/process-shipment, 2026-09-09).

**Conclusion.** Today Amazon documents exactly one way to upload the NF-e XML for a BR Easy Ship (DBA) or Self Ship order: Delivery by Amazon `submitInvoice`. It is current, Restricted Availability, BR-only, needs Tax Invoicing (Restricted), and accepts `orderId`.

## 2. Invoice status

**Polling operation: `GET /delivery/2022-07-01/invoice/status` (`getInvoiceStatus`)**
- Parameters (`paths./delivery/2022-07-01/invoice/status.get.parameters`):
  - Required: `marketplaceId`, `invoiceType` (`Outbound`), `programType` (`EasyShip` | `FbaOnSite` | `SelfShip`).
  - One of: `orderId`, `shipmentId`, or `invoiceId` ("NF-e access key for Brazilian invoices"). Precedence is orderId > shipmentId > invoiceId.
- Response `GetInvoiceStatusResponse` contains `amazonOrderId`, `amazonShipmentId`, `invoiceStatus`, `orderInvoicingStatus`, `invoices[]`, `errors` (`definitions.GetInvoiceStatusResponse`).
- Status values:
  - `invoiceStatus` (`ShipmentInvoiceStatus`): `Processing` | `Accepted` ("validation process succeeded, and the invoice was successfully ingested") | `Errored` | `NotFound`.
  - `orderInvoicingStatus`: `Processing` | `Accepted` | `PartiallyAccepted` | `Rejected` ("aggregated results of all invoices sent").
  - `invoices[].status` (`InvoiceStatus`, `id` = NF-e access key): `Processing` | `Accepted` | `Rejected` | `NotFound`.
- The model does not explain **why** an invoice is `Errored` or `Rejected` (no reason field) — **UNKNOWN**.

**Status fields on the order**
- Orders v0 `Order.ElectronicInvoiceStatus`: `NotRequired` | `NotFound` | `Processing` | `Errored` | `Accepted`. "Only available for Easy Ship orders and orders in the BR marketplace" (`ordersV0.json definitions.ElectronicInvoiceStatus`).
- Orders v2026-01-01: `Order.tax.taxInvoicing.invoiceStatus` with values `NOT_REQUIRED`, `NOT_FOUND`, `PROCESSING`, `ERRORED`, `ACCEPTED` (`orders_2026-01-01.json definitions.OrderTaxInvoicing`, reached via `OrderTax.taxInvoicing`). It requires `includedData=TAX` (D:/docs/orders-api-migration-guide, 2026-09-09).

**Notifications that could replace polling**
- **ORDER_CHANGE** carries `Summary.ElectronicInvoiceStatus` (`schemas/notifications/OrderChangeNotification.json`; D:/docs/notification-type-values, 2026-09-30).
  - It is documented as sent on "order status changes and buyer requested cancelations". `OrderChangeType` is only `BuyerRequestedChange` | `DeliveryTipChange` | `OrderStatusChange` (same sources).
  - Whether a change to ElectronicInvoiceStatus **alone** fires ORDER_CHANGE: **UNKNOWN**.
- **TAX_INVOICE_ISSUANCE_STATUS** (BR and MX only; payload `invoiceId`, `orderId`, `status` SUCCESS/ERROR, `error.govResponse`; launched Sep 30 2026) is described as "sent when the status of a tax invoice issuance changes" (D:/docs/notification-type-values; D:/docs/sp-api-release-notes).
  - Whether it covers NF-e the seller uploads via `submitInvoice` or only invoices Amazon issues: **UNKNOWN**.
- No DBA-specific invoice notification is documented. **Treat polling `getInvoiceStatus` as the documented path.**

## 3. Easy Ship API v2022-03-23

Model `models/easy-ship-model/easyShip_2022-03-23.json`, host `sellingpartnerapi-na.amazon.com`. Last model commit `ce28db4f57` (2026-01-28); first `88c9bab4e6` (2022-04-13).

**Operations** (every one: rate 1 rps, burst 5; static sandbox for 200 and 400 responses)

| Method + path | operationId | Request | Response |
|---|---|---|---|
| POST `/easyShip/2022-03-23/timeSlot` | listHandoverSlots | body `ListHandoverSlotsRequest`: required `marketplaceId`, `amazonOrderId`, `packageDimensions`, `packageWeight` | `ListHandoverSlotsResponse` {`amazonOrderId`, `timeSlots[]`} |
| GET `/easyShip/2022-03-23/package` | getScheduledPackage | query `amazonOrderId`*, `marketplaceId`* | `Package` |
| POST `/easyShip/2022-03-23/package` | createScheduledPackage | body `CreateScheduledPackageRequest`: `amazonOrderId`*, `marketplaceId`*, `packageDetails`* (`packageTimeSlot`* + optional `packageItems`, `packageIdentifier`) | `Package` |
| PATCH `/easyShip/2022-03-23/package` | updateScheduledPackages | body: `marketplaceId`*, `updatePackageDetailsList`* [{`scheduledPackageId`*, `packageTimeSlot`*}] (max 500) | `Packages` |
| POST `/easyShip/2022-03-23/packages/bulk` | createScheduledPackageBulk | body: `marketplaceId`*, `orderScheduleDetailsList`*, `labelFormat`* (`PDF` \| `ZPL`) | `CreateScheduledPackagesResponse` {`scheduledPackages`, `rejectedOrders`, `printableDocumentsUrl`} |

Sources: `paths.*`, `definitions.*`, `responses.*.x-amzn-api-sandbox`.

Other model details:
- `Dimensions`: unit enum `cm`, each dimension ≥ 0.01.
- `Weight`: unit `grams`/`g`, value ≥ 11.
- `TimeSlot`: `slotId`*, `startTime`, `endTime`, `handoverMethod` (`PICKUP` | `DROPOFF`).
- `PackageStatus` (12 values): ReadyForPickup, PickedUp, AtOriginFC, AtDestinationFC, Delivered, Rejected, Undeliverable, ReturnedToSeller, LostInTransit, LabelCanceled, DamagedInTransit, OutForDelivery.
- `Code` enum includes `RegionNotSupported` — "Amazon Easy Ship is not supported in the specified marketplace" (`definitions.Code`).
- Role: Direct to Consumer Shipping (Restricted). Regions: NA, EU, FE. Sandbox: Static (D:/docs/easy-ship-api, 2026-09-09; the old slug `easyship-api-v2022-03-23-use-case-guide` redirects there).

**Supported marketplaces: Brazil is not listed.**
- The "Amazon store support" table lists only Mexico, India, Turkey, Australia, Singapore, Japan, Netherlands and Poland (D:/docs/easy-ship-api).
- Release notes add JP (Sep 11 2024) and NL/PL (Nov 14 2024). They never mention BR for this API (D:/docs/sp-api-release-notes).
- **Per the docs, Easy Ship API v2022-03-23 is not documented for Brazil.** Whether a BR call returns `RegionNotSupported` is **UNKNOWN**.

**BR-specific questions**
- **Must the invoice be uploaded and ACCEPTED before scheduling?** **UNKNOWN**. No document links the DBA invoice to Easy Ship scheduling.
- **Are dimensions and weight required?**
  - Required for `listHandoverSlots` (`definitions.ListHandoverSlotsRequest.required`).
  - Required in the response `Package` (`definitions.Package.required`).
  - **Discrepancy:** D:/docs/schedule-easy-ship-package (2026-09-09) says the `createScheduledPackage` request "should include the desired weight and dimensions", but `CreateScheduledPackageRequest` has no such fields.
- **How are slots chosen?**
  - Call `listHandoverSlots`, then pass the chosen `TimeSlot` (`slotId`) as `packageDetails.packageTimeSlot` (D:/docs/schedule-easy-ship-package; model).
  - With bulk scheduling, if no slot is given "Amazon will then pick the earliest time slot possible" (`paths./easyShip/2022-03-23/packages/bulk.post.description`).
- **How is the label returned?**
  - `createScheduledPackage` "Generates a shipping label and an invoice" (`paths…/package.post.description`).
  - Documents come from feed `POST_EASYSHIP_DOCUMENTS` (India and Singapore only), then `getReport`/`getReportDocument` with reportType `GET_EASYSHIP_DOCUMENTS`. That report's output type is **PDF**, it is restricted (needs an RDT), and its attributes are India-specific (GSTIN, PAN) (D:/docs/get-shipping-labels-easy-ship-order, 2026-09-09; D:/docs/report-type-values-easy-ship, 2026-10-06).
  - **Discrepancy:** the overview spells the feed `POST_EASY_SHIP_DOCUMENTS` (D:/docs/easy-ship-api); the feed-type page spells it `POST_EASYSHIP_DOCUMENTS`.
  - Bulk returns `printableDocumentsUrl` ("a pre-signed URL for the zip document"). In this API, **ZPL can only be requested through bulk `labelFormat`**, and bulk scheduling is supported only in NL and PL (model `definitions.LabelFormat`, `definitions.URL`; D:/docs/easy-ship-api).
  - **BR label format and method: UNKNOWN.**
- **Reschedule:** `listHandoverSlots` then `updateScheduledPackages`. Not possible after handover to the carrier, which returns `InvalidOrderState` (D:/docs/reschedule-easy-ship-package; D:/docs/check-status-easy-ship-package). The "Update package" column marks only India as supported (D:/docs/easy-ship-api).
- **Cancel:** the model has **no cancel operation**, yet D:/reference/easy-ship-v2022-03-23 (2026-09-09) says "Schedule, reschedule, and cancel Easy Ship orders" — a discrepancy. The only status trace is `LabelCanceled` ("The seller canceled the pickup", `ordersV0.json definitions.EasyShipShipmentStatus`).

**Related path: External Fulfillment Shipping v2024-09-11, which also serves Easy Ship**
- Program detection: Easy Ship is `channelName=MFN`, `shippingType=MARKETPLACE` (D:/docs/retrieve-list-of-shipments, 2026-09-16).
- Flow: `processShipment` → `createPackages` → `retrieveShippingOptions` (slots: `timeSlot`/`pickupWindow`, `handoverMethod`) → `generateShipLabels`.
- Label formats: "Easy Ship: PNG, ZPL, and PDF". Step 6 (`updatePackageStatus`) "is not required for Easy Ship in any Amazon store" (D:/docs/process-shipment, 2026-09-09).
- Labels come back as a presigned URL (`DocumentV2.url`); the file type is read from the `contentType` header (`x.application/zpl` for ZPL).
- **There is no request parameter to choose a label format** (`paths…/shipLabels.put.parameters`, `definitions.DocumentV2`). How ZPL is selected is **UNKNOWN**.
- Regions NA/EU/FE, sandbox Dynamic, no store table (D:/docs/external-fulfillment-shipping, 2026-09-09). **BR support: UNKNOWN.**
- `Order.fulfillmentOrders[].fulfillmentOrderId` "is identical to the Shipment ID required by External Fulfillment APIs" (Easy Ship and Seller Flex only) (`orders_2026-01-01.json definitions.FulfillmentOrder`).
- Since 2026-06-30 new MFN shipments start in `ACCEPTED`; `CREATED` is deprecated (D:/docs/retrieve-list-of-shipments).

## 4. Recommended BR workflow

**No single BR Easy Ship/DBA end-to-end tutorial exists** (search of docs, sidebar and release notes). The fragments that do exist:
- **DBA invoice workflow** (D:/docs/delivery-by-amazon-api): (1) convert the XML to Base64 → (2) get the invoice's MD5 hash → (3) call `submitInvoice` → (4) call `getInvoiceStatus` to verify. Step 3a sets `programType` to EasyShip; step 3b to SelfShip (D:/docs/submit-an-invoice-delivery-by-amazon-order).
- **Generic Easy Ship workflow** (no BR) (D:/docs/easy-ship-api):
  1. Detect orders via `ORDER_CHANGE` or batch.
  2. `getOrder`/`getOrderItems`.
  3. `listHandoverSlots`.
  4. `createScheduledPackage` (with serial numbers if required).
  5. Reschedule via `listHandoverSlots` + `updateScheduledPackages`.
  6. `createFeed` `POST_EASY_SHIP_DOCUMENTS`.
  7. Amazon generates the document.
  8. `getReport` + `getReportDocument` returns a PDF.
- **External Fulfillment 6-step flow** (D:/docs/process-shipment): store coverage is unspecified.
- The changelog confirms "Easy Ship (DBA) orders" exist in BR on the Orders API side (D:/changelog/shipment-invoicing-and-orders-apis-to-provide-new-payment-data-for-the-brazil-marketplace, modified 2026-09-09).

## 5. Self-ship MFN orders in BR

**Confirm shipment: Orders v0 `confirmShipment`** — `POST /orders/v0/orders/{orderId}/shipmentConfirmation`, rate 2, burst 10 (`ordersV0.json`).
- Body: `marketplaceId`* and `packageDetail`*.
- `packageDetail` requires `packageReferenceId`, `carrierCode`, `trackingNumber`, `shipDate`, `orderItems`. `carrierCode` "is required for all marketplaces" (`definitions.ConfirmShipmentRequest`, `definitions.PackageDetail`).
- The changelog that field links to (`…/changelog/carriercode-value-required-in-shipment-confirmations-for-br-mx-ca-sg-au-in-jp-marketplaces`) now returns 404.
- Shipments can be edited by resending the same `packageReferenceId`. Multiple orders can go through feed `POST_ORDER_FULFILLMENT_DATA`. Ship+ orders return 400 (D:/docs/confirm-the-shipment-status, 2026-09-30).

**Still supported in 2026.** Only the read operations of Orders v0 are scheduled for removal (getOrders, getOrder, getOrderBuyerInfo, getOrderAddress, getOrderItems, getOrderItemsBuyerInfo: deprecated 2026-01-28, removed 2027-03-27). `confirmShipment` and `updateShipmentStatus` are not listed (D:/docs/sp-api-deprecations, 2026-09-09).

**Other operations**
- `updateShipmentStatus` (`POST /orders/v0/orders/{orderId}/shipment`, rate 5, burst 15) only accepts `ReadyForPickup` | `PickedUp` | `RefusedPickup` (`definitions.ShipmentStatus`). Its relevance to BR is **UNKNOWN**.
- NF-e for self-ship orders: DBA `submitInvoice` with `programType=SelfShip` (D:/docs/submit-an-invoice-delivery-by-amazon-order).
- External Fulfillment Self Ship (`MFN`/`SELF`): labels PNG only (D:/docs/process-shipment). BR applicability **UNKNOWN**.

## 6. Which events notify and which need polling

**Notifications** (ORDER_CHANGE and TAX_INVOICE_* use the SQS workflow)
- **ORDER_CHANGE**: order status changes and buyer cancellations. The payload includes `EasyShipShipmentStatus` and `ElectronicInvoiceStatus`. Filter with `orderChangeTypes` or CEL (D:/docs/notification-type-values; D:/docs/tutorial-subscribe-to-order-change-notification, 2026-09-09).
  - Whether Easy Ship status or invoice-status changes alone fire it: **UNKNOWN**.
  - Note: `marketplaceIds` is not a supported ORDER_CHANGE filter (D:/docs/set-up-notifications-with-amazon-sqs, 2026-09-30).
- **TAX_INVOICE_ISSUANCE_STATUS**, **TAX_INVOICE_ISSUANCE_ELIGIBILITY_STATUS_CHANGE** (operations: inbound, outbound-fba-offers, c-returns, removals), and **TAX_INVOICE_EXPORT_STATUS_CHANGE**: BR and MX, launched 2026-09-30 (D:/docs/notification-type-values; release notes).
  - **Stale FAQ:** D:/docs/invoices-faq (2026-09-09) still says no notification exists for `createInvoicesExport`.
- **EXTERNAL_FULFILLMENT_SHIPMENT_STATUS_CHANGE**: statuses ACCEPTED … PICKUP_SLOT_RETRIEVED, INVOICE_GENERATED, SHIPLABEL_GENERATED, SHIPPED, DELIVERED (D:/docs/notification-type-values).
- **FEED_PROCESSING_FINISHED** and **REPORT_PROCESSING_FINISHED**: for the feed/report document flow (same page).
- **FBA_OUTBOUND_SHIPMENT_STATUS**: FBA Onsite only, BR only. Not relevant to MFN (same page).

**Polling required** (no notification documented)
- DBA `getInvoiceStatus`
- Easy Ship `getScheduledPackage`
- Orders `getOrder` with `includedData=TAX`/`PACKAGES`/`FULFILLMENT_ORDERS`. `EasyShipShipmentStatus` maps to `packages[].packageStatus.detailedStatus` (D:/docs/orders-api-migration-guide). `FULFILLMENT_ORDERS` was added 2026-05-27 (release notes).

**SQS behaviour for the consumer**
- SQS standard queues only (no FIFO), best-effort ordering, possible duplicates (D:/docs/set-up-notifications-with-amazon-sqs).
- AWS: "Design your applications to be idempotent" (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html).

## 7. Rate limits (rate in rps / burst)

| API | Operation(s) | Rate / burst | Source |
|---|---|---|---|
| Delivery by Amazon | submitInvoice, getInvoiceStatus | 1.133 / 25 | model descriptions |
| Shipment Invoicing v0 | all 3 operations | 1.133 / 25 | model descriptions |
| Easy Ship | all 5 operations | 1 / 5 | model descriptions |
| Orders v0 | confirmShipment | 2 / 10 | D:/docs/orders-api-rate-limits (2026-09-09) |
| Orders v0 | updateShipmentStatus | 5 / 15 | same |
| Orders v0 | getOrder, getOrderItems | 0.5 / 30 | same |
| Orders v0 | getOrders | 0.0167 / 20 | same |
| Orders v2026-01-01 | getOrder | 0.5 / 30 | same |
| Orders v2026-01-01 | searchOrders | 0.0056 / 20 | same |
| Feeds | createFeed | 0.0083 / 15 | `feeds_2021-06-30.json` |
| Feeds | getFeed | 2 / 15 | same |
| Feeds | createFeedDocument | 0.5 / 15 | same |
| Feeds | getFeedDocument | 0.0222 / 10 | same |
| Reports | createReport | 0.0167 / 15 | `reports_2021-06-30.json` |
| Reports | getReport | 2 / 15 | same |
| Reports | getReportDocument | 0.0167 / 15 | same |
| Tokens | createRestrictedDataToken | 1 / 10 | `tokens_2021-03-01.json` |
| Notifications | all operations | 1 / 5 | `notifications.json` |
| External Fulfillment | getShipment(s) | 2 / 5 | D:/docs/external-fulfillment-apis-rate-limits (2026-09-09) |
| External Fulfillment | all other operations | 1 / 5 | same |
| Invoices API | getInvoices | 0.1 rps (pageSize max 200) | D:/docs/invoices-faq |
| Invoices API | other operations | **UNKNOWN** (no Usage Plan in model) | — |
| Sandbox endpoints | all | 5 / 15 | D:/docs/sp-api-sandbox (2026-09-09) |

## Open questions only a live call settles

1. **Does Easy Ship API v2022-03-23 work for A2Q3Y263D00KWC, or does it return `RegionNotSupported`?**
   - Why it matters: it decides whether BR scheduling goes through Easy Ship or External Fulfillment.
   - Sandbox: no. The static sandbox only pattern-matches canned examples.
2. **Do BR DBA orders appear in External Fulfillment `getShipments` (`MFN`/`MARKETPLACE`), and are their `shipmentId`s the `fulfillmentOrderId`?**
   - Why it matters: this may be the only documented ZPL label path.
   - Sandbox: partly. The dynamic sandbox and `createSandboxShipment` exist, but they do not prove BR production coverage.
3. **Must `getInvoiceStatus` be `Accepted` before scheduling or label generation is allowed?** What error appears if it is not?
   - Why it matters: it sets the order of steps in the ERP state machine.
   - Sandbox: no.
4. **How is the ZPL format selected in External Fulfillment `generateShipLabels` for BR?**
   - Why it matters: thermal printing.
   - Sandbox: possibly (dynamic sandbox), but not authoritative.
5. **Does an ElectronicInvoiceStatus or EasyShipShipmentStatus change alone fire ORDER_CHANGE? Does TAX_INVOICE_ISSUANCE_STATUS fire for seller-uploaded DBA NF-e?**
   - Why it matters: whether polling can be removed.
   - Sandbox: no. Only a production subscription shows it.
6. **For a BR DBA order, does Orders v2026 `programs[]` contain `AMAZON_EASY_SHIP`, `DELIVERY_BY_AMAZON`, or both?**
   - Why it matters: order routing.
   - Sandbox: no (the static examples are generic).
7. **What error detail comes back for `Errored`/`Rejected` invoices** (SEFAZ cStat, mismatched order data)? Are multiple NF-e per order (`PartiallyAccepted`) accepted for split shipments?
   - Why it matters: error handling and partial shipments.
   - Sandbox: no. Only `Accepted` and `EntityNotFound`/`InvalidInput` examples exist (`x-amzn-api-sandbox`).
8. **Can a BR Easy Ship pickup be cancelled through the API?**
   - Why it matters: the model has no cancel operation, but the reference page says "cancel".
   - Sandbox: no.
9. **Default and actual `x-amzn-RateLimit-Limit` for the Invoices API and for DBA in production.**
   - Sandbox: no. Sandbox throttling is a flat 5/15.
