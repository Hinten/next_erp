# Amazon (SP-API): master plan for the marketplace integration

Date: 2026-10-14 · Method: `marketplace-integration` skill, Phases 0–2 · Tracker: #1923 (opened 2026-10-15 with one issue per pre-cutover step, #1924–#1941; D14).
Evidence: the official SP-API documentation (developer-docs.amazon; developer-docs.amazon.com redirects there; pages dated through 2026-10-13), the official OpenAPI models (github.com/amzn/selling-partner-api-models, commits through 2026-09-30), docs.aws.amazon.com for the AWS relay, and one retired Amazon LATAM page reviewed claim by claim (`evidence/latam-dba-review.md`). Research steps:
- 6 documentation surveys (A auth/roles/sandbox · B notifications/AWS · C Orders v2026 · D NF-e/Easy Ship · E listings/stock · F price/payments/messaging);
- 2 gap investigations (BR Easy Ship; seller id and the authorization flow);
- an adversarial verification of every caps field;
- the legacy surveys, kept private (§3).

Citation conventions:
- `D:<slug>` = `https://developer-docs.amazon/sp-api/docs/<slug>`; `R:<slug>` = `.../sp-api/reference/<slug>`; `CL:<slug>` = `.../sp-api/changelog/<slug>`.
- `M:<file> <json path>` = a model file under `amzn/selling-partner-api-models/main/models/` (or `schemas/notifications/`).
- Legacy facts are cited as "legacy code", never by file and line.
- Each source of a business rule is labelled **[docs]**, **[model]**, **[LATAM, retired]** (the retired Latin America site, §1.0), **[live-proven, legacy]** (exercised daily by the working legacy integration; not yet exercised by this code), **[operator]** (confirmed by the store owner) or **[ERP rule]** (re-derived from operator intent).

---

## 0. Executive summary

- **Official MCP: none is used.**
  - Amazon publishes `@amazon-sp-api-release/sp-api-dev-mcp` (in `amzn/selling-partner-api-samples`), but describes it as "not supported products in their own right, but educational examples".
  - Its docs search runs on a pre-built local index with no documented refresh, and its `sp_api_execute` tool makes live calls.
  - The remote "Amazon Selling Partner" connector acts on a real seller account, can write, and is announced for the US.
  - Decision (2026-10-14): the source of truth is the official documentation plus the OpenAPI models. Phase-3 lookups use `evidence/amazon-doc.mjs`, which prints an operation, a definition, the sandbox examples or a notification schema straight from the models repository. It never calls the SP-API.
- **Scope (D1–D3).**
  - Amazon blocks the cutover, but only on the **order side**. There is no dual run.
  - **PRE-cutover:**
    - conta + LWA connect;
    - push intake + a backstop poll;
    - order and payment import;
    - NF-e upload → automatic Easy Ship (DBA) scheduling → a ZPL label fetched on demand at print time;
    - stock (one patch per SKU for sale-driven deltas; `JSON_LISTINGS_FEED` for bulk pushes and the daily reconcile);
    - a manual price push;
    - a read-only listing **link** (no produto creation);
    - the `int_frete` binding;
    - the web screens for all of the above.
  - **POST-cutover:** publishing and editing, listing and product notifications, returns and claims, and everything else.
- **The five architecture answers** (§1.1):
  1. Amazon **signs nothing**. The receiver authenticates our own AWS relay's API-key header and `NotificationMetadata.ApplicationId`, and fails closed.
  2. **Push exists, but only into the developer's AWS.** `ORDER_CHANGE` is **SQS-only**, so the transport is SQS → EventBridge Pipe → API destination → our receiver (D4). A 15-minute `searchOrders` poll is the backstop.
  3. **Stock has two paths, and at ~20,000 SKUs both are needed.** A sale-driven delta goes out as one synchronous `patchListingsItem` (merge) per SKU. A bulk push (the daily reconcile's drift, an operator "send all", the window's first push) goes out as one asynchronous `JSON_LISTINGS_FEED` (≤ 25,000 messages), because Amazon recommends the feed above ~1,500 items / 5 min. The feed needs a submission record plus a result poll, which no channel here has written (step 12a).
  4. **A listing is a family:** a non-buyable parent SKU plus child SKUs (`parentage_level`, `child_parent_sku_relationship`, `variation_theme`).
  5. **The buyer's fiscal identity is inline in `getOrder`, but gated** by role (CPF/CNPJ need Tax Invoicing) and by status (name and address only from UNSHIPPED).
- **Brazilian fulfilment chain:**
  - The NF-e upload is the BR-only **Delivery by Amazon API v2022-07-01** **[docs]**.
  - Pickup scheduling with a ZPL label is `createScheduledPackageBulk` (Easy Ship v2022-03-23, RDT). For Brazil it is described only by Amazon's **retired LATAM page** **[LATAM, retired]** and run daily by the working legacy integration **[live-proven, legacy]**. The global Easy Ship store table omits Brazil.
  - The label zip URL lives about 3 minutes, and the same call for an already-scheduled order returns the existing schedule (no rescheduling) with a fresh URL **[LATAM, retired] + [operator]**.
  - ⇒ The backend schedules once, after the NF-e is accepted, and **stores no label**. When the operator prints, the server only fetches the label link: for a scheduled order the bulk call returns the existing schedule and a fresh link, with no rescheduling. It downloads the zip inside the same request and returns the ZPL to the print agent (D12, step 15). This is how the legacy integration prints today.
- **Hard deadlines outside our control:**
  - **Orders v0 reads are removed on 2027-03-27** **[docs]**. The legacy reads orders through v0, so the cutover must happen before that date.
  - The LWA client secret must be **rotated every 180 days**, and the app shares it with the legacy until the cutover.
  - A public app must be **reauthorized every 365 days**.
- **Testing (D11): mock only, as LI D17.**
  - No code in this repository calls Amazon before the cutover.
  - Fixtures come from the models' official `x-amzn-api-sandbox` examples (the Orders model has BR cases) plus owner captures run through a sanitizer.
  - Every write ships behind an OFF valve with a dry-run and a canary list. The first live calls happen in the window.
- **The corpus constrains two deterministic ids**, reproduced byte for byte (§3):
  - pedido = `sha256("<contaId>-<AmazonOrderId>")`;
  - pagamento = **the same digest**.

  **No order mirror exists, and none is invented.**
- **Dropped or deferred:**
  - chat and Q&A (`'nao'`);
  - size charts and native kits (`'nao'`; the ERP computes kit quantity);
  - the stuck-reservation sweep (Amazon cancels; the event carries it);
  - returns, refunds and claims (POST, P4: refund and return detection done properly, replacing D17's interim inference; `reclamacoes` is `'desconhecido'` until settled);
  - publishing, product-type schemas, listing notifications, Finances, B2B price and External Fulfillment (all POST).

---

## 1. Phase 0: capability survey (the caps row)

This is the proposed `MARKETPLACE_TIPO_CAPS[INTEGRACAO_TIPO.amazon]` in `packages/schemas/src/shared/marketplace.ts`. It replaces today's `{ ...NAO_INVESTIGADO, channel: null, implementado: false }`. `implementado` stays `false` until step 22, and it **cannot** flip while `reclamacoes` is `'desconhecido'` (`marketplace.test.ts`). The full per-field comments with citations come from `evidence/caps-verify-result.md`.

```ts
[INTEGRACAO_TIPO.amazon]: {
  channel: 'amazon',                // apps/amazon, :3011 (next free port)
  implementado: false,              // flips at step 22, after `reclamacoes` is settled (capture C6)
  // Login with Amazon: POST https://api.amazon.com/auth/o2/token, grant_type=refresh_token → 1 h access token
  // (D:connecting-to-the-selling-partner-api). The app is a Public app in Draft: website authorization workflow
  // with version=beta (D:website-authorization-workflow); reauthorize every 365 days; rotate the client secret
  // every 180 days (D:rotating-your-apps-lwa-credentials).
  auth: 'oauth2',
  pkce: 'nao',                      // no code_challenge/code_verifier in the SP-API consent URI or code exchange (D:website-authorization-workflow)
  // Destinations are sqs | eventBridge only (M:notifications.json DestinationResourceSpecification); no HTTPS webhook.
  // ORDER_CHANGE is SQS-only (D:notification-type-values; EventBridge carries 7 listing/product types only,
  // D:set-up-notifications-with-amazon-eventbridge). Amazon recommends a fallback fetch (D:notifications-api).
  notificacoes: 'push',
  // ⚠️ NOT SIGNED: NotificationMetadata carries only ApplicationId/SubscriptionId/PublishTime/NotificationId
  // (M:OrderChangeNotification.json). Authenticated by AWS IAM (SP-API's principal writes to OUR queue,
  // D:tutorial-grant-permission-to-sqs-queue) plus OUR EventBridge Connection's API-key header
  // (docs.aws eb-target-connection-auth). The receiver compares in constant time, requires ApplicationId === ours,
  // and fails CLOSED. Never write an HMAC verifier for it.
  assinaWebhook: 'sim',
  publicarAnuncio: 'sim',           // putListingsItem, payload validated against Product Type Definitions (D:create-a-listing)
  importarAnuncio: 'sim',           // GET_MERCHANT_LISTINGS_ALL_DATA + getListingsItem / searchListingsItems (≤ 1,000 results)
  variacoes: 'sim',                 // parentage_level + child_parent_sku_relationship + variation_theme; non-buyable parent (D:building-listings-management-workflows-guide)
  categoriasEAtributos: 'sim',      // Product Type Definitions v2020-09-01, locale pt_BR (M:definitionsProductTypes_2020-09-01.json)
  tabelaDeMedidas: 'nao',           // no size-chart resource in any model; sizes are per-listing attributes only
  kitVirtual: 'nao',                // no bundle/kit resource in any model; package_contains_sku = unit/case/pallet packs
  pausarAnuncio: 'sim',             // purchasable_offer end_at in the past ("soft-close", D:manage-purchasable-offer) or quantity 0
  estoque: {
    // fulfillment_availability [{fulfillment_channel_code:'DEFAULT' (= MFN), quantity, lead_time_to_ship_max_days}]
    // via patchListingsItem op:'merge' (D:merge-a-listing). FBA (AMAZON_*) quantity is Amazon's, never written.
    suporte: 'sim',
    // ~20,000 SKUs (Lucas, 2026-10-14) ⇒ the bulk path is JSON_LISTINGS_FEED: ≤ 25,000 messages and ≤ 10 MB per
    // feed, 5 feeds / 5 min, result in a processing report up to 8 h later (D:feeds-api-faq,
    // D:building-listings-management-workflows-guide: "use the feed for operations that involve more than 1,500
    // items"). Sale-driven deltas still go out as one synchronous patchListingsItem per SKU (5 rps / burst 5,
    // D:listings-items-api-rate-limits). Needs a submission record + a result poll (plan step 12a).
    protocolo: 'feed-assincrono',
    loteMax: 25000,                 // messages per JSON_LISTINGS_FEED document
    multiDeposito: 'nao',           // Multi-Location Inventory is US-only (D:mli-integration-guide)
  },
  enviarPreco: 'sim',               // purchasable_offer merge: our_price, minimum/maximum_seller_allowed_price (D:manage-purchasable-offer)
  importarPedido: 'sim',            // Orders v2026-01-01 searchOrders (0.0056 rps / 20) + getOrder (0.5 / 30) (M:orders_2026-01-01.json)
  // includedData=PAYMENT → paymentExecutions[] {paymentMethod (OPEN string), paymentAmount, BR-only acquirerId /
  // cardBrand / authorizationCode} (M:orders_2026-01-01.json PaymentExecution). No installments field.
  importarPagamento: 'sim',
  consolidaPacote: 'nao',           // no pack id; PackageItem = {orderItemId, quantity}; every shipment call takes ONE orderId
  // Inline in getOrder (includedData=TAX,BUYER,RECIPIENT) but ROLE-gated: buyer CPF/CNPJ only with Tax Invoicing or
  // Tax Remittance (Restricted), not DTC Shipping (D:get-tax-information, D:access-orders-pii); buyer name and
  // address lines only from UNSHIPPED. MERCHANT/MARKETPLACE registrations: only while PENDING/UNSHIPPED.
  dadosFiscaisSeparados: 'sim',
  // Amazon mints it. BR DBA: createScheduledPackageBulk printableDocumentsUrl (a zip, ZPL or PDF) — described for BR
  // only on the retired LATAM page and live-proven by the legacy integration; the global store table omits BR.
  etiqueta: 'fetch',
  // ORDER_CHANGE fires on status changes / buyer cancellation / tip only; Easy Ship events are "future"
  // (D:tutorial-subscribe-to-order-change-notification). Read packages[] via getOrder includedData=PACKAGES.
  rastreio: 'pull',
  enviarNfe: 'sim',                 // Delivery by Amazon submitInvoice, BR-only, Tax Invoicing (Restricted) (D:delivery-by-amazon-api)
  perguntas: 'nao',                 // no buyer Q&A resource in any model
  mensagensPosVenda: 'nao',         // Messaging API v1 is send-only; no operation or notification delivers buyer messages
  // External Fulfillment Returns API v2024-09-11 (listReturns/getReturn, read-only) exists; no document confirms it for a
  // plain amazon.com.br MFN seller. A-to-z exists only as report columns. Settled by capture C6 before step 22.
  reclamacoes: 'desconhecido',
  origensConversa: [],
},
```

The row lands with a whole-row assertion in `marketplace.test.ts`, replacing the current Amazon `'desconhecido'` assertions. The three web registry tests that hand-write `[amazon, 'canal-nao-pesquisado']` change to `'canal-nao-implementado'` in the same commit (step 1a).

### 1.0 Documentation provenance (verified 2026-10-14)

- **The global documentation is Amazon's own** (`developer-docs.amazon`; `developer-docs.amazon.com` 301-redirects there). Most pages carry `updatedAt` 2026-09-09; the role pages are dated 2026-10-13; the release notes 2026-10-01.
- **The models are authoritative for names, paths, enums and rate limits.** The Orders v2026 model was last committed 2026-09-30 ("SPAPI September 2026 Release"); the notifications model 2026-08-05.
- **The retired LATAM site.**
  - Amazon's changelog says the Latin America SP-API site "will be removed on August 31, 2025", and that only the Delivery by Amazon (invoice) documentation moved to the global site.
  - The page "DBA caso de uso" (`pt-br-group.readme.io/amazon-latam/docs/dba-caso-de-uso`) still loads, with no date or banner.
  - It is the only Amazon page describing BR Easy Ship pickup scheduling and labels.
  - `evidence/latam-dba-review.md` marks each of its claims as still valid, outdated or only-source. Three points are outdated: `ORDER_STATUS_CHANGE`, Orders v0 + RDT, and the invoice role.
- **Limits of the sources.**
  - Several pages disagree with the models. Examples: the gift and cancellation paths in the migration guide; `INVOICE_UNCONFIRMED`; the `EventTime` meaning; the refresh-token lifetime.
  - Each disagreement is recorded in the surveys, and the model wins for shapes.
  - The static sandbox is a canned-response matcher, so it is evidence of shape, never of behaviour.

### 1.1 The facts that change the architecture (Phase 0 questions 1–5)

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Signs its notifications? | **No.** There is no signature, HMAC or token in any notification schema. Authenticity rests on AWS: the queue policy *allows* SP-API's principal (it does not make it the only writer), and the last hop to our receiver carries a static API key that **our** EventBridge Connection adds. ⇒ The receiver checks the key in constant time (unset ⇒ 503, mismatch ⇒ 401), requires `ApplicationId` to be our app, and keeps the queue's IAM writers minimal. | [model] OrderChangeNotification.json; D:tutorial-grant-permission-to-sqs-queue; docs.aws eb-target-connection-auth |
| 2 | Push or poll? | **Push into the developer's AWS only.** Destinations are SQS or EventBridge. **`ORDER_CHANGE` is SQS-only**; EventBridge carries only BRANDED_ITEM_CONTENT_CHANGE, ITEM_PRODUCT_TYPE_CHANGE, LISTINGS_ITEM_STATUS/ISSUES/MFN_QUANTITY_CHANGE, PRODUCT_TYPE_DEFINITIONS_CHANGE and SHIPMENT_TRACKING_MILESTONE_CHANGED. Delivery is at-least-once, unordered, with duplicates; dedup on `NotificationId`. `ORDER_STATUS_CHANGE` was removed 2026-07-29. Amazon advises a backup fetch ⇒ the `searchOrders` backstop (step 4). | D:notification-type-values; D:set-up-notifications-with-amazon-sqs; D:sp-api-deprecations |
| 3 | How does stock go out? | **Two ways, and ~20,000 SKUs needs both.** (a) `patchListingsItem` per SKU (`op: merge` on `/attributes/fulfillment_availability`, `productType: PRODUCT`): synchronous `ACCEPTED`/`INVALID` plus issues, applied 0–15 min later; `merge` keeps fields not sent (lead time). (b) `JSON_LISTINGS_FEED` (`PATCH` messages, the same body): ≤ 25,000 messages and ≤ 10 MB per feed, 5 feeds / 5 min, a processing report with per-message issues up to 8 h later, `FEED_PROCESSING_FINISHED` (SQS) when done. Amazon: use the feed above ~1,500 items / 5 min; mixed patches and feed messages are applied in **submission-timestamp order**. | D:merge-a-listing; D:building-listings-management-workflows-guide; D:feeds-api-faq; D:listings-apis-faq |
| 4 | Listing = one resource or a family? | **Family.** The non-buyable parent SKU carries `parentage_level: parent` and the theme. Each child carries `child_parent_sku_relationship.parent_sku` and the theme attributes. Stock and price live on children. `getListingsItem includedData=relationships` lists `childSkus`/`parentSkus`. | D:building-listings-management-workflows-guide; M:listingsItems_2021-08-01.json ItemRelationship |
| 5 | Buyer fiscal identity inline or gated? | **Inline but gated.** `tax.taxRegistrations[entityType=BUYER]` (types include `CPF`, `CNPJ`) needs Tax Invoicing or Tax Remittance (Restricted). `buyer.buyerName` and the address lines need one of those or DTC Shipping, and arrive only in UNSHIPPED / PARTIALLY_SHIPPED / SHIPPED. Phone and e-mail need DTC Shipping. MERCHANT and MARKETPLACE registrations appear only while PENDING / UNSHIPPED. ⇒ The NF-e needs **Tax Invoicing + DTC Shipping**. | D:get-tax-information; D:access-orders-pii |

### 1.2 Unknowns only a live call settles

Under D11 these split into three kinds:
- **CAPTURABLE:** a read-only production response the owner captures himself; the step-2b sanitizer turns it into a fixture before the dependent step merges.
- **WRITE-ONLY:** settled defensively in code now, and confirmed on a canary in the window.
- **GATE:** stops a step if the answer is unfavourable.

1. **BR buyer identity format (C1):** is it CPF/CNPJ or `VAT`/`BUSINESS` for business buyers? Digits only or punctuated? Is IE ever present (none is documented)? Is the MARKETPLACE CNPJ an 8-digit root or 14 digits? CAPTURABLE.
2. **`paymentMethod` strings** for Pix, card and boleto, and whether split payments appear as several executions (C1). CAPTURABLE. The importer treats the field as an open string with a fallback to `99`.
3. **Does `programs[]` carry `AMAZON_EASY_SHIP`, `DELIVERY_BY_AMAZON` or both for a BR DBA order? Are `packages[]` and `fulfillmentOrders[]` filled? Does `lastUpdatedTime` move on package events?** (C1). CAPTURABLE. It decides whether step 7 needs its in-transit refresh sweep.
4. **Is the ITEM proceeds amount tax-inclusive for BR, and how are discounts signed?** (C1). CAPTURABLE.
4b. **Exactly which fields Amazon zeroes or drops on a cancelled order** (`quantityOrdered`, `product.price.unitPrice`, `proceeds.breakdowns`, `proceeds.grandTotal`, `payment.paymentExecutions[].paymentAmount`), whether a partial cancellation lowers the quantity instead of zeroing it, whether `orderItems` comes back empty or short, and what a refunded or returned (still `SHIPPED`) order looks like: zeroed proceeds, a `cancellation` block, a package status (suspected by Lucas, not yet observed). The zeroing itself is known from production **[operator]** (D17); the models do not document it. CAPTURABLE (C1: one order captured before and after its cancellation).
5. **Invoice status response keys** (`invoiceStatus` vs `orderInvoicingStatus` vs `invoices[]`) (C2). CAPTURABLE.
6. **The bulk response shape, the zip layout and the resubmit response** (C3). CAPTURABLE from the legacy reprint. The resubmit behaviour itself is live-proven **[operator]**.
7. **The `ORDER_CHANGE` envelope as the Pipe forwards it** (C4). CAPTURABLE from a temporary queue or Amazon's sample.
8. **Listing relationships and the report headers** (C5). CAPTURABLE.
9. **External Fulfillment Returns for BR** (C6): settles `reclamacoes`. CAPTURABLE. GATE for the `implementado` flip.
10. **Whether `merge` with `lead_time_to_ship_max_days` updates the lead time, and how quickly a patch is visible.** WRITE-ONLY (canary).
11. **`purchasable_offer` in the BR product-type schema** (`value_with_tax`, min/max allowed). WRITE-ONLY. A `VALIDATION_PREVIEW` dry-run in the window settles it first.
12. **What bulk answers when the invoice is not yet `ACCEPTED`**, and the full BR `rejectedOrders` code set. WRITE-ONLY. The code never schedules before `ACCEPTED`.
13. **The actual usage plan** (`x-amzn-RateLimit-Limit`) for this seller and app pair. Observed at the window. Pacing assumes the defaults.

### 1.3 Verification record (2026-10-14)

Every provider field was handed to an independent skeptic told to refute it from the documentation. That makes 26 field entries, counting the four `estoque.*` members.
- **21 held.**
- **3 kept their value with corrected evidence:**
  - `assinaWebhook`: the queue policy is an allow, not an exclusive writer, so the `ApplicationId` check is mandatory, and `ORDER_CHANGE` needs the Pipe.
  - `importarPagamento`: the CreditCard/Pix/Boleto/Rewards list in the 2025-08-28 changelog belongs to Shipment Invoicing, not Orders, so `paymentMethod` is an open string.
  - `dadosFiscaisSeparados`: the buyer CPF has no status gate. The PENDING/UNSHIPPED gate is the MERCHANT and MARKETPLACE one, and it works in reverse: that data disappears after shipping.
- **1 changed value:** `reclamacoes` went from `'nao'` to `'desconhecido'`, because the External Fulfillment Returns API exists and its BR eligibility is undocumented.
- **1 unsettled, kept safe:** `rastreio` stays `'pull'`. `EXTERNAL_FULFILLMENT_SHIPMENT_STATUS_CHANGE` would push shipped/delivered only if BR DBA orders run through External Fulfillment, which is undocumented.

**Amendment (2026-10-14, after verification):** `estoque.protocolo` was verified as `'por-anuncio'` under the then-assumed ≤ 1,000 SKUs. Lucas corrected the catalogue to ~20,000 SKUs, so the row now records `'feed-assincrono'` (`loteMax: 25000`) for the bulk path, with per-SKU patches kept for sale-driven deltas. The facts behind both values are the ones the stock skeptic verified (`evidence/caps-verify-result.md`, cluster stock-price).

A gap investigation then read every changelog entry and every docs page for Easy Ship/DBA together with Brazil (`evidence/gap-easyship-br.md`). The operator's pointer to the legacy's documentation source led to the LATAM review (`evidence/latam-dba-review.md`).

---

## 2. Prerequisites and decisions

### 2.0 Lead-time checklist: things only the owner can do (start now)

| # | Item | Why it has lead time |
|---|---|---|
| L1 | **Developer Central: list the roles the existing app (Public, Draft) holds.** Required: Inventory and Order Tracking, Product Listing, Pricing, **Direct-to-Consumer Shipping (Restricted)**, **Tax Invoicing (Restricted)**. Also confirm the Delivery by Amazon API (Restricted Availability) is enabled for the app. | A missing restricted role means a three-stage review (business, security, technical) that takes weeks. |
| L2 | **Record the LWA client-secret rotation deadline** (notified 90 days ahead) and plan the rotation outside the window. | Until the cutover both systems share the secret, so a rotation updates both. |
| L3 | **Note the date of the current authorization** (Seller Central → Manage Your Apps). | Public apps are reauthorized every 365 days. The new authorization made in the window restarts the clock. |
| L4 | **AWS access:** an IAM principal that can create SQS queues, EventBridge Pipes, Connections, API destinations, CloudWatch alarms and a CloudFormation stack. Also choose the region. | The relay (step 3) is infrastructure only the owner deploys. |
| L5 | **The existing EventBridge rule(s) and their targets** for the product notifications (`aws events list-rules`, `list-targets-by-rule`). | W6 switches the old path off cleanly. |
| L6 | **The production domain for the new OAuth redirect URI** (ADR 0013 Phase 0 custom domain), registered as an additional redirect URI on the same app. | Public-app OAuth redirects only to registered URIs, and localhost is refused. |
| L7 | **Owner captures C1–C6** (§1.2), each before the step that needs it. | They settle what no document answers. |
| L8 | **The warehouse ZPL printer and print agent** confirmed for Amazon labels. | Step 15 sends the ZPL to the print agent as exact `text/plain`. |
| L9 | **Data Protection Policy review** (updated 2026-08-25): WAF for internet-facing endpoints, encryption at rest, MFA, PII-free logs, PII kept ≤ 30 days after delivery unless law requires it (NF-e data does). | The developer profile answers for these, and the receiver is internet-facing. |

### 2.1 Decisions taken by Lucas on 2026-10-14 (binding)

| # | Decision | Consequence in the plan |
|---|---|---|
| D1 | **Scope:** Amazon blocks the cutover, order side only. There is no dual run. | The PRE slice is §4.25. |
| D2 | **PRE-cutover:** order import, NF-e upload, Easy Ship/DBA pickup + ZPL label, stock sync, LWA conta setup, read-only listing import/link (order items map to produtos; listings created in Seller Central after the cutover stay linkable), and price sync (D9). | Steps 1–9b, 12–15, 20–22. |
| D3 | **POST-cutover:** publishing/editing (product-type schemas), product/listing notifications, returns/claims, everything else. | Steps 10, 11, 17, P1–P3. |
| D4 | **Order transport:** `ORDER_CHANGE` → SQS → **EventBridge Pipe → API destination (API_KEY Connection)** → receiver. A reconciliation poll exists only as a backstop. The legacy integration polled orders; that is replaced. | Steps 3–4; W2, W5. |
| D5 | **Receiver:** on `defineNotificationPipeline`. It acks fast and enqueues; it compares the header secret in constant time (unset ⇒ 503, mismatch ⇒ 401); it requires `ApplicationId` to be ours. The task always re-fetches `getOrder` and never maps the payload. | Step 3. |
| D6 | **Orders API v2026-01-01 only.** v0 is never built. | Steps 4–6. |
| D7 | **Fulfilment: Easy Ship/DBA only.** No self-ship, no FBA. An AFN order is flagged and never touches stock. | Steps 5, 12, 14, 15. |
| D8 | **Volume:** 1 conta, ≤ ~50 orders/day, **~20,000 SKUs** (variations counted; corrected by Lucas on 2026-10-14). The plan sizes every catalogue flow for all of them being listed on Amazon. **Feeds are used where the volume calls for them** (Lucas): bulk stock and bulk price go out as `JSON_LISTINGS_FEED`; sale-driven deltas and single-produto pushes stay per-SKU patches. | Steps 9, 12, 12a, 13; §4.23. |
| D9 | **Price:** PRE-cutover and **manual only**. **The ERP sets `our_price`**; no Amazon repricer runs at the cutover. `minimum/maximum_seller_allowed_price` come from one pure function, `faixaDePrecoAmazon`. In v1 it reads today's price lists. When the promotional list is deprecated in favour of a price range, only that function changes. | Step 13. |
| D10 | **App:** reuse the existing app (Public, Draft). The new ERP gets its **own authorization** through the website OAuth flow (`version=beta`) with its own redirect URI. After the cutover, the legacy copy is neutralised by **rotating the client secret**, not by revoking the authorization, because OAuth revocation is per app and would revoke the new token too. | Step 2; W1, W5, W13. |
| D11 | **Mock only (the LI D17 analogue).** No live call from this repository's code before the cutover. Fixtures come from the models' `x-amzn-api-sandbox` examples plus sanitized owner captures. The first live calls happen in the window, behind valves and canaries. | Step 2b; §1.2; §5. |
| D12 | **Easy Ship is scheduled automatically, once, after Amazon accepts the NF-e; after that, printing only fetches the label link.** Nothing is re-sent and nothing is rescheduled: for a scheduled order the bulk call returns the existing schedule plus a fresh `printableDocumentsUrl` **[LATAM, retired] + [operator]**, which the server downloads inside the print request (the link lives ~3 minutes, so it is never stored). `freteInicial.estado` and Amazon's invoice status say whether the order is already scheduled, as in the legacy. Amended by Lucas on 2026-10-14. | Steps 14–15. |
| D13 | **The existing AWS forwarder for product notifications is replaced, not reused** (confirmed by Lucas on 2026-10-14). It is switched off with the legacy (W6). Listing notifications return after the cutover through the step-3 relay (P1). | Step 3; P1. |
| D14 | **Issues:** a tracker plus one issue per step, opened only after Lucas approves this written plan. Migration-window issues (§5) need a **separate** yes. | — |
| D15 | **Execution:** every step gets a Phase-3 step plan that Lucas approves before code is written; stacked draft PRs. | §4.25. |
| D16 | **All AWS-side code lives in this repository, in TypeScript, in a dedicated folder** (Lucas, 2026-10-14: nothing may again exist only in the AWS console, as the old forwarder did). The relay is an **AWS CDK v2 app in TypeScript** at `infra/amazon-relay/`: a workspace package that is typechecked, linted and tested (`aws-cdk-lib/assertions`) like any other. No account id, ARN, URL or secret value is in the code; they arrive as deploy-time context or from Secrets Manager. Agents never deploy it; the owner runs `cdk deploy` in the window (W2). | Step 3; W2. |
| D17 | **Order items vs sale state.** Amazon zeroes item values and quantities on a cancelled order **[operator]** (undocumented), and Lucas suspects a cancelled, refunded or returned order may also lose its items. Orders v2026 has no refund or return status, so reversal is read from the order data: `CANCELLED`, a line `cancellation` block, a refused/undeliverable/returning/returned/lost/damaged package, or a zeroed `SHIPPED` order. **Reversed ⇒ keep every stored line, quantity and value** (0 never overwrites a stored positive value, no line is deleted); only the estado, status, cancellation info and freight state change, and the reservation is released with the stored lines. **Approved but not yet shipped, with no reversal signal ⇒ the items must match Amazon exactly** (never ship more or fewer): any difference is a blocking divergence (`estado: error` + aviso), never applied silently. **Before approval ⇒ mirror Amazon.** The refund/return part of the reversal detection is an **interim inference**; P4 replaces it with explicit signals after the cutover. | Steps 5–7; §3; P4. |
| D18 | **⏸ Listings discussion gate.** The legacy listing flows have several known problems that Lucas will describe in person. Before the Phase-3 plan of **any listing step** is written, Lucas walks through those problems and we agree on the best way forward. That covers the pre-cutover link (steps 9 + 9b) and every listing part after the cutover (steps 10, 11, P1, the P3 import mode), plus the link-doc census W11. Everything this plan says about listings is a starting point, not a decision, until that discussion has happened. | Steps 9, 9b, 10, 11, P1, P3; W11; §7. |

**Orchestrator calls (vetoable, one line each):**
- **Stock:** sale-driven deltas are `patchListingsItem` merges per SKU while a flush holds fewer than 1,500 SKUs; anything bigger (the daily reconcile's drift, an operator "send all", the window's first push) is one `JSON_LISTINGS_FEED` with a submission record (step 12a).
- **`MissingPackageDimensions`:** an aviso only, and the operator fixes the dimensions in Seller Central. The label flow never writes to the catalog and never sends fabricated defaults.
- **NF-e upload:** only for `aprovada`, never for an EPEC-only authorization (`'p'`).
- **NF-e `detPag` for CreditCard/Pix:** carry the BR-only `acquirerId` (CNPJ), `cardBrand` and `authorizationCode`. Amazon added those fields for SEFAZ-compliant invoices.
- **Reservations:** PENDING orders reserve ERP stock and CANCELLED releases it. A first-seen CANCELLED order is skipped. A first-seen SHIPPED order is imported.
- **Link docs:** new `prodAmazon` docs get a deterministic id from `(contaId, sku)`; readers always query by fields.
- **Listing import before the cutover is link-only:** no produto creation, and no import of photos, prices or stock.
- **Logger, valves, canary lists and the capture sanitizer:** copy LI step 2b's **design**. LI is built in a parallel session; extracting a shared module is a follow-up once both have merged.
- **`faixaDePrecoAmazon` v1:** `base` = the conta's normal list; `minimo` = the promotional list when > 0, else `base`; `maximo` = `base`.

---

## 3. Legacy (`.old`): what constrains the port, what to keep, what NOT to port

**Corpus that exists. It survives the cutover with its ids, so read tolerance is mandatory:**
- **`integracao/{contaId}` with `tipo = 8`.**
  - Generic integracao fields.
  - `modalidadeFreteImportacao`.
  - `cpf_cnpj` + `idCadIntTran`: the NF-e intermediador. `buildInfIntermed` throws without them when `indIntermed == '1'`.
  - `selling_partner_id`: the seller id (merchant token), written by the OAuth callback. It becomes the notification routing key, so it joins `serverOwnedFields`, with an index `integracao (tipo, selling_partner_id, ativo)`.
- **`integracao/{contaId}/tokenoaut/{autoId}`.** The legacy LWA token documents, including a **live refresh token**. They are neither modelled nor cascaded here, and W3 deletes them from the migrated copy.
- **`int_frete/{id}` with `tipo 'amz'`** (`INTEGRACAO_FRETE.amazon`). Back-ref field `contaAmazonContaFreteAmazonOuterRef = 'documents/integracao/<contaId>'`. Step 20 binds it; W12 adopts the migrated docs.
- **`produtos/{id}/prodAmazon/{docId}`** (typed today by `produtoAmazonLinkSchema`).
  - **Doc ids are mixed:** the ASIN, random 64-hex ids, and native 20-character ids.
    - ⇒ Readers query by `(contaAmazonOuterRef, sku)` through a collection-group index and never compute a doc id.
  - The stored `contaAmazonOuterRef` is `'documents/integracao/<contaId>'`.
  - The corpus may contain duplicate link docs, and child link docs carrying their parent's ASIN or SKU. W11 runs a census of both.
- **`produtos/{id}` denorms** written by legacy Amazon code: `marketplace[]`, `marketplaceIds[]` (bare ASINs), `integracoesComProduto[]` (bare contaId) and `statusProdutosMarketplace{'<contaId>_<ASIN>': {enviarEstoque, …}}`.
  - They are read tolerantly. `integracoesComProduto` is maintained by the step-9b trigger.
  - `enviarEstoque === false` is honoured by step 12.
- **`grupoDeVariacoes/{id}.linksVariacoesAmazon[]`** stays untyped JSON (`z.array(z.json())`) until POST step 11, because publishing is POST.
- **Orders:** `pedidos/{digest}` + `pedidos/{digest}/pagamentos/{digest}` + `clientes/{id}/enderecos/{id}`.
  - Items are an embedded map keyed by produto id (or `'NONE'` when unmatched).
  - Item identity is `mktplaceId = OrderItemId`, with **no `ensureUniqueId`**. ⇒ Step 5 matches migrated items by `OrderItemId`.
  - `numero` = the Amazon order id. `integracaoPedidoOuterRef` = `'documents/integracao/<contaId>'`.

**The two deterministic ids.** Reproduce them byte for byte and pin them in `orderIds.test.ts`, with near-misses asserted unequal:

| Id | Preimage (UTF-8, sha256, lowercase hex) |
|---|---|
| pedido | `"<contaId>-<AmazonOrderId>"`: the **bare** conta doc id (no `documents/`, no `integracao/`, no channel prefix), one ASCII `-`, and the order id verbatim (`NNN-NNNNNNN-NNNNNNN`) |
| pagamento | **The same preimage, so the same digest as the pedido**, used as the doc id under `pedidos/{pedidoId}/pagamentos/` |

- Test vectors use the Orders model's sandbox order id `171-9876543-2109876` and a fixed conta id.
- Near-misses that must stay distinct:
  - `'integracao/<contaId>-<orderId>'` (the LI pagamento spelling);
  - `'/documents/integracao/<contaId>-<orderId>'` (the ML spelling);
  - `'amazon<contaId>-<orderId>'` (a channel-prefixed spelling).

**Corpus that does NOT exist:**
- no order mirror;
- no order cursor;
- no notification failure store;
- no webhook secret.

⇒ **Do not invent a mirror.** The question "which pedido owns Amazon order N of conta C" is answered by the deterministic id.

**What the shared seams replace:**
- The legacy token subcollection → the generic admin-only `integracao/{id}/credenciais` (step 2; W3).
- The legacy sliding-window poll → push + a durable backstop cursor (steps 3–4).
- Per-flow retries → `defineNotificationPipeline`.
- `produtos.marketplace[]` / `marketplaceIds` denorms → link-doc queries + the `integracoesComProduto` anchor.

**Business rules to re-derive.** Each carries its source class:
- **Estado by an enumerated status table**, monotonic, never regressing ERP-owned progress **[ERP rule]**:
  - `PENDING`/`PENDING_AVAILABILITY` → `aguardandoConfirmacaoDePagamento` (reserves);
  - `UNSHIPPED`/`PARTIALLY_SHIPPED`/`SHIPPED` → `pago`;
  - `CANCELLED` → `cancelado` (releases; after payment it is a refund);
  - `UNFULFILLABLE` (AFN only) → `error` + aviso;
  - anything else → `error` + aviso, never a default **[model]** (FulfillmentStatus enum).
- **MFN only** (`fulfillment.fulfilledBy = MERCHANT`). An AMAZON order is flagged and has no stock effect **[ERP rule, D7]**.
- **Item → produto** through the conta's link docs (`contaAmazonOuterRef` + `sellerSku`). Unmatched lines are kept and flagged for the step-9 link action **[ERP rule]**.
- **Cliente:** `cpf_cnpj` from `taxRegistrations[BUYER]`, the name from `buyer.buyerName` (never the recipient's name), the address from `recipient.deliveryAddress` + `extendedFields` (streetName, streetNumber, complement, neighborhood), and the IBGE code resolved at import **[model; ERP rule]**.
- **Dispatch deadline** = `fulfillment.shipByWindow.latestDateTime` **[model]**.
- **Easy Ship `packages[].packageStatus.detailedStatus` → `freteInicial.estado`** through an explicit transition table (step 7) **[model; ERP rule]**.
- **Payment form** from `paymentExecutions[].paymentMethod`:
  - Pix → 17, with the acquirer CNPJ + authorization code;
  - CreditCard → card group, with the acquirer CNPJ, `cardBrand` and authorization code;
  - Boleto → 15;
  - anything else → 99 with `xPag` = the raw method;
  - parcelas = 1 (not exposed).

  **[model; ERP rule]**
- **Stock** from the **conta's** depósito, integer, clamped at 0. Kit quantity = the min over limiting components of ⌊disponível/qtd⌋ **[ERP rule, ADR 0014]**. One quantity function serves publish, sweep and manual sends.
- **Price** scoped per conta. Parents skipped (non-buyable). Money via `roundReais`. The whole offer (our_price + min + max) compared before writing **[ERP rule, D9]**.
- **Items and values by sale state** **[operator + model, D17]**: on a reversed sale (cancelled, line cancellation, return/refusal package status, or a zeroed shipped order) the stored lines and values are kept; on an approved order not yet shipped the items must match Amazon exactly, and any difference blocks the pedido for a human; before approval Amazon is mirrored (step 5).
- **DBA detection** (legacy and LATAM rule) re-expressed for v2026: `programs[]` and `tax.taxInvoicing.invoiceStatus` **[model; LATAM, retired]**.

**Other legacy-code findings are kept in the operator's private notes; only the rules above are ported.**

---

## 4. Phase 2: the master plan

Every step gets a Phase-3 step plan that Lucas approves before code is written (D15). Each step carries the same bullets: **Gate · Trigger · Docs · Wire · Firestore (incl. Indexes + Rulesets + Env) · Seam · Rule 7 · Dry-run/valve · Verification · Timing · Does NOT**. **When** marks each step PRE or POST cutover.

### 4.i Template → Amazon step mapping

| Template step | Amazon step(s) | When | Note |
|---|---|---|---|
| 1 Scaffold + OAuth connect | 1a (caps) + 1 (package + app) + 2 (connect) | PRE | Website OAuth with `version=beta`. |
| 2 Context + credential store + cache | 2 + 2b | PRE | 2b = logger, valves, canary lists, read switch, capture sanitizer. |
| 3 Receiver + queue, or poller | 3 | PRE | The AWS relay as IaC plus the HTTPS receiver. |
| 4 Delivery backstop | 4 | PRE | `searchOrders` poll with a durable cursor. SQS retention + DLQ hold undelivered messages. |
| 5 Order → pedido | 5 | PRE | |
| 6 Payment | 6 | PRE | Inline, same task. |
| 7 Shipment → `freteInicial` | 7 | PRE | Pull (`rastreio: 'pull'`). |
| 8 Stuck-reservation release | dropped | — | Amazon cancels unpaid orders. `ORDER_CHANGE` + the backstop carry the change to step 5. |
| 9 Product import | 9 + 9b | PRE (link only) | "Create produto from listing" is P3. |
| 10 Categories / attributes | 10 | POST | Product Type Definitions. |
| 11 Publish / lifecycle | 11 | POST | |
| 12 Stock | 12 + 12a | PRE | Per-SKU patches for deltas; 12a = the `JSON_LISTINGS_FEED` submission record + result poll for bulk. |
| 13 Price | 13 | PRE (manual) | |
| 14 NF-e upload | 14 | PRE | Delivery by Amazon API. |
| 15 Labels | 15 | PRE | Easy Ship bulk: automatic scheduling; the ZPL is fetched on demand at print time, never stored. |
| 16 Chat | dropped | — | `perguntas`/`mensagensPosVenda: 'nao'`. |
| 17 Claims / returns | 17 → P4 | POST | Folded into P4 (refunds and returns done properly). `'desconhecido'` until C6. |
| 18 Tabela de medidas | dropped | — | `'nao'`. |
| 19 Kits virtuais | dropped | — | `'nao'`; quantity is ERP-computed in step 12. |
| 20 `int_frete` sync | 20 | PRE | `'amz'` back-ref binding + adoption. |
| 21 `apps/web` | 21 | PRE (piecewise) | |
| — | 22 | PRE | Deploy isolation, settle `reclamacoes`, flip `implementado`. |
| — | P1–P3 | POST | Listing notifications, automated secret rotation, extras. |

### 4.ii Conventions every step obeys

- **No generic `catch`** (rule 6). Narrow on in-repo classes (`AmazonAuthError`, `AmazonThrottleError`, `AmazonNotFoundError`, `ZodError`, …) and `throw err` otherwise.
- **Every optional Firestore field is `.nullable().default(null)`.**
- **Money via `roundReais`.** Responses are read via `lerRespostaJson`; numbers via `wireNumber`/`wireInt`. Money in v2026 is a decimal **string** (`Money.amount`).
- **Watermark units are written beside every field.** `lastMarketplaceUpdate` is µs; cursor and lease stamps are ms.
- **Task payloads, failure docs and logs carry ids only, no PII** (DPP; L9).
- **`paymentMethod`, `detailedStatus`, `programs[]` and `rejectedOrders[].error.code` are open strings.** Every mapping has an explicit fallback and an aviso, never a silent default.
- **Live end-to-end verification of any Amazon read or write happens first in the window** (D11). Every step's Verification says what is fixture-only.

### 4.iii Definition of done, per step

1. Tests, including a **near-miss** wherever two values are decided "the same": the deterministic ids, the link-doc key, and the price-offer comparison.
2. Every new query has its composite declared in `firestore.indexes.json` in the same PR.
3. Both rulesets regenerated (`gen:rules` **and** `gen:rules:e2e`) plus both snapshots refreshed whenever a `*Meta`, PERM, `serverOwnedFields` entry, validator whitelist, enum or collection changes.
4. New env vars appear in the root `.env.example` **and** `apps/amazon/apphosting.yaml` (and the functions env) in the step that introduces them.
5. The CI lane runs the new tests. `ci-amazon.yml` lands in step 3 with the first tasks-emulator test.
6. New `runTransaction` sites are classified in `firestore-transaction-inventory.test.js`. New HTTP clients with a `{ curto, longo }` timeout pair are registered in `http-client-timeout-ceiling.test.js`.
7. Anything that must run against production data or infrastructure is a §5 item, never a TODO.

### Step 0: Prerequisites (L1–L9). Human, not code

- **Outcome:**
  - roles confirmed (L1);
  - the rotation and reauthorization dates recorded (L2, L3);
  - AWS access (L4);
  - the old rule list (L5);
  - the redirect-URI domain known (L6);
  - captures scheduled (L7);
  - printer confirmed (L8);
  - DPP review started (L9).
- **No probe token** (D11): the new authorization is made in the window (W5).

### Step 1a: Caps row — PRE

- **Gate:** none (it is the gate). **Wire:** none. **Firestore:** none. **Rulesets:** none expected (the `gen:rules` diff is checked).
- **Change:** the §1 row; a whole-row assertion in `marketplace.test.ts`; `apps/web/lib/marketplace/{estoque,preco,anuncioStatus}/registry.test.ts` flip Amazon to `'canal-nao-implementado'`.
- **Verification:** `pnpm --filter @delfrance/schemas test` and the three registry suites.
- **Does NOT:** touch `FREIGHT_TIPO_CAPS` (step 15) or create an app.

### Step 1: `packages/integrations/amazon-sp-api` + `apps/amazon` scaffold — PRE

- **Gate:** `auth: 'oauth2'`, `pkce: 'nao'`.
- **Two stacked PRs:**
  - **PR a:** package + guard change + docs.
  - **PR b:** bare app scaffold + the rosters and counts a new Next app makes false.
- **Package** `@delfrance/integrations-amazon-sp-api`: fetch-only, with no Firestore, no `process.env` and no logging.
  - **`lwa.ts`:** the refresh-token exchange and the authorization-code exchange (`POST https://api.amazon.com/auth/o2/token`).
  - **`client.ts`:**
    - Host `https://sellingpartnerapi-na.amazon.com`; the BR marketplace id is a constant.
    - Headers `x-amz-access-token` and a mandatory `user-agent`. No SigV4 (not required since 2023-10-02, CL:sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4).
    - Redirects are never followed. One per-call deadline (`abrirPrazo`).
    - An `onChamada` observer hook.
  - **`errors.ts`:**
    - `AmazonAuthError` (invalid_grant / 401 / 403, the parking signal);
    - `AmazonThrottleError` (429, with `x-amzn-RateLimit-Limit` when present);
    - `AmazonNotFoundError`;
    - `AmazonHttpError` (status, `transitorio`; 5xx is transient);
    - `AmazonSchemaError`, `AmazonNetworkError`, `AmazonTimeoutError`.

    No error carries any part of the response body.
  - **`types.ts`:** wire schemas written from the models with `.passthrough()`, deferred to their first consumer step.
- **App** `apps/amazon` (`@delfrance/amazon-app`, Next pinned exactly as the catalog requires, API-only, `:3011`):
  - `app/api/health`, `apphosting.yaml` (`minInstances: 0`), `CLAUDE.md`.
  - PR b fixes what a new Next app makes false:
    - `KNOWN_APPHOSTING_APPS`/`KNOWN_NEXT_APPS`;
    - the ports and pin counts in root `CLAUDE.md`;
    - `SERVER_PATHS` in `no-ambient-timezone`;
    - the `next` pin guard (`apphosting-next-pinned.test.js`).
- **Guard change (PR a):** `packages/config-eslint/rules/removed-plugin-contracts.test.js` moves `amazon-sp-api` from the must-be-absent list to the shape list (no `MarketplaceChannel` declared, re-exported or registered). The prose saying three scaffolds "stay deleted" becomes two: root `CLAUDE.md`, ADR 0015, the integration-authoring guide and `packages/integrations/README.md`.
- **Firestore:** none. **Env:** none yet. **Seam:** `@delfrance/core/wire` (`lerRespostaJson`, `abrirPrazo`, `wireInt`/`wireNumber`).
- **Verification:**
  - package unit tests with a mocked `fetch` against fixtures built from the models' `x-amzn-api-sandbox` examples;
  - LWA happy path, `invalid_grant`, and 429 with and without the header;
  - redirect not followed;
  - no error carries the token.
- **Does NOT:** handle the OAuth route, the credential store, any write method, or retries (all later steps).

### Step 2: Conta context + OAuth connect + LWA token store + parking + avisos — PRE

- **Gate:** always. **Trigger:** HTTP routes + a daily `onSchedule` (the trigger ships with step 3's functions codebase). **Docs:** D:website-authorization-workflow, D:rotating-your-apps-lwa-credentials, D:authorize-public-applications.
- **Connect (website OAuth, Public app in Draft):**
  1. `POST /api/marketplace/amazon/conta/[id]/oauth/start` (`PERM.integracao.write`) mints a signed single-use state through the shared `oauth-state` seam, persists it, and returns `https://sellercentral.amazon.com.br/apps/authorize/consent?application_id=…&state=…&version=beta`.
  2. The public callback `/api/oauth/amazon/callback` receives `state`, `selling_partner_id` and `spapi_oauth_code` (valid 5 minutes). It verifies and redeems the state in a transaction, exchanges the code, persists the refresh token, and writes `selling_partner_id` on the conta.
  3. **Wrong-seller guard:** if the conta already carries a different `selling_partner_id` (a migrated conta), refuse and raise an aviso.
- **Credential store:** the generic admin-only `integracao/{id}/credenciais` (`credenciaisIntegracaoSchema`, OAuth-shaped, already naming Amazon as a consumer). The authorization date (for the 365-day reminder) and the parking state ride as typed extensions; the step plan fixes their shape.
- **Context:** `loadAmazonContext(db, integracaoId, deps)` through `createCachedDocReader` (15-minute TTL; an inactive conta is never served from cache). The **credential read is uncached**.
  - The access token is refreshed when it is within 60 s of expiry. The LWA refresh token does **not** rotate, so concurrent refreshes are harmless (rule 7 tier 0).
- **Parking:** an `AmazonAuthError` from the current credential marks `reconexaoPendente` and raises `amazonReconexaoPendente` (crítico). It is a tier-1 precondition write keyed on a versioned credential ref (the LI step-2 design).
  - Intake for a parked or unconnected conta takes the **deferred** lane (#808): an outage of human scale must not burn retries.
- **Avisos (daily sweep):**
  - `amazonReautorizacaoExpirando` 30 days before the 365-day mark;
  - `amazonSegredoLwaExpirando` before the 180-day rotation deadline, with the date recorded at each rotation;
  - the reconexão aviso above.
- **Read switch** `AMAZON_CHAMADAS`: only the exact `on` lets this code call Amazon at all; otherwise the routes answer 503 with zero fetches. It stays unset until W5.
- **Firestore:**
  - `integracao/{id}/credenciais` (admin-only);
  - `integracao/{id}/oauthState` (cascaded);
  - `selling_partner_id` joins `integracaoMeta.serverOwnedFields` ⇒ **both rulesets + snapshots regenerate**;
  - new index `integracao (tipo ASC, selling_partner_id ASC, ativo ASC)`;
  - `TIPO_AVISO`/`CANAL_AVISO` gain the Amazon entries.
- **Env:** `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET` (secret), `AMAZON_APPLICATION_ID`, `AMAZON_OAUTH_REDIRECT_URI`, `AMAZON_OAUTH_STATE_SECRET` (secret), `AMAZON_CHAMADAS`, `ALLOWED_ADMIN_ORIGINS`.
- **Verification:**
  - state replay refused;
  - wrong seller refused;
  - a 401 from a stale credential ref parks nothing, while one from the current ref parks;
  - the sweep warns at 29 days and stays silent at 31.

  All offline, against a fake.
- **Does NOT:** make any live call before W5; store the token on the `integracao` doc; cache the credential.

### Step 2b: Logger + valves + canary lists + capture sanitizer — PRE

- **Logger:** one JSON line per Amazon call with operation, status, attempt, `x-amzn-RateLimit-Limit`, latency, correlation ids and a body excerpt under **allow-list redaction** that fails closed.
  - Order bodies keep only structural keys (ids, statuses, quantities, money, dates, SKUs/ASINs).
  - Buyer name, address, CPF/CNPJ, phone, e-mail and gift messages are always redacted; a regex layer runs over everything that survives.
  - The `x-amz-access-token` header and every LWA body are never logged.
- **Valves:** `AMAZON_MODO_ESTOQUE`, `_PRECO`, `_NFE`, `_AGENDAMENTO`, each `off | dry-run | on`. **Only the exact `on` writes**; anything else is off.
- **Canary lists** `AMAZON_CANARIO_<FLUXO>`: unset ⇒ no target; exactly `*` ⇒ every target; otherwise `<contaId>:<sku>` (stock, price) or `<contaId>:<orderId>` (NF-e, agendamento).
- **Capture sanitizer** `scripts/sanitizar.ts`:
  - It turns owner captures (raw JSON + a `METHOD URL STATUS` sidecar, kept outside every git checkout) into committed fixtures under `lib/amazon/fixtures/__wire__/`.
  - It fakes every PII value, refuses on any finding, and never opens a label file's content.
- **Firestore:** none. **Env:** the valves and canary lists, as blank lines.
- **Verification:** a redaction snapshot over the models' BR sandbox order (address, CPF/CNPJ, payment acquirer); valve and canary parsing tables.
- **Does NOT:** send any write or make any call.

### Step 3: AWS relay (IaC) + receiver + pipeline + queues + CI lane — PRE

- **Gate:** `notificacoes: 'push'`, `assinaWebhook: 'sim'`. **Trigger:** HTTP → Cloud Task. **Docs:** D:set-up-notifications-with-amazon-sqs; docs.aws eb-pipes-sqs, eb-api-destinations, eb-target-connection-auth.
- **AWS relay as TypeScript code (D16):** an AWS CDK v2 app at `infra/amazon-relay/` (`@delfrance/infra-amazon-relay`, a pnpm workspace member: `bin/relay.ts`, `lib/relayStack.ts`, `cdk.json`). No account id, ARN, URL or secret value in the source; the receiver URL arrives as CDK context and the relay key from an existing Secrets Manager secret. It defines:
  - **SQS standard queue** (14-day retention, a resource policy allowing SP-API's `437568002678` to `SendMessage`/`GetQueueAttributes`) + its **DLQ** (generous `maxReceiveCount`);
  - **EventBridge Connection** (`API_KEY` auth: a header we name, its value from Secrets Manager) + **API destination** (the receiver URL, an invocation rate limit);
  - **EventBridge Pipe** (`CfnPipe`): source = the queue, target = the API destination, the input template forwarding the SQS body unchanged, logging at ERROR;
  - **CloudWatch alarms** on DLQ depth and on the pipe state (a Pipe auto-disables on sustained 4xx).

  Tests synthesise the stack and assert it with `aws-cdk-lib/assertions` (`Template.fromStack`): the queue policy principal, retention, the DLQ wiring, the Connection auth type, the Pipe source and target, the alarms, and that no literal account id appears. The package's `test`, `typecheck` and `lint` run in `ci.yml` like every workspace; `cdk synth` needs no AWS credentials. **Deployed only by the owner** (`cdk deploy`, W2). Retargeting after a domain change is a context change plus a redeploy.
  - ⚠️ Adding `aws-cdk-lib` is a new heavy devDependency for one workspace; the step plan checks the lockfile impact and keeps it out of every runtime bundle.
- **Receiver** `apps/amazon/app/api/webhooks/amazon/route.ts`:
  1. Secret unset ⇒ 503; header missing or wrong ⇒ 401 (constant-time, equal-length buffers).
  2. Bounded body. Parse only the routing fields, and ⚠️ **the two envelopes are cased differently** **[model]**:
     - `ORDER_CHANGE` is PascalCase: `NotificationType`, `NotificationMetadata.{NotificationId, ApplicationId, SubscriptionId, PublishTime}`, `Payload.OrderChangeNotification.{SellerId, AmazonOrderId, OrderChangeType}` (`schemas/notifications/OrderChangeNotification.json`);
     - `FEED_PROCESSING_FINISHED` (step 12a; same SQS queue) is camelCase: `notificationType`, `notificationMetadata.{notificationId, applicationId, …}`, `payload.feedProcessingFinishedNotification.{sellerId, feedId, feedType, processingStatus, resultFeedDocumentId}` (`schemas/notifications/FeedProcessingFinishedNotification.json`).

     The parser is one function per envelope, chosen by which type key is present; a test pins both casings.
  3. `ApplicationId` ≠ ours, an unknown type, or a malformed body ⇒ **200 + drop with a log line**, never a 4xx (pipe auto-disable).
  4. Enqueue `{sellerId, amazonOrderId, notificationId, publishTimeMs, origem: 'push'}` and answer 200 within the **5-second** API-destination timeout.
  5. If the enqueue fails ⇒ `persistNotificationFailure` ⇒ still 200.
- **Pipeline:**
  - `notificacoesAmazon` is failures-only (`notificationResilienceFields()`). `docIdOf = NotificationId`; synthetic backstop entries use `poll:<contaId>:<orderId>:<lastUpdatedUs>`. Dedup key = `<contaId>:<orderId>`.
  - The task resolves the conta by `selling_partner_id` (none or parked ⇒ **defer**), then hands off to step 5.
  - Dispositions:
    - throttle, 5xx or network ⇒ throw;
    - 404 ⇒ park;
    - AFN ⇒ resolve + flag.
- **Nested functions codebase** `apps/amazon/functions`: `processAmazonNotification`, `reprocessAmazonNotifications` (every 30 min) and the step-2 daily sweep. `tasksInvoker.ts` copied verbatim; the queue export name equals the queue constant. Plus `firebase.amazon.tasks.json` (tasks emulator; ports from the inventory, proposed 8086/5005/9502) and `firebase.amazon.deploy.json`.
- **CI lane:**
  - `ci-amazon.yml` with the `changes`/`gate` pattern;
  - `CI gate (amazon)` registered in `ci-lane-gates.test.js` and `main-red-alert.yml`;
  - the lane and pinnable-check counts and the rule-4 emulator carve-out updated in root `CLAUDE.md`.
- **Firestore:** `notificacoesAmazon`; index `(status ASC, processedAt ASC)`; both rulesets regenerated (a new bare collection).
- **Env:** `AMAZON_RELAY_SECRET` (secret; plus the optional `AMAZON_RELAY_PREVIOUS_SECRET` during a rotation), `AMAZON_APPLICATION_ID`, `AMAZON_TASKS_DISABLED`, `AMAZON_TASKS_REGION`. *(Amended in step 3, PR 3-c: renamed from `AMAZON_RELAY_KEY` so the `_SECRET` suffix puts it in `.env.secrets.example`; step-3 plan §3 decision 13.)*
- **Rule 7:** the receiver writes nothing on the happy path; idempotency is the importer's (deterministic ids).
- **Verification:**
  - a 503/401/200 table;
  - foreign `ApplicationId` ⇒ 200 + drop;
  - a malformed body ⇒ 200 + drop;
  - a duplicate `NotificationId` is harmless;
  - the tasks-emulator round trip (receiver → queue → task → fake import).

  The SQS envelope comes from capture C4 or Amazon's documented sample.
- **Does NOT:** subscribe anything (W5); handle listing notifications (P1); trust the payload beyond routing.

### Step 4: Backstop poll — PRE

- **Trigger:** `onSchedule` every 15 minutes → synthetic notifications onto the step-3 queue. **Docs:** M:orders_2026-01-01.json `searchOrders`; D:orders-api-rate-limits.
- **Wire:** `searchOrders(lastUpdatedAfter = cursor − 10 min, marketplaceIds = [A2Q3Y263D00KWC], maxResultsPerPage = 100)`, paged by `paginationToken`.
  - The token expires after 24 h and every other parameter must stay identical between pages.
  - `lastUpdatedBefore` is omitted; Amazon requires a 2-minute gap from now.
  - Rate 0.0056 rps / burst 20 ⇒ 96 calls/day, well inside the bucket.
- **Cursor** `pollPedidosAmazon/{contaId}` (bare constant, outside `ALL_DOMAINS`): `cursorMs` (ms, per §4.ii's cursor units: Amazon's own `lastUpdatedTime` of a fully drained window, capped at the drain's start − 5 min), `pendente` (a stopped drain to resume), `vistos` (orderId → µs, the overlap's dedup), `emExecucaoAteMs` (lease), `ultimaVarreduraEmMs`, `ultimoErro`, `falhasSeguidas`. It advances only after every row is enqueued. *(Amended at step 4 implementation: the ISO `cursor` became `cursorMs`; step-3/4 plan §3 decision 20.)*
- **Rule 7:** single-flight lease plus an advance-only cursor, both tier 1 (`update(…, {lastUpdateTime})`, the Admin SDK precondition; not the order field `lastUpdatedTime`).
- **Bootstrap:** no cursor ⇒ `now − AMAZON_POLL_LOOKBACK_H`. The window sets it (W7).
- **Firestore:** the cursor doc (bare and Meta-less, so no ruleset change: both `gen:rules` checks stay up to date). **Env:** `AMAZON_POLL_LOOKBACK_H` (functions only).
- **Verification:** fixture-driven sweep tests: empty page; several pages; truncated window ⇒ cursor unchanged; a stale run never moves the cursor back; a held lease exits.
- **Does NOT:** map anything (the task re-fetches); replace push.

### Step 5: Order → pedido import — PRE

- **Gate:** `importarPedido`, `dadosFiscaisSeparados: 'sim'`, `consolidaPacote: 'nao'`. **Trigger:** Cloud Task (push or poll). **Docs:** M:orders_2026-01-01.json; D:access-orders-pii; D:get-tax-information; D:orders-api-migration-guide.
- **Wire:** `getOrder(orderId, includedData = BUYER, RECIPIENT, TAX, PAYMENT, PROCEEDS, FULFILLMENT, PACKAGES, CANCELLATION)`. Items are always inline. No RDT.
- **Ids:** the §3 digests. A migrated pedido is found by id; its items match by `OrderItemId`.
- **Mapping:**
  - The §3 estado table, monotonic: never overwrites ERP-owned progress or fields the operator owns.
  - `pedido.marketplace {tipo: 'amazon', status: <fulfillmentStatus verbatim>, statusEm}`; `MARKETPLACE_PEDIDO_TIPO` gains `amazon`.
  - Items through link docs; unmatched lines flagged.
  - Money from `proceeds.breakdowns` (ITEM, SHIPPING, DISCOUNT, TAX), with tax inclusion settled by capture C1.
  - `freteInicial` seeded with `seedFreteInicial`: `externalOptionIntegracao = INTEGRACAO_FRETE.amazon`, `integracaoFreteOuterRef` = the conta's `'amz'` int_frete (step 20), `prazoDespacho = shipByWindow.latestDateTime` (µs), `modalidade` from the conta.
- **Order items vs sale state (D17) — `reconciliarItens(armazenado, recebido)`, a pure function.** Which rule applies depends on whether the sale was **reversed**, decided from the incoming order:
  - **Reversal signals** **[model]**. Orders v2026 has **no refund or return status** (a refunded or returned order stays `SHIPPED`; refunds live in the Finances API), so the guard keys on what the order data does carry:
    - `fulfillment.fulfillmentStatus = CANCELLED`;
    - a line with a `cancellation` block (`cancellationRequest` or `cancellationExecution`);
    - a package whose `packageStatus.detailedStatus` is `REJECTED_BY_BUYER`, `UNDELIVERABLE`, `RETURNING_TO_SELLER`, `RETURNED_TO_SELLER`, `LOST` or `DAMAGED`;
    - an order already `SHIPPED` (or a pedido already invoiced) whose lines or money arrive zeroed, emptied or short: that is how a refund or return would show up, and nothing left to ship can be protected by blocking it. **Interim:** P4 replaces this inference with explicit refund and return signals after the cutover.
  - **Reversed ⇒ keep everything stored.** On a cancelled order Amazon sends item values **and quantities** as 0 **[operator]**, may drop the items (suspected), and refunds or returns may do the same (suspected by Lucas). Copied blindly, a 0 quantity breaks the reservation release, and 0 money breaks the line totals, the pagamento and the return NF-e built from the pedido. So:
    - every stored line is kept (matched by `OrderItemId`; migrated lines through `mktplaceId`), even when `orderItems` is empty, absent or short;
    - a 0 or absent quantity or money value never overwrites a stored value > 0; each group is kept as a unit (a line: quantity + unit price + discount + tax; the order: freight + total; a pagamento: `valor`);
    - what changes: the estado (`cancelado`, refund after payment), `pedido.marketplace.status`, the cancellation info and the freight state (step 7). The reservation, if any, is released with the **stored** lines and quantities. A zeroed `SHIPPED` order with no explicit signal also raises an aviso ("possível reembolso ou devolução") so someone checks the return flow.
  - **Approved but not yet shipped (UNSHIPPED / PARTIALLY_SHIPPED), no reversal signal ⇒ the items must match Amazon exactly: never ship more or fewer.** If the incoming item set or any line differs from the stored pedido (a line added, removed or zeroed, or a quantity or price changed), the import does **not** apply it silently. It is a **blocking divergence**: persist `estado: error` with the diff and raise an aviso, then stop, so the order is neither picked, invoiced nor shipped until a human checks (the ML `orderShipmentConference` pattern: persist the error, never just throw).
  - **Before approval (PENDING / PENDING_AVAILABILITY) ⇒ Amazon's list is mirrored as it arrives** (lines added, updated and removed); nothing has been picked or invoiced yet.
  - **First import** (nothing stored): what arrives is written. A non-reversed order with a 0 quantity or price raises an aviso, because it cannot be invoiced. A first-seen CANCELLED order is skipped anyway.
  - ⚠️ **The wire schema must tolerate a missing or empty `orderItems`.** The v2026 model lists it as required on `Order`. A strict parser would turn an item-less cancelled order into a `ZodError`: the notification would be parked and the cancellation never recorded. The schema accepts absent or `[]`; the rules above decide what happens.
  - **Observability:** the task's log line carries `detail: 'itens-preservados-reversao'` or `'divergencia-itens-aprovado'` plus the counts.
  - **Rule 7:** decided from the pedido read inside the step-5 transaction (`tx.get`), together with the watermark, never from a read taken before it.
- **Cliente:**
  - `findOrCreateCliente` with `cpf_cnpj` from `taxRegistrations[BUYER]`, the buyer name, and the address from `recipient.deliveryAddress` + `extendedFields`, with the IBGE code resolved at import.
  - A PENDING order (name and address still gated) creates the pedido **without** a cliente. The PENDING→UNSHIPPED `ORDER_CHANGE` re-fetches and completes it.
  - The MARKETPLACE tax registration, while visible, is compared with the conta's intermediador `cpf_cnpj`; a mismatch raises an aviso.
- **AFN:** flagged, no stock effect, aviso (D7).
- **Rule 7:** tier-2 watermark. `lastMarketplaceUpdate` (µs, from `lastUpdatedTime`) is re-read inside the transaction; anything not fresher is dropped; the winning write always advances it. Class B in the transaction inventory, with that named guard.
- **Firestore:** `pedidos` (+ items), `clientes/{id}/enderecos`, the history subcollections written by the existing triggers. No new index expected (ids are deterministic). Rulesets: the `MARKETPLACE_PEDIDO_TIPO` enum may reach the generator; checked by the diff.
- **Verification:**
  - `orderIds.test.ts` (vectors + near-misses);
  - an estado table test that enumerates every `FulfillmentStatus`;
  - the D17 item rules, one table over (sale state × incoming change), with near-misses:
    - **reversed** (CANCELLED / line `cancellation` block / return-type package status / zeroed `SHIPPED`): stored quantity 2 + incoming 0 ⇒ 2 kept with its price; stored price 10.00 + incoming 0 or absent ⇒ 10.00 kept; `orderItems` empty, absent or missing one of two lines ⇒ every stored line kept, no `ZodError`; estado and status still updated; reservation released with the stored lines;
    - **approved, not shipped, no reversal signal**: a line removed, added or zeroed, or a quantity 2 → 1 ⇒ `estado: error` + aviso with the diff, nothing silently applied; an identical item set ⇒ no divergence;
    - **near-misses across the boundary**: the same zeroed line on a CANCELLED order ⇒ kept, on an UNSHIPPED order with no signal ⇒ divergence; a `SHIPPED` order with unchanged values ⇒ no aviso; stored 10.00 + incoming 0.01 on UNSHIPPED ⇒ divergence (a change, not a zero);
    - **before approval**: PENDING items mirrored, including a removed line;
  - the models' BR sandbox orders (B2B `searchOrders` case + `getOrder 171-9876543-2109876`) as fixtures;
  - a migrated-pedido fixture with legacy item keys;
  - PENDING without PII ⇒ no cliente.

  Captures C1 settle §1.2 items 1–4b before merge.
- **Does NOT:** keep an order mirror; map the notification body; create produtos.

### Step 6: Payment → pagamento — PRE (same task as step 5)

- **Wire:** `payment.paymentExecutions[]` (PAYMENT). **Id:** the same digest as the pedido.
- **Mapping:** the §3 payment-form table; `valor` = the sum of the executions (reconciled against `proceeds.grandTotal`, which is what the seller receives); approved from UNSHIPPED; cancelled → the cancel/refund status. D17 applies: on a reversed sale (cancellation, return, refund) a zeroed payment amount changes the status but keeps the stored `valor`; on an approved order not yet shipped a changed amount is part of the blocking divergence.
- **Does NOT:** record Amazon fees (Finances, P3) or installments (not exposed).
- **Verification:** each `paymentMethod` with a fallback; card/Pix carry the acquirer CNPJ + authorization code into the NF-e payment group.

### Step 7: Easy Ship status → `freteInicial` — PRE

- **Gate:** `rastreio: 'pull'`. **Trigger:** the step-5 task (every order change) plus, only if capture C1 shows `lastUpdatedTime` does not move on package events, a 6-hourly in-transit refresh over pedidos with Amazon freight in transit (≤ ~50/day ⇒ trivial).
- **Mapping** (`packages[].packageStatus.detailedStatus` → `freteInicial.estado`; enum names checked against `frete.ts` in the step plan; unknown ⇒ no change + aviso):

| detailedStatus | freteInicial.estado (intent) |
|---|---|
| `PENDING_SCHEDULE` | awaiting the invoice, or awaiting scheduling (`invoiceStatus` decides) |
| `PENDING_PICK_UP`, `PENDING_DROP_OFF` | scheduled, awaiting posting (printing only fetches the label link, step 15) |
| `LABEL_CANCELLED` | needs rescheduling + aviso (the pickup was cancelled, not the order) |
| `PICKED_UP`, `DROPPED_OFF` | posted |
| `AT_ORIGIN_FC`, `AT_DESTINATION_FC`, `OUT_FOR_DELIVERY` | in transit (never a pre-checkout state) |
| `DELIVERED` | delivered |
| `REJECTED_BY_BUYER` | delivery failed |
| `UNDELIVERABLE` | address not found |
| `RETURNING_TO_SELLER` / `RETURNED_TO_SELLER` | returning / returned |
| `LOST`, `DAMAGED` | lost |

- **Rule 7:** state-preserving merge under the step-5 watermark; transitions only forward along the table.
- **Does NOT:** write tracking back to Amazon (Amazon owns DBA tracking).

### Step 8: DROPPED (template stuck-reservation release)

Amazon cancels orders whose payment fails. `ORDER_CHANGE` (`OrderStatusChange` to CANCELLED) or the backstop poll carries the change to step 5, whose table releases the reservation.

### Step 9 + 9b: Listing link (read-only) + the anchor trigger — PRE

> **⏸ Discussion first (D18).** Before this step's Phase-3 plan, Lucas walks through the known problems of the legacy listing flows and we decide how to handle them. The bullets below are the starting point for that conversation, not a decision.

- **Gate:** `importarAnuncio: 'sim'`. **Trigger:** HTTP + a Cloud Task job; 9b is a Firestore trigger. **Docs:** D:report-type-values-inventory; M:listingsItems_2021-08-01.json; M:reports_2021-06-30.json.
- **Link job** (`importacoesAmazon/{jobId}`, the ML mass-import job shape: a durable checkpoint, a self-re-enqueuing chain, capped failure detail):
  1. `createReport GET_MERCHANT_LISTINGS_ALL_DATA` → `getReport` → `getReportDocument`, parsed **by header name**.
  2. For each SKU not yet linked on the conta: `getListingsItem(includedData = summaries, relationships)`.
  3. Suggest a produto by SKU, then by EAN/GTIN.
  4. **The operator confirms** in the web screen.
  5. Write the `prodAmazon` link doc (`produtoAmazonLinkSchema`; new docs get a deterministic id from `(contaId, sku)`). Parent relationships are recorded.
- **Scale (~20,000 SKUs, D8):** the report is the only full enumeration (`searchListingsItems` stops at 1,000 results). Detail reads (`getListingsItem`, 5 rps) are made only for SKUs not already linked, and the migrated corpus already links most of the catalogue. A full first pass would be ≈ 20,000 reads ≈ 67 min, so the job is resumable and paced, and interleaves with order intake.
- **Single-SKU link:** the operator types a SKU (a listing created in Seller Central after the cutover) → `getListingsItem` → confirm → link.
- **9b `onProdutoAmazonLinkChanged`:** maintains `produtos.integracoesComProduto` from link docs, like the existing ML and Shopee link triggers.
- **Firestore:** `prodAmazon` (collection-group index `(contaAmazonOuterRef ASC, sku ASC)`), `importacoesAmazon` + `(integracaoId, status)`; both rulesets regenerated for the job collection.
- **Rule 7:** link writes are operator-driven `create()` on a deterministic id (ALREADY_EXISTS ⇒ already linked); job cancellation versus finalisation is a classified transaction (ML precedent).
- **Verification:** report parsing by header (capture C5), family grouping, a near-miss on the link key (same SKU, other conta).
- **Does NOT:** create produtos, import photos, prices or stock (P3), or publish (step 11).

### Step 10: Product Type Definitions — POST

> **⏸ Discussion first (D18)**, as for step 9.

Cached `getDefinitionsProductType` (locale `pt_BR`) for publishing. Not needed before the cutover: stock and price patches use `productType: PRODUCT`.

### Step 11: Publish / edit / pause + `linksVariacoesAmazon` typing — POST

> **⏸ Discussion first (D18)**, as for step 9. Publishing is where most of the legacy listing problems sit.

`putListingsItem` with `VALIDATION_PREVIEW` first; families; pause through `purchasable_offer.end_at`.

### Step 12: Stock sync — PRE

- **Gate:** `estoque.suporte: 'sim'`, `protocolo: 'feed-assincrono'` (bulk) with per-SKU patches for deltas. **Trigger:**
  - event-driven deltas from the shared estoque core (Cloud Task per flush of changed SKUs);
  - a daily reconcile (`onSchedule`);
  - a manual send per produto (HTTP row action) and an operator "send all" (HTTP → job).
- **Two write paths, one body.** Both carry `{productType: 'PRODUCT', op: 'merge', path: '/attributes/fulfillment_availability', value: [{fulfillment_channel_code: 'DEFAULT', quantity}]}`; `merge` keeps the lead time.
  - **Patch path:** `PATCH /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=A2Q3Y263D00KWC`, used for a flush of **fewer than 1,500 SKUs** (sale-driven deltas, a single produto). `ACCEPTED` ≠ applied, so the issues come back on the link doc.
  - **Feed path:** one `JSON_LISTINGS_FEED` of `PATCH` messages (step 12a), used for **1,500 SKUs or more** (the daily reconcile's drift, "send all", the window's first full push, a mass ERP stock adjustment). 20,000 SKUs fit in one feed (≤ 25,000 messages, ≤ 10 MB).
- **Quantity:** one function shared by every path. It uses the conta's depósito, is clamped at 0, makes kits ERP-computed, honours `statusProdutosMarketplace[...].enviarEstoque === false`, skips parents, and never writes AFN.
- **Read cost (the cost centre, now at ~20,000 SKUs):**
  - Discovery opens with the `integracoesComProduto` anchor and a change-window aggregate, so an idle tick costs ~nothing.
  - The daily reconcile reads Amazon's quantities from **one report**, `GET_MERCHANT_LISTINGS_ALL_DATA` (`quantity` column, parsed by header), not from 20,000 `getListingsItem` calls (≈ 67 min at 5 rps). The report is 1–6 h stale, so a SKU with an ERP movement or an Amazon order after the report's data time is excluded from that day's drift and left to the delta path.
  - The ERP side of the reconcile reads ~20,000 stock positions per day from Firestore; Enterprise bills data scanned, so the step plan measures it and declares the indexes. Sweep tiering is decided from that measurement, not assumed.
- **Rule 7:**
  - One writer per SKU on the patch path (a queue with `maxConcurrentDispatches: 1`); the quantity is computed at dispatch time, never baked in at enqueue time.
  - ⚠️ **Feed vs patch race.** Amazon applies patches and feed messages in **submission-timestamp order**. A feed built from a snapshot at T0 and submitted at T3 would overwrite a patch sent at T2 for a sale at T1 (T0 < T1 < T2 < T3) with the stale quantity. Guards:
    - (1) the feed is built from quantities read immediately before `createFeed`, and its snapshot time is stored (`snapshotEmUs`);
    - (2) when the feed completes, a catch-up re-sends a patch for every SKU whose ERP quantity moved since `snapshotEmUs` (the ledger change window);
    - (3) at most one stock feed in flight per conta (a lease). Patches keep flowing during the feed.
- **Dry-run/valve:** `AMAZON_MODO_ESTOQUE` + canary.
  - The patch dry-run diffs against `fulfillmentAvailability`. Its read-back is deferred ≥ 5 min (the 1–5 min visibility lag).
  - The feed dry-run builds the whole feed document and diffs it against the listings report, without `createFeed`.
  - Under a canary list other than exactly `*`, bulk paths send **patches for the canary SKUs only**, never a feed.
- **Verification:**
  - the quantity table (kits, depósito, `enviarEstoque`, parent skip, AFN);
  - the 1,499/1,500 path switch (near-miss);
  - an idle-tick cost test;
  - a stale patch task loses to a fresh one;
  - the catch-up re-sends exactly the SKUs moved after the snapshot.
- **Does NOT:** subscribe `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` (P1); read 20,000 listings one by one.

### Step 12a: Feed submission infrastructure (`JSON_LISTINGS_FEED`) — PRE

The template's `'feed-assincrono'` warning applies: the notification pipeline has no state for "submitted, result unknown", so the feed needs **its own submission record plus a result poll**. No channel here has built one. Shared by stock (step 12) and bulk price (step 13).
- **Wire** **[model]** (`feeds_2021-06-30.json`, `schemas/feeds/listings-feed-schema-v2.json`):
  1. `POST /feeds/2021-06-30/documents {contentType: 'application/json; charset=UTF-8'}` → a pre-signed upload URL (5 min).
  2. `PUT` the document to that URL: `{header: {sellerId, version: '2.0', issueLocale: 'pt_BR' (en_US fallback)}, messages: [{messageId, sku, operationType: 'PATCH', productType: 'PRODUCT', patches: [...]}]}`.
  3. `POST /feeds/2021-06-30/feeds {feedType: 'JSON_LISTINGS_FEED', marketplaceIds: ['A2Q3Y263D00KWC'], inputFeedDocumentId}`. Limits: `createFeed` 0.0083 rps / burst 15; `JSON_LISTINGS_FEED` 5 feeds per 5 minutes per account.
  4. Completion: the `FEED_PROCESSING_FINISHED` notification (SQS, the step-3 relay and receiver) **and**, as the backstop, a Cloud Task polling `getFeed` (2 rps) with backoff until `DONE`/`CANCELLED`/`FATAL`, deadline 12 h (Amazon: up to 8 h under load).
  5. `GET /feeds/2021-06-30/documents/{resultFeedDocumentId}` → download (5-minute URL, possibly gzip) → the processing report: `summary` plus per-message `issues[]` with `sku`, `code`, `severity`.
- **Submission record** `feedsAmazon/{feedId}` (admin-only, a bare const outside `ALL_DOMAINS`): `contaId`, `fluxo` (`estoque` | `preco`), `snapshotEmUs`, `mensagens`, `status` (`enviado` | `processando` | `concluido` | `falhou` | `cancelado`), `resultado {erros, avisos, aceitos, invalidos}`, `criadoEmMs`, `prazoEmMs`. The input document itself is never stored in Firestore (≤ 10 MB).
- **Result handling:** per-SKU issues are written to that SKU's link doc (`issues`, the legacy field). A report with errors **completes** the task; it never throws or loops. `FATAL`, `CANCELLED` or a missed deadline ⇒ aviso.
- **Rule 7:** the record is created with `create()` on the `feedId` Amazon returns (tier 0). Status moves only forward (tier 1 precondition). The notification and the poll may both arrive, and the second one finds a terminal status and does nothing.
- **Firestore:** `feedsAmazon` + an index `(contaId ASC, status ASC)`; both rulesets regenerated.
- **Verification:** the feed document validates against `listings-feed-schema-v2.json`; the report parser handles errors, warnings and per-SKU attribution; a duplicate completion is harmless; the deadline raises an aviso.
- **Does NOT:** use legacy XML or flat-file feeds (removed by Amazon); submit a feed under a canary list other than `*`.

### Step 13: Price push (manual) — PRE

- **Gate:** `enviarPreco: 'sim'`. **Trigger:** HTTP (per-produto row action) + a bulk job (`precosAmazon` job doc). **Docs:** D:manage-purchasable-offer; D:manage-listings-issues.
- **Ladder** (ML's eight gates):
  1. fresh `getListingsItem` (attributes + issues);
  2. skip if the **whole offer** is equal (our_price, min, max);
  3. status gate (skip parents and non-buyable listings);
  4. decrease guard (operator confirms);
  5. build the merge body `purchasable_offer [{marketplace_id, currency: 'BRL', audience: 'ALL', our_price, minimum_seller_allowed_price, maximum_seller_allowed_price}]` with `value_with_tax`, rounded by `roundReais`;
  6. PATCH;
  7. read back (issues 19037/19038/18701 are refusals);
  8. write the outcome back.
- **Bulk (≥ 1,500 SKUs, D8):** the ladder above runs per produto. A bulk job over the catalogue (up to ~20,000 SKUs) cannot read 20,000 offers one by one, so it changes in three ways:
  - **Gate 1 (fresh read)** becomes the listings report's `price` column plus the last offer the ERP sent, recorded on each link doc (`ultimaOfertaEnviada {our, min, max, emUs}`). `min`/`max` are not in any report.
  - **Gate 6 (send)** becomes one `JSON_LISTINGS_FEED` of `PATCH purchasable_offer` messages (step 12a).
  - **Gate 7 (read-back)** becomes the processing report plus a sampled `getListingsItem` check.
- **Range:** `faixaDePrecoAmazon(produto, conta) → {base, minimo, maximo}` (D9, v1 orchestrator call). When the promotional list is deprecated, only this function changes.
- **Dry-run/valve:** `AMAZON_MODO_PRECO` + canary. The per-produto dry-run diffs against `attributes.purchasable_offer`; the bulk dry-run builds the feed document and diffs it against the report and the recorded offers.
- **Verification:** range table, including the near-miss "equal our_price, different min"; per-conta scoping; the bulk job's skip-if-equal against `ultimaOfertaEnviada`.
- **Does NOT:** push automatically on a price change (D9); send `discounted_price` or B2B price (P3).

### Step 14: NF-e upload (Delivery by Amazon) — PRE

- **Gate:** `enviarNfe: 'sim'`.
- **Trigger:** `onNfeAprovadaAmazon` (`onDocumentWritten` on `pedidos/{pedidoId}/nfev4/{nfeId}`, database `default`). It is an **edge** trigger via `decideNfeUploadTransition` (`packages/schemas/src/nfeEnvioCanal.ts`), so a level re-fire never floods. It requires `tpAmb == 1` (`extractTpAmb`), `aprovada`, a tipo-8 conta and an Easy Ship order, then enqueues `processAmazonNfeUpload`.
- **Docs:** D:delivery-by-amazon-api; D:submit-an-invoice-delivery-by-amazon-order; D:check-the-invoice-status-for-a-delivery-by-amazon-order; release notes 2026-09-30.
- **Wire:**
  1. `GET /delivery/2022-07-01/invoice/status?orderId&marketplaceId&invoiceType=Outbound&programType=EasyShip` **first**: idempotency is the live provider state.
  2. If `NOT_FOUND`/`ERRORED`: `POST /delivery/2022-07-01/invoice?orderId=` `{invoiceContent: base64(nfeProc XML), contentMD5Value: base64(md5(xml bytes)), invoiceType: 'Outbound', programType: 'EasyShip', marketplaceId}`.
  3. Enqueue the status check with backoff (1, 2, 5, 10, 30 min…, deadline 24 h), reading `orderInvoicingStatus` / `invoiceStatus` / `invoices[]`.
  4. `ACCEPTED` ⇒ enqueue step 15.
  5. `Errored`/`Rejected`/`NotFound` after submit ⇒ aviso `nfeUploadRejeitado` + `freteInicial.estado = error` (deterministic failure, watermarked) and **never schedule**.
- **Re-drive:** `POST /api/marketplace/amazon/enviar-nfe` (`PERM.pedido.write`).
- **Firestore:** the failure stamp only; the happy path writes nothing (ML zero-write model).
- **Dry-run/valve:** `AMAZON_MODO_NFE` + canary.
- **Verification:** edge vs level (a rewrite of an approved NF-e does not re-fire); status-first idempotency; every status branch; MD5 encoding vector.
- **Does NOT:** upload EPEC-only NF-e; schedule anything itself.

### Step 15: Easy Ship scheduling + on-demand ZPL label — PRE

- **Gate:** `etiqueta: 'fetch'`. **Trigger:** Cloud Task from step 14 (D12, automatic) and HTTP from checkout (print and reprint). **Docs:** [LATAM, retired] (`evidence/latam-dba-review.md`); M:easyShip_2022-03-23.json; D:tokens-api; D:get-tax-information step 5.
- **What the "label link" is.** It is `printableDocumentsUrl` from `createScheduledPackageBulk`, a zip that lives ~3 minutes. There is no separate "get label" operation for BR (`getScheduledPackage` carries no document field), and the link is never stored because it expires. For an order that is **already scheduled**, the same call **does not reschedule**: it returns the existing schedule plus a fresh link **[LATAM, retired] + [operator]: this is how reprinting works in production today**. Fetching the link therefore needs nothing but that call.
- **Scheduling (automatic, once, D12):** the step-14 task, on `ACCEPTED`:
  1. RDT: `POST /tokens/2021-03-01/restrictedDataToken {restrictedResources: [{method: 'POST', path: '/easyShip/2022-03-23/packages/bulk'}]}`.
  2. `POST /easyShip/2022-03-23/packages/bulk {marketplaceId, orderScheduleDetailsList: [{amazonOrderId}], labelFormat: 'ZPL'}`: ONE order per call, slot chosen by Amazon.
  3. Write `freteInicial` (`codRastreio = trackingDetails.trackingId`, `externalId = scheduledPackageId.packageId`, `estado = despachoAutorizado`). The link in the response is discarded.
- **How the ERP knows it can go straight to the label** (the same signals the legacy used, made explicit):
  - `freteInicial.estado` says scheduled: `despachoAutorizado` written by the step above, or the post-scheduling states mirrored from Amazon's package status by step 7 (`PENDING_PICK_UP` / `PENDING_DROP_OFF`);
  - the NF-e acceptance is Amazon's own `tax.taxInvoicing.invoiceStatus = ACCEPTED`, mirrored by steps 5/14.

  No new flag or collection is added: `freteInicial` already carries it.
- **Printing and reprinting (checkout):** `POST /api/marketplace/amazon/etiqueta {pedidoId}`:
  - **already scheduled** ⇒ just fetch the link: RDT + the same bulk call, download the zip **inside the request**, return the first `.zpl` entry. No NF-e upload, no new schedule, no extra status reads;
  - **not scheduled yet, NF-e `ACCEPTED`** ⇒ the same call schedules and returns the link, and `freteInicial` is written as above;
  - **NF-e not accepted yet** ⇒ 409 "aguardando aceite da NF-e pela Amazon" (the step-14 chain is still running).
- **No label is stored (D12, amended):** no `Arquivo`, no Storage object, no retention question.
- **Rule 7:** two callers at once (the automatic task and a checkout print) are harmless, because Amazon returns the same schedule to the second caller and the `freteInicial` write carries the same values (tier 0). No lease and no schedule record are needed.
- **Rejections:** `MissingPackageDimensions` ⇒ aviso + a 409 with the reason at checkout (fix in Seller Central); anything else ⇒ aviso with the code (open set).
- **Web:**
  - `apps/web/lib/checkout/etiqueta/providers/amazon.ts` calls `POST /api/marketplace/amazon/etiqueta {pedidoId}` and prints the returned ZPL with exact `text/plain`;
  - `FREIGHT_TIPO_CAPS.amz.canFetchLabel = true` (only that flag);
  - `'amz'` leaves `unsupportedMarketplace`.
- **Firestore:** `pedidos.freteInicial` only; no new collection, no ruleset change.
- **Dry-run/valve:** `AMAZON_MODO_AGENDAMENTO` + canary (the dry-run checks the gates and builds the body; no bulk call). Printing an order that is already scheduled is a read of an existing schedule, but it still goes through the valve because bulk is a write endpoint.
- **Verification:** gates refuse before `ACCEPTED`; the zip is downloaded within the request; first `.zpl` entry extraction; a second call returns the same tracking id (fixture from capture C3); `MissingPackageDimensions` ⇒ 409.
- **Does NOT:** store labels; choose slots; patch catalog dimensions; reschedule (Seller Central); request PDF.

### Steps 16, 18, 19: DROPPED (§4.24) · Step 17: returns/claims — POST, folded into P4

### Step 20: `int_frete` binding for `'amz'` — PRE

- `VINCULO_INT_FRETE_CONTA` gains the Amazon row (back-ref `contaAmazonContaFreteAmazonOuterRef`).
- A conta trigger materialises or deactivates the conta's `'amz'` `int_frete` via `intFreteContaSync`.
- A one-shot adoption script (`tools/migrations`, in the shape of Shopee's `migrate:shopee-int-frete`) adopts the migrated docs (W12).
- **Firestore:** `int_frete` + its index. **Verification:** adoption dry run reports zero duplicates.

### Step 21: `apps/web` — PRE, piecewise

- `/canais/amazon` becomes a TableView (replacing `CanalCapsPanel`).
- **The conta screen:** connect button (OAuth), status/aviso panel, intermediador fields (`cpf_cnpj`, `idCadIntTran`), freight tab.
- **Link UI:** job + single SKU.
- **Estoque and preço row providers** in `apps/web/lib/marketplace/{estoque,preco}/registry.ts`, gated off the caps row.
- **The etiqueta provider** (step 15).
- `selling_partner_id` is shown read-only (server-owned).

### Step 22: Deploy isolation, rosters, settle `reclamacoes`, flip `implementado` — PRE

- *(Amended in step 3, PR 3-d: the deploy plumbing — `firebase.amazon.deploy.json`, `prepare-deploy.mjs` and the `tools/deploy-env` preflight row — the codebase rosters (`tasks-invoker-inventory`, `runtime-deps-pinned`, `functions-export-names`) and the root `CLAUDE.md` manifest counts shipped with the functions codebase in step 3. The nested manifest's `firebase-admin` / `firebase-functions` pins follow the catalog exactly (14.5.0 / 7.4.0 today, the root `CLAUDE.md` exact-pin bump rule), never the 14.2.0 / 7.3.2 this step named before.)*
- What stays here: the App Hosting rosters and the remaining root `CLAUDE.md` counts (App Hosting apps, codebases, lanes).
- Capture C6 settles `reclamacoes`, then `implementado: true` and `registriesAlinhadas.test.ts`.

### P1–P3: POST-cutover

- **P1:** (⏸ D18 discussion first) listing and product notifications. EventBridge `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE` (payload 2023-12-13; 1.0 was removed) and `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` (fires on our own patches too: filter the echo) → a rule → an API destination → the step-3 receiver.
- **P2:** automated LWA secret rotation (`rotateApplicationClientSecret`, grantless, plus the "Application Client New Secret" SQS row in Developer Central).
- **P3:**
  - "create produto from listing" import mode;
  - Finances fees;
  - B2B price;
  - External Fulfillment evaluation (the documented alternative path for BR DBA);
  - the DPP retention purge.
- **P4: refunds and returns, done properly** (⏸ an in-depth discussion with Lucas first; requested on 2026-10-14).
  - **Why:** before the cutover, D17 can only *infer* a refund or return from the order data (a zeroed `SHIPPED` order, a line `cancellation` block, a return-type package status), because Orders v2026 has no refund or return status. That inference protects the stored items and values, but it does not tell the ERP *what* happened: which items, how much was refunded, whether the goods came back.
  - **Sources to explore** (all documented, all deferred; none is in the pre-cutover slice):
    - **Finances API v2024-06-19** `listTransactions` with `relatedIdentifierName = ORDER_ID`: refund transactions per order (the v0 event operations, with `RefundEventList`, are removed 2027-08-27);
    - the **`TRANSACTION_UPDATE`** notification (SQS): a new transaction posted to the seller account, which can ride the step-3 relay and receiver;
    - **MFN returns reports** (`GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE` and siblings: return reason, refund amount, A-to-z flag; BR availability undocumented);
    - the **External Fulfillment Returns API** v2024-09-11 (`listReturns`/`getReturn`, read-only; BR eligibility undocumented; the same check settles `reclamacoes`);
    - the Orders v2026 signals D17 already reads (`cancellation`, `packages[].packageStatus`);
    - seller-issued refunds through the `POST_PAYMENT_ADJUSTMENT_DATA` feed, if Lucas wants the ERP to issue them.
  - **ERP side to design together:**
    - the pedido estado and pagamento status for a partial or full refund;
    - the return NF-e (devolução), which needs the original stored values D17 keeps;
    - stock re-entry when the goods come back;
    - the aviso and operator flow.
  - **Captures first:** one refunded order and one returned order, read before and after, from the Orders, Finances and returns sources.
  - **Outcome:** an explicit refund/return signal replaces D17's "zeroed `SHIPPED` order" inference; the keep-stored rule stays.

### 4.23 Request budget (D8 volumes; default usage plans)

| Flow | Calls/day |
|---|---|
| Backstop `searchOrders` (every 15 min) | 96 (bucket ≈ 480/day sustained) |
| `getOrder` (≈ 3–5 changes × 50 orders) | 150–250 at 0.5 rps |
| NF-e: status + submit + status checks | ≈ 50 × 4 at 1.133 rps |
| Easy Ship: RDT + bulk (schedule once + each print) | ≈ 50 × 2–4 at 1 rps |
| Stock deltas (patch + deferred read-back) | a few hundred at 5 rps |
| Daily stock reconcile | 1 listings report (create + status polls + document) + drift as patches (< 1,500) or 1 feed |
| Full stock push (≈ 20,000 SKUs) | 1 `JSON_LISTINGS_FEED`: document + upload + `createFeed` + status polls + report (vs ≈ 67 min of patches) |
| Price, per produto (manual) | ≈ 3 calls per SKU |
| Price, bulk (manual) | 1 listings report + 1 feed |
| Listing link job, first pass | 1 report + one `getListingsItem` per unlinked SKU (≤ 20,000 ≈ 67 min, resumable) |

**Queues** (starting points; the step plans confirm): a reads queue for intake and the link job; a writes queue (stock, price, NF-e, agendamento) with `maxConcurrentDispatches: 1` per flow; a feeds queue for the step-12a result polls; `minBackoff 10 s`, `maxBackoff 300 s`. `AmazonThrottleError` throws. Feeds stay far below the limit of 5 `JSON_LISTINGS_FEED` per 5 minutes: at most one stock feed and one price feed in flight per conta.

### 4.24 Dropped steps, with the `'nao'` or decision that dropped them

| Step | Dropped by | Note |
|---|---|---|
| 8 Stuck-reservation release | Amazon cancels | `ORDER_CHANGE` / backstop → step 5 |
| 16 Chat / Q&A / post-sale | `perguntas: 'nao'`, `mensagensPosVenda: 'nao'` | `origensConversa: []` |
| 18 Tabela de medidas | `tabelaDeMedidas: 'nao'` | — |
| 19 Kits virtuais | `kitVirtual: 'nao'` | ERP-computed kit quantity in step 12 |
| Template step 4 missed-feed replay | no replay feed in SP-API | the cursor + SQS retention + DLQ |
| Sweep tiering | not assumed (D8) | deltas + one daily reconcile; tiering is decided from the step-12 scan measurement at ~20,000 SKUs |

**Deferred by decision (POST, D3):** steps 10, 11, 17 (folded into P4) and P1–P4.

### 4.25 Execution order to reach cutover parity (stacked draft PRs; each step's Phase-3 plan approved first, D15)

1. **PR 0:** this plan + evidence, opened only after Lucas approves (D14).
2. **Step 0** (L1–L9).
3. **Step 1a → step 1** (PR a package + guard; PR b scaffold + rosters).
4. **Steps 2 + 2b + 21-conta.**
5. **Steps 3 + 4** (receiver, pipeline, backstop, CI lane).
6. **Step 20.**
7. **Steps 5 + 6 + 7** (captures C1 first).
8. **⏸ The listings discussion (D18)**, then **steps 9 + 9b + 21-link** (order items need links).
9. **Step 14 → step 15 + 21-etiqueta** (captures C2, C3 first).
10. **Step 12a** (feed infrastructure), then **step 12 + 21-estoque.**
11. **Step 13 + 21-preço** (the bulk path reuses 12a).
12. **Step 22** (capture C6).
13. **The window** (§5).

### 4.26 Amazon write inventory (every write → valve → dry-run → read-back)

None of these writes is exercised by this code before the window. Each one's first real write is a canary.

| Amazon write | Step | Valve (+ canary list) | Dry-run diff against | Read-back |
|---|---|---|---|---|
| `patchListingsItem` `fulfillment_availability` | 12 | `AMAZON_MODO_ESTOQUE` | `getListingsItem` `fulfillmentAvailability` | the same, deferred ≥ 5 min |
| `JSON_LISTINGS_FEED` (stock `PATCH` messages) | 12 + 12a | `AMAZON_MODO_ESTOQUE` (feeds only under a canary list of exactly `*`) | the whole feed document vs the listings report | the processing report + sampled `getListingsItem` |
| `patchListingsItem` `purchasable_offer` | 13 | `AMAZON_MODO_PRECO` | `getListingsItem` `attributes.purchasable_offer` | the same + issues |
| `JSON_LISTINGS_FEED` (price `PATCH` messages) | 13 + 12a | `AMAZON_MODO_PRECO` (feeds only under `*`) | the feed document vs the report price + `ultimaOfertaEnviada` | the processing report + sampled `getListingsItem` |
| `submitInvoice` (Delivery by Amazon) | 14 | `AMAZON_MODO_NFE` | `getInvoiceStatus` | `getInvoiceStatus` |
| `createScheduledPackageBulk` (schedule, and each label fetch) | 15 | `AMAZON_MODO_AGENDAMENTO` | the gates (status, invoice `ACCEPTED`) | `getScheduledPackage` / `getOrder` PACKAGES |
| `createDestination` / `createSubscription` | W5 | manual, by a person | — | `getSubscription` |

---

## 5. Migration-window items (rule 8: surfaced, NOT done)

Each item below becomes an issue **only after Lucas says yes to opening it**. That is a separate yes from approving this plan (D14). Each is labelled `needs-migration-window` + `task:ops-deploy` and linked from **#1208**, in ADR 0013 phase order. Agents never run any of these.

1. **W1: secrets + redirect URI.**
   - **Phase:** 0.
   - **Action:** in the new project's Secret Manager, put the LWA client id and secret, `AMAZON_RELAY_SECRET` (the same value also goes to AWS Secrets Manager for the relay; `AMAZON_RELAY_PREVIOUS_SECRET` only during a rotation) and `AMAZON_OAUTH_STATE_SECRET`. Register the new redirect URI (custom domain) on the app.
   - **Verify:** the routes boot.
   - **Why:** the backend cannot start without them, and the redirect URI must exist before W5.
2. **W2: the AWS relay stack.**
   - **Phase:** 0.
   - **Action:** from `infra/amazon-relay/`, the owner runs `cdk deploy` with the receiver's custom-domain URL as context and the relay key already in Secrets Manager (D16). It creates the queue, DLQ, Pipe, Connection, API destination and alarms.
   - **Verify:** the stack is green, and a test message put on the queue reaches the receiver (200).
   - **Why:** nothing flows until W5, so it is safe early. A custom domain means no retarget later.
3. **W3: delete the legacy token subcollection from the migrated docs.**
   - **Phase:** 2, after the import and before Phase-3 traffic.
   - **Action:** a `tools/migrations` script deletes `integracao/*/tokenoaut/*`. Dry-run, apply, then a second pass reports 0.
   - **Why:** those docs hold a live refresh token, and nothing in the new app reads them.
4. **W4: pause every legacy Amazon background writer at the freeze.**
   - **Phase:** 1.
   - **Action:** pause the legacy order-poll scheduler, the stock fan-out, the feeds/scheduling/products queues and the NF-e trigger.
   - **Verify:** no legacy Amazon call is logged after the freeze.
   - **Why:** they write to **Amazon** (stock, scheduling, invoices), not only to Firestore. Leaving them running makes two writers.
5. **W5: connect + subscribe.**
   - **Phase:** 3 step 4.
   - **Action:** set `AMAZON_CHAMADAS=on` and roll out. Connect the conta (OAuth, `version=beta`). Then `createDestination` (the SQS ARN; grantless, scope `sellingpartnerapi::notifications`) and `createSubscription ORDER_CHANGE` (payloadVersion 1.0) and `createSubscription FEED_PROCESSING_FINISHED` (step 12a), both to the same SQS destination.
   - **Verify:** `getSubscription` lists both subscriptions, and the next order change arrives as `origem: 'push'`.
   - **Why:** a subscription before the legacy is off would deliver orders into a system that must not yet act on them.
6. **W6: switch off the old product-notification path.**
   - **Phase:** 4.
   - **Action:** disable the old EventBridge rule and forwarder; delete or keep the old listing subscriptions per P1's plan.
   - **Why:** after the legacy is off, those events fail against a dead endpoint.
7. **W7: seed the backstop by look-back.**
   - **Phase:** 3.
   - **Action:** set `AMAZON_POLL_LOOKBACK_H` to cover the freeze plus a margin.
   - **Verify:** every Amazon order since the freeze has a pedido.
   - **Why:** it is idempotent by the deterministic ids.
8. **W8: valves.**
   - **Phase:** 4.
   - **Action:** per flow (estoque, preço, NF-e, agendamento): `dry-run` → canary → `on` → `*`. The first full stock push (≈ 20,000 SKUs) is one `JSON_LISTINGS_FEED`, first as a dry-run (the feed document diffed against the listings report) and only then submitted, once the canary list is `*`.
   - **Verify:** the run-start log line, then the dry-run diffs, then clean read-backs; for the first feed, its processing report (errors per SKU) and the post-feed catch-up count.
   - **Why:** there must be no dual writer to Amazon.
9. **W9: deploy in order.**
   - **Phase:** 0/3.
   - **Order:** indexes → rules → the `amazon` functions codebase (`firebase deploy --config firebase.amazon.deploy.json --project <new>`) → `apps/amazon` App Hosting (with the real `AMAZON_TASKS_REGION`) → `apps/web`.
   - **Why:** on Enterprise a missing index full-scans and bills; an enqueue against a queue that does not exist yet is dropped while the route answers 200.
10. **W10: intake smoke + first label.**
    - **Phase:** 4.
    - **Action:** one real order goes SQS → Pipe → receiver → task → pedido (ids, links, payment, `freteInicial`). Then the first DBA NF-e upload and label on a canary order.
11. **W11: `integracoesComProduto` + link-doc census** (⏸ its repair rules follow the D18 listings discussion).
    - **Phase:** 4.
    - **Action:** a read-only census of `prodAmazon` (by field, since doc ids are mixed): missing anchors, duplicates, children carrying the parent's ASIN or SKU. It produces an operator repair list.
    - **Why:** an import fires no triggers.
12. **W12: `int_frete` adoption pass** (step-20 script).
    - **Phase:** 2, before the functions deploy.
    - **Action:** dry run, apply, dry run again.
13. **W13: rotate the LWA client secret.**
    - **Phase:** 4, after the new integration's calls succeed.
    - **Action:** rotate in Developer Central; update the new project's secret.
    - **Why:** the legacy's copy stops working after the 7-day grace. Do **not** revoke the app authorization (D10).

---

## 6. Definition of ready: checklist

- [x] Caps row drafted; every `'sim'`/`'nao'` cites a doc or model path (§1, `evidence/caps-verify-result.md`).
- [ ] `reclamacoes` settled (capture C6) before step 22.
- [x] Every dropped step listed with its `'nao'` or decision (§4.24).
- [x] `estoque.protocolo` decided: `'feed-assincrono'` for bulk (~20,000 SKUs) with per-SKU patches for deltas, and the plan contains the submission-record + result-poll step no channel here has written (step 12a), including the feed-vs-patch ordering guard.
- [x] All AWS-side code is TypeScript in the repository (`infra/amazon-relay/`, D16); nothing lives only in the AWS console.
- [x] `assinaWebhook: 'sim'` with its Amazon meaning written in the row, and the receiver fails closed (step 3).
- [x] Legacy corpus checked: `prodAmazon` (mixed ids), `tokenoaut`, the `'amz'` `int_frete`, the produto denorms and the two deterministic ids constrain the port. **No order mirror exists, and none is invented** (§3).
- [x] Decisions D1–D18 recorded, with the vetoable orchestrator calls (§2.1).
- [x] Every Amazon write has a valve, a canary, a dry-run and a read-back (§4.26).
- [x] The PRE/POST split is explicit on every step (§4.i).
- [ ] This plan approved by Lucas (PR review).
- [ ] Tracker + step issues opened (D14, after approval).
- [ ] L1 roles confirmed; L4 AWS access; L6 redirect-URI domain.
- [ ] The listings discussion held (D18) before the step-9 plan.

---

## 7. Questions still open for Lucas (not decided above)

1. **`faixaDePrecoAmazon` v1:** `minimo` = the promotional list when > 0, else the normal price, and `maximo` = the normal price. Is that the range you want until the new price-range model exists?
2. **Reservations:** keep PENDING Amazon orders reserving ERP stock (the current behaviour), or reserve only from UNSHIPPED?
3. **Pickup rescheduling:** is it acceptable that rescheduling a DBA pickup stays in Seller Central (there is no documented BR API for it)?
4. **Listings (D18):** the known problems of the legacy listing flows, and the best way to handle each one. To be discussed when we reach step 9, before any listing step plan is written.
5. **Refunds and returns (P4):** how the ERP should detect and handle them properly, beyond D17's interim inference. To be explored in depth after the cutover.

---

## Appendix: evidence files

All of them live under `.master_plans/amazon/evidence/` and are derived from Amazon's public documentation and models:
- `survey-a-auth-roles-sandbox.md`: LWA, app types, roles, RDT, limits, sandbox, DPP/AUP, official MCPs.
- `survey-b-notifications-aws.md`: Notifications API, the type table, `ORDER_CHANGE`, delivery semantics, EventBridge API destinations and Pipes, the transport comparison.
- `survey-c-orders-v2026.md`: Orders v2026-01-01 vs v0, the field inventory, Easy Ship status, the migration guide, sandbox cases.
- `survey-d-nfe-easyship.md`: every invoice path, invoice status, Easy Ship v2022-03-23, self-ship, events.
- `survey-e-listings-stock.md`: Listings Items, Feeds, reports, families, listing notifications, Catalog, MLI, bundles, pausing.
- `survey-f-price-finance-messaging.md`: price, payments, Finances, Messaging, returns, Product Type Definitions, tax data.
- `gap-easyship-br.md`: every official mention of BR Easy Ship/DBA; External Fulfillment; RDT.
- `gap-seller-auth.md`: seller id, the authorization workflow, revocation, one app vs two.
- `caps-verify-result.md`: the adversarial per-field verification.
- `latam-dba-review.md`: the retired LATAM DBA page, claim by claim.
- `amazon-doc.mjs`: reads the official models and prints an operation, a definition, the sandbox examples or a notification schema. It caches under an ignored `./cache/`.

Operator decisions, the legacy surveys and every legacy-code finding live in the gitignored `.private/amazon/`.

### Critical files for implementation

- `packages/schemas/src/shared/marketplace.ts` (caps row) + `marketplace.test.ts`
- `packages/schemas/src/integracao.ts` (`credenciaisIntegracaoSchema`, `serverOwnedFields`, cascade)
- `packages/schemas/src/produto/collection/amazonLink.ts` (`produtoAmazonLinkSchema`)
- `packages/data/src/admin/notifications/pipeline.ts` (`defineNotificationPipeline`) + `apps/shopee/lib/shopee/notificacoes/orderBackfill.ts` (cursor precedent)
- `packages/data/src/admin/oauthState/` (signed single-use state)
- `packages/schemas/src/nfeEnvioCanal.ts` (`decideNfeUploadTransition`, `extractTpAmb`) + Shopee's `onNfeAprovadaShopee.ts`
- `packages/schemas/src/shared/frete.ts` (`FREIGHT_TIPO_CAPS.amz`, `INTEGRACAO_FRETE.amazon`) + `apps/web/lib/checkout/etiqueta/`
- `packages/schemas/src/intFrete.ts` (`VINCULO_INT_FRETE_CONTA`) + `packages/data/src/admin/frete/intFreteContaSync.ts`
- `packages/data/src/admin/estoque/` (pure stock core) + `integracoesComProduto` triggers
- `packages/config-eslint/rules/removed-plugin-contracts.test.js` (the `amazon-sp-api` guard move)
- `infra/amazon-relay/` (new: the AWS CDK app in TypeScript, D16) + `pnpm-workspace.yaml` (the new workspace glob)
