# Survey E: listings import/link, stock, catalog, variation families

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Scope: Listings Items API, Feeds (JSON_LISTINGS_FEED), listing reports, variation families, listing notifications, Catalog Items, multi-location inventory, bundles, size charts and pausing. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

# Amazon SP-API research for listings import/link, MFN stock sync, catalog and variations on Amazon.com.br

Research date is 2026-10-14. All reading was read-only: docs were fetched as the `.md` form of the developer-docs pages, models through raw.githubusercontent.com and the GitHub API. No SP-API or AWS endpoint was called.

**Source keys.** Each entry shows the docs page "updatedAt", or the model file's last commit date.

| Key | Source |
|---|---|
| D1 | https://developer-docs.amazon/sp-api/docs/listings-items-api (2026-09-09) |
| D2 | …/docs/search-for-listings-items-by-id (2026-09-09) |
| D3 | …/docs/listings-items-api-rate-limits (2026-09-09) |
| D4 | …/docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management (2026-09-09) |
| D5 | …/docs/building-listings-management-workflows-guide (2026-09-24) |
| D6 | …/docs/submit-listings-data (2026-09-09) |
| D7 | …/docs/merge-a-listing (2026-09-09) |
| D8 | …/docs/mapping-product-attributes (2026-09-09) |
| D9 | …/docs/manage-amazon-haul-advanced-multiple-offer-multiple-fulfillment-use-cases (2026-09-09) |
| D10 | …/docs/listings-apis-faq (2026-09-09) |
| D11 | …/docs/feeds-api-rate-limits (2026-09-09) |
| D12 | …/docs/feeds-api-faq (2026-09-09) |
| D13 | …/docs/feeds-api-best-practices (2026-09-09) |
| D14 | …/docs/submit-a-feed (2026-09-09) |
| D15 | …/docs/listings-management-workflow-migration (2026-09-09) |
| D16 | …/docs/sp-api-deprecations (2026-09-09) |
| D17 | …/changelog/deprecation-of-feeds-api-support-for-xml-and-flat-file-listings-feeds (no date in the page source) |
| D18 | …/docs/sp-api-release-notes |
| D19 | …/docs/report-type-values-inventory (2026-10-06) |
| D20 | …/docs/notification-type-values (2026-09-30) |
| D21 | …/docs/set-up-notifications-with-amazon-eventbridge (2026-09-09) |
| D22 | …/docs/set-up-notifications-with-amazon-sqs (2026-09-30) |
| D23 | …/docs/filter-notification-subscriptions (2026-09-30) |
| D24 | …/docs/catalog-items-api-rate-limits (2026-09-09) |
| D25 | …/docs/search-catalog-items (2026-09-09) |
| D26 | …/docs/mli-integration-guide (2026-09-09) |
| D27 | …/docs/supply-sources-api (2026-09-09) |
| D28 | …/docs/manage-purchasable-offer (2026-09-09) |
| D29 | …/docs/preview-errors-before-partially-updating-a-listing (2026-09-09) |
| D30 | …/docs/listings-feed-type-values (2026-09-09) |
| D31 | …/docs/marketplace-ids (2026-09-30) |
| D32 | …/docs/sp-api-endpoints (2026-09-09) |
| D33 | …/docs/listings-items-guidance-for-complex-attributes (2026-09-09) |
| D34 | …/docs/role-mappings-for-types |
| D35 | …/docs/supply-sources-api-rate-limits |
| D36 | …/docs/manage-product-listings-guide (2026-09-09) |
| D37 | …/changelog/update-listings-items-v2021-08-01-api-and-json_listing_feed-now-include-a-json-patch-merge-operation (no date in the page source) |
| M1 | models/listings-items-api-model/listingsItems_2021-08-01.json (commit 2026-08-19, 94219a3fd0) |
| M2 | models/feeds-api-model/feeds_2021-06-30.json (2026-09-30) |
| M3 | models/reports-api-model/reports_2021-06-30.json (2026-04-01) |
| M4 | models/catalog-items-api-model/catalogItems_2022-04-01.json (2025-12-22) |
| M5 | models/notifications-api-model/notifications.json |
| S1 | schemas/feeds/listings-feed-schema-v2.json (2026-01-22) |
| S2 | schemas/feeds/listings-feed-processing-report-schema-v2.json (2025-11-17) |
| S3 | schemas/notifications/ListingsItemMfnQuantityChange.json (2023-06-21) |
| S4 | schemas/notifications/ListingsItemStatusChangeNotification.json |
| S5 | schemas/notifications/ListingsItemIssuesChangeNotification_2023-12-13.json |
| AWS1 | https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-targets.html |

**Context**
- Brazil's marketplace ID is `A2Q3Y263D00KWC` (D31). Its endpoint is the North America one, `https://sellingpartnerapi-na.amazon.com`, AWS region `us-east-1` (D32).
- The Listings Items, Feeds, Reports, Catalog Items, Notifications and Product Type Definitions APIs all have a "Static" sandbox (the overview pages for D1 and the others). The Listings sandbox scenarios in M1 (`x-amzn-api-sandbox`) are canned responses keyed on SKU values like `VALIDATION_VALID` and `BadSKU`, with marketplace `ATVPDKIKX0DER`. So the sandbox can test request shape, not real behaviour.

---

## 1. Listings Items API v2021-08-01

**Operations**
All are listed in M1 `paths`. The roles are Product Listing or Inventory and Order Tracking, in regions NA, EU and FE (D1, Roles section).

| Operation | Path | Model rate / burst | Docs rate (account-app) / per-app / burst (D3) |
|---|---|---|---|
| getListingsItem | GET /listings/2021-08-01/items/{sellerId}/{sku} | 5 / **10** | 5 / 100 / **5** |
| searchListingsItems | GET /listings/2021-08-01/items/{sellerId} | 5 / 5 | 5 / 100 / 5 |
| patchListingsItem | PATCH …/{sku} | 5 / 5 | 5 / 500 / 5 |
| putListingsItem | PUT …/{sku} | 5 / **10** | 5 / 100 / **5** |
| deleteListingsItem | DELETE …/{sku} | 5 / 5 | 5 / 100 / 5 |

- **Burst discrepancy:** the model (M1 `paths.*.get.description`, `paths.*.put.description`) says burst 10 for get and put. D3 says 5. Treat 5 as the safe value.
- **Extra per-application limits on patchListingsItem (D3):**
  - 100 rps for relationship attributes (`child_parent_sku_relationship`, `package_contains_sku`).
  - 100 rps for product-data attributes.
  - 20 rps for validation previews.
- **putListingsItem** has the same 100 rps per-application limit for relationship attributes (D3).
- D3 lists distinct 429 messages for the application, relationship and product-data limits.

**getListingsItem**
- `includedData` accepts `summaries`, `attributes`, `issues`, `offers`, `fulfillmentAvailability`, `procurement`, `relationships`, `productTypes`. The default is `summaries` (M1 `paths./listings/2021-08-01/items/{sellerId}/{sku}.get.parameters[includedData]`).
- `marketplaceIds` accepts up to 12 stores in one region (D2). Multi-store support was added on 2026-07-29 (D18).
- `summaries[].status` can be `BUYABLE` and/or `DISCOVERABLE`. Summaries also carry `asin`, `productType`, `conditionType`, `fnSku`, `itemName`, `createdDate`, `lastUpdatedDate` and `mainImage` (M1 `definitions.ItemSummaryByMarketplace`).
- **Read quantity from `fulfillmentAvailability`, not from `attributes`.** `attributes` holds the last data the seller submitted. `fulfillmentAvailability` is the live data: after selling the one unit you submitted, attributes still show 1 while fulfillmentAvailability shows 0 (D1 Considerations, D4).
- `definitions.FulfillmentAvailability` has only `fulfillmentChannelCode` (required) and `quantity` (minimum 0). There is no lead time and no marketplaceId (M1). Lead time is visible only inside `attributes.fulfillment_availability`, which is the submitted data.
- After a change, getListingsItem typically reflects it in 1–5 minutes (D10).

**searchListingsItems**
- It exists in the current model (M1 `paths./listings/2021-08-01/items/{sellerId}.get`). It was added on 2024-12-18 (D18).
- Filters (all in M1):
  - `identifiers`: up to 20 values. It requires `identifiersType`, which accepts ASIN, EAN, FNSKU, GTIN, ISBN, JAN, MINSAN, SKU or UPC. It cannot be combined with `variationParentSku` or `packageHierarchySku`.
  - `variationParentSku`, `packageHierarchySku`: mutually exclusive with each other and with `identifiers`.
  - `createdAfter`, `createdBefore`, `lastUpdatedAfter`, `lastUpdatedBefore`.
  - `withIssueSeverity`: WARNING or ERROR.
  - `withStatus`, `withoutStatus`: BUYABLE or DISCOVERABLE.
  - `includedData`: the same 8 values as getListingsItem.
- Paging and sorting (M1):
  - `sortBy` is `sku`, `createdDate` or `lastUpdatedDate`; the default is `lastUpdatedDate`.
  - `sortOrder` is ASC or DESC; the default is DESC.
  - `pageSize` maximum is 20, default 10.
  - Pass `pageToken` from `pagination.nextToken` or `previousToken` (M1 `definitions.Pagination`).
- Token rules (D2):
  - Tokens expire after 24 hours and are bound to the original query parameters.
  - Changing any parameter between pages returns a 400.
  - Encode `=` in the token as `%3D`.
  - A SKU that contains a comma must be searched on its own.
  - With `packageHierarchySku`, only the first 20 SKUs of the family are returned.
- **It cannot enumerate all listings.** At most 1,000 results can be returned and paged through, however many match (M1 `definitions.ItemSearchResults.properties.numberOfResults.description`; D2). D4 says the same cap applies across all pages and advises against using this operation to retrieve a whole, very large inventory.
- Whether partitioning by created-date windows works around the cap is not documented (UNKNOWN; see Open questions).

**patchListingsItem**
- Body: `productType` (required) and `patches[]` (at least 1). Each patch has `op` (`add`, `replace`, `merge` or `delete`), `path` and `value[]` (M1 `definitions.ListingsItemPatchRequest`, `definitions.PatchOperation`).
- Only top-level attributes can be patched (M1 description).
- `merge` is supported only on `fulfillment_availability` and `purchasable_offer` (D1 use-case list). It was added on 2025-05-28 (D18, D37).
- Query parameters:
  - `mode=VALIDATION_PREVIEW` validates the request without saving it (M1 `…patch.parameters[mode]`).
  - `includedData` accepts `identifiers` or `issues`; `identifiers` is allowed only with VALIDATION_PREVIEW (M1).
- Response `status` is ACCEPTED, INVALID, or VALID (VALID only in VALIDATION_PREVIEW) (M1 `definitions.ListingsItemSubmissionResponse`).
- Inventory updates use `productType: "PRODUCT"` (D6). The multi-location guide warns that ProductType must be `PRODUCT` and the path `/attributes/fulfillment_availability` (D26).
- The fulfillment record fields come from D8 and D9:
  - `fulfillment_channel_code`: `DEFAULT` = MFN; `AMAZON_NA`, `AMAZON_EU`, `AMAZON_JP` = FBA.
  - `quantity`, `lead_time_to_ship_max_days`, `restock_date`, `is_inventory_available`.
- Which channel codes this seller can use comes from Product Type Definitions with `sellerId` (D9). Whether `DEFAULT` is the BR MFN code for this seller is UNKNOWN until that call.

**Proposed body for Brazil (not tested).** It is assembled from the documented field names (D6, D7, D9); the BR-specific schema has not been checked.
```http
PATCH https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=A2Q3Y263D00KWC&mode=VALIDATION_PREVIEW&includedData=issues,identifiers
```
```json
{
  "productType": "PRODUCT",
  "patches": [
    {
      "op": "replace",
      "path": "/attributes/fulfillment_availability",
      "value": [
        { "fulfillment_channel_code": "DEFAULT", "quantity": 7, "lead_time_to_ship_max_days": 3 }
      ]
    }
  ]
}
```
- For quantity-only updates, D7 and D9 recommend `"op": "merge"` with `fulfillment_channel_code` (a selector, which must be non-empty) plus `quantity`. Fields you leave out, such as `restock_date` and `lead_time_to_ship_max_days`, stay unchanged.
- D9 says that with merge you no longer need to resend the lead time to keep the SKU-level handling time. That implies `replace` without a lead time may not keep it; this is not stated explicitly.
- Whether merge also updates `lead_time_to_ship_max_days` when you include it is not shown in any example (UNKNOWN).
- Whether the BR schema wants `marketplace_id` inside `fulfillment_availability` items is UNKNOWN; no docs example includes it.
- Whether `issueLocale=pt_BR` is supported is UNKNOWN; M1 only gives en_US, fr_CA and fr_FR as examples.

**putListingsItem**
- Body: `productType`, `requirements` (`LISTING`, `LISTING_PRODUCT_ONLY` or `LISTING_OFFER_ONLY`) and `attributes` (M1 `definitions.ListingsItemPutRequest`). `marketplaceIds` maxItems is 1 (M1).
- For sellers, put replaces previously submitted product-fact attributes and merges sales-term attributes (D5).
- Leaving content out of a put can remove it: for example, a `LISTING_OFFER_ONLY` put without bullet points removes the existing bullet points (D1).
- Offer-only listings on an existing ASIN use the `PRODUCT` product type, `LISTING_OFFER_ONLY` and `merchant_suggested_asin` (D5, D6).

**deleteListingsItem**
- `marketplaceIds` maxItems is 1 (M1).
- Deleting removes the listing from the seller's inventory entirely, including all reports and API data (D4).

**Timing and ordering**
- If you mix patch calls and `JSON_LISTINGS_FEED`, Amazon orders updates by submission timestamp (D10).

---

## 2. Feeds API v2021-06-30

**Operations and rate limits.** Model descriptions in M2 and the D11 table agree; the per-application column is "Not applicable".

| Operation | Rate / burst |
|---|---|
| createFeedDocument (POST /feeds/2021-06-30/documents) | 0.5 / 15 |
| createFeed (POST /feeds/2021-06-30/feeds) | **0.0083 / 15** |
| getFeed | 2 / 15 |
| getFeeds | 0.0222 / 10 |
| cancelFeed | 2 / 15 |
| getFeedDocument | 0.0222 / 10 |

**Operation details (M2 unless noted)**
- **createFeed for `JSON_LISTINGS_FEED`** has its own limit: 5 feeds per account per 5 minutes, and 25,000 records per feed (D11; M2 createFeed description).
- **cancelFeed** works only on feeds in `IN_QUEUE`.
- **Feed status values:** CANCELLED, DONE, FATAL, IN_PROGRESS, IN_QUEUE (`definitions.Feed.processingStatus`).
- **Retention:** feeds are kept for at most 90 days (getFeeds `createdSince` description).
- **Presigned URLs** for upload and download expire after 5 minutes (`definitions.CreateFeedDocumentResponse.url`, `definitions.FeedDocument.url`).
- **Compression:** feed documents may be GZIP-compressed; `enableContentEncodingUrlHeader` exists.
- **createFeed body:** `CreateFeedSpecification.marketplaceIds` allows 1–25 entries. However, `JSON_LISTINGS_FEED` accepts only one store per feed (D10, D14).

**JSON_LISTINGS_FEED message format (S1)**
- `header` contains `sellerId`, `version` = "2.0", `issueLocale`, and optionally `report{ includedData[], apiVersion: "2021-08-01" }`.
- `messages[]` holds 1 to **25,000** items.
- Each message has `messageId` (integer 1–2147483647), `sku`, and `operationType`:
  - `UPDATE`: requires `productType` and `attributes`.
  - `PARTIAL_UPDATE`: equivalent to `PATCH` with `replace`.
  - `PATCH`: requires `productType` and `patches`, with ops add, replace, merge or delete.
  - `DELETE`: no other fields.
- D6 has the inventory example: an operationType PATCH message that replaces `/attributes/fulfillment_availability` with a `DEFAULT` record and a quantity.
- **Size:** the allowed size of one feed document is 10 MB (D12). D13 recommends staying under 10 MiB (10,485,760 bytes).
- **Ordering:** messages within a feed are not guaranteed to be processed in feed order (D5, comparison table).

**Processing report (S2)**
- `header{sellerId, version, feedId, report}`.
- `issues[]` with `messageId`, `sku`, `code`, `severity` (ERROR, WARNING or INFO), `message` and `attributeName`. The `sku` field was added on 2025-12-03 (D18).
- `summary{errors, warnings, messagesProcessed, messagesAccepted, messagesInvalid, itemSummary{items, errors, warnings}}`.
- `items[]` is filled only when the header's `report.includedData` is set. That option was added on 2025-02-26 (D18).

**Timing and notification**
- Feeds can take up to 8 hours under high load (D14, D12).
- The processing report is produced only after every item has finished, so even a small feed can take hours (D5).
- Since 2026-02-23, `JSON_LISTINGS_FEED` moves to DONE and fires `FEED_PROCESSING_FINISHED` only after all processing is complete (D18).
- `FEED_PROCESSING_FINISHED`:
  - Fires on DONE, CANCELLED or FATAL.
  - Is delivered through **SQS**.
  - Payload: `accountId`, `sellerId`, `feedId`, `feedType`, `processingStatus`, `resultFeedDocumentId`.
  - Supports `filterExpression` (D20, D22, D23).

**Amazon's guidance: feed vs. patchListingsItem**
- The Feeds FAQ (D12) recommends that you "use the feed for operations that involve more than 1,500 items", with a ceiling of 25,000 per feed.
- D5's comparison table, paraphrased:
  - The Listings Items API allows 5 rps per operation and gives synchronous feedback.
  - The feed allows 5 submissions per 5 minutes and gives asynchronous feedback.
  - The suggested minimum feed size is 1,500 items. Below 1,500 items per 5-minute period, calling the API directly is faster.
  - Combining the two is acceptable: for example, an initial bulk load by feed, then ongoing maintenance through the API.
- D5 also warns against resubmitting unchanged data, because it lengthens processing backlogs.

**Legacy inventory feeds: removed**
- `POST_INVENTORY_AVAILABILITY_DATA` and `POST_FLAT_FILE_INVLOADER_DATA`, along with the other XML and flat-file listings feeds, were deprecated on 2024-03-18. The deprecation schedule gives a **removal date of 2025-12-03** (D16).
- The docs give conflicting dates:
  - Guides say that from **2025-07-31** these feeds return a FATAL `processingStatus` (D15, D30, D13, D14).
  - The original announcement set a migration deadline of **2025-03-31** (D17).
- All three dates are in the past, so treat these feeds as unavailable.

---

## 3. Reports API v2021-06-30 for listing enumeration

**Operations and rate limits (M3 descriptions)**
- createReport: 0.0167 rps, burst 15.
- getReport: 2 rps, burst 15.
- getReportDocument: 0.0167 rps, burst 15.
- getReports: 0.0222 rps, burst 10.
- No Reports rate-limits page appears in the docs index, so the model is the only source.
- Status `CANCELLED` can also mean the report had no data to return (M3 `definitions.Report.processingStatus`).
- The document URL expires after 5 minutes and may be GZIP-compressed (M3 `definitions.ReportDocument`).

**Report types (D19)**
All three below are request-only (cannot be scheduled) and tab-delimited.

| Report | What it holds | Columns |
|---|---|---|
| `GET_MERCHANT_LISTINGS_ALL_DATA` | All listings: active, inactive and suppressed (D4) | item-name, item-description, listing-id, seller-sku, price, quantity, open-date, image-url, item-is-marketplace, product-id-type, zshop-*, item-note, item-condition, asin1, asin2, asin3, will-ship-internationally, expedited-shipping, product-id, bid-for-featured-placement, add-delete, pending-quantity, **fulfillment-channel**, merchant-shipping-group, **status** |
| `GET_MERCHANT_LISTINGS_DATA` | Purchasable listings plus zero-quantity ones (D4) | Same as ALL_DATA but without `status`, plus B2B pricing columns |
| `GET_FLAT_FILE_OPEN_LISTINGS_DATA` | Seller Central sellers | sku, asin, price, quantity, plus B2B pricing columns; no fulfillment-channel or status |

- The docs reference page describes `GET_MERCHANT_LISTINGS_DATA` as "A detailed all listings report", which looks like a copy-paste slip in D19. D4's description is more specific.
- **Common rules (D19):**
  - One store per report; only the first `marketplaceId` is used.
  - `preferredReportDocumentLocale` sets the locale of the column headers.
  - Reports are cached for 1–6 hours, depending on how many entries they have.
  - Files start with a UTF-8 BOM.
- **No parent-SKU or relationship column** exists in any of them. Whether variation parents appear as rows is UNKNOWN.
- The possible values of the `status` column are not documented (UNKNOWN).
- **Brazil availability:** D19 lists no store restriction for these three reports, while other sections, such as Pan-EU, do list one. Explicit confirmation for BR is UNKNOWN.
- **Freshness:** inventory reports are not near real-time. The stock-data freshness SLA is 3 hours, and data in repeat requests is 1–6 hours old (D4).
- **Processing time** has no number in the docs; it depends on report size and system load (reports-faq).
- **`REPORT_PROCESSING_FINISHED`** is delivered through SQS. Payload: `accountId`, `sellerId`, `reportId`, `reportType`, `processingStatus`, `reportDocumentId`. It supports `filterExpression` (D20, D22, D23).

**Reports vs. searchListingsItems for a one-off or periodic import**
- Reports are documented as the bulk path; search is meant for checking one or several items, capped at 1,000 results (D4, D2).
- A practical split implied by the docs:
  1. Use `GET_MERCHANT_LISTINGS_ALL_DATA` to get every seller-sku, asin1, quantity, fulfillment-channel and status.
  2. Then call getListingsItem or a filtered searchListingsItems with `relationships`, `fulfillmentAvailability` and `issues` for live detail.
- Search costs: 5 rps with pageSize 20, so the full 1,000-result cap takes 50 calls.

---

## 4. Variation families

- **Parent attributes (D5):**
  - `parentage_level` = `parent`.
  - `child_parent_sku_relationship.child_relationship_type` = `variation`.
  - `variation_theme.name`.
- **Child attributes (D5):**
  - `parentage_level` = `child`.
  - `child_parent_sku_relationship` with `child_relationship_type` = `variation` and `parent_sku` = the parent's SKU.
  - The same `variation_theme` as the parent.
  - The theme's attributes, which become mandatory (for example `shirt_size`, `color`, `number_of_items`).
- **Schema selection:** Product Type Definitions accepts `parentageLevel` = PARENT, CHILD or NONE (D5; added 2026-05-27 per D18).
- **The parent is a non-buyable listing with its own SKU.** D5 says the parent must not be buyable, and children point to it by `parent_sku`, which is a SKU.
- **Stock lives on children.** That stock is only on child SKUs follows from the parent being non-buyable; the docs do not say it outright.
- **Changing families (D5):**
  - Deleting the parent removes every relationship; deleting a child removes only that child's link.
  - Removing a relationship does not change the status of the remaining listings.
  - A child must be unlinked before it can be relinked to a new parent.
- **How the APIs surface relationships:**
  - `includedData=relationships` returns `relationships[].relationships[]` with `type` (VARIATION or PACKAGE_HIERARCHY), `childSkus`, `parentSkus`, and `variationTheme{attributes[], theme}` (M1 `definitions.ItemRelationship`, `definitions.ItemVariationTheme`).
  - `variationParentSku` finds all children of a parent (D5, M1).
  - Catalog `includedData=relationships` returns `parentAsins` at ASIN level (D5).
- **Unknowns:**
  - Whether an unfiltered search returns parent SKUs as items: UNKNOWN.
  - Whether reports contain parent rows: UNKNOWN (§3).
- **Throttling:** relationship updates have their own 100 rps per-application limit (D3).

---

## 5. Notifications for listings and stock

**Delivery channels**
- `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` and `PRODUCT_TYPE_DEFINITIONS_CHANGE` are **EventBridge only** (D20 "Workflow" line on each type; D21 list).
- `FEED_PROCESSING_FINISHED` and `REPORT_PROCESSING_FINISHED` are **SQS only** (D20, D22).
- The three listings notification types require the Product Listing role, in regions NA, EU and FE (D34).

**EventBridge setup**
- An EventBridge destination needs `accountId` and `region` (M5 `definitions.EventBridgeResourceSpecification`).
- Only one EventBridge destination is allowed per AWS account (D21).
- Events arrive on a partner event source named `aws.partner/sellingpartnerapi.amazon.com/{AWS Account Id}/{Application Id}` (D21).
- AWS side (AWS1):
  - A rule can target SQS standard, fair or FIFO queues.
  - SQS queues encrypted with an AWS-owned key are not supported as targets.
  - A rule can have up to 5 targets.

**Delivery behaviour**
- SQS standard queues do not guarantee order and can deliver duplicates; deduplicate on `notificationId` (D22).
- Status and issues notifications usually lag 15–20 minutes, because the backend updates every 15 minutes (D10).
- `filterExpression` is **not** supported for any of the three LISTINGS_ITEM_* types (D23).

**LISTINGS_ITEM_MFN_QUANTITY_CHANGE**
- **Order decrements do fire it.** It fires on any change in available MFN quantity, including seller updates, new orders and cancellations, and Amazon decrements available quantity when a customer orders (D20).
- **It also fires on your own updates.** Because it fires on seller quantity updates, an ERP that pushes stock will receive an echo of its own changes; filter these out to avoid sync loops.
- Payload is version 1.0, all fields required: `SellerId`, `FulfillmentChannelCode`, `Sku`, `Quantity` (S3 `properties.Payload`; D20).
- **There is no MarketplaceId in the payload.** That is fine for a BR-only account but ambiguous for a multi-store one.

**LISTINGS_ITEM_STATUS_CHANGE**
- Fires when a listing is created, deleted, or changes buyability, for any Amazon store (D20).
- Payload: `SellerId`, `Sku` and `Status` (required); `MarketplaceId`, `Asin` and `CreatedDate` (optional).
- `Status` can be BUYABLE, DISCOVERABLE or DELETED (S4).

**LISTINGS_ITEM_ISSUES_CHANGE**
- Payload version 2023-12-13: `SellerId`, `Sku`, `Severities` (NONE, ERROR or WARNING), plus `MarketplaceId`, `Asin`, `EnforcementActions` (S5).
- **Payload version 1.0 is deprecated, with a removal date of 2026-08-26 (D16).** That date has passed, so subscribe with `2023-12-13`.

---

## 6. Catalog Items API v2022-04-01

**searchCatalogItems** (GET /catalog/2022-04-01/items; M4 `paths./catalog/2022-04-01/items.get.parameters`)
- `identifiers`: up to 20 values.
- `identifiersType`: ASIN, EAN, GTIN, ISBN, JAN, MINSAN, SKU or UPC. **SKU requires `sellerId`.**
- `marketplaceIds`: maxItems 1.
- `includedData`: attributes, classifications, dimensions, identifiers, images, productTypes, relationships, salesRanks, summaries or vendorDetails.
- `pageSize`: maximum 20.
- `keywords` cannot be combined with `identifiers`.
- At most 1,000 results can be paged through (D25).

**getCatalogItem** (GET /catalog/2022-04-01/items/{asin}; M4) takes the same `includedData` values.

**Rate limits (D24)**
- getCatalogItem: 2 rps per account-application, 250 per application, burst 2.
- searchCatalogItems: 2 rps per account-application, 500 per application, burst 2; keyword searches are capped at 50 rps per application.
- D24 recommends searchCatalogItems for batch retrieval by ASIN.

**Linking an ERP product to an existing ASIN**
- External identifiers do not map 1:1 to ASINs. If several come back, check product type, brand, title and parentage, then confirm with getCatalogItem (D25, D5).
- To list an offer on an existing ASIN (step c), Amazon's flow is: find the ASIN, check restrictions with getListingsRestrictions, then put `PRODUCT` + `LISTING_OFFER_ONLY` (D5, D10).
- For linking **existing** listings (step a), searchListingsItems also accepts EAN, GTIN and UPC identifiers (M1), and listing summaries carry the `asin`.

**Deprecations:** Catalog v0 `listCatalogCategories` was removed on 2026-08-26 (D16). Version 2020-12-01 is legacy ("use the latest version", D24).

---

## 7. Multi-location inventory and the Supply Sources API

- **Multi-location inventory is not available for inventory outside the Amazon US store (D26).** By the docs, it does not apply to Amazon.com.br.
- It is also unavailable to FBA sellers, BOPIS (buy online, pick up in store) sellers, and sellers who manage inventory in Seller Central (D27).
- The Supply Sources API itself lists regions NA, EU and FE and requires the Selling Partner Insights role (D27). Its rate limits are in D35.
- `fulfillment_availability` is technically an array keyed by `fulfillment_channel_code`, and supply-source IDs can serve as channel codes (D9). For BR, only a single `DEFAULT` MFN record is consistent with D26. Multiple locations in BR: not supported per D26; confirm live.

---

## 8. Bundles, kits and size charts

**Virtual Bundles**
- No mention exists in the SP-API docs index or the models: I searched the llms.txt index and ran a domain-limited web search. API support: **UNKNOWN / none documented**. Availability on Amazon.com.br: **UNKNOWN**.
- [third-party, non-authoritative] In an Amazon Seller Forums EU thread (relative date "2 years ago"), an Amazon staff reply says the Seller Central tool is the only way to create Virtual Bundles, not in bulk, and that bundles cannot be part of variation families: https://sellercentral-europe.amazon.com/seller-forums/discussions/t/8969ff5c-e71f-4aa1-b766-74a38387adfc
- **Package hierarchy is not a bundle.** `package_level` and `package_contains_sku` model unit, case and pallet packs, and each level needs its own external identifier (D5).

**Size charts**
- No size-chart API or attribute is documented: **UNKNOWN**.
- D33 covers only apparel and footwear size attributes (size system, class and value).
- `size_map` appears only as an attribute name in a sample LUGGAGE schema (D36). That is not evidence of a size-chart feature.

---

## 9. Pausing a listing without deleting it

- **Quantity 0:** the listing becomes inactive (out of stock) and is reactivated by restocking. Zero-quantity listings still appear in `GET_MERCHANT_LISTINGS_DATA` and the inactive report (D4).
- **Close the offer:** remove the purchasable offer, or move its sale period into the past (D4).
  - Concretely, a `merge` on `/attributes/purchasable_offer` that sets `end_at` to a past date "soft-closes" the offer.
  - The selectors are `marketplace_id`, `currency` and `audience` (D28).
  - `end_at` can later be removed by setting it to `null`.
  - The whole offer is removed with the `delete` op; `our_price` cannot be set to null (D28).
- **deleteListingsItem** is permanent removal from inventory, reports and API data (D4). Deleting a parent also unlinks all its children (D5).
- **No dedicated pause or inactive status attribute is documented** (UNKNOWN). Listing statuses are only BUYABLE and DISCOVERABLE (M1 `definitions.ItemSummaryByMarketplace.status`).

---

## Open questions only a live call settles

The sandbox is static (canned responses, mostly keyed to the US marketplace), so it cannot settle any behavioural question below.

1. **Which MFN `fulfillment_channel_code` does this BR seller have, and what does the `PRODUCT` schema look like for BR?** This covers whether items need `marketplace_id` and the bounds on `lead_time_to_ship_max_days`. It matters because the patch body depends on it. Sandbox: no. Settle with a read-only `getDefinitionsProductType` call that passes `sellerId` and `marketplaceIds=A2Q3Y263D00KWC`, then a `VALIDATION_PREVIEW` patch.
2. **Does a `merge` that includes `lead_time_to_ship_max_days` update the lead time, and does a `replace` without it reset the handling time?** It matters because stock pushes could silently change handling time. Sandbox: no. VALIDATION_PREVIEW checks validity only, not what is saved.
3. **How many SKUs does the seller have, and can created-date windows walk past the 1,000-result search cap?** It matters for choosing the import strategy. Sandbox: no.
4. **Do `GET_MERCHANT_LISTINGS_ALL_DATA` rows in BR include variation parents, which `status` values appear, and what are the header names under a pt_BR locale?** It matters for the import parser and parent/child mapping. Sandbox: no (static).
5. **Does an unfiltered `searchListingsItems` return parent SKUs, and do parents carry `fulfillmentAvailability`?** It matters for the family model. Sandbox: no.
6. **Does `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` fire in BR, how long does it take, and does our own patch produce an echo event?** It matters for loop prevention and reconciling stock. Sandbox: no; static notifications emit no real events.
7. **What are this seller and application's actual rate limits (the `x-amzn-RateLimit-Limit` header), including the get/put burst of 5 vs. 10?** It matters for throttling design. Sandbox: no.
8. **Is `issueLocale=pt_BR` supported for issue messages?** It matters for user-facing error text. Sandbox: no.
9. **In BR, does quantity 0 vs. an `end_at` soft-close trigger `LISTINGS_ITEM_STATUS_CHANGE` the same way, and can the listing be reopened cleanly?** It matters for the pause feature. Sandbox: no.
10. **Does `getSupplySources` return anything (or an error) for a BR seller?** It confirms there is no multi-location inventory in BR. Sandbox: no.
11. **How long does a `JSON_LISTINGS_FEED` actually take for this account?** The docs say up to 8 hours. It matters for choosing between feed and patch for stock. Sandbox: no.
12. **Are Virtual Bundles available in Seller Central for Amazon.com.br, and do BR apparel product types expose any size-chart attribute?** For bundles, someone needs to check the seller's Seller Central; for size charts, a read-only `getDefinitionsProductType` call. Sandbox: no.
