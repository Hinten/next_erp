# Survey B: Notifications API and the AWS delivery path

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Scope: destinations and subscriptions, the notification-type table (SQS vs EventBridge), ORDER_CHANGE in depth, delivery semantics, EventBridge API destinations and Pipes, and the transport comparison. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

# SP-API Notifications to an HTTPS receiver on Google Cloud: documentation research report (as of 2026-10-14)

**Headline finding:** `ORDER_CHANGE` can only be delivered to an **SQS destination**. It cannot use an EventBridge destination [EBWF][SQSWF][NTV]. Transport options (a) and (b) in the brief start from "EventBridge rule". For `ORDER_CHANGE` they only work after an SQS hop, such as SQS → Pipe → event bus. Section 8 rewrites them on that basis.

## Sources and citation keys

**SP-API docs.** All URLs below are `https://developer-docs.amazon/sp-api/...`. The raw markdown was read by adding `.md` to each page URL. The date shown is the page's `updatedAt`.
- [NTV] docs/notification-type-values — 2026-09-30
- [NAPI] docs/notifications-api — 2026-09-09
- [SQSWF] docs/set-up-notifications-with-amazon-sqs — 2026-09-30
- [EBWF] docs/set-up-notifications-with-amazon-eventbridge — 2026-09-09
- [FILT] docs/filter-notification-subscriptions — 2026-09-30
- [OCT] docs/tutorial-subscribe-to-order-change-notification — 2026-09-09
- [MFN] docs/subscribe-to-mfn-notifications — 2026-09-09
- [DEP] docs/sp-api-deprecations — 2026-09-09
- [RN] docs/sp-api-release-notes — 2026-10-01
- [ROLE] docs/role-mappings-for-types — 2026-09-09
- [GL] docs/grantless-operations — 2026-09-09
- [CONN] docs/connecting-to-the-selling-partner-api
- [SQSPERM] docs/tutorial-grant-permission-to-sqs-queue — 2026-09-09
- [ROT] docs/rotate-your-application-client-secret — 2026-09-09
- [CRN] docs/set-up-credential-rotation-notifications — 2026-09-09
- [EASY] docs/easy-ship-api — 2026-09-09
- [SBX] docs/sp-api-sandbox — 2026-09-09
- [REF] reference/{createsubscription, getsubscriptions, sendtestnotification, createdestination} — 2026-09-10

**Models** (`https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/...`)
- [NM] `models/notifications-api-model/notifications.json`. Last commit 2026-08-05 (`34dc93fe45`, "notifications model update"); previous commit 2026-05-27.
- [OCS] `schemas/notifications/OrderChangeNotification.json`. Last commit 2026-05-27 (`fafbbefd70`, "DeliveryTip added").
- Other `schemas/notifications/*.json` files are cited by file name. The folder has 26 files.

**AWS docs.** No last-updated date is visible on any of these pages.
- `docs.aws.amazon.com/eventbridge/latest/userguide/`:
  - [AWS-APID] eb-api-destinations
  - [AWS-CONN] eb-target-connection
  - [AWS-AUTH] eb-target-connection-auth
  - [AWS-CC] eb-target-connection-create
  - [AWS-CE] eb-target-connection-edit
  - [AWS-CS] eb-target-connection-states
  - [AWS-RETRY] eb-rule-retry-policy
  - [AWS-DLQ] eb-rule-dlq
  - [AWS-Q] eb-quota
  - [AWS-SAAS] eb-saas
  - [AWS-TGT] eb-targets
  - [AWS-IT] eb-transform-target-input
  - [AWS-MON] eb-monitoring
  - [AWS-LOGS] eb-event-bus-logs
  - [AWS-PSQS] eb-pipes-sqs
  - [AWS-PTGT] eb-pipes-event-target
  - [AWS-PERR] eb-pipes-error-troubleshooting
  - [AWS-PBATCH] eb-pipes-batching-concurrency
  - [AWS-PIT] eb-pipes-input-transformation
  - [AWS-PLOG] eb-pipes-logs
- `.../eventbridge/latest/APIReference/`:
  - [AWS-RP] API_RetryPolicy
  - [AWS-CAD] API_CreateApiDestination
  - [AWS-UAD] API_UpdateApiDestination
  - [AWS-KEY] API_CreateConnectionApiKeyAuthRequestParameters
  - [AWS-UC] API_UpdateConnection
- Other AWS pages:
  - [AWS-EVS] eventbridge/latest/ref/overiew-event-structure.html
  - [AWS-SQSQ] AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
  - [AWS-OIDC] IAM/latest/UserGuide/id_roles_providers_oidc.html
- AWS pricing pages (marketing site). The price tables did not render; the figures come from each page's worked examples, and the region is not stated:
  - [EB-$] aws.amazon.com/eventbridge/pricing
  - [SQS-$] aws.amazon.com/sqs/pricing
  - [LAMBDA-$] aws.amazon.com/lambda/pricing

---

## 1. Notifications API v1

**Host and rate limits**
- Host is `sellingpartnerapi-na.amazon.com` [NM `host`].
- Every operation has a default rate of 1 request per second with a burst of 5 [NM each `paths.*.*.description`].
- Every operation is available in the NA, EU and FE regions [NAPI].

**Operations**

| Operation | Method and path | Authorization |
|---|---|---|
| getSubscriptions (new) | GET `/notifications/v1/subscriptions` | UNKNOWN. It is not in the [NAPI] roles list or the [GL] table. Its description says "returns all subscriptions for the caller's party" [NM], which suggests seller authorization is needed. |
| getSubscription | GET `/notifications/v1/subscriptions/{notificationType}` | Seller authorization. Needs the role that maps to the notification type [NAPI]. |
| createSubscription | POST `/notifications/v1/subscriptions/{notificationType}` | Seller authorization. Needs the role that maps to the notification type [NAPI]. |
| getSubscriptionById | GET `/notifications/v1/subscriptions/{notificationType}/{subscriptionId}` | Grantless [NM][NAPI][GL] |
| deleteSubscriptionById | DELETE, same path | Grantless [NM][NAPI][GL] |
| getDestinations / createDestination | GET / POST `/notifications/v1/destinations` | Grantless [NM][NAPI][GL] |
| getDestination / deleteDestination | GET / DELETE `/notifications/v1/destinations/{destinationId}` | Grantless [NM][NAPI][GL] |
| sendTestNotification | POST `/notifications/v1/subscriptions/{notificationType}/testNotification` | Grantless, sandbox only, "to your SQS" [NM]. Not listed in [GL]. |

Notes on the operations:
- **getSubscriptions** takes `notificationTypes` (required, exactly 1 item), an optional `payloadVersion`, `pageSize` (30–100, default 30) and `nextToken` [NM `paths./notifications/v1/subscriptions.get.parameters`].
- **getSubscription** returns the latest payload version's subscription when `payloadVersion` is omitted [NM].
- **sendTestNotification** has `x-amzn-api-sandbox-only: true` [NM].
- **Doc inconsistency:** [GL] lists `deleteSubscriptionById` at `/notifications/v2/...`. The model has only v1.

**How grantless calls authenticate**
- Use the LWA `grant_type=client_credentials` grant with `scope=sellingpartnerapi::notifications` and no refresh token [CONN].
- Grantless operations "apply only to seller applications" [GL].

**Destination resource shapes** [NM `definitions`]
- **Request** (`CreateDestinationRequest`): `name` (required) and `resourceSpecification` (required).
  - The resource specification has either `sqs` or `eventBridge`. The model says "Applications should use one resource type (sqs or eventBridge) per destination."
  - `SqsResource.arn` is required, max length 1000, pattern `^arn:aws:sqs:\S+:\S+:\S+`.
  - `EventBridgeResourceSpecification` has `region` (required) and `accountId` (required), where the account is "responsible for charges".
- **Response** (`Destination`): `name` (max 256), `destinationId`, and `resource`.
  - `resource.eventBridge` contains `name`, which is "the name of the partner event source", plus `region` and `accountId`.
- **EventBridge limit:** you can only create one EventBridge destination per AWS account [EBWF].
- **SQS requirements:**
  - The queue must be a standard queue; FIFO queues are not supported [SQSWF].
  - The queue policy must allow principal `437568002678` to call `sqs:SendMessage` and `sqs:GetQueueAttributes` [SQSPERM].
  - With SSE-KMS, the key policy must also allow `arn:aws:iam::437568002678:root` to call `kms:GenerateDataKey` and `kms:Decrypt` [SQSWF].

**Is there exactly one subscription per (application, seller, notificationType)? No.**
- "We allow multiple subscriptions with different payload versions per application, notification type and party (seller/vendor)" [NAPI][SQSWF][EBWF].
- createSubscription can add a subscription for a different payload version while one already exists [NM createSubscription description].
- getSubscriptions exists for the case where "multiple subscriptions exist for a notification type (for example, when using filter expressions)" [NM].
- The filter migration guide tells you to create a new `filterExpression` subscription alongside the existing one [FILT].
- You cannot update a subscription; you delete it and create a new one [FILT].
- UNKNOWN: whether a second identical subscription (same payloadVersion, same destination, no filter) is accepted or returns 409. The model describes 409 only as "conflicts with the current state" [NM].
- **Doc error:** [FILT] mentions a `deleteSubscription` operation and `DELETE /notifications/v1/subscriptions/ANY_OFFER_CHANGED`. Neither exists in [NM].

**Can two apps subscribe the same seller to the same type independently?**
- Subscriptions are scoped per application:
  - "multiple subscriptions ... per application" [NAPI].
  - deleteSubscriptionById works on "any subscription associated with your application" [NM].
  - Every notification carries `NotificationMetadata.ApplicationId` [OCS].
- No page says explicitly that two different applications can each subscribe the same seller. That is UNKNOWN, though implied by the per-application scoping.

**processingDirective** [NM `definitions.ProcessingDirective`]
- It holds either `eventFilter` or `filterExpression`; the two are mutually exclusive.
- **`eventFilter`** combines the aggregation, marketplace, order-change-type and tracking filters, plus a required `eventFilterType`. The `eventFilterType` enum is `ANY_OFFER_CHANGED | ORDER_CHANGE | SHIPMENT_TRACKING_MILESTONE_CHANGED`.
  - `aggregationSettings.aggregationTimePeriod` (required inside the settings) is `FiveMinutes | TenMinutes`.
  - `marketplaceIds` is a string array.
  - `orderChangeTypes` takes `BuyerRequestedChange | DeliveryTipChange | OrderStatusChange`.
  - `trackingIdentifier` takes exactly one of `id`, `acsin`, `aftn`, `containerNumber`, `houseBillOfLadingNumber`, or `carrierTracking{trackingNumber (required), carrierCode}`.
- **Which types accept which filter** [SQSWF]:
  - `aggregationSettings` and `marketplaceIds`: `ANY_OFFER_CHANGED` only.
  - `orderChangeTypes`: `ORDER_CHANGE` only.
  - `trackingIdentifier`: required for `SHIPMENT_TRACKING_MILESTONE_CHANGED`.
  - Using an unsupported filter returns HTTP 400.
  - "`marketplaceIds` is not a supported filter for `ORDER_CHANGE`".
- **`filterExpression`**:
  - It is a CEL string of 1–256 characters, with no arithmetic and no `[]` indexing [NM].
  - Supported operators are listed in [FILT].
  - If the expression references a missing field without a `has()` guard, evaluation fails and the event is **dropped** [FILT].
  - It cannot do aggregation [FILT].
  - It was added on 2026-05-27 [RN].
- **payloadVersion** is a required string in createSubscription. The model has no enum for it; valid values per type are on [NTV]. The model's sandbox examples use `"1.0"` [NM].

## 2. Notification type table

Abbreviations: **SQS** = SQS destination only, **EB** = EventBridge destination only. Roles: AF = Amazon Fulfillment, DTCS(R) = Direct to Consumer Shipping (Restricted), IOT = Inventory and Order Tracking, PL = Product Listing; any one listed role is enough [ROLE]. "Regions" means SP-API regions; Brazil is served through the NA endpoint.

**CRITICAL: which types work with which destination**
- The EventBridge workflow supports **only** these 7 types [EBWF]: BRANDED_ITEM_CONTENT_CHANGE, ITEM_PRODUCT_TYPE_CHANGE, LISTINGS_ITEM_STATUS_CHANGE, LISTINGS_ITEM_ISSUES_CHANGE, LISTINGS_ITEM_MFN_QUANTITY_CHANGE, PRODUCT_TYPE_DEFINITIONS_CHANGE, SHIPMENT_TRACKING_MILESTONE_CHANGED. The page says: "If you want to receive any other notification type, skip this tutorial."
- `SHIPMENT_TRACKING_MILESTONE_CHANGED` is the **only** type documented for both SQS and EventBridge [NTV "Workflow (select one)"].
- **Every other type is SQS-only, including ORDER_CHANGE** [SQSWF list][NTV per-type "Workflow"].

| Type | Destination | Payload version | Brazil | Role | Description / status |
|---|---|---|---|---|---|
| ORDER_CHANGE | **SQS** | 1.0 | Regions NA/EU/FE [ROLE]. The [OCT] example uses MarketplaceId `A2Q3Y263D00KWC`. No explicit Brazil statement. | AF, DTCS(R) or IOT [ROLE]. [OCT] says IOT or AF. | "Important change in the order… order status changes and buyer requested cancelations" [NTV]. Supports both eventFilter and filterExpression. |
| ORDER_STATUS_CHANGE | — | — | — | Still listed in [ROLE], which is stale. | **REMOVED.** Deprecated 2023-06-21, removal date **2026-07-29** [DEP]. [MFN] says "have been removed". It is absent from [NTV]. |
| LISTINGS_ITEM_STATUS_CHANGE | **EB** | 1.0 | "Any Amazon store" [NTV] | PL | Listing created, deleted or buyability changed [NTV]. **Discrepancy:** `ListingsItemStatusChangeNotification.json` sets the NotificationType enum to `LISTINGS_ITEM_STATUS_CHANGED`. |
| LISTINGS_ITEM_ISSUES_CHANGE | **EB** | 2023-12-13 | Any store | PL | Listing issues changed. Version 1.0 was deprecated 2024-02-28 with removal **2026-08-26** [DEP]. [NTV] still says 1.0 "will be deprecated soon", and the 2024-12-18 release note gave a removal date of 2025-03-26 [RN]. The docs contradict each other. |
| LISTINGS_ITEM_MFN_QUANTITY_CHANGE | **EB** | 1.0 | Regions NA/EU/FE | PL | MFN available quantity changed [NTV]. |
| ITEM_PRODUCT_TYPE_CHANGE | **EB** | 1.0 | Any store | Pricing (NA only) or PL | Product type changed on an item the seller has a brand relationship with [NTV]. |
| BRANDED_ITEM_CONTENT_CHANGE | **EB** | 1.0 | Any store | PL | Title, description, bullets or images changed on a brand-owned ASIN [NTV]. |
| PRODUCT_TYPE_DEFINITIONS_CHANGE | **EB** | 1.0 | Regions NA/EU/FE | PL | New product type or product type version [NTV]. |
| FEED_PROCESSING_FINISHED | **SQS** | [NTV] heading says 1.0. Its example and the schema example both use `2020-09-04`. **Discrepancy.** | NA, EU\*, FE | AF, DTCS(R), IOT, Pricing or PL | Feed reaches DONE, CANCELLED or FATAL [NTV]. |
| REPORT_PROCESSING_FINISHED | **SQS** | Same 1.0 vs `2020-09-04` discrepancy | NA, EU\*, FE | Many roles [ROLE] | Report reaches DONE, CANCELLED or FATAL. |
| PRICING_HEALTH | **SQS** | 1.0 | NA, EU, FE\* | Pricing | Offer is ineligible for Featured Offer because of an uncompetitive price. |
| ANY_OFFER_CHANGED | **SQS** | 1.0 | NA, EU, FE\* | Pricing | Change in the top-20 offers, Buy Box or external price. Only sent for items with active offers [NTV]. |
| ACCOUNT_STATUS_CHANGED | **SQS** | 2021-01-01 | NA/EU/FE | Selling Partner Insights | Account status changes between NORMAL, AT_RISK and DEACTIVATED. |
| APPLICATION_OAUTH_CLIENT_NEW_SECRET | Not a Notifications API type | UNKNOWN | — | — | The name appears nowhere in [NTV], [ROLE], [ROT] or [CRN]. The new secret goes to an SQS queue registered in the Developer Console row "Application Client New Secret" [ROT]; its payload is UNKNOWN. The related expiry message `APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY` (payloadVersion `2023-11-30`) goes to the queue in the "Application Client Secret Expiry" row [CRN]. Rotation cannot be called from a sandbox app, and the old secret expires 7 days after rotation [ROT]. |
| TAX_INVOICE_EXPORT_STATUS_CHANGE | **SQS** | 1.0 | **BR and MX only** [NTV] | AF; Region NA | Launched 2026-09-30 [RN]. No filterExpression [FILT]. |
| TAX_INVOICE_ISSUANCE_ELIGIBILITY_STATUS_CHANGE | **SQS** | 1.0 | **BR and MX only** | AF | Launched 2026-09-30 [RN]. |
| TAX_INVOICE_ISSUANCE_STATUS | **SQS** | 1.0 | **BR and MX only** | AF | Launched 2026-09-30 [RN]. Includes error details when issuance fails. |
| TRANSACTION_UPDATE | **SQS** | 1.0 | Not stated | Not in [ROLE]: UNKNOWN | New transaction posted to the seller account [NTV]. Added 2024-10-14 [RN]. |
| FBA_OUTBOUND_SHIPMENT_STATUS | **SQS** | 1.0 | **Brazil store only**; FBA Onsite only [NTV] | AF | FBA shipment created or cancelled. |
| FULFILLMENT_ORDER_STATUS | **SQS** | 2026-07-04 (1.0 deprecated [NTV]) | NA, EU\*, FE | AF | Multi-Channel Fulfillment order, shipment or package status. |
| EXTERNAL_FULFILLMENT_SHIPMENT_STATUS_CHANGE | **SQS** | 1.0 | Not stated | Not in [ROLE]: UNKNOWN | Warehouse-integration order statuses, including INVOICE_GENERATED and SHIPLABEL_GENERATED [NTV]. |
| SHIPMENT_TRACKING_MILESTONE_CHANGED | SQS **or** EB | 2026-01-30 | **NA (US only)** [ROLE], so not Brazil | Grantless [ROLE] | Requires the `trackingIdentifier` eventFilter. Launched 2026-08-05 [RN]. |
| SHIPPING_CHARGE_NOTIFICATION, BOPIS_CHECKIN_DETAILS | UNKNOWN | UNKNOWN | — | DTCS(R); IOT | Listed only in [ROLE], not in [NTV]. Status UNKNOWN. |
| Returns | — | — | — | — | No returns notification type exists in [NTV]. |
| Easy Ship | — | — | — | — | No dedicated type. Easy Ship appears only as a field inside ORDER_CHANGE (see section 3). The Easy Ship API store table does **not list Brazil** [EASY]. |

## 3. ORDER_CHANGE in depth

All field facts in this section come from [OCS] (JSON Schema draft-07; `$id` is a placeholder) unless another source is given.

**Envelope.** All six top-level fields are required: `NotificationVersion` (string), `NotificationType` (string), `PayloadVersion` (string), `EventTime` (string), `Payload` (object), `NotificationMetadata` (object).
- `NotificationMetadata` has four required strings: `ApplicationId`, `SubscriptionId`, `PublishTime`, `NotificationId`.

**`Payload.OrderChangeNotification`.** `NotificationLevel`, `SellerId`, `AmazonOrderId`, `OrderChangeType`, `OrderChangeTrigger` and `Summary` are all required.
- `NotificationLevel`: string, enum `OrderItemLevel | OrderLevel`.
- `SellerId`: string.
- `AmazonOrderId`: string in 3-7-7 format.
- `OrderChangeType`: string, enum `BuyerRequestedChange | DeliveryTipChange | OrderStatusChange`. `DeliveryTipChange` was added 2026-05-27 [RN].
- `OrderChangeTrigger`: both fields required.
  - `TimeOfOrderChange`: string or null.
  - `ChangeReason`: string. The example value is "Buyer Requested Cancel".

**`Summary`.** Required: `MarketplaceId`, `OrderStatus`, `PurchaseDate`, `DestinationPostalCode`, `FulfillmentType`, `OrderType`, `OrderItems`.
- `MarketplaceId`: string.
- `OrderStatus`: enum `Pending | Unshipped | PartiallyShipped | Shipped | Canceled | Unfulfillable | InvoiceUnconfirmed | PendingAvailability`. **Discrepancy:** [NTV] also lists `UpComing`.
- `PurchaseDate`: string or null.
- `DestinationPostalCode`: string or null.
- `FulfillmentType`: `AFN | MFN`.
- `OrderType`: `StandardOrder | LongLeadTimeOrder | Preorder | BackOrder | SourcingOnDemandOrder`.
- Optional fields:
  - `NumberOfItemsShipped` and `NumberOfItemsUnshipped`: integer.
  - `EarliestDeliveryDate`: string. Returned only for seller-fulfilled orders.
  - `LatestDeliveryDate`: string. Not returned for orders in PendingAvailability, Pending or Canceled.
  - `EarliestShipDate`, `LatestShipDate`, `CancelNotifyDate`: string.
  - `OrderPrograms[]`: `Business | Prime | Premium | IBA | Replacement`.
  - `ShippingPrograms[]`: `ShipDateSet | GlobalExpress | ISPU | AccessPoint | TFM | EasyShip`.
  - **`EasyShipShipmentStatus`**: `PendingSchedule | PendingPickUp | PendingDropOff | LabelCanceled | PickedUp | DroppedOff | AtOriginFC | AtDestinationFC | Delivered | RejectedByBuyer | Undeliverable | ReturningToSeller | ReturnedToSeller | Lost | OutForDelivery | Damaged`. Included "only for Amazon Easy Ship orders".
  - `ElectronicInvoiceStatus`: `NotRequired | NotFound | Processing | Errored | Accepted`.
- [NTV] spells the first field `MarketplaceID`; the schema uses `MarketplaceId`.

**`OrderItems[]`.** An OrderItemLevel payload carries one item; an OrderLevel payload carries all items. Required: `OrderItemId`, `SellerSKU`, `SupplySourceId`, `Quantity`.
- `OrderItemId`: string.
- `SellerSKU`: string.
- `SupplySourceId`: string or null.
- `OrderItemStatus`: `Unshipped | Shipped`. Present "when items' status are different".
- `Quantity` and `QuantityShipped`: integer.
- `IsBuyerRequestedCancel`: boolean.
- `ItemEarliestDeliveryDate` and `ItemLatestDeliveryDate`: string.

**What triggers it**
- Order status changes and buyer-requested cancellations [NTV]. Elsewhere described as an "order availability status change" [MFN].
- Delivery tip added or updated [OCT].
- How to act on each change type [OCT]:
  - `BuyerRequestedChange`: cancel the MFN order through the `POST_ORDER_ACKNOWLEDGEMENT_DATA` feed.
  - `DeliveryTipChange`: call `getOrder` with `includedData=PROCEEDS`.
  - `OrderStatusChange`: if the status is `Unshipped`, start fulfilling.
- What decides OrderLevel vs OrderItemLevel delivery is UNKNOWN. [OCT] advertises "consolidated payloads at the order level".

**Easy Ship.**
- [OCT] says the design "allows Amazon to add additional events related to orders **in the future**, like certain Easy Ship events". As documented, an Easy Ship status change on its own is **not** a listed trigger.
- Whether a notification fires for **every** Easy Ship status change is **UNKNOWN**; the docs suggest it does not.
- Easy Ship is not listed for Brazil [EASY].

**MFN orders in Brazil.**
- No doc states explicitly that ORDER_CHANGE is available in BR.
- The only evidence is the [OCT] example: MarketplaceId `A2Q3Y263D00KWC`, `FulfillmentType: MFN`, `OrderStatus: Unshipped`. Also, [ROLE] lists the NA region for this type.

**Related deprecation.** Orders API v0 (`getOrder`, `getOrders`, `getOrderItems`, etc.) was deprecated 2026-01-28, with removal 2027-03-27 [DEP]. That matters for any getOrder backstop.

## 4. Delivery semantics

**What the docs state**
- SQS destinations must be standard queues [SQSWF].
- SQS delivery has **no ordering guarantee**; notifications can arrive out of order [SQSWF].
- They may be delivered **more than once** [SQSWF].
- To detect duplicates, use `notificationId` in `NotificationMetadata` [SQSWF].
- `NotificationId` is "a unique identifier for this notification instance" [OCS][SQSWF].
- UNKNOWN: whether a redelivery on Amazon's side (as opposed to an SQS duplicate) keeps the same `NotificationId`.

**Timestamps**
- **`EventTime` conflict:**
  - [SQSWF] defines it as the time "the event which triggered the notification occurred".
  - [OCS] defines it as "The time when this notification was published".
- `PublishTime` is when the notification was sent [SQSWF][OCS].
- `TimeOfOrderChange` is the time of the change, and may be null [OCS].

**Retries and retention**
- Amazon's retries and retention when its `SendMessage` to your queue fails (wrong policy, KMS denial, queue deleted) are **UNKNOWN**. Nothing documented.
- SQS retention defaults to 4 days and can be set from 60 seconds to 14 days [AWS-SQSQ].
- EventBridge destinations:
  - If the partner event source is not associated with a bus, events are "immediately dropped" [AWS-SAAS].
  - Once ingested, delivery to rule targets follows the target retry policy (default 24 hours / 185 attempts) and the DLQ [AWS-RETRY][AWS-DLQ].
  - Whether SP-API partner events are "durable" or "best effort" is UNKNOWN.

**Amazon's advice.** "Build a backup mechanism" to retrieve the data in case of outage or delay [NAPI].

**Signing and authentication**
- No signature or verification mechanism is documented for SP-API notifications on [NTV], [SQSWF] or [EBWF]. Treat signing as UNKNOWN; it is not documented.
- Authenticity rests on AWS resource controls:
  - The SQS queue policy only lets principal `437568002678` write [SQSPERM].
  - On a partner event bus, "only the partner account … is permitted to send events" [AWS-SAAS].
- An HTTPS receiver on GCP therefore only authenticates the AWS-side forwarder. It can cross-check `ApplicationId` and `SubscriptionId` [OCS] against known values.

**Recommended idempotency handling** (my recommendation, not from the docs)
- Deduplicate on `NotificationId`.
- Treat each notification as a hint, and re-read the order's current state.
- Use `TimeOfOrderChange` or `EventTime` to discard stale, out-of-order updates.

## 5. EventBridge destination mechanics

**Setup**
1. Call `createDestination` with `eventBridge{accountId, region}` [NM][EBWF]. The response's `resource.eventBridge.name` is the partner event source name [NM].
2. The partner event source appears in that account and region with the name `aws.partner/sellingpartnerapi.amazon.com/{AWS Account Id}/{Application Id}` [EBWF].
3. Manually associate it: console, Partner event sources, choose **Associate with event bus** [EBWF]. Alternatively, run `create-event-bus` with `--name` and `--event-source-name` both set to the source name, or use CloudFormation `AWS::Events::EventBus` with `EventSourceName` [AWS-SAAS].
   - Before association the source is Pending; after, it is Active [AWS-SAAS].
   - `put-permission` and `EventBusPolicy` on a partner bus return errors [AWS-SAAS].
   - Partner buses are "Custom Event Bus - Classic" [AWS-SAAS].
4. Create a rule with this pattern [EBWF]:
   `{"source":[{"prefix":"aws.partner/sellingpartnerapi.amazon.com"}],"detail-type":["<NOTIFICATION_TYPE>"]}`

**Event envelope**
- The generic EventBridge fields are `version`, `id`, `detail-type`, `source`, `account`, `time`, `region`, `resources`, `detail` [AWS-EVS].
- SP-API sets `detail-type` to the notification type name [EBWF].
- **No SP-API page shows a full envelope.** Whether `detail` is the whole notification (including `NotificationMetadata`) or only `Payload` is UNKNOWN.

**Limits**
- One EventBridge destination per AWS account [EBWF].
- 300 rules per bus in most regions (100 in af-south-1 and eu-south-1) [AWS-Q].
- 5 targets per rule, not adjustable [AWS-Q].
- Event pattern size: 2,048 characters [AWS-Q].
- Which regions SP-API accepts in `region` (for example, sa-east-1) is UNKNOWN. The model only points to the EventBridge endpoints list [NM `EventBridgeResource.region`].
- Partner event ingestion costs $1.00 per million [EB-$].

## 6. AWS EventBridge API destinations

**Authorization types**
- `BASIC`, `OAUTH_CLIENT_CREDENTIALS`, `API_KEY` [AWS-UC].
- `ApiKeyName` and `ApiKeyValue` are each 1–512 characters, with no control characters [AWS-KEY].
- For Basic and API Key, EventBridge "populates the required authorization headers" [AWS-AUTH].
- You can add header, query or body parameters marked `IsValueSecret` [AWS-UC].
- OAuth tokens are refreshed on a 401 or 407 response, or during an invocation if the token expires within 60 seconds. There is no background refresh [AWS-AUTH].

**Where the secret is stored**
- EventBridge creates the secret in AWS Secrets Manager through the service-linked role `AmazonEventBridgeApiDestinationsServiceRolePolicy` [AWS-APID][AWS-CONN].
- It is encrypted with an AWS-owned KMS key by default, or a customer managed key [AWS-CC].
- Secrets Manager costs are included in the API destination charge [AWS-AUTH].

**Rotation**
- Rotate through `UpdateConnection` or the console. Changing the authorization parameters re-authorizes the connection [AWS-CE][AWS-UC].
- Connection states are `AUTHORIZED` and `DEAUTHORIZED` (public APIs) [AWS-CS].
- EventBridge emits events on connection state changes [AWS-CS].
- UNKNOWN: whether native Secrets Manager rotation can be attached to the EventBridge-managed secret.
- The connection holds one value at a time. For zero-downtime rotation the receiver should accept both the old and new key during the overlap (my recommendation).

**Invocation rate**
- `InvocationRateLimitPerSecond` is optional, minimum 1 [AWS-CAD].
- Account quota: 300 per second per API destination per region, adjustable [AWS-Q].
- Excess invocations are delayed, not dropped. A backlog can exceed the 24-hour retry window, so configure a DLQ [AWS-APID].

**Timeout**
- 5 seconds; requests that take longer time out and are retried under the retry policy [AWS-APID].
- Do not confuse this with [AWS-Q]'s "InvocationTimeoutSeconds 1–30, default 30". That figure belongs to the new **Custom Event Bus** (EventsV2) subscribers, not to Classic rules.

**Retry policy**
- Defaults are 24 hours and 185 attempts, with exponential backoff and jitter [AWS-APID][AWS-RETRY].
- `MaximumEventAgeInSeconds` ranges 60–86,400; `MaximumRetryAttempts` ranges 0–185 [AWS-RP].

**Which status codes are retried**
- Retried: 401, 407, 409, 429 and 5xx.
- Not retried: 1xx, 2xx, 3xx and all other 4xx.
- The `Retry-After` header is honoured; a negative value stops retries [AWS-APID].
- Permission errors, missing resources and DNS failures skip retries and go straight to the DLQ [AWS-DLQ].

**Dead-letter queue** [AWS-DLQ]
- Must be a standard SQS queue (not FIFO) in the same region as the rule.
- Each message carries the attributes `RULE_ARN`, `TARGET_ARN`, `ERROR_CODE`, `ERROR_MESSAGE`, `EXHAUSTED_RETRY_CONDITION` and `RETRY_ATTEMPTS`.
- Related metrics: `InvocationsSentToDlq` and `InvocationsFailedToBeSentToDlq`.

**Input transformers**
- Up to 100 variables, with predefined variables such as `aws.events.event.json` and `aws.events.event.ingestion-time` [AWS-IT].

**Request headers EventBridge sends** [AWS-APID]
- `User-Agent: Amazon/EventBridge/ApiDestinations` (cannot be overridden).
- Default `Content-Type: application/json; charset=utf-8`.
- No mTLS; the endpoint must be HTTPS.
- Available in South America (São Paulo), among other regions.

**Partner bus → API destination**
- Partner buses are Classic buses [AWS-SAAS], and Classic rules can target API destinations [AWS-TGT]. No restriction for partner buses is documented.
- SP-API docs never show this combination, and it does not help `ORDER_CHANGE`, which cannot reach EventBridge directly.

**Pricing**
- $0.20 per million invocations; each 64 KB of payload is billed as one; data transfer is billed separately [EB-$].

**Observability**
- CloudWatch `AWS/Events` metrics, including `Invocations`, `FailedInvocations`, `RetryInvocationAttempts`, `SuccessfulInvocationAttempts`, `IngestionToInvocationSuccessLatency` and `ThrottledRules`. Metrics are best-effort [AWS-MON].
- Event bus logs can go to CloudWatch Logs, Firehose or S3, and cover partner events. Levels are OFF (default), ERROR, INFO and TRACE. Logging is best-effort [AWS-LOGS].

## 7. EventBridge Pipes (SQS source → API destination)

**Feasibility.** Yes. SQS (standard or FIFO) is a supported source [AWS-PSQS], and an API destination is a supported target [AWS-PTGT]. This is the no-code route for SQS-only types such as `ORDER_CHANGE`.

**Request shaping**
- API destination targets must use an `InputTemplate` [AWS-PTGT].
- A JSON SQS body is parsed implicitly, so you can reference fields like `<$.body.NotificationMetadata.NotificationId>`, or pass the whole event with `<aws.pipes.event.json>` [AWS-PIT].
- A JSON path that doesn't exist becomes an empty string [AWS-PIT].
- API destinations are **not** in the batchable-target list, so the pipe cannot batch at the source and makes one invocation per message [AWS-PBATCH].

**Polling behaviour** [AWS-PSQS]
- Up to 10 messages per batch by default; long polling.
- Optional batch window up to 5 minutes. With a batch window and low traffic, the pipe may wait about 20 seconds.
- Set the queue's visibility timeout to at least 6 times the target runtime.

**Retries** [AWS-PERR][AWS-PSQS]
- Pipe internal errors are retried indefinitely until the message expires from the queue. They do not count toward `maxReceiveCount`.
- Target errors from the API destination are retried up to the source queue's `maxReceiveCount`, then go to the **source queue's** DLQ. Configure the DLQ on the source queue, not on the pipe.
- "Nearly continuous 4xx errors" can **auto-disable the pipe** [AWS-PERR].
- The 5-second API destination timeout applies to pipes as well; for pipes, retries follow the source's settings [AWS-APID].

**Limits** [AWS-Q]
- 1,000 pipes per account.
- 1,000 concurrent executions in most regions, including São Paulo; 3,000 in us-east-1, us-west-2 and eu-west-1.
- Payload up to 6 MB, or the target's own limit if smaller [AWS-PTGT].

**Pricing**
- $0.40 per million requests after filtering; each 64 KB is billed as one request [EB-$].
- UNKNOWN: whether the $0.20 per million API destination charge is also billed when the API destination is a pipe target.

**Logs.** Pipe logs can go to CloudWatch Logs, Firehose or S3 [AWS-PLOG].

## 8. Transport comparison for ~hundreds to a few thousand ORDER_CHANGE events per day (about 90,000 per month)

`ORDER_CHANGE` is SQS-only (section 2), so options (a) and (b) need an SQS hop first:
- **(a′)** SQS destination → Lambda (SQS event source mapping, as mentioned in [MFN]) → POST to the receiver.
- **(b′)** SQS destination → EventBridge Pipe → API destination. Routing SQS → Pipe → event bus → rule → API destination is also possible, but adds nothing.
- **(c)** SQS destination plus a scheduled poller on Google Cloud.

| | (a′) SQS → Lambda | (b′) SQS → Pipe → API destination | (c) GCP poller |
|---|---|---|---|
| Code and infrastructure you own | Lambda code and runtime, IAM role, event source mapping | Queue, pipe, connection, API destination (infrastructure as code only) | Poller code, Cloud Scheduler job, AWS credentials. GCP pieces not researched. |
| Where the shared secret lives and how it rotates | Your choice (Lambda configuration or Secrets Manager); your own rotation code | EventBridge-managed Secrets Manager secret [AWS-APID]; rotate with `UpdateConnection` [AWS-UC], receiver accepts two keys during overlap | No inbound secret. AWS access key in GCP Secret Manager, or better, OIDC federation, which AWS recommends over long-term keys outside AWS [AWS-OIDC]. Whether Google tokens work for this is unverified. |
| Retry and DLQ | SQS redrive and DLQ. Lambda retry details not researched. | SQS `maxReceiveCount` then source-queue DLQ; internal errors retried until expiry [AWS-PERR] | Message reappears after visibility timeout; SQS redrive and DLQ; you control the backoff |
| Observability | Lambda logs (not researched) | Pipe logs [AWS-PLOG], CloudWatch metrics | Your own GCP logs; queue depth visible in AWS |
| Failure modes | Code bugs, deploy drift | 5-second timeout [AWS-APID]; **auto-disable on sustained 4xx** [AWS-PERR]; public endpoint protected only by a static key | Delay equals the polling interval; credential expiry; the poller must delete messages correctly |
| Estimated cost at ~90k/month | About $0 (Lambda free tier of 1M requests [LAMBDA-$]; SQS free tier of 1M requests [SQS-$]). Whether the Lambda free tier is permanent is UNKNOWN. | About $0.04 for Pipes, plus possibly $0.02 for the API destination [EB-$]; SQS polling volume UNKNOWN | SQS cost about $0, since one receive per minute (≈43k) plus deletes stays under 1M free [SQS-$]. GCP cost not researched. |
| Changing the target URL at a project migration | Change Lambda configuration | One `UpdateApiDestination` call to set `InvocationEndpoint` [AWS-UAD] | Nothing changes on the AWS side; redeploy the poller and its credentials |

**Recommendation: (b′) SQS → Pipe → API destination (API_KEY connection), pointed at a receiver that responds 200 quickly and queues the work.**

Reasons:
- `ORDER_CHANGE` requires SQS anyway, and SQS gives a durable buffer of up to 14 days [AWS-SQSQ].
- There is no AWS code to own.
- The secret is managed by EventBridge and rotates with one call.
- Delivery is pushed with low latency.
- A project migration means updating one endpoint.

Settings to use:
- 14-day queue retention.
- A source-queue DLQ with a generous `maxReceiveCount`.
- Pipe logging at ERROR.
- An alarm on DLQ depth and on the pipe state, to catch auto-disable.
- An Orders API reconciliation sweep, following Amazon's "build a backup mechanism" advice [NAPI].

Choose **(c)** instead if a public inbound endpoint or the 5-second timeout is unacceptable. Choose **(a′)** only if you need transformation logic on the AWS side.

## Open questions only a live call settles

1. **Does a second identical `ORDER_CHANGE` subscription (same payloadVersion and destination, no filter) return 409?**
   - Why it matters: it decides whether onboarding is idempotent and whether you can migrate without gaps.
   - Sandbox: no. The Notifications API sandbox is static [SBX].
2. **What is the exact EventBridge envelope and `detail` content for SP-API events?**
   - Why it matters: it shapes input templates and dedupe keys.
   - Sandbox: no, because the sandbox does not deliver to AWS.
3. **Does `ORDER_CHANGE` fire for BR MFN orders, at OrderLevel or OrderItemLevel, and does it fire for changes other than status changes?**
   - Why it matters: it shapes the parser and the polling backstop.
   - Sandbox: no. sendTestNotification is mock data only [NM].
4. **Does any Easy Ship or `EasyShipShipmentStatus` change produce a notification in Brazil?**
   - Why it matters: it decides whether label and shipment tracking can rely on notifications.
   - Sandbox: no.
5. **What does Amazon do when `SendMessage` to the queue fails, and for how long?**
   - Why it matters: this is the data-loss window during a KMS or policy misconfiguration.
   - Sandbox: no.
6. **Does a duplicate delivered by Amazon (not by SQS) keep the same `NotificationId`?**
   - Why it matters: dedupe correctness.
   - Sandbox: no.
7. **Is `EventTime` the change time or the publish time?** The docs and schema disagree (section 4).
   - Why it matters: stale-update ordering logic.
   - Sandbox: no.
8. **Which roles and authorization does `getSubscriptions` require, and is it grantless?**
   - Why it matters: the onboarding audit flow.
   - Sandbox: possibly. A static sandbox call would show whether a grantless token is accepted.
9. **Does a pipe treat a persistently failing API destination (repeated 401 after a rotation mistake) as grounds for auto-disable?**
   - Why it matters: silent stoppage.
   - Sandbox: no. It needs an AWS test outside SP-API.
10. **Is the API destination's $0.20 per million charged in addition to Pipes, and how many SQS requests does the pipe's polling consume?**
    - Why it matters: cost (small either way).
    - Sandbox: no; check AWS billing.
11. **Can SP-API create an EventBridge destination in sa-east-1?**
    - Why it matters: only for the 7 EventBridge types, for data residency.
    - Sandbox: no.
12. **What is the payload of `APPLICATION_OAUTH_CLIENT_NEW_SECRET` (or whatever the actual new-secret message is called)?**
    - Why it matters: automating secret rotation.
    - Sandbox: no. Rotation cannot be called from sandbox apps [ROT].
