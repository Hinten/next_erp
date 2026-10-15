# Gap: the Brazilian Easy Ship / DBA chain

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Scope: every official mention of Easy Ship or DBA with Brazil, the Easy Ship model, Orders v2026 fields for a DBA order, External Fulfillment as an alternative, notifications and the RDT for createScheduledPackageBulk. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

# Report: Brazil Easy Ship / DBA shipping chain (SP-API), as of 2026-10-14

**Method.** I read the full text of all 276 changelog entries, found through the 28 pages of `https://developer-docs.amazon/sp-api/changelog.rss`. I also read all 495 `/docs/` pages listed in `https://developer-docs.amazon/sp-api/llms.txt`, plus the release notes. In the models repo I read the current Easy Ship, Delivery by Amazon, Orders v0, Orders v2026, Tokens and External Fulfillment (EF) models. I also checked all 10 historical commits of `easyShip_2022-03-23.json` (2022-04-13 to 2026-01-28) and ran a GitHub code search of the repo. I made no live SP-API or AWS calls. Docs text is paraphrased below; enum and field names are copied exactly.

---

## 1. Official mentions of Easy Ship or DBA together with Brazil

**Pages that tie Easy Ship and DBA to Brazil**

| Date | Source | What it says |
|---|---|---|
| (model) | `models/delivery-by-amazon/deliveryShipmentInvoiceV2022-07-01.json` → `definitions.ProgramType.x-docgen-enum-table-extension[0].description` | "EasyShip program (also known as DBA in Brazil - Delivered By Amazon)." This is the only model text that equates the two. `info.description` limits the API to the Brazil store. `paths./delivery/2022-07-01/invoice/status.get.parameters[invoiceId]` takes the NF-e access key. |
| (undated page) | https://developer-docs.amazon/sp-api/docs/delivery-by-amazon-api.md | The DBA API is Restricted Availability and BR-only. Both operations list Regions `BR` and need the role Tax Invoicing (Restricted). Release notes linked: Dec 3, 2025 and Sep 30, 2026. Small doc bug: the version table says "v2021-12-28" but links the 2022-07-01 model. |
| (undated page) | https://developer-docs.amazon/sp-api/docs/submit-an-invoice-delivery-by-amazon-order.md (Step 3a) | Submitting the invoice "for a Delivery by Amazon order" uses `programType: EasyShip`, `invoiceType: Outbound`, `marketplaceId: A2Q3Y263D00KWC`, Base64 content plus an MD5 hash. This is the invoice step of the BR DBA flow. |
| (undated page) | https://developer-docs.amazon/sp-api/docs/check-the-invoice-status-for-a-delivery-by-amazon-order.md | Status check is `GET /delivery/2022-07-01/invoice/status?...&programType=EasyShip`. This is the status step of the BR DBA flow. |
| (undated page) | https://developer-docs.amazon/sp-api/docs/get-tax-information.md (Step 5) | Says to use `Order.tax.taxInvoicing.invoiceStatus` to gate Brazil EasyShip pickup scheduling: schedule only when the value is `ACCEPTED`. The attribute applies only to Brazil EasyShip orders. This is the only docs page that says a BR EasyShip pickup-scheduling step exists. It does not name the API that does the scheduling. |
| 2025-08-19 (pubDate) | changelog `shipment-invoicing-and-orders-apis-to-provide-new-payment-data-for-the-brazil-marketplace` | From Aug 28, 2025, `getOrders` returns new payment fields for "Self Ship (MFN) and Easy Ship (DBA) orders" in BR. |
| 2025-08-29 | changelog `update-delivery-by-amazon-api-documentation-is-now-available-on-the-global-selling-partner-api-website` | DBA API docs moved from the LatAm site (removed Aug 31, 2025). The API is Restricted Availability, for select BR developers only. |
| 2025-12-03 | release notes `#december-3-2025` | DBA API: `SelfShip` added to `ProgramType`. |
| 2026-08-19 (pubDate) | changelog `sp-api-updates-simplified-authorization-...-multi-invoice-support-changes-for-brazil` | From Sep 30, 2026 (already live today), `getInvoiceStatus` supports several invoices per order. It adds `orderInvoicingStatus` (`Processing`/`Accepted`/`PartiallyAccepted`/`Rejected`) and `invoices[]`, and keeps `invoiceStatus`. Audience named: "Self Ship or EasyShip orders in Brazil". |
| 2026-09-30 | release notes `#september-30-2026` | DBA: `invoiceId` query parameter added to `getInvoiceStatus`. |
| (model) | `orders_2026-01-01.json` → `definitions.OrderTaxInvoicing.properties.invoiceStatus` (same idea in `ordersV0.json` → `definitions.ElectronicInvoiceStatus`) | Available only for Easy Ship orders and BR orders. Values: `NOT_REQUIRED`/`NOT_FOUND`/`PROCESSING`/`ERRORED`/`ACCEPTED`. |
| (model) | `orders_2026-01-01.json` → `paths./orders/2026-01-01/orders.get.responses.200.x-amzn-api-sandbox.static[2].response.orders[0]` | Sample BR order: `programs: [AMAZON_BUSINESS, DELIVERY_BY_AMAZON]`, `fulfilledBy: MERCHANT`, `taxInvoicing.invoiceStatus: PROCESSING`. It contains no `packages` and no `fulfillmentOrders`. |

**Pages that mention BR or Easy Ship but not both**
- `external-fulfillment-errors.md`: error `SC_30007` (no invoice available for the shipment) is marked as applying to the Amazon BR store. It is not tied to Easy Ship.
- The ORDER_CHANGE tutorial has a BR example (`MarketplaceId A2Q3Y263D00KWC`), but its `ShippingPrograms` is empty.
- 2025-07-28 changelog "Update to getOrder and getOrders": from Aug 11, 2025 `EasyShipShipmentStatus=PendingSchedule` appears for new Easy Ship orders in "North America (NA), Europe (EU)". The endpoints page puts BR in the NA endpoint, but whether this "NA" covers BR is **UNKNOWN**.

**Evidence against BR support in the Easy Ship API itself**
- The store-support table on https://developer-docs.amazon/sp-api/docs/easy-ship-api.md lists Mexico, India, Turkey, Australia, Singapore, Japan, Netherlands and Poland. Brazil is absent. "Bulk Package Scheduling" is Supported only for NL and PL. "Shipping label" is Not supported for NL and PL.
- No version of `easyShip_2022-03-23.json` mentions Brazil or `A2Q3Y263D00KWC` (all 10 commits checked).
- No changelog entry announces Easy Ship API support for BR. The Easy Ship store entries are JP (2024-09-11) and NL/PL (2024-11-15; release note dated 2024-11-14).
- Other Easy Ship changelog entries do not concern BR: 2025-10-01 value-format change (`cm`, `PICKUP`/`DROPOFF`, timestamps with offsets) and 2022-04-13 API launch.

---

## 2. What the Easy Ship model says (`models/easy-ship-model/easyShip_2022-03-23.json`)

**Marketplace support**
- The model contains no marketplace list. `info.description` and every operation description point to the external "Marketplace Support Table" (the docs table above, which has no BR).
- `host` is `sellingpartnerapi-na.amazon.com`.
- The sandbox samples use `A2XZLSVIQ0F4JT`, which is not on the marketplace-IDs page, and `A21TJRUUN4KGV` (India).

**Bulk scheduling (`paths./easyShip/2022-03-23/packages/bulk.post`)**
- Amazon schedules a slot for every `amazonOrderId` sent. If no time slot is given, it picks the earliest one possible.
- It returns `scheduledPackages`, an optional `rejectedOrders`, and a short-lived URL to a zip with the labels and the other documents enabled for the marketplace.
- Rate limit is 1 request/second, burst 5 (the same for all five operations).

**`labelFormat`**
- Required (`definitions.CreateScheduledPackagesRequest.required` = `marketplaceId`, `orderScheduleDetailsList`, `labelFormat`).
- `definitions.LabelFormat.enum` = `PDF`, `ZPL`. Neither value is restricted to a marketplace in the model.

**`packageDetails`**
- Optional (`definitions.OrderScheduleDetails.required` = `amazonOrderId` only).
- If you send it, `definitions.PackageDetails.required` = `packageTimeSlot`. Its other properties are `packageItems` and `packageIdentifier`.
- **The bulk request has no dimensions or weight field.** A `MissingPackageDimensions` rejection therefore cannot be fixed through the bulk request itself.

**Error codes**
- `MissingPackageDimensions` is not in `definitions.Code.enum`.
- `definitions.Code` is not referenced anywhere in the model; `definitions.Error.properties.code` is a free `string`. Treat `rejectedOrders[].error.code` as an open set.
- `Code` does include `ScheduledPackageAlreadyExists` (order already scheduled) and `RegionNotSupported` (Easy Ship not supported in the marketplace).

**RDT:** the model never mentions a restricted data token, in any version. See section 6.

**`printableDocumentsUrl`**
- Shape: a `string` (`definitions.URL`), described as a pre-signed URL to a zip with the labels and marketplace-enabled documents. The operation text calls it "short-lived". The sandbox value is `https://www.amazon.com/documents.zip`.
- Not documented: how long it lives, whether it is S3, what the files inside are named, and how zip entries map to packages.
- AWS rule, applicable only if it is an S3 presigned URL (**UNKNOWN**): validity is fixed when the URL is created, at most 7 days with SigV4. It ends early when temporary credentials expire. Expiry is checked when the request starts (https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html).

**Other model details**
- `scheduledPackages` has `maxItems` 100. `orderScheduleDetailsList` has `minItems` 1 and no documented maximum.
- The sandbox package uses units `IN` and `ounces`, while `UnitOfLength` = `cm` and `UnitOfWeight` = `grams`/`g`. Parse units leniently.

**`getScheduledPackage` (`paths./easyShip/2022-03-23/package.get` → `#/definitions/Package`)**
- Returns `scheduledPackageId{amazonOrderId, packageId}`, `packageDimensions`, `packageWeight`, `packageItems`, `packageTimeSlot`, `packageIdentifier`, `invoice{invoiceNumber, invoiceDate}`, `packageStatus` and `trackingDetails.trackingId`.
- It has **no label, document or URL field**.
- `packageStatus` values: `ReadyForPickup`, `PickedUp`, `AtOriginFC`, `AtDestinationFC`, `Delivered`, `Rejected`, `Undeliverable`, `ReturnedToSeller`, `LostInTransit`, `LabelCanceled`, `DamagedInTransit`, `OutForDelivery`.

**Re-downloading a label for an already scheduled package: no documented path for BR**
- `getScheduledPackage`: no document field (above).
- `updateScheduledPackages` returns `Packages`, also without a URL.
- The documented route is the `POST_EASYSHIP_DOCUMENTS` feed, then the `GET_EASYSHIP_DOCUMENTS` report (a restricted PDF). That route is for documents generated by `createScheduledPackage` (get-shipping-labels-easy-ship-order.md), and the feed is available only in India and Singapore (easy-ship-feed-type-values.md).
- Calling bulk again: the error enum suggests it would be refused with `ScheduledPackageAlreadyExists`. Whether that comes back as a `rejectedOrders` entry, and whether a URL is still returned, is **UNKNOWN**.
- The reports `GET_EASYSHIP_WAITING_FOR_PICKUP` and `GET_EASYSHIP_PICKEDUP` return `tracking-id` but no label. Their BR availability is **UNKNOWN**.

**Roles:** all Easy Ship operations need Direct to Consumer Shipping (Restricted), Regions NA/EU/FE (easy-ship-api.md, role-mappings.md).

---

## 3. Orders v2026-01-01 `getOrder` for a BR DBA order (`models/orders-api-model/orders_2026-01-01.json`)

**What the model exposes**
- **`packages[]`** (`includedData=PACKAGES`, `definitions.Order.properties.packages`): the model says FBM orders only.
  - `definitions.OrderPackage` has `packageReferenceId`, `createdTime`, `packageStatus{status, detailedStatus}`, `carrier`, `shipTime`, `shippingService`, `trackingNumber`, `shipFromAddress` and `packageItems`.
  - `detailedStatus` includes `PENDING_SCHEDULE`, `PENDING_PICK_UP`, `PENDING_DROP_OFF`, `LABEL_CANCELLED`, `PICKED_UP`, …
  - The migration guide (orders-api-migration-guide.md) maps v0 `EasyShipShipmentStatus` to `packages[].packageStatus.detailedStatus` (needs `PACKAGES`). The v0 filter `EasyShipShipmentStatuses` has no equivalent; the guide says to use `includedData=PACKAGES` instead.
  - There is no `scheduledPackageId`, time slot or label field.
- **`fulfillmentOrders[]`** (`includedData=FULFILLMENT_ORDERS`): the model says Easy Ship and Seller Flex only. `definitions.FulfillmentOrder.properties.fulfillmentOrderId` is described as identical to the EF Shipment ID. This was added in the 2026-05-27 release notes ("fulfillment ID for Easy Ship orders").
- **`fulfillment.labelPrintingWindow`** (`includedData=FULFILLMENT`, `definitions.OrderFulfillment`): the earliest time the label can be printed. If blank, printing is allowed at any time. It is not specific to Easy Ship.
- **`programs`** may include `AMAZON_EASY_SHIP` and/or `DELIVERY_BY_AMAZON`. The model gives no description per value. The BR sample shows `DELIVERY_BY_AMAZON` only.
- **`tax.taxInvoicing.invoiceStatus`** (`includedData=TAX`) is the gate described in section 1.

**Verdict.** The model has the shapes, but whether they are filled for a BR DBA order is **UNKNOWN**:
- The only BR DBA sample has none of these fields.
- Whether `packages[].trackingNumber` equals Easy Ship `trackingDetails.trackingId` is **UNKNOWN**.
- Whether `packageReferenceId` relates to `packageId` is **UNKNOWN**.

v2026 needs no RDT, only roles (migration guide, Step 2). Orders v0 was deprecated on 2026-01-28 and will be removed on 2027-03-27 (sp-api-deprecations.md).

---

## 4. External Fulfillment Shipments v2024-09-11

**Brazil**
- There is no mention of BR, `A2Q3Y263D00KWC` or "Easy Ship Brazil" in any of the 4 EF models (`models/external-fulfillment/*`) or in the EF docs pages (shipping, inventory, returns, rate limits, process-shipment, retrieve-list-of-shipments, easy-ship-cross-border-shipments).
- Sample data uses `A21TJRUUN4KGV` (India) and US/IN addresses.
- The only BR mention is error `SC_30007` (invoice availability, BR store).
- Program coverage over time:
  - 2025-10-01 launch: covers Seller Flex, Easy Ship, Self Ship and MFN Self Delivery, with no countries named.
  - 2026-04-29 release notes: Easy Ship support added "for US domestic shipments".
  - 2026-06-30 change: new MFN and Easy Ship shipments start in `ACCEPTED`, not `CREATED`.

**If a BR DBA order were processed through EF** (per process-shipment.md and the model):
1. **Find the shipment:** `getShipments` with `status=ACCEPTED` and `marketplaceId`, or take `fulfillmentOrderId` from Orders v2026. Easy Ship is identified by `channelName=MFN` plus `shippingType=MARKETPLACE` (retrieve-list-of-shipments.md).
2. **Confirm:** `processShipment` with `operation=CONFIRM`.
3. **Packages:** `createPackages`, with dimensions and weight. This is where a dimensions problem would be fixed.
4. **Pickup slot:** `retrieveShippingOptions` (per package) returns `shippingOptions[]` and `recommendedShippingOption`, each with `timeSlot.handoverMethod` `PICKUP`/`DROPOFF`.
5. **Label:** `generateShipLabels` (`PUT .../shipLabels?operation=GENERATE&shippingOptionId=`) returns `packageShipLabelList[].fileData.url`. This is an S3 presigned URL per `definitions.DocumentV2`.
   - The file type comes from the response `contentType` header; ZPL is `x.application/zpl`.
   - The docs list Easy Ship label formats as PNG, ZPL and PDF. **The request has no parameter to choose the format**, so how ZPL would be obtained is **UNKNOWN**.
   - **Re-download is documented:** call `generateShipLabels` again with `operation=GENERATE`. `REGENERATE` makes a new label.
6. Not needed for Easy Ship:
   - `generateInvoice` and `retrieveInvoice` (Easy Ship uses them only in India).
   - `updatePackageStatus`: no store needs it for Easy Ship; Amazon updates the status itself.

**Alternative or successor?** No doc says EF replaces the Easy Ship API.
- The Easy Ship API page still lists v2022-03-23 as current with no legacy version.
- Easy Ship does not appear in the deprecation schedule.
- So EF is a documented **alternative**, not a documented successor, and its **BR availability for DBA is UNKNOWN**.

**Auth:** EF operations need Direct-to-Consumer Shipping (Restricted). They are not on the RDT list, so a normal LWA token is used.

---

## 5. Notifications for Easy Ship package status or e-invoice status in BR

**Answer: none documented.**
- **Easy Ship has no notification of its own.** The Easy Ship row on sp-api-seller-use-cases.md says Notifications (Events) are "Not applicable". The ORDER_CHANGE tutorial says Easy Ship events may be added in future.
- **`ORDER_CHANGE`** (SQS only):
  - Its triggers are only `BuyerRequestedChange`, `DeliveryTipChange` and `OrderStatusChange` (`schemas/notifications/OrderChangeNotification.json`, `OrderChangeType.enum`).
  - The `Summary` includes `EasyShipShipmentStatus` and `ElectronicInvoiceStatus`, but as a snapshot, not as triggers.
  - So a package-status change or an invoice change fires only if it also changes the order status. Whether pickup flips the order to Shipped in BR is **UNKNOWN**.
  - A BR example exists in the tutorial, so the notification is used in BR.
- **`EXTERNAL_FULFILLMENT_SHIPMENT_STATUS_CHANGE`** (SQS only): reports shipment statuses `ACCEPTED` … `SHIPPED`/`DELIVERED`/`CANCELLED`. The schema file is not in the repo. It is relevant only if DBA runs through EF, which is **UNKNOWN** for BR.
- **Not about the DBA NF-e:**
  - The `TAX_INVOICE_*` notifications (BR and MX, SQS) cover Invoices API issuance and export, for the operations `inbound`, `outbound-fba-offers`, `c-returns`, `removals`.
  - `SHIPMENT_TRACKING_MILESTONE_CHANGED` (SQS or EventBridge) belongs to the Tracking API, which is US only (tracking-api.md).
- **EventBridge** supports only `BRANDED_ITEM_CONTENT_CHANGE`, `ITEM_PRODUCT_TYPE_CHANGE`, `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE`, `PRODUCT_TYPE_DEFINITIONS_CHANGE` and `SHIPMENT_TRACKING_MILESTONE_CHANGED` (set-up-notifications-with-amazon-eventbridge.md).

---

## 6. RDT for `createScheduledPackageBulk`

- **Restricted:** the "List of restricted operations" on https://developer-docs.amazon/sp-api/docs/tokens-api.md has, under Easy Ship API v2022-03-23, only `createScheduledPackageBulk`. Amazon's own Java client agrees: `clients/sellingpartner-api-aa-java/.../RestrictedDataTokenSigner.java` lists `"EasyShipApi-createScheduledPackageBulk"`.
- **`dataElements`:** per `tokens_2021-03-01.json` → `definitions.RestrictedResource.properties.dataElements.description`, it is required only for the Orders API `getOrder`, `getOrders` and `getOrderItems`.
  - So the documented request is `{"restrictedResources":[{"method":"POST","path":"/easyShip/2022-03-23/packages/bulk"}]}` with **no `dataElements`**.
  - `method` and `path` are required; up to 50 resources per request.
  - Whether `dataElements` is accepted or ignored here is **UNKNOWN**.
- **Lifetime:** `expiresIn` is in seconds. The only value shown is 3600, in the sandbox samples; the real value is **UNKNOWN**.
- **Role:** Direct to Consumer Shipping (Restricted).
- **Not restricted (no RDT, normal LWA token):** DBA `submitInvoice` and `getInvoiceStatus` (role Tax Invoicing (Restricted)), the other Easy Ship operations, EF operations and Orders v2026.

---

## 7. Conclusion and recommendation

> **Superseded in part (2026-10-14, after this report):** Amazon's retired LATAM page "DBA caso de uso" documents the BR bulk flow, a 3-minute URL life, and that **resubmitting an already-scheduled order returns the same schedule**. The operator confirmed that a reprint (a resubmit) returns a fresh label URL in production. Risk 2 below is therefore resolved differently: no label is stored; once an order is scheduled, each print fetches a fresh link through the same call (plan D12, step 15). See `latam-dba-review.md`.

**Option A: build the documented DBA invoice step plus the Easy Ship bulk call (RDT, ZPL) that runs in production for BR today.** Recommended as the primary path.
- **For it:**
  - It works in production (an existing integration runs it daily).
  - The DBA steps match the docs exactly (`programType=EasyShip`).
  - The docs confirm that a BR EasyShip pickup-scheduling step exists and that it is gated on invoice `ACCEPTED` (get-tax-information.md).
- **Risks:**
  1. Bulk and Easy Ship are undocumented for BR (the store table excludes BR, and bulk is listed for NL/PL only). They can change without any changelog entry.
  2. The URL is short-lived and the label cannot be re-fetched. **Download the zip and store the label bytes on the first response.** Treat scheduling as "once only": a second bulk call will probably return `ScheduledPackageAlreadyExists`.
  3. How zip files map to packages is undocumented. Taking "the first `.zpl` in the zip" is only safe with **one order per bulk call** (1 request/second, burst 5).
  4. `MissingPackageDimensions` cannot be fixed through bulk, and the fix path is **UNKNOWN**.
  5. Since 2026-09-30, the invoice poll must read `orderInvoicingStatus` (including `PartiallyAccepted`/`Rejected`) and treat `Errored`/`NotFound` as stop states, not just `invoiceStatus=Accepted`.

**Option B: External Fulfillment.**
- **For it:** documented re-download, slot choice, a way to send dimensions (`createPackages`), and an SQS status notification.
- **Risk:** no BR or DBA documentation (Easy Ship support was announced only for US domestic shipments). There is also no request parameter for ZPL. Keep it behind a feature flag and turn it on only after a probe proves it works.

**Option C: tracking, as a pull.**
- Use `getScheduledPackage` for `packageStatus` and `trackingId`.
- Use Orders v2026 with `PACKAGES,TAX,FULFILLMENT_ORDERS` once it is confirmed to be filled for BR.
- No push exists, so the caps row should be `rastreio: 'pull'`.

**Caps-row implications for this topic:** `etiqueta: 'fetch'` (Amazon mints the label); `enviarNfe: 'sim'` (DBA `submitInvoice` is documented for BR); `rastreio: 'pull'`.

**Facts that only a live call or an operator capture can settle:**
1. The real `printableDocumentsUrl`: host, `X-Amz-Expires` value, and zip layout (file names, one file per package, whether BR adds other documents).
2. What a repeated bulk call returns for an already scheduled order (error code, and whether a URL comes back).
3. Whether `getScheduledPackage`, `createScheduledPackage`, `listHandoverSlots` and `updateScheduledPackages` work for `A2Q3Y263D00KWC`, or return `RegionNotSupported`.
4. The full set of BR `rejectedOrders` codes, and how `MissingPackageDimensions` gets fixed.
5. What bulk returns when the invoice is not yet `ACCEPTED`.
6. Whether an RDT carrying `dataElements` is accepted, and the real `expiresIn`.
7. For a BR DBA order in Orders v2026:
   - whether `programs` shows `AMAZON_EASY_SHIP`, `DELIVERY_BY_AMAZON` or both;
   - whether `packages[]` is filled, and whether `trackingNumber` equals `trackingId`;
   - whether `fulfillmentOrders[]` and `labelPrintingWindow` are present.
8. Whether EF `getShipments` with `marketplaceId=A2Q3Y263D00KWC` returns DBA orders, and which label format it serves.
9. Whether pickup moves the order to Shipped in BR, which would trigger `ORDER_CHANGE`.
10. Whether "NA" in the 2025-07-28 `PendingSchedule` changelog includes BR.
