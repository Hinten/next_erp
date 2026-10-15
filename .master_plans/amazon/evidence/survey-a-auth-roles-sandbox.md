# Survey A: credentials, app registration, roles, limits, sandbox, data protection, official MCPs

Provenance: read-only research dated 2026-10-14 for the Amazon SP-API marketplace integration (master plan `../amazon-marketplace-integration.md`). Scope: LWA, self-authorization vs website OAuth, client-secret rotation, roles and restricted roles, RDT, rate limits, grantless operations, the sandbox, the Data Protection and Acceptable Use policies, and the official MCP packages. Sources: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there), the official OpenAPI models (github.com/amzn/selling-partner-api-models) and, where stated, docs.aws.amazon.com. No live SP-API or AWS endpoint was called. Every claim carries its citation; UNKNOWN marks what the documentation does not settle. Facts about the legacy application's code are kept in the operator's private notes and are not part of this file.

---

# Amazon SP-API: credentials, app registration, roles, limits, sandbox, data protection and the official MCPs (Brazilian ERP, Amazon.com.br)

Research date: 2026-10-14. Everything below is read-only research. No live SP-API or AWS endpoint was called, nothing was signed into, and no form was submitted.

**Citation legend**
- `[D:slug]` = https://developer-docs.amazon/sp-api/docs/slug
- `[CL:slug]` = https://developer-docs.amazon/sp-api/changelog/slug
- `[M:file → path]` = https://raw.githubusercontent.com/amzn/selling-partner-api-models/main/models/... plus the JSON path

Most docs pages show `updatedAt` 2026-09-09. Pages with a different date are flagged where they are cited.

---

## 1. Login with Amazon (LWA)

**Token endpoint**
- `POST https://api.amazon.com/auth/o2/token` [D:connecting-to-the-selling-partner-api] (updatedAt 2026-09-09T22:32:25Z).
- Seller-authorized calls use `grant_type=refresh_token` with `refresh_token`, `client_id` and `client_secret`.
- Grantless calls use `grant_type=client_credentials` with `scope`, `client_id` and `client_secret` (same page).

**Access-token lifetime**
- "An LWA access token expires one hour after it is issued." The example shows `"expires_in":3600` [D:connecting-to-the-selling-partner-api].
- The self-authorization page says the value is "typically 3600" [D:self-authorization].

**Refresh-token lifetime: no fixed lifetime is documented (UNKNOWN)**
- The token is called "a long-lived credential" [D:self-authorization].
- Expiry in practice comes only from the deactivation rule. The FAQ says Amazon "periodically deactivates application authorizations that have not been renewed by the seller in more than 365 days and have not made an API call within this time frame". Sellers "can reactivate at any time through their Manage Your Apps page" [D:seller-authorizations-faq], which was added 2026-08-26 according to [D:sp-api-release-notes].
- The FAQ does not distinguish public apps from private apps.
- [D:reactivate-authorizations] does not say whether the same refresh token works again after reactivation (UNKNOWN).

**Self-authorization flow for a private seller app** [D:self-authorization] (updatedAt 2026-09-09T23:45:58Z)
- Sign in to one of:
  - Solution Provider Portal → Manage Authorizations sign-in link
  - Seller Central → Apps and Services → Develop Apps
  - Vendor Central → Integration → API Integration
- On the Authorize application page, "Choose **Authorize app** for each selling partner account".
- What it returns: a refresh token (`Atzr|…`).
- Who can do it: "you must be the Primary User of that account."

**Several tokens for the same seller**
- "Each time you choose **Authorize app**, a new refresh token appears."
- "Generating a new refresh token doesn't invalidate previous refresh tokens." [D:self-authorization]
- So an app can hold several valid refresh tokens for the same seller, and minting a new one does not revoke the old one.

**Authorization limits** [D:application-authorization-limits]
- Private app: "Maximum of 10 self-authorizations."
- Public unlisted seller app: 25 OAuth authorizations. Listed app: unlimited.
- "After your application reaches its authorization limit, you can't add additional authorizations."
- Whether each extra token for the same seller counts against the 10 is UNKNOWN.

**12-month renewal**
- Public apps: "Reauthorization is required annually or if you want existing users… to authorize new roles" [D:authorizing-selling-partner-api-applications]. The selling partner "must reauthorize your [public] application every 365 days" [D:reauthorize-applications] (updatedAt 2026-09-30).
- Private apps: "Reauthorization is required when you add new roles" [D:authorizing-selling-partner-api-applications]. No annual rule is stated for private apps beyond the 365-day no-renewal-and-no-API-call deactivation above.

## 2. LWA client-secret rotation

**Rotation is mandatory**
- "You must rotate your LWA credentials (client secrets) for all applications every 180 days." [D:rotating-your-apps-lwa-credentials] (updatedAt 2026-09-09T22:31:20Z)
- Notice: "You receive a notification 90 days before your LWA credentials rotation deadline." (same page)

**Grace period**
- "Your old credentials expire seven days after you generate new credentials." (same page)
- The FAQ says "you can use your old LWA credentials for seven days after you rotate them" [D:lwa-credentials-faq].
- The rotate page says "The credential you use to call `rotateApplicationClientSecret` expires after seven days." [D:rotate-your-application-client-secret]

**What breaks if nobody rotates**
- "your application returns an error when it calls the SP-API" [D:rotating-your-apps-lwa-credentials].
- The FAQ calls it the "loss of ability to make any API calls" [D:lwa-credentials-faq].
- "If you don't update your credential before it expires, your application will stop working." [D:rotate-your-application-client-secret]

**Application Management API v2023-11-30**
- Operation: `POST /applications/2023-11-30/clientSecret` (`rotateApplicationClientSecret`). It is grantless with role "None" [D:application-management-api], [D:role-mappings].
- Model: "a new client secret is generated and sent to the developer-registered queue", and "Developers must register a destination queue in the developer console before calling this operation" [M:application-management-api-model/application_2023-11-30.json → paths./applications/2023-11-30/clientSecret.post.description].
- Rate: 0.0167 rps, burst 1.
- A 400 response means "Application is not enrolled for rotation notification".
- The LWA scope is `sellingpartnerapi::client_credential:rotation` [D:connecting-to-the-selling-partner-api].

**Notifications**
- To receive the new secret: "In the Application Client New Secret row, enter the SQS queue where you want to receive the new credential." [D:rotate-your-application-client-secret]. You then read it from SQS with `ReceiveMessage`.
- The exact notificationType string `APPLICATION_OAUTH_CLIENT_NEW_SECRET` was **not found** in any page I read, including [D:notification-type-values] (UNKNOWN). The secret payload fields are UNKNOWN too.
- The expiry warning notification is `APPLICATION_OAUTH_CLIENT_SECRET_EXPIRY`:
  - payload `applicationOAuthClientSecretExpiry{clientId, clientSecretExpiryTime, clientSecretExpiryReason:"PERIODIC_ROTATION"}`, payloadVersion 2023-11-30
  - delivered by SQS only
  - SQS policy principal `437568002678` [D:set-up-credential-rotation-notifications] (updatedAt 2026-09-09T22:38:58Z)
- How many days before expiry that notification is sent is not stated beyond "approaching" (UNKNOWN). The 90-day figure above comes from the rotating page.

## 3. App registration and app types

**App types** [D:sp-api-registration-overview]
- Private seller apps: self-authorized, for your own organization only.
- Private vendor apps.
- Public seller and vendor apps: authorized through OAuth and listed in the Appstore.
- Private seller registration needs a "professional selling account".

**Developer profile** [D:register-as-a-private-developer] (updatedAt 2026-09-09T23:08:24Z)
- Where: Seller Central → Apps and Services → Develop Apps, or Solution Provider Portal (SPP) → Settings → Developer Profile.
- What it collects: contact information, data access ("private developer"), roles, use cases, security controls, and agreement to the SPP Agreement, AUP and DPP.
- If Amazon contacts you, you "must respond within five days" or the case is closed.

**Review time** [D:onboarding-step-3-create-a-developer-profile]
- Non-restricted roles: "typically takes one to two weeks."
- Restricted roles: "a three-stage review process" covering business review, security review, and a technical review with an Amazon solution architect.
- The service-provider roles page says "Review usually takes at least two weeks" [D:service-provider-onboarding-step-5].

**Registering an app**
- SPP → Develop Apps → Developer Central page → "Add new app client" [D:registering-your-application].
- "You can only select roles that Amazon approved for your developer account" [D:onboarding-step-7-register-your-first-production-application].
- Apps are created in draft status. OAuth redirect URIs are for public apps only, and localhost is not accepted.
- No IAM ARN field is mentioned anywhere.
- Number of apps per developer profile: UNKNOWN (not documented).

**Recent changes**
- A "Sandbox" application type can be created while your profile is still under review [D:onboarding-step-4-register-your-first-sandbox-application].
- 2025-05-28: guide published for moving from Service Provider Central to SPP [D:sp-api-release-notes].
- From 2026-08-25: updated DPP, SPPA and AUP [CL:sp-api-updates-solution-provider-portal-agreement-and-policy-updates-br-store-shippertrackingnumber-validation-and-listings-attribute-and-enumeration-values-changes].
- From 2026-08-19: simplified service-provider authorization. Public service providers only; nothing about private apps [CL:sp-api-updates-simplified-authorization-for-service-providers-external-fulfillment-sandbox-changes-and-multi-invoice-support-changes-for-brazil].

## 4. Roles

**Role list** [D:roles-in-the-selling-partner-api] (updatedAt **2026-10-13**)
- Account Information Service Provider
- Amazon Fulfillment
- AWD
- Brand Analytics
- Buyer Communication
- Buyer Solicitation
- **Direct-to-Consumer Shipping (Restricted)**
- Finance and Accounting
- Inventory and Order Tracking
- Notifications in Seller Central
- PISP
- Pricing
- Product Listing
- **Professional Services (Restricted)**
- Selling Partner Insights
- **Selling Partner Support (Restricted)**
- **Tax Invoicing (Restricted)**
- **Tax Remittance (Restricted)**

That is 5 restricted roles.

**Applying for restricted roles**
- Restricted roles mean "you must provide additional information about your data use and security controls" [D:roles-in-the-selling-partner-api].
- Choosing them expands the form with use-case questions [D:onboarding-step-3-create-a-developer-profile].
- Public developers face Phase 1, "Business verification…", then Phase 2, "Data security assessment", which examines "data flow architecture and implementation of PII protection controls" [D:register-as-a-public-developer].
- Annual re-review: not stated (UNKNOWN). The DPP does allow audits on request (see §9).

**Operation → required role** (at least one is needed) [D:role-mappings] (updatedAt 2026-10-13). "Full-12" means: Amazon Fulfillment, Buyer Communication, Buyer Solicitation, DTC Shipping (R), Finance and Accounting, Inventory and Order Tracking, Pricing, Product Listing, Professional Services (R), Selling Partner Insights, Tax Invoicing (R), Tax Remittance (R).

| API | Operation(s) | Role(s) |
|---|---|---|
| Orders v2026-01-01 | searchOrders, getOrder | Full-12 |
| Orders v0 (deprecated) | getOrders, getOrder, getOrderAddress, getOrderBuyerInfo, getOrderItems, getOrderItemsBuyerInfo | Full-12 |
| Orders v0 | confirmShipment | Inventory and Order Tracking; DTC Shipping (R) |
| Orders v0 | updateShipmentStatus | Inventory and Order Tracking |
| Orders v0 | getOrderRegulatedInfo, updateVerificationStatus | DTC Shipping (R) |
| Easy Ship v2022-03-23 | all 5 operations | DTC Shipping (R) |
| Shipment Invoicing v0 (NA) | getShipmentDetails, submitInvoice, getInvoiceStatus | Tax Invoicing (R) |
| Invoices v2024-06-19 (NA) | all, including the government-invoice operations | Tax Invoicing (R) |
| Listings Items v2021-08-01 | all | Inventory and Order Tracking; Product Listing |
| Feeds v2021-06-30 | create/cancel/document operations | Amazon Fulfillment, Brand Analytics, DTC (R), Inventory and Order Tracking, Pricing, Product Listing, Tax Invoicing (R); getFeed/getFeeds add Selling Partner Insights |
| Reports v2021-06-30 | all | Full-12 |
| Notifications v1 | destination operations, getSubscriptionById, deleteSubscriptionById | None (grantless) |
| Notifications v1 | createSubscription, getSubscription | the role tied to the notification type |
| Product Type Definitions v2020-09-01 | both | Inventory and Order Tracking; Product Listing |
| Catalog Items v2022-04-01 | both | Product Listing |
| Product Pricing v0 | all | Pricing; Product Listing |
| Product Pricing v2022-05-01 | all | Pricing |
| Finances v0 | listFinancialEventGroups, listFinancialEventsByGroupId, listFinancialEventsByOrderId | Finance and Accounting (AISP is also accepted for the first two, EU only) |
| Finances v0 | listFinancialEvents | Finance and Accounting (Amazon Fulfillment also accepted in NA/FE) |
| Finances v2024-06-19 | all | Finance and Accounting |
| Messaging v1 | most operations | Buyer Communication |
| Tokens v2021-03-01 | createRestrictedDataToken | Full-12 |

**Orders v2026 includedData → PII gating** [D:access-orders-pii] (updatedAt 2026-09-30). Brazil falls in the non-US/JP/SG table.
- The enum, per [M:orders_2026-01-01.json → paths./orders/2026-01-01/orders.get.parameters includedData]: BUYER, RECIPIENT, PROCEEDS, EXPENSE, PROMOTION, CANCELLATION, FULFILLMENT, PACKAGES, TAX, PAYMENT, FULFILLMENT_ORDERS.
- `buyer.buyerEmail` (BUYER): **DTC Shipping, merchant-fulfilled only.**
- `buyer.buyerName` (BUYER), and restricted address fields `name`, `addressLine1-3`, `extendedFields` (RECIPIENT):
  - FBA: Tax Invoicing or Tax Remittance
  - FBM: "Tax Invoicing (Restricted), Tax Remittance (Restricted), or Direct-to-Consumer Shipping (Restricted)"
  - Order status must be UNSHIPPED, PARTIALLY_SHIPPED or SHIPPED.
- `deliveryAddress.phone`: DTC, FBM only, and "may be suppressed".
- Not restricted: `postalCode`, `city`, `districtOrCounty`, `countryCode`.
- `fulfillment.packing.giftOption.giftMessage` (FULFILLMENT): DTC, FBM.
- **`order.tax.taxRegistrations`** (TAX):
  - FBA and FBM: Tax Remittance or Tax Invoicing.
  - **DTC Shipping alone: No.**
  - [D:access-orders-pii] does not name the includedData value for this field; TAX is inferred from the field path and the enum.
- PROCEEDS, EXPENSE, PROMOTION, CANCELLATION, PACKAGES, PAYMENT and FULFILLMENT_ORDERS have no field-level PII gating documented (UNKNOWN). This includes the BR-only `PaymentExecution.acquirerId`, `cardBrand` and `authorizationCode`.

**Which role unlocks the Brazilian buyer's CPF/CNPJ and the shipping address**
- **CPF/CNPJ:** Tax Invoicing (R) or Tax Remittance (R), not DTC Shipping. The model's `OrderTaxRegistration.taxRegistrationType` lists possible values including `CPF` and `CNPJ` [M:orders_2026-01-01.json → definitions.OrderTaxRegistration.properties.taxRegistrationType].
- **Shipping address (FBM):** any one of DTC Shipping, Tax Invoicing or Tax Remittance.
- **Buyer email and phone:** DTC Shipping only.
- **Orders v0:** `BuyerInfo.BuyerTaxInfo` is "only available for business orders in the Brazil, Mexico and India marketplaces". BuyerInfo is restricted and needs an RDT [M:ordersV0.json → definitions.OrderBuyerInfo.properties.BuyerTaxInfo; definitions.Order.properties.BuyerInfo].

## 5. Transport

**SigV4 / IAM: no longer required**
- "Starting October 2, 2023, SP-API no longer requires the use of AWS IAM or AWS Signature Version 4." Requests that still carry SigV4: "we'll disregard the signature and proceed with LWA authorization" [CL:sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4]. No post date was visible.
- Headers: `host`, `x-amz-access-token`, `x-amz-date`, and `user-agent`, which is mandatory [D:connecting-to-the-selling-partner-api].

**Host and marketplace**
- North America (which includes Brazil): `https://sellingpartnerapi-na.amazon.com`, AWS region us-east-1 [D:sp-api-endpoints].
- Brazil marketplace ID: `A2Q3Y263D00KWC` [D:store-identifiers].

**Restricted Data Token (RDT)**
- Orders v2026: "Accessing PII with the Orders API v2026-01-01 does not require a Restricted Data Token (RDT)." [D:access-orders-pii]
- Operations that still list an RDT requirement [D:tokens-api] (updatedAt 2026-09-09T22:49:17Z):
  - Orders v0: getOrders, getOrder, getOrderItems, getOrderRegulatedInfo, getOrderAddress, getOrderBuyerInfo, getOrderItemsBuyerInfo
  - Easy Ship: createScheduledPackageBulk
  - Merchant Fulfillment: getShipment, cancelShipment, cancelShipmentOld, createShipment
  - Reports: getReportDocument (restricted reports)
  - **Shipment Invoicing: getShipmentDetails**
  - Shipping: getShipment
  - Vendor Direct Fulfillment operations
- RDT lifetime: `expiresIn` is described only as "lifetime… in seconds"; the actual value is UNKNOWN [M:tokens_2021-03-01.json → definitions.CreateRestrictedDataTokenResponse.properties.expiresIn].
- `dataElements` values: buyerInfo, shippingAddress, buyerTaxInformation.
- createRestrictedDataToken rate: 1 rps, burst 10.

## 6. Rate limiting [D:usage-plans-and-rate-limits]

**Model**
- Token bucket. Each operation has a rate and a burst, and you are limited by whichever you hit first.
- "Usage plans are specific to the application and selling partner pair."
- Dynamic plans are "automatically adjusted to each selling partner based on the current and historical business needs". "Rates do not dynamically increase because an application makes API requests more frequently."

**Header and 429**
- `x-amzn-RateLimit-Limit` is returned "if available", only for 20x, 400 and 404 responses. "you must not depend on this header being present".
- "A 429 is a retry-able status code."

**Where limits are published**
- In each operation's reference page, in per-API rate-limit pages (added 2025-01-29 per [D:sp-api-release-notes]), and in the model descriptions.

**Orders limits** [D:orders-api-rate-limits]
- v2026 **searchOrders: 0.0056 rps, burst 20.** That is about one request every 3 minutes once the burst is used up.
- v2026 getOrder: 0.5 rps, burst 30.
- v0 getOrders: 0.0167 rps, burst 20. confirmShipment: 2 rps, burst 10.

## 7. Grantless operations [D:grantless-operations]

- Definition: "an operation that you can call without explicit authorization from a selling partner."
- The list:
  - Notifications: createDestination, deleteDestination, deleteSubscriptionById, getDestination, getDestinations, getSubscriptionById
  - Tracking: getShipmentTracking
  - getAuthorizationCode (the Authorization API v1 was announced as deprecated on 2024-01-31 per [D:sp-api-release-notes]; its current status is UNKNOWN)
  - rotateApplicationClientSecret
- How to get a grantless token: call the LWA token endpoint with `grant_type=client_credentials` and a `scope`:
  - `sellingpartnerapi::notifications`
  - `sellingpartnerapi::client_credential:rotation`
  - `sellingpartnerapi::shipments:track`

  [D:connecting-to-the-selling-partner-api]
- Destinations can be either `sqs` (ARN) or `eventBridge` (accountId and region) [M:notifications.json → definitions.DestinationResourceSpecification].
- ORDER_CHANGE is documented as an SQS workflow [D:notification-type-values].

## 8. Sandbox [D:sp-api-sandbox] (updatedAt 2026-09-09T22:32:02Z)

**Static vs dynamic**
- Static "works like many mock-based frameworks". It pattern-matches against `x-amzn-api-sandbox` in the model, and all required parameters must still be present.
- Dynamic "proxies (forwards) calls to a sandbox backend" and can be stateful.

**How to call it**
- NA host: `https://sandbox.sellingpartnerapi-na.amazon.com`.
- Throttling: 5 rps, burst 15.
- RDT: "you must get the RDT from the production environment and pass it to your sandbox call".
- Credentials: in SPP, "View sandbox credentials", then "Create Token" gives an `Atzr|` refresh token. Exchange it at the normal LWA endpoint [D:onboarding-step-5-make-your-first-call-to-the-sp-api-sandbox]. A Sandbox app type exists for this [D:onboarding-step-4-…].
- Whether production-app credentials work against the sandbox host is UNKNOWN.
- "AI" in the support table refers to a locally deployed Sample AI Sandbox (localhost:9001, uses Bedrock).

| API | Support | What it can prove / cannot prove |
|---|---|---|
| Orders v2026-01-01 | Static, AI | Has a **BR scenario**: searchOrders with `marketplaceIds=A2Q3Y263D00KWC`, `createdAfter=2024-12-20T00:00:00Z`, includedData BUYER, RECIPIENT, PROCEEDS, FULFILLMENT, TAX, PAYMENT. It returns `extendedFields` and taxRegistrations (VAT and CNPJ, no CPF). getOrder `171-9876543-2109876` is also BR [M:orders_2026-01-01.json → paths…x-amzn-api-sandbox]. Proves parsing and request shape. Cannot prove role-based redaction or real data. |
| Orders v0 | Not listed in the table, but the model has static scenarios (TEST_CASE_200, US/FR, no BR seen) | Shape only |
| Easy Ship | Static (scenarios in other marketplaces) | Easy Ship docs do not list Brazil as a supported store [D:easy-ship-api] |
| Shipment Invoicing v0 | Static (`shipmentId1`, BadShipId) | Request and response shape only |
| Invoices v2024-06-19 | Static (all examples use A2Q3Y263D00KWC) | Shape only |
| Listings Items | Static, AI | Shape only |
| Feeds | Static | Shape only |
| Reports | Static, AI | Shape only |
| Notifications | Static, plus `sendTestNotification` (dynamic, sandbox-only) | Whether it delivers to your own queue is UNKNOWN |
| Product Type Definitions | Static, AI | Shape only |
| Catalog Items | Static, AI | Shape only |
| Product Pricing v2022-05-01 | Static, AI | Shape only |
| Finances v2024-06-19 | Static | Shape only |

Across all of them, the sandbox can prove LWA exchange, header handling, serialization and 400 handling. It cannot prove role grants, PII visibility, production rate limits, or seller-specific data.

## 9. Data Protection Policy and Acceptable Use Policy

The policies were updated effective **2026-08-25**: the DPP "now requires a web application firewall for internet-facing endpoints" and adds storage encryption, screen-lock and expanded scanning rules [CL:sp-api-updates-solution-provider-portal-agreement…]. Policy links are on [D:policies-and-agreements] (updatedAt 2026-09-16). The policy pages themselves show no effective date.

DPP quotes are from https://sellercentral.amazon.com/mws/static/policy?documentType=DPP&locale=en_US.

**Retention**
- §2.1: "Solution Provider will retain PII for no longer than 30 days after order delivery", "and only for the purpose of… (i) fulfill orders, (ii) calculate and remit taxes, (iii) produce tax invoices…, (iv) meet legal requirements".
- "may retain data for over 30 days after order delivery only if required by law".
- "Order delivery" is not defined.

**Encryption**
- §2.4: "must encrypt all PII at rest using at least AES-128 or RSA with 2048-bit key size or higher."
- In transit: "TLS 1.2 or higher".
- §2.3.2: do not store PII on removable media, personal devices, or "unsecured public cloud applications" unless it is encrypted.

**Logging**
- "Retain logs for at least twelve (12) months"
- "Ensure logs do not contain PII unless necessary to meet legal requirements"
- "Review logs in real-time… or at least every 2 weeks."

**Access control**
- "must require Multi-Factor Authentication (MFA) for all user accounts"
- "denied by default… need-to-know"
- lockout after 10 failed attempts
- passwords of at least 12 characters
- screen lock after at most 15 minutes

**Incident reporting**
- Notify "(via email to security@amazon.com) within twenty four (24) hours".
- Review the incident plan "every six (6) months".

**Audits**
- "Amazon may audit, assess and inspect the books, records, facilities, operations, and security…"
- Must certify compliance in writing on request.

**Vulnerability management**
- WAF or equivalent
- scans every 30 days
- pentest every 365 days
- critical issues fixed in 7 days, high in 30
- annual third-party risk assessments (§2.8)

**AUP** (https://sellercentral.amazon.com/mws/static/policy?documentType=AUP&locale=en_US)
- §4.1: "Do not use Personally Identifiable Information about Customers for any purposes other than merchant-fulfilled shipping… or to meet legal requirements, including tax and regulatory requirements."
- §4.2: no marketing to Amazon customers.
- §4.4: "Do not aggregate data across Authorized Users' businesses".
- §4.7: share only with parties that have equal-or-stricter security.
- §2.11 (quality standard): submissions must be "accurate, policy-compliant".
- Violations "may result in suspension or termination".

## 10. Official MCPs

**(a) `@amazon-sp-api-release/sp-api-dev-mcp`**
- Package facts (npm registry): version 1.0.5, published 2026-08-18; created 2026-05-12; maintainers have @amazon.com addresses; Apache-2.0.
- The repo's `package.json` is named `@amazon-sp-api-release/dev-mcp` 0.0.1. That mismatch is unexplained.
- Dev Assistant tools:
  - `sp_api_reference`: "local vector search (no remote API calls)", "Ships with a pre-built index", cached in `~/.sp-api-dev-mcp/contextual-search-tool/`
  - `sp_api_explore_catalog`
  - `sp_api_execute`: live calls
  - `sp_api_generate_code_sample`: its `clone_repo` action writes to `~/.sp-api-dev-mcp`
  - `sp_api_migration_assistant`
  - `sp_api_optimize`
- Credentials: "SP-API credentials are only needed when using `sp_api_execute`."
- Workflow server: builder, interpreter and callback tools. Its task states allow GET, POST, PUT and DELETE, so it **can write live**. Its examples include feed submission.
- The sample config puts **`sp_api_execute` in `autoApprove`**, so live calls would run without a confirmation prompt.
- Support status: "not supported products in their own right, but educational examples".

Sources: https://github.com/amzn/selling-partner-api-samples/tree/main/use-cases/sp-api-dev-mcp (README, `sp-api-dev-assistant-mcp-server/README.md`, `sp-api-workflow-mcp`) and https://registry.npmjs.org/@amazon-sp-api-release/sp-api-dev-mcp

**(b) Remote connector `https://sellingpartner-ai.amazon.com/mcp`**
- It is Amazon-official:
  - It is registered by `amzn/selling-partner-agentic-toolkit/.mcp.json` as the "Amazon Selling Partner Connector (MCP server)".
  - Amazon's announcement, https://www.aboutamazon.com/news/innovation-at-amazon/seller-assistant-plugin-amazon-quick-claude (no date shown), says "now available in beta for sellers in Amazon's U.S. stores, with international expansion to follow". It does **not** mention MCP or the URL.
  - https://sellingpartners.aboutamazon.com/accelerate-2026-recap (2026-09-29) says "starting with… Claude and… Quick in the U.S."
- No developer-docs.amazon page mentions it.
- Auth: "the standard Seller Central OAuth consent flow"; the assistant "can only use tools allowed by your Seller Central roles" (toolkit README).
- Tools listed on the Claude directory page include `call_read_only_tool`, **`call_write_tool`**, `sellerAssistant_sellerAssistantCreate`, `accounts_getMerchants` and others [third-party listing: https://claude.com/marketplace/connectors/amazon-selling-partner].
- It **can write** to the seller account. Writes are "drafted for your approval" and "never executed without your explicit approval" (toolkit README).
- Brazil support: UNKNOWN. The announcement says U.S. only.

**(c) `github.com/amzn/selling-partner-agentic-toolkit`**
- It exists: a Claude plugin with 12 skills and 3 commands. `plugin.json` says v1.0.0, Beta, Apache-2.0.
- It contains no docs-lookup tool. It targets live seller accounts.

**Recommendation for documentation-only use (my inference, not from the docs)**

The READMEs do not show a `claude mcp add` line. This one is derived from their npx config:

```
claude mcp add sp-api-dev-assistant -- npx -y @amazon-sp-api-release/sp-api-dev-mcp sp-api-dev-assistant-mcp-server
```

- Set **no** `SP_API_*` environment variables.
- Do not autoApprove `sp_api_execute`; deny it in permissions.
- Do not install the workflow server, the remote connector, or the agentic toolkit for planning.

Risk: the remote connector and the workflow server act on a real Seller Central account. A mistaken approval, or an auto-approved `sp_api_execute`, can change listings, prices or feeds in production. A connector that receives buyer PII also falls under the DPP/AUP obligations in §9.

---

## Open questions only a live call settles

1. **Does a private app keep valid refresh tokens beyond 365 days if it calls the API daily?** The deactivation rule implies yes (it needs both no renewal and no calls), but private apps are not covered explicitly. It matters for long-running tokens. Sandbox: **no**.
2. **Does each "Authorize app" click for the same seller count against the 10 self-authorization limit?** It matters for rotating tokens. Sandbox: **no**, it is an SPP UI behaviour.
3. **Exact SQS payload and notificationType for the new secret, and how many days before expiry the expiry notice arrives.** Needed to automate rotation. Sandbox: **no** (rotateApplicationClientSecret only has a static 400 response).
4. **Do BR FBM orders actually return CPF (not just CNPJ) in `tax.taxRegistrations` with Tax Invoicing, and are the BR PAYMENT fields gated?** This is core to issuing NF-e. Sandbox: **no**, because the static sample has only VAT and CNPJ entries and no role gating.
5. **Is Tax Invoicing (Restricted) granted to a private BR seller developer, and how long does it take?** Sandbox: **no**.
6. **The actual searchOrders and getOrder usage plan for this seller.** The header is optional and plans may be dynamic. Sandbox: **no** (it is fixed at 5 rps, burst 15).
7. **Can production-app LWA tokens call the sandbox host, or only Sandbox-type apps?** Sandbox: **yes**, a single sandbox call settles it.
8. **Does `sp_api_reference` ever fetch remote documentation or refresh its index?** That determines how fresh it is. Not an SP-API question: inspect the package source or watch its network traffic.
9. **Will the remote Selling Partner connector work for a Brazil seller account?** Sandbox: **no**.
