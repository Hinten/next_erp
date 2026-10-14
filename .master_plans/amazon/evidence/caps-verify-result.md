# Caps-row verification (adversarial)

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Method: the planner proposed a value for each MarketplaceCapabilities field; six independent skeptics, one per cluster of fields, were told to REFUTE each value from the official documentation and to default to "corrected" or "unsettled" on weak evidence. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

**Tally:** 21 held, 4 corrected, 1 unsettled (one entry per field; the estoque members count separately). "Corrected" with an unchanged value means the evidence or wording was fixed; see each entry.

## Cluster: auth-push

### `auth`: HOLDS → `oauth2`

**Proposed:** oauth2

**Row comment:**

```ts
// LWA OAuth2: POST https://api.amazon.com/auth/o2/token grant_type=refresh_token → 1 h access token (connecting-to-the-selling-partner-api).
// Private app = self-authorization by the Seller Central Primary User, no redirect (self-authorization). Rotate the LWA client_secret every 180 days (changelog).
```

**Reasoning:** Every part of the claim checks out against the docs I fetched. The token endpoint is POST https://api.amazon.com/auth/o2/token with grant_type=refresh_token, and the access token lasts one hour. A private app gets its initial authorization by self-authorization in Seller Central or the Solution Provider Portal, and the self-authorization page describes no redirect. 'oauth2' is right rather than 'token-longo': every call still needs a fresh 1 h access token from the refresh token, and the docs call the public flow 'OAuth 2.0 through Login with Amazon'.

Three small corrections to the planner's wording:
(a) Public apps can use the Website workflow OR the Selling Partner Appstore workflow, not only the website one.
(b) Self-authorization of a Seller Central account must be done by that account's Primary User, which matters if the ERP vendor is not the seller.
(c) The LWA client_secret must be rotated every 180 days or the app loses SP-API access. The integration needs to handle this.

Grantless calls (createDestination, getDestinations) need a client_credentials token with a scope instead of a refresh token. The exact scope string is not on the grantless-operations page: UNKNOWN from what I read.

Refresh-token lifetime: UNKNOWN. The auth pages do not state one; they only say private apps reauthorize when roles are added and public apps reauthorize annually.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/connecting-to-the-selling-partner-api (Step 1: POST https://api.amazon.com/auth/o2/token; grant_type 'refresh_token' | 'client_credentials'; 'An LWA access token expires one hour after it is issued'; example expires_in 3600; 'If you include refresh_token, do not include scope')
- https://developer-docs.amazon/sp-api/docs/authorizing-selling-partner-api-applications (public apps: 'OAuth 2.0 through Login with Amazon (LWA)', Website or Appstore workflow, 'Reauthorization is required annually'; private apps: self-authorization through Seller Central / Vendor Central / Solution Provider Portal, 'Reauthorization is required when you add new roles')
- https://developer-docs.amazon/sp-api/docs/self-authorization ('Authorize app' per selling-partner account on the Authorize application page; no redirect/callback described; 'To self-authorize a Seller Central account, you must be the Primary User of that account'; 'Generating a new refresh token doesn't invalidate previous refresh tokens')
- https://developer-docs.amazon/sp-api/docs/website-authorization-workflow (code exchange: grant_type=authorization_code, code=spapi_oauth_code, redirect_uri, client_id, client_secret; expires_in 'typically 3600')
- https://developer-docs.amazon/sp-api/changelog/important-you-must-rotate-your-login-with-amazon-lwa-credentials-client-secrets-for-all-applications-every-180-days ('rotate ... client secrets ... every 180 days'; otherwise the app 'will lose access to SP-API')

### `pkce`: HOLDS → `nao`

**Proposed:** nao

**Row comment:**

```ts
// No code_challenge/code_verifier in the SP-API consent URI or code exchange (website-authorization-workflow); self-authorization has no authorize hop.
// LWA's generic /ap/oa PKCE (login-with-amazon/authorization-code-grant) is a different flow.
```

**Reasoning:** The docs support the absence. The SP-API website authorization workflow lists its parameters in full tables for each hop: the authorization URI (application_id, state, version), the redirect (state, selling_partner_id, spapi_oauth_code) and the code exchange (grant_type, code, redirect_uri, client_id, client_secret). None of them is code_challenge or code_verifier, and the exchange authenticates with client_secret. Self-authorization, the path a private seller app uses, has no authorization request at all, so there is nowhere to send a code_challenge.

Adversarial check: plain Login with Amazon does support PKCE on https://www.amazon.com/ap/oa (marked RECOMMENDED). A future author could see that and assume SP-API supports it too. They are different flows: SP-API's consent URI takes only application_id/state/version.

Whether the LWA token endpoint would quietly accept a code_verifier for an spapi_oauth_code is UNKNOWN, but it does not matter, because no code_challenge can be sent on the consent URI. The evidence standard matches the Shopee precedent ('no code_challenge anywhere in guide 20').

**Citations:**
- https://developer-docs.amazon/sp-api/docs/website-authorization-workflow (authorization URI params: application_id, state, version[=beta for Draft apps]; redirect params: state, selling_partner_id, spapi_oauth_code; code exchange: grant_type, code, redirect_uri, client_id, client_secret. No code_challenge / code_verifier / S256 anywhere)
- https://developer-docs.amazon/sp-api/docs/self-authorization (no authorize request or redirect at all; no PKCE mentioned)
- https://developer-docs.amazon/sp-api/docs/authorizing-selling-partner-api-applications (no PKCE / code_challenge mentioned)
- https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html (CONTRAST: the generic LWA endpoint https://www.amazon.com/ap/oa lists code_challenge / code_challenge_method / code_verifier as 'RECOMMENDED'. That is not the SP-API consent flow)

### `notificacoes`: HOLDS → `push`

**Proposed:** push

**Row comment:**

```ts
// Push into OUR AWS only: destinations are sqs | eventBridge (notifications.json #/definitions/DestinationResourceSpecification). No HTTPS webhook.
// ORDER_CHANGE = SQS workflow (notification-type-values); Amazon recommends a fallback fetch for outages (notifications-api-v1-use-case-guide).
```

**Reasoning:** Amazon does push events: it writes notifications into an SQS standard queue or an EventBridge partner event source in the developer's AWS account. The model has exactly two destination resource types, sqs and eventBridge, and no HTTPS/webhook type, so 'no HTTPS webhook' is confirmed. ORDER_CHANGE is listed under the SQS workflow, and the EventBridge page says every type outside its list of 7 must use SQS, so 'ORDER_CHANGE is SQS-only' is confirmed.

Caveats for the plan:
(1) On the SQS path, someone on our side still has to read the queue: the ERP calls ReceiveMessage, or a relay (a Pipe or Lambda) does.
(2) Amazon itself recommends a fallback way to fetch data when delivery is delayed or down, so a polling backstop is required, as with Loja Integrada.
(3) FIFO queues are not supported, so the queue gives no ordering guarantee.
(4) One EventBridge destination per AWS account.

Duplicate-delivery semantics: UNKNOWN. I could not find an SP-API page that states them. Dedup on NotificationMetadata.NotificationId anyway (the field is in the schemas).

**Citations:**
- selling-partner-api-models models/notifications-api-model/notifications.json #/definitions/DestinationResourceSpecification (properties only 'sqs' and 'eventBridge': 'Applications should use one resource type (sqs or eventBridge) per destination') and #/definitions/DestinationResource (sqs | eventBridge). No HTTPS/webhook resource type
- https://developer-docs.amazon/sp-api/docs/notifications-api-v1-use-case-guide (two workflows: EventBridge and SQS; 'we recommend that you have a means to retrieve needed information in the event of an unexpected outage or delay in notification delivery'; createDestination/getDestinations are grantless)
- https://developer-docs.amazon/sp-api/docs/notification-type-values (ORDER_CHANGE, ITEM_INVENTORY_EVENT_CHANGE, REPORT_PROCESSING_FINISHED, FEED_PROCESSING_FINISHED, PRICING_HEALTH → 'Amazon Simple Queue Service workflow'; LISTINGS_ITEM_STATUS_CHANGE / LISTINGS_ITEM_ISSUES_CHANGE / LISTINGS_ITEM_MFN_QUANTITY_CHANGE → 'Amazon EventBridge workflow')
- https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-eventbridge (only 7 EventBridge types: BRANDED_ITEM_CONTENT_CHANGE, ITEM_PRODUCT_TYPE_CHANGE, LISTINGS_ITEM_STATUS_CHANGE, LISTINGS_ITEM_ISSUES_CHANGE, LISTINGS_ITEM_MFN_QUANTITY_CHANGE, PRODUCT_TYPE_DEFINITIONS_CHANGE, SHIPMENT_TRACKING_MILESTONE_CHANGED; every other type uses SQS; 'You can only create one EventBridge destination per AWS account')
- https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-sqs ('Selling Partner API does not support delivery to FIFO queues. You must use Amazon SQS standard queues')

### `assinaWebhook`: CORRECTED → `sim`

**Proposed:** sim

**Row comment:**

```ts
// ⚠️ NOT SIGNED (no signature in notifications.json / schemas NotificationMetadata). Authenticated by AWS IAM: SP-API (437568002678, tutorial-grant-permission-to-sqs-queue) writes to OUR queue/partner bus;
// OUR EventBridge Connection (API_KEY, eb-target-connection-auth) adds the header: constant-time compare, fail CLOSED, and require NotificationMetadata.ApplicationId === our app.
// ORDER_CHANGE is SQS-only → relay via EventBridge Pipe (SQS → API destination) or Lambda; 5 s timeout (eb-api-destinations).
```

**Reasoning:** The value 'sim' survives, but two of the planner's three supporting claims are inaccurate or incomplete, so the row comment must change.

1. 'Amazon documents no signature' is CONFIRMED. The notifications model and the per-type notification schemas have no signature, HMAC or token field; NotificationMetadata holds only ApplicationId, SubscriptionId, PublishTime and NotificationId. Neither setup page mentions signing.

2. 'SQS writes are restricted to 437568002678' is WRONG as stated.
- The documented queue policy ALLOWS 437568002678 to call SendMessage and GetQueueAttributes, with no Condition, and the console version uses Resource '*'. It does not make that principal the only writer: identities in our own AWS account with an IAM SendMessage permission can also write.
- 437568002678 is described as 'the SP-API account ID', i.e. shared by all SP-API applications, not specific to ours.
- The docs do not say whether createDestination checks that the caller owns the queue ARN (UNKNOWN). So the trustworthy statement is narrower: 'this message was written by SP-API (or by our own account)', not 'this message is for our app'.
- Therefore the receiver must also require NotificationMetadata.ApplicationId to equal our app id (and the SubscriptionId to be one of ours), and keep the queue's IAM writers minimal.
- The EventBridge path is scoped more tightly: the partner event source name contains our AWS account id and our Application Id.

3. 'An EventBridge Connection with API_KEY adds a header the receiver can check' is CONFIRMED for event-bus rules → API destination. It is INCOMPLETE for ORDER_CHANGE: that type goes only to SQS, and an event-bus rule cannot read from SQS. The relay for it must be an EventBridge Pipe (SQS source → API destination target, both documented) or a Lambda. Pipe retries depend on the source (SQS visibility timeout or redrive), not the 24 h / 185 attempts default for buses. In every case the endpoint must respond within 5 s.

Why 'sim' and not 'nao': the type doc asks whether the receiver can authenticate a notification, and it can. Amazon's write is IAM-authenticated into a resource we own, and the last hop carries a static secret we chose. A 'nao' would push the next author toward Mercado Livre's fail-open posture, which is unnecessary here.

The mechanism is neither of the two the type doc lists:
- Amazon does not sign the body (unlike Shopee).
- Amazon does not echo a secret (unlike Loja Integrada); our own EventBridge Connection injects it.

The row comment therefore has to say 'AUTHENTICATED BY AWS IAM + OUR RELAY'S API KEY, NOT SIGNED BY AMAZON'. Otherwise someone may write an HMAC verifier, or treat the API key as proof the event came from Amazon.

If the ERP instead polls SQS directly with its own IAM credentials, there is no HTTP receiver and authenticity comes purely from IAM. The value is 'sim' either way.

**Citations:**
- selling-partner-api-models models/notifications-api-model/notifications.json (no signature field in any definition; 'Invalid Signature' appears only in a 403 response description, about request auth)
- selling-partner-api-models schemas/notifications/OrderChangeNotification.json #/properties/NotificationMetadata (ApplicationId, SubscriptionId, PublishTime, NotificationId. No signature/HMAC/token); same in schemas/notifications/ListingsItemStatusChangeNotification.json
- https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-sqs and .../set-up-notifications-with-amazon-eventbridge (no mention of message signing or verifying authenticity)
- https://developer-docs.amazon/sp-api/docs/tutorial-grant-permission-to-sqs-queue (principal 'arn:aws:iam::437568002678:root' / CloudFormation AWS: '437568002678'; Actions sqs:SendMessage + sqs:GetQueueAttributes; console JSON Resource '*'; NO Condition block)
- https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-eventbridge (partner event source 'aws.partner/sellingpartnerapi.amazon.com/{AWS Account Id}/{Application Id}')
- https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-overview-of-managing-access.html (IAM identity-based policies in the owning account can also grant queue access, so a queue policy is an extra allow, not an exclusive whitelist)
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-target-connection-auth.html ('For Basic and API Key authorization, EventBridge populates the required authorization headers for you'; the credential is stored as a Secrets Manager secret)
- https://docs.aws.amazon.com/eventbridge/latest/APIReference/API_CreateConnectionApiKeyAuthRequestParameters.html (ApiKeyName / ApiKeyValue, both required)
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-api-destinations.html (HTTPS endpoint target; 5-second client execution timeout; event-bus retries default 24 h / 185 times; retries on 401/407/409/429/5xx)
- https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-event-source.html (Amazon SQS queue is a Pipes source) and https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-pipes-event-target.html (API destination is a Pipes target)

## Cluster: catalogue

### `publicarAnuncio`: HOLDS → `sim`

**Proposed:** sim

**Row comment:**

```ts
// sim: putListingsItem (listingsItems_2021-08-01.json paths./items/{sellerId}/{sku}.put), payload = PTD JSON schema (docs/create-a-listing).
// Async: status ACCEPTED = 'accepted for processing' (definitions.ListingsItemSubmissionResponse.status); dry-run via mode=VALIDATION_PREVIEW.
```

**Reasoning:** putListingsItem exists in the 2021-08-01 model and the create-a-listing tutorial says the payload must follow the Product Type Definitions schema, so publishing is supported. Brazil is in the NA region, where the API is offered. Two caveats belong in the plan. First, the response status ACCEPTED only means the submission was 'accepted for processing'. Final success or errors arrive later (asynchronously), so the ERP must not treat ACCEPTED as 'published'. Second, the docs describe client-side schema conformance plus an optional mode=VALIDATION_PREVIEW dry run. They do not say Amazon validates against the PTD schema synchronously at submit time beyond returning INVALID for invalid submissions.

**Citations:**
- models/listings-items-api-model/listingsItems_2021-08-01.json paths./listings/2021-08-01/items/{sellerId}/{sku}.put (operationId putListingsItem: "Creates a new or fully-updates an existing listings item for a selling partner.")
- models/listings-items-api-model/listingsItems_2021-08-01.json definitions.ListingsItemPutRequest.properties.productType / .requirements (enum LISTING, LISTING_PRODUCT_ONLY, LISTING_OFFER_ONLY)
- models/listings-items-api-model/listingsItems_2021-08-01.json definitions.ListingsItemSubmissionResponse.properties.status (ACCEPTED: "accepted for processing"; VALID only with mode=VALIDATION_PREVIEW)
- https://developer-docs.amazon/sp-api/docs/create-a-listing (payload follows the Product Type Definitions schema for seller/store/product type)
- https://developer-docs.amazon/sp-api/docs/product-type-definitions-api ("Amazon Product Type Definition JSON schemas extend JSON Schema 2019-09")
- https://developer-docs.amazon/sp-api/docs/marketplace-ids (Brazil A2Q3Y263D00KWC listed under 'North America and Brazil')
- https://developer-docs.amazon/sp-api/docs/listings-items-api (operations available in NA, EU, FE)

### `importarAnuncio`: HOLDS → `sim`

**Proposed:** sim

**Row comment:**

```ts
// sim: getListingsItem/searchListingsItems (listingsItems_2021-08-01.json); search capped at 1000 SKUs (definitions.ItemSearchResults.numberOfResults).
// Full sync: GET_MERCHANT_LISTINGS_ALL_DATA (docs/report-type-values-inventory, request-only); BR availability and parent rows UNKNOWN.
```

**Reasoning:** Confirmed. getListingsItem and searchListingsItems are in the model. The 1,000-SKU ceiling is stated both in the model (ItemSearchResults.numberOfResults) and in the search tutorial, and pageSize is capped at 20. GET_MERCHANT_LISTINGS_ALL_DATA is documented as 'a detailed all listings report' and can only be requested on demand, not scheduled. A full import above 1,000 SKUs therefore needs the report, followed by a getListingsItem call per SKU. Three points are UNKNOWN from the report-type page: whether this report is available on the BR marketplace (no per-marketplace availability is given), its column layout, and whether it includes non-buyable variation parents.

**Citations:**
- models/listings-items-api-model/listingsItems_2021-08-01.json paths./listings/2021-08-01/items/{sellerId}.get (searchListingsItems) and paths./listings/2021-08-01/items/{sellerId}/{sku}.get (getListingsItem)
- models/listings-items-api-model/listingsItems_2021-08-01.json definitions.ItemSearchResults.properties.numberOfResults.description ("The maximum number of items (SKUs) that can be returned and paged through is 1000.")
- models/listings-items-api-model/listingsItems_2021-08-01.json searchListingsItems parameter pageSize (max 20, default 10)
- https://developer-docs.amazon/sp-api/docs/search-for-listings-items-by-id (results 'limited to 1,000'; packageHierarchySku families >20 SKUs return only first 20)
- https://developer-docs.amazon/sp-api/docs/report-type-values-inventory (GET_MERCHANT_LISTINGS_ALL_DATA: 'A detailed all listings report'; 'This report can only be requested'; only the first marketplaceId is accepted)

### `variacoes`: HOLDS → `sim`

**Proposed:** sim

**Row comment:**

```ts
// sim: parentage_level + child_parent_sku_relationship + variation_theme; parent is non-buyable (docs/building-listings-management-workflows-guide).
// Themes are product-type/marketplace specific; read them from the PTD schema (themes pruned 2025, see changelog).
```

**Reasoning:** Confirmed verbatim in the Building Listings Management Workflows guide, including the exact attribute names and the statement that the parent is non-buyable. The guide also says that removing a relationship means deleting the parent or child listing. searchListingsItems can list a family's children with variationParentSku. The allowed variation_theme values depend on the product type and marketplace, and Amazon removed unused themes in late 2025. Valid themes for BR must therefore be read at runtime from the Product Type Definitions schema, not hard-coded.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/building-listings-management-workflows-guide (variation families: parent parentage_level=parent, child_parent_sku_relationship.child_relationship_type=variation, variation_theme.name; 'The parent listing is a non-buyable entity used to relate child products.'; 'A parent listing must not be a buyable product.'; children carry parentage_level=child and same variation_theme)
- https://developer-docs.amazon/sp-api/docs/manage-product-listings-guide (PTD 'variations' property group: parentage_level, child_parent_sku_relationship, variation_theme)
- models/listings-items-api-model/listingsItems_2021-08-01.json searchListingsItems parameter variationParentSku
- https://developer-docs.amazon/sp-api/changelog/upcoming-removal-of-unused-variation-themes-in-the-listings-items-api (unused themes removed Sep 15 - Nov 30, 2025)

### `categoriasEAtributos`: HOLDS → `sim`

**Proposed:** sim

**Row comment:**

```ts
// sim: Product Type Definitions v2020-09-01 (definitionsProductTypes_2020-09-01.json getDefinitionsProductType), JSON Schema 2019-09.
// locale enum includes pt_BR (paths./productTypes/{productType}.get.parameters[6]); browse nodes via PTD recommendations.
```

**Reasoning:** Confirmed in the model. getDefinitionsProductType returns a link to a JSON schema of attributes and requirements, and its locale enum contains pt_BR. searchDefinitionsProductTypes finds product types; its locale parameter has no enum and defaults to the marketplace's primary locale. One nuance: Amazon's 'category' axis is the product type plus browse nodes, not a single tree. Browse-node recommendations are a separate PTD use case. The schema itself is reached through a link in the response, so the actual attribute set for BR can only be confirmed with a live call, which this review did not make.

**Citations:**
- models/product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json paths./definitions/2020-09-01/productTypes/{productType}.get.parameters[6] (locale; enum includes "pt_BR" = 'Portuguese (Brazil)')
- models/product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json paths./definitions/2020-09-01/productTypes/{productType}.get.parameters[4] (requirements enum LISTING, LISTING_PRODUCT_ONLY, LISTING_OFFER_ONLY)
- models/product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json definitions.ProductTypeDefinition.properties.schema / .metaSchema
- models/product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json paths./definitions/2020-09-01/productTypes.get (searchDefinitionsProductTypes; locale has no enum, 'Defaults to primary locale of the marketplace')
- https://developer-docs.amazon/sp-api/docs/product-type-definitions-api (JSON schemas extend JSON Schema 2019-09; use cases incl. get-recommended-browse-nodes-or-item-type-keywords)

### `tabelaDeMedidas`: HOLDS → `nao`

**Proposed:** nao

**Row comment:**

```ts
// nao: no size-chart API in models/ or docs/sp-api-models; media limited to MAIN/PT01-08/SWCH (docs/submit-media).
// Sizes are per-listing PTD attributes only (docs/listings-items-guidance-for-complex-attributes; size_map in manage-product-listings-guide).
```

**Reasoning:** No API in the models repo or the docs index manages size charts. The only size-related surfaces are per-listing attributes: apparel size attributes in the complex-attributes guidance, and a 'size_map' attribute in the product_details group of the PTD example. None of these is a reusable chart resource. The media tutorial says only MAIN, PT01-PT08 and SWCH image slots can be submitted programmatically, which rules out a size-chart image slot through the API. Third-party sources (not official SP-API docs) describe size charts as a Seller Central / Brand Registry UI tool. Residual risk: product-type schemas are only reachable through live calls, so a marketplace-specific attribute cannot be fully excluded. This does not affect the absence of a size-chart resource.

**Citations:**
- https://github.com/amzn/selling-partner-api-models/tree/main/models (55 model directories; none is a size-chart API)
- https://developer-docs.amazon/sp-api/docs/sp-api-models (API index; no size-chart API)
- https://developer-docs.amazon/sp-api/docs/submit-media (only MAIN, PT01-PT08, SWCH image variants; 'Only the preceding variants can be submitted programmatically.')
- https://developer-docs.amazon/sp-api/docs/listings-items-guidance-for-complex-attributes (apparel size attributes per product type; no size-chart resource; links out to Seller Central 'Apparel size standards')
- https://developer-docs.amazon/sp-api/docs/manage-product-listings-guide (product_details group lists size and size_map attributes; no size-chart guidance)

### `kitVirtual`: HOLDS → `nao`

**Proposed:** nao

**Row comment:**

```ts
// nao: no bundle/kit resource in models/ or docs/sp-api-models; listingsItems_2021-08-01.json has no 'bundle'/'kit'.
// package_contains_sku = unit/case/pallet packs (building-listings-management-workflows-guide), US/EU/JP only (changelog 2023-09).
```

**Reasoning:** Evidence of absence holds. No model directory, no entry in the docs API index, and no term in the Listings Items model refers to bundles, kits or virtual bundles. The only multi-SKU relationship besides variations is package hierarchy. It links units, case packs and pallets of one product, each level needs its own external identifier, and per the September 2023 announcement it is offered in US, EU and JP, not BR. Nothing documents Amazon deriving one SKU's stock from its components. Amazon's Seller Central 'Virtual Bundles' tool appears only in third-party sources, which describe it as UI-only. It is not an SP-API capability and its BR availability is UNKNOWN.

**Citations:**
- https://github.com/amzn/selling-partner-api-models/tree/main/models (55 model directories; none bundle/kit-related)
- https://developer-docs.amazon/sp-api/docs/sp-api-models (full API index across both page halves; no bundle/kit API)
- models/listings-items-api-model/listingsItems_2021-08-01.json (no occurrence of 'bundle', 'kit' or 'virtual' in the whole file)
- https://developer-docs.amazon/sp-api/docs/building-listings-management-workflows-guide (relationships are only variation families and package hierarchies; package hierarchy = units/cases/pallets, 'Each item in the package hierarchy must contain a unique external product identifier')
- https://developer-docs.amazon/sp-api/changelog/september-2023-sp-api-release-announcement (package hierarchy 'available in US, EU, and JP'; Brazil not listed)

### `pausarAnuncio`: HOLDS → `sim`

**Proposed:** sim

**Row comment:**

```ts
// sim: close = end_at in past ('soft-close', docs/manage-purchasable-offer) or qty 0; reopen = current offer + qty>0 / restock
// (docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management). end_at=null reopening is inferred, not stated.
```

**Reasoning:** The value holds, but one citation needs fixing. The proposed URL 'understanding-amazon-listing-status' returns 404; the real page is understanding-amazon-listing-status-and-seller-fulfilled-inventory-management. That page separates close/open from delete. Closing (removing the offer or moving the sale period into the past) makes a listing non-purchasable while it stays in inventory as inactive. Deleting removes it entirely. Reopening means adding a current offer with a price and a positive quantity, and restocking reactivates a zero-quantity listing. Weak spot: the docs never say verbatim that merging end_at to null reopens a soft-closed offer. That follows by inference from 'merge null deletes end_at' plus 'open = current offer'. Setting quantity 0, or moving end_at into the past and later forward again, are the more directly documented routes.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer (end_at: 'Stop selling date. Set to a past date to soft-close the offer.'; optional sub-attributes, including end_at, are deleted with op 'merge' set to null; our_price cannot be deleted; op 'delete' 'Cannot target sub-attributes within purchasable_offer')
- https://developer-docs.amazon/sp-api/docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management ('Closing a listing item means making it non-purchasable by customers' via 'removing the purchasable offer or changing the sale period of the current offer'; 'Opening a listing item means adding a current offer for it'; 'Reactivate your out of stock listing by updating its inventory levels'; zero-quantity listings are considered inactive; 'Deleting a listing completely removes it from the seller inventory')
- https://developer-docs.amazon/sp-api/docs/manage-product-listings-guide (LISTINGS_ITEM_STATUS_CHANGE is published when 'its buyability changes')

## Cluster: stock-price

### `estoque.suporte`: HOLDS → `sim`

**Proposed:** 'sim' — fulfillment_availability (fulfillment_channel_code DEFAULT = MFN, quantity, lead_time_to_ship_max_days) via patchListingsItem or JSON_LISTINGS_FEED

**Row comment:**

```ts
// fulfillment_availability [{fulfillment_channel_code:'DEFAULT' (=MFN), quantity, lead_time_to_ship_max_days}] via patchListingsItem op:'merge'
// (developer-docs.amazon/sp-api/docs/merge-a-listing; .../manage-amazon-haul-advanced-multiple-offer-multiple-fulfillment-use-cases). FBA (AMAZON_*) qty is Amazon's, never written.
```

**Reasoning:** I tried to refute this and could not. Amazon's own 'Merge a listing' guide shows a patchListingsItem merge on /attributes/fulfillment_availability that sets quantity for fulfillment_channel_code DEFAULT. The multiple-fulfillment guide defines DEFAULT as merchant-fulfilled (MFN) and shows lead_time_to_ship_max_days next to quantity. One caveat that does not apply here: the same guide says fulfillment_availability is not supported for Amazon Haul listings, and Haul is a US-store programme. The docs examples use the US marketplace and nothing shows a BR example, but nothing restricts DEFAULT quantity to the US either. Stock for FBA records (AMAZON_*) is Amazon-managed, and the docs' FBA example carries no seller quantity, so the ERP only writes DEFAULT.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/merge-a-listing (example body: op 'merge', path '/attributes/fulfillment_availability', value [{fulfillment_channel_code: 'DEFAULT', quantity: 20}]; comment: no change to restock_date / lead_time_to_ship_max_days if omitted)
- https://developer-docs.amazon/sp-api/docs/manage-amazon-haul-advanced-multiple-offer-multiple-fulfillment-use-cases (glossary: MFN = 'Merchant-fulfilled (DEFAULT)'; DEFAULT row: 'Provide quantity for standard fulfillment by a selling partner'; MFN example has quantity 10 and lead_time_to_ship_max_days 5; FBA example AMAZON_NA has no quantity)
- models/listings-items-api-model/listingsItems_2021-08-01.json paths./listings/2021-08-01/items/{sellerId}/{sku}.patch (patchListingsItem); definitions.PatchOperation.op enum add|replace|merge|delete
- https://developer-docs.amazon/sp-api/docs/building-listings-management-workflows-guide (JSON_LISTINGS_FEED is the bulk alternative)

### `estoque.protocolo`: HOLDS → `por-anuncio`

**Proposed:** 'por-anuncio' — patchListingsItem one synchronous call per SKU (5 rps, burst 5); JSON_LISTINGS_FEED exists (25,000 msgs, 5 feeds/5 min, report hours later); Amazon says <~1,500 items/5 min the Listings Items API is faster; ERP ≤ ~1,000 SKUs

**Row comment:**

```ts
// patchListingsItem: 1 SKU/call, 5 rps burst 5 per seller-app, no per-day cap (developer-docs.amazon/sp-api/docs/listings-items-api-rate-limits).
// JSON_LISTINGS_FEED (feed-assincrono, ≤25,000 msgs, 5 feeds/5 min, ≤8 h) exists but Amazon says the API is faster below 1,500 items/5 min
// (docs/building-listings-management-workflows-guide). ACCEPTED ≠ applied: watch LISTINGS_ITEM_ISSUES_CHANGE.
```

**Reasoning:** Both refutation conditions fail. (1) Amazon's guidance agrees with the planner: the Building Listings Management Workflows Guide says the Listings Items API is faster below 1,500 items in a five-minute period, and the Feeds FAQ recommends the feed only above 1,500 items. 1,000 SKUs at 5 rps takes about 200 s, well under that threshold. (2) The dedicated Listings Items API Rate Limits page (updated 2026-09-09) lists only per-second limits: 5/5 per account-application pair and 500 per application for patchListingsItem. It has no per-day or per-SKU cap. Fulfillment_availability and purchasable_offer are not in the separately throttled product-data or relationship classes; that page's product-data example is item_name. No multi-SKU synchronous write exists in the 2021-08-01 model, so 'lote' is ruled out. The feed is the 'feed-assincrono' alternative: 25,000 messages, 5 feeds per 5 minutes, processing up to eight hours. Correction to the planner's wording: 'report hours later' should read 'up to eight hours' (Feeds FAQ). Design caveat, which does not change the value: ACCEPTED means 'accepted for processing', not applied. Issues can surface later via LISTINGS_ITEM_ISSUES_CHANGE or getListingsItem?includedData=issues, so the per-listing task must treat ACCEPTED as provisional. Price and stock share patchListingsItem's 5 rps budget. Both top-level attributes can go in one request's patches array (minItems 1, no maxItems in the model).

**Citations:**
- https://developer-docs.amazon/sp-api/docs/building-listings-management-workflows-guide (Items-per-request table: 'Listings Items API operations accept data for one item at a time'; JSON_LISTINGS_FEED 'can contain up to 25,000 messages'; 'The suggested minimum feed size is 1,500 items; using the Listings Items API directly is faster with less than 1,500 items during a five-minute period'; throttle table: five rps per operation for put/patch/delete, five feed submissions per five minutes; after ACCEPTED: 'data has been submitted for further processing', issues arrive via LISTINGS_ITEM_ISSUES_CHANGE / getListingsItem includedData=issues)
- https://developer-docs.amazon/sp-api/docs/listings-items-api-rate-limits (updatedAt 2026-09-09; v2021-08-01 patchListingsItem: 5 rps / burst 5 per account-application pair, 500 rps per application, 100 rps per application for product-data or relationship updates, 20 rps for validation previews; no per-SKU, per-hour or per-day cap listed)
- https://developer-docs.amazon/sp-api/docs/feeds-api-faq ('Generally, it is recommended to use the feed for operations that involve more than 1,500 items (up to 25,000 per feed)'; processing 'can take up to eight hours'; 10 MB per feed document)
- models/listings-items-api-model/listingsItems_2021-08-01.json paths./listings/2021-08-01/items/{sellerId}/{sku}.patch.description (usage plan Rate 5 / Burst 5); definitions.ListingsItemSubmissionResponse.status enum ACCEPTED = 'accepted for processing'
- https://github.com/amzn/selling-partner-api-models/tree/main/models/listings-items-api-model (only listingsItems_2020-09-01.json and listingsItems_2021-08-01.json; no batch/multi-SKU write operation)

### `estoque.loteMax`: HOLDS → `null`

**Proposed:** null

**Row comment:**

```ts
// null: patchListingsItem addresses one {sku} per call (developer-docs.amazon/sp-api/docs/building-listings-management-workflows-guide).
// Would be 25,000 only if we switched to JSON_LISTINGS_FEED (feeds-api-faq; also 10 MB/doc).
```

**Reasoning:** With protocolo 'por-anuncio', each patchListingsItem call addresses exactly one SKU through the {sku} path parameter. A batch size does not apply, so null is correct under the repo's own definition. A patch request can carry several patch operations (for example fulfillment_availability and purchasable_offer), but they are attributes of the same SKU, not extra SKUs. If the row ever switches to 'feed-assincrono', loteMax should become 25,000 (JSON_LISTINGS_FEED message cap per the guide and Feeds FAQ). Note the separate 10 MB per-document limit in the Feeds FAQ.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/building-listings-management-workflows-guide ('Listings Items API operations accept data for one item at a time')
- models/listings-items-api-model/listingsItems_2021-08-01.json definitions.ListingsItemPatchRequest (productType + patches for a single {sku} path parameter; patches minItems 1)
- packages/schemas/src/shared/marketplace.ts:58 (loteMax: 'Max SKUs per call/feed. `null` when not applicable or not yet known.')

### `estoque.multiDeposito`: HOLDS → `nao`

**Proposed:** 'nao' — Multi-Location Inventory / Supply Sources is US-only per the mli-integration-guide; BR has one DEFAULT MFN record

**Row comment:**

```ts
// one pooled DEFAULT (MFN) qty: MLI 'not available for … Inventory that is outside of the Amazon US store'
// (developer-docs.amazon/sp-api/docs/mli-integration-guide, upd. 2026-09-09). External Fulfillment/Seller Flex per-location = allowlist-only, BR UNKNOWN.
```

**Reasoning:** The absence is documented, not guessed. The MLI Integration Guide, updated 2026-09-09, explicitly excludes 'Inventory that is outside of the Amazon US store'. A Brazil seller therefore cannot use supply-source UUIDs as fulfillment_channel_code and keeps one pooled DEFAULT (MFN) quantity per SKU. I checked one other per-location route. The External Fulfillment Inventory API's locationId also maps 'MFN multi-location' to channel location IDs, which is the same MLI mechanism. Its other per-location codes are for Seller Flex / FBA Onsite, which needs allowlisting and a restricted role; its BR availability is UNKNOWN (no country list in the docs). That is not a route for an ordinary BR MFN seller. FBA records hold Amazon-managed stock that the seller does not write. Note that the Supply Sources API reference lists regions 'NA, EU, FE', but that is about API endpoints, not marketplace eligibility; the MLI guide is what settles eligibility.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/mli-integration-guide (updatedAt 2026-09-09; 'Multi-location inventory is currently not available for:' FBA inventory; 'Inventory that is outside of the Amazon US store')
- https://developer-docs.amazon/sp-api/docs/publish-location-level-inventory (locationId: 'DEFAULT for the MFN single location', 'Channel location ID for MFN multi-location', 'Four-character warehouse code for Seller Flex / FBA Onsite'; merchant must be allowlisted on the External Fulfillment API; role 'Direct to Consumer Shipping (Restricted)')
- https://developer-docs.amazon/sp-api/docs/external-fulfillment-inventory (updatedAt 2026-09-09; channels Seller Flex/FBA Onsite, Multi Seller Flex, Easy Ship, Self Ship, MFN Self Delivery, Amazon Pharmacy; no country list)
- https://developer-docs.amazon/sp-api/docs/manage-amazon-haul-advanced-multiple-offer-multiple-fulfillment-use-cases (FBA AMAZON_NA record carries no seller quantity)

### `enviarPreco`: HOLDS → `sim`

**Proposed:** 'sim' — purchasable_offer (our_price, discounted_price schedule with start_at/end_at, minimum/maximum_seller_allowed_price) via patchListingsItem merge

**Row comment:**

```ts
// patchListingsItem op:'merge' /attributes/purchasable_offer {marketplace_id, currency:'BRL', audience:'ALL', our_price[{schedule[{value_with_tax}]}]}
// promo = discounted_price schedule start_at/end_at; offer-level end_at = stop selling (developer-docs.amazon/sp-api/docs/manage-purchasable-offer).
// BR availability of discounted_price/min-max allowed price: UNKNOWN until the BR product-type schema is read.
```

**Reasoning:** Holds. The 'Manage purchasable offer' guide documents patchListingsItem merge on /attributes/purchasable_offer with our_price, discounted_price, and minimum/maximum_seller_allowed_price. Each price sits in a schedule array with value_with_tax. discounted_price schedule entries carry start_at and end_at, so the planner's 'discounted_price schedule with start_at/end_at' is right. Two corrections or caveats. (a) purchasable_offer also has offer-level start_at/end_at objects ({value: date}) that mean the offer's release and stop-selling dates; a past end_at soft-closes the offer. They are not the promo window, and confusing the two would pull the offer off sale. (b) Every docs example uses the US marketplace (ATVPDKIKX0DER, USD). Whether BR product-type schemas expose discounted_price and minimum/maximum_seller_allowed_price is UNKNOWN from the docs; only the Product Type Definitions API for A2Q3Y263D00KWC would settle it, and I made no live calls. our_price alone is enough for 'sim'. The selectors must be marketplace_id A2Q3Y263D00KWC, currency BRL and audience ALL. our_price can never be nulled.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer (selectors currency / marketplace_id / audience; our_price [{schedule:[{value_with_tax}]}]; discounted_price [{schedule:[{start_at, end_at, value_with_tax}]}]; minimum_/maximum_seller_allowed_price [{schedule:[{value_with_tax}]}]; merge recommended; 'The our_price sub-attribute cannot be deleted (set to null)'; maximum_retail_price 'Only available in the Amazon IN store'; quantity_discount_plan only for Amazon Business offers)
- https://developer-docs.amazon/sp-api/docs/update-price-for-multiple-amazon-stores (patchListingsItem on /attributes/purchasable_offer; multi-store only within one region; currency must match the store)
- https://developer-docs.amazon/sp-api/docs/listings-items-api-rate-limits (patchListingsItem budget shared with stock writes)

## Cluster: orders-fiscal

### `importarPedido`: HOLDS → `sim`

**Proposed:** sim — Orders API v2026-01-01 searchOrders (0.0056 rps, burst 20) + getOrder (0.5 rps, burst 30) with includedData; v0 read operations are removed 2027-03-27.

**Row comment:**

```ts
// sim — Orders v2026-01-01 searchOrders (0.0056 rps/burst 20) + getOrder (0.5/30, includedData; items always inline): models/orders-api-model/orders_2026-01-01.json paths.
// v0 getOrders/getOrder/getOrderItems/getOrderAddress/getOrderBuyerInfo/getOrderItemsBuyerInfo removed 2027-03-27 (docs/sp-api-deprecations); v0 confirmShipment NOT in that list.
```

**Reasoning:** I checked every part of the claim against the model and the docs and found nothing to refute. The v2026-01-01 model defines searchOrders at 0.0056 rps / burst 20 and getOrder at 0.5 rps / burst 30. Both accept the includedData array. definitions.Order.required includes orderItems, which matches the migration guide's 'items always included', so no separate getOrderItems call is needed. The deprecation schedule lists exactly six v0 read operations, removed on March 27, 2027. Two precisions the planner left out. First, only those six read operations are scheduled for removal. confirmShipment, updateShipmentStatus and the other v0 write operations are not on the list, and v2026-01-01 has no shipment-confirmation operation, so shipping writes stay on v0 (or Feeds). Second, at 0.0056 rps, about one call every 3 minutes once the burst of 20 is used up, searchOrders cannot be the only ingestion path. A notification-driven getOrder flow is implied (the ORDER_CHANGE notification is out of scope for this field). The NA region serves BR, according to the orders-api page's region note.

**Citations:**
- models/orders-api-model/orders_2026-01-01.json paths['/orders/2026-01-01/orders'].get (operationId searchOrders; Usage Plan table rate 0.0056, burst 20)
- models/orders-api-model/orders_2026-01-01.json paths['/orders/2026-01-01/orders/{orderId}'].get (operationId getOrder; Usage Plan rate 0.5, burst 30)
- models/orders-api-model/orders_2026-01-01.json paths[...].get.parameters[name=includedData].items.enum = [BUYER, RECIPIENT, PROCEEDS, EXPENSE, PROMOTION, CANCELLATION, FULFILLMENT, PACKAGES, TAX, PAYMENT, FULFILLMENT_ORDERS]
- models/orders-api-model/orders_2026-01-01.json definitions.Order.required includes orderItems; info.description (no data older than two years outside JP/AU/SG)
- https://developer-docs.amazon/sp-api/docs/sp-api-deprecations (Orders v0 row: getOrders, getOrder, getOrderBuyerInfo, getOrderAddress, getOrderItems, getOrderItemsBuyerInfo; deprecated January 28, 2026; removal March 27, 2027)
- https://developer-docs.amazon/sp-api/changelog/new-introducing-the-orders-api-v2026-01-01 (must migrate by March 27, 2027; applies to all marketplaces)
- https://developer-docs.amazon/sp-api/docs/orders-api (v2026-01-01 operations searchOrders/getOrder available in NA, EU, FE; sellers only)
- https://developer-docs.amazon/sp-api/docs/orders-api-migration-guide (GetOrderItems -> getOrder, items always included)

### `importarPagamento`: CORRECTED → `sim`

**Proposed:** sim — includedData=PAYMENT returns paymentExecutions[] {paymentMethod (CreditCard, Pix, Boleto, Rewards, Other per a 2025-08-28 changelog), paymentAmount, BR-only acquirerId/cardBrand/authorizationCode}; no installments field.

**Row comment:**

```ts
// sim — getOrder includedData=PAYMENT -> payment.paymentExecutions[] {paymentMethod (OPEN string), paymentAmount, BR-only acquirerId/cardBrand/authorizationCode}; no installments
// (orders_2026-01-01.json definitions.PaymentExecution). The CreditCard/Pix/Boleto/Rewards/Other list in the 2025-08-28 changelog is for getShipmentDetails, not Orders: 'Boleto' literal in v2026 is UNKNOWN.
```

**Reasoning:** The value 'sim' stands, but the planner's evidence for the payment-method list is mis-attributed. The CreditCard / Pix / Boleto / Rewards / Other list in the August 28, 2025 changelog is the PaymentMethod enum of the Shipment Invoicing getShipmentDetails Payments array (Seller Flex / FBA Onsite). It is not the Orders paymentExecutions enum. For getOrders, that changelog only adds AcquirerId / CardBrand / AuthorizationCode, and only for new MFN and Easy Ship BR orders. In v2026-01-01, PaymentExecution.paymentMethod is an open string. Its examples are CashOnDelivery, ConvenienceStore, CreditCard, Invoice and Pix. The v0 PaymentExecutionDetailItem enum is COD, GC, PointsAccount, Invoice, CreditCard, Pix, Other, with no Boleto. Boleto and Rewards appear only in v0 paymentMethodDetails, which the migration guide folds into the same v2026 paymentMethod field. Whether v2026 emits the literal strings 'Boleto' or 'Rewards' is therefore UNKNOWN; the importer must treat paymentMethod as an open string with a fallback. Confirmed: paymentAmount (Money) exists; the BR-only acquirerId, cardBrand and authorizationCode exist; there is no installments field (PaymentExecution has exactly five properties). Coverage of FBA BR orders is UNKNOWN, because the changelog names only MFN and Easy Ship. The Access Orders PII page lists no restricted role for PAYMENT. With method + amount + acquirer + authorization code per execution, the ERP can build a payment record.

**Citations:**
- models/orders-api-model/orders_2026-01-01.json definitions.Order.properties.payment -> definitions.OrderPayment.properties.paymentExecutions[] -> definitions.PaymentExecution
- models/orders-api-model/orders_2026-01-01.json definitions.PaymentExecution.properties = {paymentMethod, paymentAmount (Money), acquirerId, cardBrand, authorizationCode} — no installments property; paymentMethod.type = string, description 'for example, CashOnDelivery, ConvenienceStore, CreditCard, Invoice, Pix, and so on'
- models/orders-api-model/orders_2026-01-01.json definitions.PaymentExecution.properties.acquirerId/authorizationCode ('only available for orders in the Brazil (BR) marketplace when the paymentMethod is CreditCard or Pix'), cardBrand ('... when the paymentMethod is CreditCard')
- https://developer-docs.amazon/sp-api/changelog/shipment-invoicing-and-orders-apis-to-provide-new-payment-data-for-the-brazil-marketplace (Starting August 28, 2025; the PaymentMethod value list CreditCard, Pix, Boleto, Rewards, Other is given for the getShipmentDetails Payments array (Seller Flex); getOrders gets AcquirerId/CardBrand/AuthorizationCode in PaymentExecutionDetail for new Self Ship (MFN) and Easy Ship (DBA) BR orders)
- models/orders-api-model/ordersV0.json definitions.PaymentExecutionDetailItem.properties.PaymentMethod (possible values COD, GC, PointsAccount, Invoice, CreditCard, Pix, Other — no Boleto)
- https://developer-docs.amazon/sp-api/changelog/update-orders-api-v0-returns-pix-boleto-and-rewards-based-payment-method-details (v0 paymentMethodDetails now returns Pix, Boleto, Rewards; undated)
- https://developer-docs.amazon/sp-api/docs/orders-api-migration-guide (PaymentMethod and PaymentMethodDetails both map to Order.payment.paymentExecutions[].paymentMethod; require includedData=PAYMENT)

### `consolidaPacote`: HOLDS → `nao`

**Proposed:** nao — Orders v2026 packages[] are per order and packageItems reference orderItemId only; no field links several orders to one package; confirmShipment is per order.

**Row comment:**

```ts
// nao — no multi-order grouping in Orders v2026: Order has no pack id, associatedOrders only REPLACEMENT/EXCHANGE, PackageItem = {orderItemId, quantity}
// (orders_2026-01-01.json definitions.Order/AssociatedOrder/PackageItem); confirmShipment, Shipping v2, MFN and Easy Ship all take ONE orderId (docs/confirm-the-shipment-status).
```

**Reasoning:** I tried to refute this and found nothing that groups several orders, so 'nao' rests on evidence of absence across every shipment-related model. The v2026 Order has no pack, cart or group field. associatedOrders carries only REPLACEMENT_ORIGINAL_ID and EXCHANGE_ORIGINAL_ID links. packages[] are scoped 'within the context of the order', and PackageItem references only orderItemId. Every shipment-creating or confirming surface takes exactly one Amazon order ID: v0 confirmShipment (orderId in the path, one packageDetail), Shipping v2 AmazonOrderDetails.orderId, MFN ShipmentRequestDetails.AmazonOrderId, and Easy Ship createScheduledPackage / bulk OrderScheduleDetails. The docs cover the reverse case (one order split across several packages), not consolidation. Residual UNKNOWN: the docs are silent on whether Amazon accepts the same trackingNumber on confirmShipment for two different orders. That would be seller-side co-shipping, not a provider-modeled consolidated pedido, so it does not change the value. Note that confirmShipment lives only in v0, but it is not on the 2027-03-27 removal list.

**Citations:**
- models/orders-api-model/orders_2026-01-01.json definitions.Order.properties (orderId, orderAliases, createdTime, lastUpdatedTime, programs, associatedOrders, salesChannel, buyer, recipient, proceeds, payment, tax, fulfillment, orderItems, packages, fulfillmentOrders) — no pack/cart/shipment-group identifier
- models/orders-api-model/orders_2026-01-01.json definitions.AssociatedOrder.properties.associationType (Possible values: REPLACEMENT_ORIGINAL_ID, EXCHANGE_ORIGINAL_ID)
- models/orders-api-model/orders_2026-01-01.json definitions.OrderPackage.properties.packageReferenceId ('unique identifier for this package within the context of the order'); definitions.PackageItem.required = [orderItemId, quantity]
- https://developer-docs.amazon/sp-api/docs/confirm-the-shipment-status (call confirmShipment 'passing an orderId in the path'; multiple tracking IDs = multiple requests with the same order ID and different packageReferenceId; bulk via POST_ORDER_FULFILLMENT_DATA feed)
- models/orders-api-model/ordersV0.json paths['/orders/v0/orders/{orderId}/shipmentConfirmation'].post (confirmShipment) — ConfirmShipmentRequest.properties = packageDetail, codCollectionMethod, marketplaceId (single packageDetail)
- models/shipping-api-model/shippingV2.json definitions.AmazonOrderDetails.required = [orderId] (single string)
- models/merchant-fulfillment-api-model/merchantFulfillmentV0.json definitions.ShipmentRequestDetails.required includes AmazonOrderId (single)
- models/easy-ship-model/easyShip_2022-03-23.json definitions.CreateScheduledPackageRequest.amazonOrderId; definitions.OrderScheduleDetails.amazonOrderId (bulk = list of per-order schedules)

### `dadosFiscaisSeparados`: CORRECTED → `sim`

**Proposed:** sim — buyer CPF/CNPJ arrives in the SAME getOrder call (includedData=TAX → tax.taxRegistrations[entityType=BUYER]) but it is ROLE-gated (Tax Invoicing or Tax Remittance, restricted) and STATUS-gated (buyer name and restricted address fields only in UNSHIPPED/PARTIALLY_SHIPPED/SHIPPED; MERCHANT and MARKETPLACE registrations only while PENDING/UNSHIPPED), so the importer must re-read after the gate opens — Shopee precedent.

**Row comment:**

```ts
// sim — inline in getOrder (includedData=TAX,BUYER,RECIPIENT) but ROLE-gated: buyer CPF only with Tax Invoicing/Tax Remittance (Restricted), not DTC (docs/get-tax-information, docs/access-orders-pii);
// buyerName + deliveryAddress name/lines only once UNSHIPPED/PARTIALLY_SHIPPED/SHIPPED, so re-read after PENDING. MERCHANT/MARKETPLACE regs are the inverse gate (PENDING/UNSHIPPED only). BR buyer CNPJ: UNKNOWN.
```

**Reasoning:** The value 'sim' stands under the Shopee precedent (same call, but gated, with a re-read after the gate opens). Two parts of the planner's justification are wrong, though. (1) The buyer CPF itself has NO documented status gate. get-tax-information says only that buyer CPF is available for Brazil orders, gated by the Tax Invoicing or Tax Remittance (Restricted) role. Direct-to-Consumer Shipping alone does NOT return taxRegistrations (PII table: No for DTC FBA and FBM). (2) The PENDING/UNSHIPPED condition the planner cites is real, but it applies to the MERCHANT (seller legalName) and MARKETPLACE (Amazon store tax registration) entries, not to the buyer. It is also the inverse gate: that data disappears after the order ships, so the importer must capture it early. MARKETPLACE is the likely source for the NF-e intermediary data (the exact registration type is UNKNOWN). The status gate that actually forces a re-read of the buyer's fiscal identity is on buyer.buyerName and recipient.deliveryAddress.name/addressLine1-3/extendedFields. These return only in UNSHIPPED, PARTIALLY_SHIPPED or SHIPPED, standard orders start in PENDING, and the NF-e destinatário needs both name and address. Net result: inline in getOrder (includedData=TAX,BUYER,RECIPIENT), role-gated (a whitelist analog), with name/address status-gated, so 'sim'. It is not 'freely inline', and no separate call is required; the v0 separate calls are being removed anyway. Buyer CNPJ for BR business buyers is UNKNOWN: the model's taxRegistrationType enum lists CNPJ, but the docs mention only CPF for Brazil. If the app cannot obtain a Tax role, the CPF never arrives and the integration must handle that case.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/get-tax-information (Step 2: buyer registrations need Tax Remittance (Restricted) or Tax Invoicing (Restricted); filter entityType == "BUYER"; 'You can also get the buyer CPF tax registration number for Brazil orders.'; CNPJ not mentioned; no order-status condition on buyer registrations; updatedAt 2026-09-09)
- https://developer-docs.amazon/sp-api/docs/get-tax-information (Steps 3–4: MERCHANT returns only legalName and MARKETPLACE only taxRegistrationType/taxRegistrationNumber, 'only for Brazil orders that are either pending or unshipped')
- https://developer-docs.amazon/sp-api/docs/access-orders-pii (non-US/Japan/Singapore table: order.tax.taxRegistrations = No without restricted roles, Yes for Tax Remittance/Tax Invoice FBA and FBM, No for Direct-to-Consumer Shipping; buyer.buyerName and deliveryAddress.name/addressLine1-3/extendedFields need a restricted role AND status UNSHIPPED, PARTIALLY_SHIPPED or SHIPPED; no RDT needed)
- models/orders-api-model/orders_2026-01-01.json definitions.OrderTaxRegistration.properties.entityType (BUYER, MERCHANT, MARKETPLACE) and taxRegistrationType (BUSINESS, VAT, CST, CPF, CNPJ)
- models/orders-api-model/orders_2026-01-01.json definitions.FulfillmentStatus x-docgen-enum-table-extension PENDING ('For standard orders, the initial order status is PENDING')
- https://developer-docs.amazon/sp-api/docs/roles-in-the-selling-partner-api (Tax Invoicing (Restricted) / Tax Remittance (Restricted): restricted roles require additional information about data use and security controls)
- https://developer-docs.amazon/sp-api/docs/sp-api-deprecations (v0 getOrderBuyerInfo / getOrderAddress removed March 27, 2027 — no separate call survives)

## Cluster: fulfilment

### `etiqueta`: HOLDS → `fetch`

**Proposed:** fetch

**Row comment:**

```ts
// DBA = Easy Ship in BR (deliveryShipmentInvoiceV2022-07-01.json ProgramType). Amazon mints the label: easyShip_2022-03-23 createScheduledPackageBulk printableDocumentsUrl (PDF|ZPL) or EF generateShipLabels presigned URL (process-shipment.md step 5).
// BR path UNKNOWN: easy-ship-api.md store table omits Brazil; EF error SC_30007 is BR-only (NF-e before label). Self Ship sellers would be 'emit'.
```

**Reasoning:** The value holds for DBA orders: Amazon mints the label in both documented paths. In Easy Ship v2022-03-23, createScheduledPackage generates the label, and createScheduledPackageBulk takes a required labelFormat (PDF|ZPL; the model has no PNG) and returns printableDocumentsUrl, a pre-signed zip. In External Fulfillment v2024-09-11, generateShipLabels returns a per-package S3 presigned URL plus carrierName/trackingId; for Easy Ship it supports PNG, ZPL and PDF. Easy Ship exists in Brazil under the name DBA, per the Delivery by Amazon model's ProgramType enum. Caveats: (1) The BR API path is UNKNOWN. The Easy Ship API store table does not list Brazil, so the docs do not support calling createScheduledPackageBulk for BR; the legacy production integration that does so is not documentary evidence. External Fulfillment lists regions NA/EU/FE with no store table, but its error SC_30007 is marked as applying to the Amazon BR store, which suggests EF runs in BR. Which program it serves there (DBA, Seller Flex/FBA Onsite or Self Ship) is UNKNOWN. (2) For Self Ship orders (ProgramType SelfShip, channel MFN/SELF) the seller delivers on its own, so the label would be ours ('emit'). 'fetch' is only correct if the seller uses DBA. (3) SC_30007 suggests that in BR the invoice (NF-e) must exist before EF will generate a label. Also: the planner's 'labelFormat ZPL' is valid, but the Easy Ship model enum is PDF|ZPL, not PNG.

**Citations:**
- models/easy-ship-model/easyShip_2022-03-23.json paths['/easyShip/2022-03-23/package'].post.description (createScheduledPackage: 'Generates a shipping label and an invoice')
- models/easy-ship-model/easyShip_2022-03-23.json paths['/easyShip/2022-03-23/packages/bulk'].post.description (createScheduledPackageBulk: PDF or ZPL; 'Amazon will create the label'; returns a short-lived URL to a zip)
- models/easy-ship-model/easyShip_2022-03-23.json definitions.LabelFormat.enum = [PDF, ZPL]; definitions.CreateScheduledPackagesRequest.required includes labelFormat; definitions.CreateScheduledPackagesResponse.properties.printableDocumentsUrl
- https://developer-docs.amazon/sp-api/docs/easy-ship-api.md section 'Amazon store support' (rows: Mexico, India, Turkey, Australia, Singapore, Japan, Netherlands, Poland; no Brazil)
- models/delivery-by-amazon/deliveryShipmentInvoiceV2022-07-01.json definitions.ProgramType x-docgen-enum-table-extension: EasyShip = 'EasyShip program (also known as DBA in Brazil - Delivered By Amazon)'; SelfShip = sellers deliver directly
- https://developer-docs.amazon/sp-api/docs/process-shipment.md Step 5 'Generate shipping labels' (generateShipLabels; formats: Easy Ship PNG, ZPL, PDF; Self Ship only PNG)
- models/external-fulfillment/externalFulfillmentShipments_2024-09-11.json paths['/externalFulfillment/2024-09-11/shipments/{shipmentId}/shipLabels'].put (generateShipLabels); definitions.DocumentV2.properties.url (S3 presigned URL, ZPL/PDF/PNG/plain text); definitions.ShipLabelMetadata.required = [carrierName, trackingId]
- https://developer-docs.amazon/sp-api/docs/external-fulfillment-shipping.md Roles > generateShipLabels: Regions NA, EU, FE; role Direct-to-Consumer Shipping (Restricted)
- https://developer-docs.amazon/sp-api/docs/retrieve-list-of-shipments.md 'Determine the program' (Easy Ship = MFN/MARKETPLACE, Self Ship = MFN/SELF)
- https://developer-docs.amazon/sp-api/docs/external-fulfillment-errors.md row SC_30007 OperationNotPermitted 'No invoice available for shipment' (applies to the Amazon BR store)

### `rastreio`: UNSETTLED → `pull`

**Proposed:** pull

**Row comment:**

```ts
// pull: orders_2026-01-01 getOrder includedData=PACKAGES -> packages[].packageStatus.detailedStatus/trackingNumber. ORDER_CHANGE fires only on status/buyer-cancel/tip; Easy Ship events listed as 'future' (tutorial-subscribe-to-order-change-notification.md).
// SHIPMENT_TRACKING_MILESTONE_CHANGED rides the US-only Tracking API (tracking-api.md). UNSETTLED: EXTERNAL_FULFILLMENT_SHIPMENT_STATUS_CHANGE pushes SHIPPED/DELIVERED, but whether BR DBA orders flow through EF is undocumented.
```

**Reasoning:** Pull is documented and works: Orders v2026-01-01 getOrder with includedData=PACKAGES returns packageStatus.status/detailedStatus and trackingNumber for FBM orders, including the Easy Ship detailed states. Easy Ship getScheduledPackage also returns packageStatus and trackingDetails, but the Easy Ship API is not documented for BR. No push is documented for BR in these channels: (a) ORDER_CHANGE has only three trigger types, Amazon order status has no delivered state, and the ORDER_CHANGE tutorial lists Easy Ship events as a possible future addition, so a change to EasyShipShipmentStatus alone is not documented as a trigger. ORDER_CHANGE does push the Unshipped-to-Shipped status change, which is a milestone but not tracking. (b) SHIPMENT_TRACKING_MILESTONE_CHANGED shares version 2026-01-30 and the shipments:track scope with the Tracking API, which is US-only. The planner's 'documented US-only' holds only by that inference, because the notification page states no store scope. (c) FULFILLMENT_ORDER_STATUS covers MCF orders only, and FBA_OUTBOUND_SHIPMENT_STATUS covers FBA Onsite creation/cancellation only. Why this is not 'holds': EXTERNAL_FULFILLMENT_SHIPMENT_STATUS_CHANGE pushes SHIPPED and DELIVERED for EF shipments, EF covers Easy Ship (MFN/MARKETPLACE) shipments, and EF has a BR-specific error code. If a BR DBA seller's orders flow through External Fulfillment, a coarse push of shipped/delivered exists. The docs give no EF store table and do not say whether BR DBA orders go through EF. 'pull' is the safe row value, but it cannot be called evidence that no push exists.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/notification-type-values.md#order_change ('sent whenever there is an important change in the order. Important changes include order status changes and buyer requested cancelations'; OrderChangeType = BuyerRequestedChange | DeliveryTipChange | OrderStatusChange; OrderChangeSummary.OrderStatus values have no Delivered state)
- schemas/notifications/OrderChangeNotification.json properties.Payload.properties.OrderChangeNotification.properties.OrderChangeType.enum and .properties.Summary.properties.EasyShipShipmentStatus (enum PendingSchedule..Damaged; 'included only for Amazon Easy Ship orders' - a snapshot field, not a trigger)
- https://developer-docs.amazon/sp-api/docs/tutorial-subscribe-to-order-change-notification.md (says Amazon may 'add additional events related to orders in the future, like certain Easy Ship events')
- https://developer-docs.amazon/sp-api/docs/tracking-api.md (Tracking API available only in the United States; getShipmentTracking Regions 'NA (US only)'; version 2026-01-30)
- https://developer-docs.amazon/sp-api/docs/subscribe-to-shipment-tracking-notifications.md (SHIPMENT_TRACKING_MILESTONE_CHANGED: scope sellingpartnerapi::shipments:track, payloadVersion 2026-01-30, one subscription per trackingIdentifier; the notification page itself states no store scope)
- https://developer-docs.amazon/sp-api/docs/notification-type-values.md#external_fulfillment_shipment_status_change (sent on status change of a 'warehouse integration order'; statuses include SHIPPED, DELIVERED, CANCELLED)
- https://developer-docs.amazon/sp-api/docs/retrieve-list-of-shipments.md 'Determine the program' (EF shipments include Easy Ship MFN/MARKETPLACE)
- https://developer-docs.amazon/sp-api/docs/external-fulfillment-errors.md row SC_30007 (BR store)
- https://developer-docs.amazon/sp-api/docs/notification-type-values.md#fba_outbound_shipment_status (BR-only, FBA Onsite only, statuses Created/Cancelled only) and #fulfillment_order_status (Multi-Channel Fulfillment orders only)
- models/orders-api-model/orders_2026-01-01.json paths['/orders/2026-01-01/orders/{orderId}'].get includedData enum includes PACKAGES; definitions.OrderPackage ('Only available for merchant-fulfilled (FBM) orders'; trackingNumber, carrier, shipTime); definitions.PackageStatus.status/detailedStatus
- models/easy-ship-model/easyShip_2022-03-23.json definitions.Package.properties.packageStatus/trackingDetails; definitions.PackageStatus enum (ReadyForPickup..OutForDelivery)

### `enviarNfe`: HOLDS → `sim`

**Proposed:** sim

**Row comment:**

```ts
// DBA API submitInvoice POST /delivery/2022-07-01/invoice?orderId= (Base64 SEFAZ-approved XML + Base64 MD5, programType EasyShip|SelfShip|FbaOnSite), BR-only.
// Restricted Availability + Tax Invoicing (Restricted) role (delivery-by-amazon-api.md; deliveryShipmentInvoiceV2022-07-01.json). Status: GET .../invoice/status (invoiceId = NF-e key since 2026-09-30).
```

**Reasoning:** Every element of the proposal checks out. submitInvoice is POST /delivery/2022-07-01/invoice with orderId (or shipmentId) as a query parameter. The body requires invoiceContent (Base64 SEFAZ-approved XML), contentMD5Value (Base64 MD5), invoiceType Outbound, programType (EasyShip|FbaOnSite|SelfShip) and marketplaceId. It is BR-only, in Restricted Availability, and needs the Tax Invoicing (Restricted) role. getInvoiceStatus is GET /delivery/2022-07-01/invoice/status. Additions the planner left out: (1) getInvoiceStatus also requires marketplaceId, invoiceType and programType. Since 2026-09-30 it accepts invoiceId (the NF-e access key) and returns an aggregated orderInvoicingStatus for multi-invoice Self Ship orders. (2) ORDER_CHANGE's Summary carries ElectronicInvoiceStatus, so a status change could also be observed there. (3) The docs overview table says 'Current version v2021-12-28' but links the 2022-07-01 reference and model, and the model's info.version is 2022-07-01; this looks like a docs typo. 'sim' is a capability fact. Access is gated by Restricted Availability plus a restricted role, which is an onboarding risk, not evidence of absence.

**Citations:**
- https://developer-docs.amazon/sp-api/docs/delivery-by-amazon-api.md (Restricted Availability, only available in the Brazil Amazon store; Roles: submitInvoice/getInvoiceStatus Regions BR, Tax Invoicing (Restricted))
- https://developer-docs.amazon/sp-api/docs/submit-an-invoice-delivery-by-amazon-order.md (prerequisite: XML of an invoice approved on SEFAZ; Step 1 Base64 XML; Step 2 Base64 MD5; Step 3a POST /delivery/2022-07-01/invoice?orderId=... programType EasyShip; host sellingpartnerapi-na.amazon.com)
- models/delivery-by-amazon/deliveryShipmentInvoiceV2022-07-01.json paths['/delivery/2022-07-01/invoice'].post (submitInvoice; orderId or shipmentId query, orderId wins); definitions.SubmitInvoiceRequest.required = [contentMD5Value, invoiceContent, invoiceType, programType, marketplaceId]; definitions.ProgramType.enum = [EasyShip, FbaOnSite, SelfShip]; definitions.InvoiceType.enum = [Outbound]
- models/delivery-by-amazon/deliveryShipmentInvoiceV2022-07-01.json paths['/delivery/2022-07-01/invoice/status'].get (getInvoiceStatus; required marketplaceId, invoiceType, programType; optional orderId/shipmentId/invoiceId = NF-e access key); definitions.GetInvoiceStatusResponse.orderInvoicingStatus; definitions.ShipmentInvoiceStatus enum Processing|Accepted|Errored|NotFound
- https://developer-docs.amazon/sp-api/changelog/sp-api-updates-simplified-authorization-for-service-providers-external-fulfillment-sandbox-changes-and-multi-invoice-support-changes-for-brazil.md (from 2026-09-30 getInvoiceStatus supports multiple invoices per order: invoiceId param, orderInvoicingStatus)
- schemas/notifications/OrderChangeNotification.json properties.Payload.properties.OrderChangeNotification.properties.Summary.properties.ElectronicInvoiceStatus (enum NotRequired|NotFound|Processing|Errored|Accepted)

## Cluster: conversation-claims

### `reclamacoes`: CORRECTED → `desconhecido`

**Proposed:** nao

**Row comment:**

```ts
// 'desconhecido': EF Returns API v2024-09-11 has listReturns/getReturn (read-only; Seller Flex/Easy Ship/Self Ship/MFN Self Delivery),
// but no doc confirms it for a plain amazon.com.br MFN seller; A-to-z exists only as returns-report columns.
// src: models/external-fulfillment/externalFulfillmentReturns_2024-09-11.json; developer-docs.amazon/sp-api/docs/external-fulfillment-returns
```

**Reasoning:** The planner's premise is refuted. A returns API that is not a report does exist: the External Fulfillment Returns API v2024-09-11, with listReturns (filterable by status, RMA, time and location; paginated) and getReturn. It exposes a return lifecycle (CREATED through PROCESSED, REJECTED or CANCELLED), the return reason, the RMA ID and forward/reverse tracking. The October 1, 2025 release note says the EF APIs handle returns across Seller Flex, Easy Ship, Self Ship and MFN Self Delivery, and several of those are MFN channels. So 'nao' cannot stand as evidence of absence. The opposite value, 'sim', is not proven either. No EF doc lists supported marketplaces, the model examples use India (A21TJRUUN4KGV), the identifiers are SmartConnect-specific (returnLocationId, channelSku), the API needs the restricted Direct-to-Consumer Shipping role, and it assumes the seller is enrolled in an External Fulfillment program. For BR the only evidence is FBA Onsite, which is a Seller Flex-type program that exists in BR per the FBA_OUTBOUND_SHIPMENT_STATUS notification. Nothing establishes that a plain Amazon.com.br merchant-fulfilled seller can call listReturns. Even where it is available, the API is read-only: there are no operations to approve, refund or answer a return. There is still no A-to-z claim or mediation resource in any model; A-to-z and SafeT claims appear only as columns in the returns reports. No notification type covers returns or claims. Final value: 'desconhecido', pending a check of BR eligibility for EF Returns.

**Citations:**
- models/external-fulfillment/externalFulfillmentReturns_2024-09-11.json info.title = "The Selling Partner API for Amazon External Fulfillment Return Item Processing"; info.description = "...retrieve, track, and process return items through Amazon's External Fulfillment returns management system"
- models/external-fulfillment/externalFulfillmentReturns_2024-09-11.json paths["/externalFulfillment/2024-09-11/returns"].get.operationId = listReturns; paths["/externalFulfillment/2024-09-11/returns/{returnId}"].get.operationId = getReturn (these are the only operations, both GET)
- models/external-fulfillment/externalFulfillmentReturns_2024-09-11.json definitions.Return.properties.returnType.enum = [CUSTOMER, REJECT]; definitions.Return.properties.status.enum = [CREATED, CARRIER_NOTIFIED_TO_PICK_UP_FROM_CUSTOMER, ..., PROCESSED, REJECTED, CANCELLED]; definitions.ReturnMetadata.properties = {returnReason, rmaId, fulfillmentOrderId, invoiceInformation}; definitions.Return.properties.returnLocationId.description = "The SmartConnect identifier ..."
- https://developer-docs.amazon/sp-api/docs/external-fulfillment-returns.md (Availability: Sellers only; listReturns/getReturn Regions NA, EU, FE; Required role: Direct-to-Consumer Shipping (Restricted))
- https://developer-docs.amazon/sp-api/docs/retrieve-return-information.md (prerequisites: Location ID and SKU ID from the seller + approved Direct-to-Consumer Shipping (Restricted) role)
- https://developer-docs.amazon/sp-api/docs/sp-api-release-notes.md (October 1, 2025, 'External Fulfillment APIs': Inventory, Returns, Shipping APIs cover channels including Seller Flex, Easy Ship, Self Ship, and MFN Self Delivery)
- https://developer-docs.amazon/sp-api/docs/retrieve-list-of-shipments.md (program table: Easy Ship = channelName MFN/shippingType MARKETPLACE; Self Ship = MFN/SELF; Seller Flex = FBA/MARKETPLACE)
- https://developer-docs.amazon/sp-api/docs/external-fulfillment-inventory.md (channels: Seller Flex / FBA Onsite, Multi Seller Flex, Easy ship, Self ship, MFN Self Delivery, Amazon Pharmacy)
- https://developer-docs.amazon/sp-api/docs/notification-type-values.md#fba_outbound_shipment_status (FBA Onsite shipments; 'available only in the Amazon Brazil store'), which shows an EF-family program exists in BR, though not that the Returns API covers it
- models/external-fulfillment/externalFulfillmentLocation_2026-07-30.json and externalFulfillmentShipments_2024-09-11.json examples use marketplaceId A21TJRUUN4KGV (India); no EF doc lists the supported marketplaces
- https://developer-docs.amazon/sp-api/docs/report-type-values-returns.md (GET_XML/FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE: seller-fulfilled returns only, report columns a_to_z_claim / SafeT claim id/state; these are reports, not resources)
- https://github.com/amzn/selling-partner-api-models/tree/main/models (55 model directories; no A-to-z / claims / mediation model) and schemas/notifications/ (26 schemas; no return or claim notification)
- models/fulfillment-outbound-api-model/fulfillmentOutbound_2020-07-01.json paths["/fba/outbound/2020-07-01/fulfillmentOrders/{sellerFulfillmentOrderId}/return"].put.operationId = createFulfillmentReturn (MCF fulfillment orders only, not Amazon.com.br marketplace orders)

### `mensagensPosVenda`: HOLDS → `nao`

**Proposed:** nao

**Row comment:**

```ts
// 'nao': Messaging API v1 is send-only (POST .../messages/*; GetAttributes returns only buyer.locale), and no op or
// notification type delivers buyer messages to the seller. Amazon emails the buyer (docs/messaging-api step 8).
// src: models/messaging-api-model/messaging.json paths; developer-docs.amazon/sp-api/docs/notification-type-values
```

**Reasoning:** I tried to refute this and could not. The Messaging API v1 model has two GETs: getMessagingActionsForOrder, which lists the message types the seller may send, and GetAttributes, which returns only buyer.locale. Every other operation POSTs a templated seller-to-buyer message, and the docs say Amazon delivers it by email. No operation, model definition or notification type returns a buyer's message to the seller. The 26 documented notification types and the schemas/notifications directory have none. The Solicitations API is explicitly no-reply. The Support API covers the seller's own cases with Amazon Selling Partner Support. Data Kiosk and report schemas carry no message data. The only counter-signal is the Buyer Communication role text 'to and from Amazon buyers', and no operation implements the 'from' direction. Because nothing can deliver buyer messages to the ERP, 'nao' holds as evidence of absence, for the two-way, inbox-feeding definition. Seller-to-buyer send-only messaging does exist; consider a separate note if the row ever needs to express it.

**Citations:**
- models/messaging-api-model/messaging.json info.description = "With the Messaging API you can build applications that send messages to buyers..."
- models/messaging-api-model/messaging.json paths: GET /messaging/v1/orders/{amazonOrderId} (getMessagingActionsForOrder), GET /messaging/v1/orders/{amazonOrderId}/attributes (GetAttributes); every other operation is POST .../messages/* (confirmCustomizationDetails, createConfirmDeliveryDetails, createLegalDisclosure, createConfirmOrderDetails, createConfirmServiceDetails, CreateWarranty, createDigitalAccessKey, createUnexpectedProblem, sendInvoice)
- models/messaging-api-model/messaging.json definitions.GetAttributesResponse.properties.buyer.properties = {locale} only; the definitions contain no message, thread or conversation read type
- https://developer-docs.amazon/sp-api/docs/messaging-api.md ('Workflow for sending a message', step 8: Amazon emails a message from the seller to the buyer)
- https://developer-docs.amazon/sp-api/docs/notification-type-values.md (26 '## ' notification types, ACCOUNT_STATUS_CHANGED ... TRANSACTION_UPDATE; none for buyer messages) and https://github.com/amzn/selling-partner-api-models/tree/main/schemas/notifications (no messaging schema)
- models/solicitations-api-model/solicitations.json info.description ('Buyers cannot respond to solicitations sent by this API')
- models/support-api-model/support_2025-02-01.json paths listCases/getCase/listContacts and https://developer-docs.amazon/sp-api/docs/support-api.md (selling-partner support cases with Amazon, not buyers)
- https://developer-docs.amazon/sp-api/docs/roles-in-the-selling-partner-api.md#buyer-communication (counter-signal: says 'messaging to and from Amazon buyers', but every example operation is seller-to-buyer)

### `perguntas`: HOLDS → `nao`

**Proposed:** nao

**Row comment:**

```ts
// 'nao': no buyer Q&A resource in any SP-API model or docs-index section ('question' only hits developer FAQs);
// Customer Feedback = review/return insights, Support = seller<->Amazon cases.
// src: github.com/amzn/selling-partner-api-models/tree/main/models; developer-docs.amazon/sp-api/llms.txt
```

**Reasoning:** I tried to refute this and could not. No model directory, docs-index section or notification type exposes pre-sale buyer questions on a product or offer, or a way to answer them. The 'question' matches in the SP-API docs index are all developer FAQ pages. The nearest candidates are not Q&A: the Customer Feedback API returns aggregated review and return-topic insights per ASIN or browse node; the Support API covers the seller's own cases with Amazon; Messaging and Solicitations are post-order, seller-to-buyer only, and keyed on amazonOrderId. 'nao' therefore holds as evidence of absence across the full official model and docs index as of 2026-10-14.

**Citations:**
- https://github.com/amzn/selling-partner-api-models/tree/main/models (all 55 model directories, from amazon-warehousing-and-distribution-model to vendor-transaction-status-api-model; none is a buyer Q&A / customer-questions API)
- https://developer-docs.amazon/sp-api/llms.txt (every 'Documentation:' and 'API Reference:' section; the only 'question' hits are FAQ pages, e.g. 'Frequently Asked Questions', 'Feeds API FAQ'; no Q&A or answer API)
- models/customer-feedback-api-model/customerFeedback_2024-06-01.json info.description ('information about customer reviews and returns at both the item and browse node level'); paths are review/return topics and trends, plus browse node
- models/support-api-model/support_2025-02-01.json paths listCases/getCase/listContacts (the selling partner's support cases with Amazon)
- models/messaging-api-model/messaging.json and models/solicitations-api-model/solicitations.json (seller-to-buyer, post-order only, keyed on amazonOrderId)
- https://developer-docs.amazon/sp-api/docs/notification-type-values.md (no Q&A notification type among the 26)

