# Shopee — master plan for the marketplace integration

Date: 2026-09-03 · Branch: `claude/shopee-marketplace-integration-536e69` · Method: `marketplace-integration` skill, Phases 0–2.
Evidence: Shopee Open Platform docs read through their JSON API (`shopee-doc.mjs`, no login), 4 doc surveys (A auth/push · B orders/logistics · C products/stock · D chat/promotions), 1 legacy survey of `.old/packages/canais_de_venda/shopee`, and the announcements feed (552 entries scanned). Citations use `guide N` (developer guide document id), `api v2.x.y` (API reference page), `push N` (push_api_id) and `announcement N`.

---

## 0. Executive summary

- **No official Shopee MCP exists.** The MCP registry has none; the web has only community scrapers and affiliate tools; Shopee's own docs and announcements never mention MCP. **Do not install a third-party Shopee MCP** — every one of them would hold the `partner_key`. The docs SPA exposes a JSON API that needs no login; the helper `shopee-doc.mjs` reads guides, API pages, push docs and announcements as plain text, and should be promoted into the skill as the Phase 3 reference tool.
- **Chat: you remembered correctly, with one Brazilian nuance.** Since 2024-11-18 Shopee accepts no new Chat OpenAPI or Customer Service App applications from individual third parties and third-party partner platforms (`announcement 1026`). Brazil reaffirmed it twice in 2026 (`1363`, `1430`): a seller with the **Registered Business Seller** profile may still request access **through their Account Manager** (not a ticket), case-by-case, not guaranteed. The 12 `v2.sellerchat.*` reference pages are login-gated (`error_auth`) while every other module is public. A 2026-08-29 BR developer FAQ (`announcement 1548`) answers "can Open Platform release the Chat API for my app?" with "Não" and says the request is made by the RM (Account Manager); without an RM "não é possível prosseguir" (`guide 735`). Even with the grant, platform rules forbid chatbot replies, proactive order updates and broadcasts over chat (`guide 34`, penalty-bearing), and an ERP System app cannot subscribe to the webchat push at all (`guide 18`). Step 16 is therefore **conditional on that grant** and is planned last.
- **The caps row can be filled with zero `'desconhecido'`.** Every field below cites a page. Two answers carry a documented contradiction that only a live call settles (re-listing an unlisted item; how kit stock derives from components), flagged as the first task of their steps.
- **Decisions taken on 2026-09-03 (§2.1):** production stays on the legacy **ERP System** app, with a same-type test app for the sandbox; **no chat in this migration**; the seller is **Simples Nacional** (CNPJ); authorization expiry is watched by a weekly sweep that raises an in-app notification. Still open: the static-egress option (Shopee's IP whitelist blocks *all* API calls from undeclared IPs once enabled, and unmasked buyer data needs it — costed in §2.1) ; the push receiver runs **scale-to-zero** (P3, decided after the worked examples in §2.1).
- **The legacy corpus constrains less than feared.** Legacy never wrote `pedshopee`, so there is no order mirror to be compatible with; `prodshopee`/`variashopee`/`brandshopee`/`tabelasMedidasShopee`/`linksVariacoesShopee` do exist and are kept. The legacy receiver, token store and push handling are the anti-patterns the shared seams were built to replace.

---

## 1. Phase 0 — capability survey (the caps row)

Proposed `MARKETPLACE_TIPO_CAPS[INTEGRACAO_TIPO.shopee]` (`packages/schemas/src/shared/marketplace.ts`). `implementado` stays `false` until step 22 ships; the test forbids a `'desconhecido'` only once it flips.

```ts
[INTEGRACAO_TIPO.shopee]: {
  channel: 'shopee',                 // apps/shopee, :3009 (next free port)
  implementado: false,
  // Authorization-code-SHAPED, not RFC 6749: no client_secret (HMAC `sign` with the
  // partner_key instead), no scope (fixed by the immutable App Category), no PKCE.
  // guide 20, guide 16.
  auth: 'oauth2',
  pkce: 'nao',                       // no code_challenge anywhere in guide 20
  notificacoes: 'push',              // + a pull backstop: v2.push.get_lost_push_message (3 days)
  // Authorization header = lowercase hex HMAC-SHA256(partner_key, callback_url + "|" + raw_body).
  // Fail CLOSED. guide 18.
  assinaWebhook: 'sim',
  publicarAnuncio: 'sim',            // api v2.product.add_item / update_item
  importarAnuncio: 'sim',            // get_item_list → get_item_base_info (50) → get_model_list (1/item)
  variacoes: 'sim',                  // ≤2 tiers, ≤50 models; standardise_tier_variation (guide 219, init_tier_variation)
  categoriasEAtributos: 'sim',       // get_category / get_attribute_tree / get_brand_list / get_item_limit
  // READ + ATTACH only: get_size_chart_list/detail + size_chart_info.size_chart_id on add/update_item.
  // Authoring is Seller Centre only — v2.product.update_size_chart no longer exists (survey C §6).
  tabelaDeMedidas: 'sim',
  // Native kit SKU: add_kit_item mints an item_id whose category/attributes/brand sync from a main
  // component; no stock field anywhere in the kit APIs (derived). 1 tier, ≤9 kit variations,
  // 2–10 components each (get_kit_item_limit), composition frozen after create. survey C §7.
  kitVirtual: 'sim',
  // unlist_item {unlist:false} re-lists (guide 221 §6) — but its own error list carries
  // `error_set_normal_unlisted_item`; step 11 verifies live before this row flips implementado.
  pausarAnuncio: 'sim',
  estoque: {
    suporte: 'sim',
    // One item per call (api v2.product.update_stock); the item's models ride in the same call
    // with a per-model success_list/failure_list. Fan-out is per LISTING, attribution per MODEL.
    protocolo: 'por-anuncio',
    loteMax: 50,                     // models per call, not items
    multiDeposito: 'sim',            // location_id from get_warehouse_detail — WHITELIST feature; structure is sticky
  },
  enviarPreco: 'sim',                // update_price, one item ≤50 models, 2 decimals in BR, LOCKED during a promotion
  importarPedido: 'sim',
  // No payment resource and no payment push: payment = pay_time != null on get_order_detail,
  // fees/settlement = get_escrow_detail (floats, one order per call). survey B §3.
  importarPagamento: 'sim',
  // One order → N packages (package_list). Many orders → one parcel exists only as a read-only
  // group_shipment_id with no seller action; split_order is not a BR flow. survey B §10.
  consolidaPacote: 'nao',
  // Same call, but STATUS- and WHITELIST-gated: buyer name/address/CPF only from INVOICE_PENDING
  // onward and only for a CNPJ seller; masked values are '***' STRINGS, not nulls; phone never.
  // guide 382 / 743 / 718. The importer must re-read after the gate opens.
  dadosFiscaisSeparados: 'sim',
  etiqueta: 'fetch',                 // Shopee mints; BR forbids self-design outright (guide 292)
  rastreio: 'push',                  // push 2 / 33 / 44 + pull get_tracking_info
  enviarNfe: 'sim',                  // upload_invoice_doc (XML, file_type 4, 1 MB), BEFORE ship_order, 5-min SERPRO delay
  perguntas: 'nao',                  // no public pre-sale Q&A surface; only private chat + post-purchase reviews
  // 12 v2.sellerchat.* APIs exist (docs login-gated) and webchat_push (code 10) carries the message
  // inline — but access is a per-app grant closed to ISVs since 2024-11-18 (announcement 1026);
  // BR Registered Business Sellers request it via their Account Manager (1363/1430).
  // Decision 2026-09-03: the production app is an ERP System app, which excludes the Chat API and
  // the webchat push BY TYPE (guide 14, guide 18) — unreachable from this app regardless of any
  // grant. Revisit after the cutover with a Seller In-house System app + the RM grant (step 16).
  mensagensPosVenda: 'nao',
  reclamacoes: 'sim',                // v2.returns.* + push 32
  origensConversa: [],               // filled by step 16 only if the chat grant lands
},
```

### 1.1 The facts that change the architecture (Phase 0 questions 1–5)

| # | Question | Answer | Source |
|---|---|---|---|
| 1 | Signs its notifications? | **Yes.** `Authorization: <bare hex>` = HMAC-SHA256(partner_key, `callback_url|raw_body`); compare case-insensitively; which URL form enters the base string is undocumented (settle in sandbox). No event id, no ordering, at-least-once — deterministic doc ids must come from domain keys (`ordersn`+`update_time`, `return_sn`, `message_id`). Ack = **2xx with an EMPTY body within 3 s** (2 s for chat). `200 {"received":true}` counts as a failure. >600 pushes/6 h with <70 % success → warnings; <30 % → **subscription disabled, missed pushes never redelivered**. Retries are **per push type** (order/product pushes 300/1800/10800; webchat 1/2/3; FBS pushes differ — unit and anchor are inferred, not documented), then the lost-push queue (3 days, earliest 100, a watermark confirm whose batch semantics are inferred — confirm in sandbox; partner-level, spans all shops). | `guide 18`, `push *`, `api v2.push.*` |
| 2 | Push or poll? | Push for orders/tracking/labels/returns/violations/promotions/chat; **no push at all for payment or for ordinary stock changes**; a pull backstop is mandatory (`get_lost_push_message` + `get_order_list` by `update_time`, 15-day windows). | `push-list`, survey B §3.1, §6.3 |
| 3 | How does stock go out? | `update_stock`: **one item per call**, up to 50 models, `seller_stock[{location_id?, stock}]`, per-model result lists. **No many-item stock API for a normal shop** (`batch_update_outlet_stock` is Outlet-shop only). Writes below `total_reserved_stock` are refused; an active promotion, holiday mode or FBS can refuse outright. No published rate limit. | `api v2.product.update_stock`, `get_item_promotion`, survey C §3 |
| 4 | Listing = one resource or a family? | **item + models** (≤2 tiers, ≤50 models). `init_tier_variation` **invalidates every model_id** when tier depth changes; omitting a model from `update_tier_variation.model_list` **deletes it** (the #831 shape). Kits are a separate first-class `item_id`. | `guide 219`, survey C §2, §7 |
| 5 | Buyer fiscal identity inline or gated? | Same call, **gated twice**: by order status (`INVOICE_PENDING`+ for CNPJ sellers; never phone) and by the app's IP whitelist. Masked fields are starred strings. | `guide 382`, `guide 718`, survey B §2 |

### 1.2 Contradictions the docs leave open (settled by a live call, not by reading)

- `unlist_item {unlist:false}` re-lists (`guide 221 §6`) vs `error_set_normal_unlisted_item` in its own error list → step 11, sandbox.
- Kit stock: no stock field in the kit APIs, derivation rule unstated → step 19, first task.
- Which authorize-URL format is live for BR (`open.shopee.com.br/auth?…&response_type=code` vs the signed legacy `/api/v2/shop/auth_partner`) → step 1, sandbox.
- Which sandbox host is real (`partner.test-stable.shopeemobile.com` on every API page vs `openplatform.sandbox.test-stable.shopee.sg` in `guide 644`) → step 1.
- Whether the push HMAC base uses the configured callback URL or the received URL → step 3, log both on first live delivery.
- `guide 383` FAQ says `upload_invoice_doc` is "not used in BR"; `guide 382` and the API page say the opposite → trust the API page + `guide 382` (newer).
- Whether `get_order_detail.model_original_price` / `model_discounted_price` are per unit or line totals → step 5, one live order with quantity > 1 (only the escrow fields are documented as subtotals).
- What `order_status` does after `ship_order` on channels 90021/90026 → step 7, live observation (the citation is an update-log line with no surviving text).
- Whether `media_space.upload_image` really needs no `shop_id`/token (its error list contradicts its Public typing) → step 11, sandbox.
- Which host serves a BR shop in production (`partner.shopeemobile.com` vs `openplatform.shopee.com.br`; the docs select by server location and name no BR host) → step 1, sandbox then live.

## 1.3 Verification record (2026-09-03)

Every claim in §1 and §1.1 was handed to an independent skeptic with the docs and instructions to refute it: **21 held, 8 were refuted and corrected in place** (`tokens`, `push-ack`, `app-type`, `prices-line-totals`, `payment`, `labels`, `ship-status-trap`, `price`), and 19 design-relevant caveats were folded into the steps. The full verdict table is `caps-verify-result.md` in the evidence folder. Corrections not visible elsewhere in this document:
- Rate limits are **unpublished, not absent**: expect HTTP 429 plus two distinct classes — `error_rate_limit` (burst, retry with backoff) and `error_limit` (daily, resets 00:00 UTC+8, do not retry before then); a per-shop limit exists alongside the per-app one.
- `push 25`'s `update_field` is `original_price` **or `local_price`** (a derived cross-border figure) — branch on it, never mirror a `local_price` into the ERP price.
- A combined order (`group_shipment_id` non-zero) is **unfulfillable through the API**; treat `0`, `null` and absent as "not combined".
- Buyer **email** is not returned by any BR order API, and phone never — model neither.
- NF-e `access_key` is globally unique across orders, so a retry after a lost 200 must first read back `invoice_data.access_key`; "Correios" is an example, the predicate is `INVOICE_PENDING` membership or error 11; a Shopee-Invoice-Issuer shop cannot use the upload API at all.
- Returns: `ReturnSolution` is a string on write and an int on read; disputes are allowed in `REQUESTED`, `PROCESSING` **and `ACCEPTED`**; BR has the Seller-Arrange reverse-logistics path (`is_seller_arrange`, `is_shipping_proof_mandatory`, `upload_shipping_proof`) and `return_refund_request_type` selects which reverse-logistics enum applies.
- Listings: BR `tax_info` fields are **all-or-nothing**; `UNLIST` is overloaded with "scheduled launch", so do not map it to "paused" unconditionally; the `get_item_limit.size_chart_limit` probe is undocumented and contradicted by `guide 209` — treat its booleans as unverified; `get_item_base_info` returns the size chart as a **URL**, not the image id you wrote.
- Kits: the component bound is **per category** (read `get_kit_item_limit`, do not hardcode 2–10); there is no delete/unlist API for a kit; kit stock is **undocumented**, not "derived".
- Import: page with `next_offset`/`has_next_page` (an undocumented offset cap exists); multi-image uploads fail per index.
- Chat: for an **ERP System** app the honest row value is `'nao'` (app type + module whitelist, twice gated) and obtainability is `'desconhecido'` until the Account Manager answers; a separate **24-hour duplicate-message block** (`announcement 1268`) sits beside `shop_bound_subaccount`.

---

## 2. Prerequisites and decisions (before any code — several are irreversible)

| # | Decision | Recommendation | Why it is load-bearing |
|---|---|---|---|
| P1 | **App category** of the app we will use. ISV "ERP System" = all APIs **except Chat and Ads**, no webchat push, and **no console "Authorize" button** (the app builds the consent URL itself); Registered Business Seller + "Seller In-house System" = **all APIs incl. Chat in its permission set** and the button. ⚠️ That permission set is a **precondition, not the grant**: the Chat API document permission is still approved per app, after the RM-initiated review and against the same acceptance criteria (`FAQ 56`; confirmed by Shopee's own console assistant on 2026-09-03). **Cannot be edited on the app** (`guide 740`); the one documented move is one-way and destructive — converting the developer account to ISV auto-converts Seller In-house → ERP System and **removes Chat** (`guide 14`). Max 10 apps. | If the legacy production app (its partner id lives in the legacy source and is deliberately not reproduced here) is "ERP System", create a **new** Seller In-house System app under an RBS developer profile before anything else. Reset the legacy app's test key in the Console before any reuse. | `guide 14`, `guide 740`, `guide 739`, `guide 18 §app-type gating` |
| P2 | **Static egress IP.** Unmasked buyer data (needed for NF-e) requires the IP Address Whitelist; once enabled **every API call must come from a declared IP**. App Hosting and Cloud Functions egress from rotating pools. | `runConfig.vpcAccess: {egress: ALL_TRAFFIC, connector}` on `apps/shopee/apphosting.yaml` + the same connector on the `shopee` functions codebase, Cloud Router + Cloud NAT with reserved static IPs. Decide before Go Live. BR needs **no** pentest report. | `guide 718`, `742`, `741`; Firebase App Hosting VPC docs |
| P3 | **Push receiver posture.** 3-second empty-body ack; a disabled subscription is not recoverable from the lost-push queue. | Superseded by §2.1: **scale-to-zero** (`minInstances: 0`), with the lost-push sweep and the push-health monitor as backstops; one warm instance only if the monitor ever reports `Warning`. | `guide 18 §5.7`, survey A §6 |
| P4 | **Chat access.** New applications closed to individual third parties and ISVs since 2024-11-18; in Brazil only a Registered Business Seller may request, **through the Account Manager (RM), never a ticket**, case by case, not guaranteed; Open Platform support can neither grant it nor see the outcome ("Não", `announcement 1548`); **no RM = no path** (`guide 735 §2`). Retention criteria are reviewed (NFR < 3 %, LSR < 3 %, pre-order listings < 20 %, preparation time < 2 days; `FAQ 56`). Do not create a "Customer Service" app and never upgrade the account to ISV (it converts the app to ERP System and removes chat). | Confirm the profile under *Account Information* in the console; ask Atendimento ao Vendedor who the RM is if unknown; open the request now; plan step 16 as conditional; ship steps 1–15 without it. | `announcement 1026`, `1363`, `1430`, `1548`, `guide 14`, `735` |
| P5 | **Sandbox.** Test partner + a **local BR** test shop, OTP `123456`; sandbox pushes are canned ("Push Test Data"), orders are driven manually from Console. | Create it in the Console (needs your login — Claude for Chrome can drive it with you signed in). | `guide 644`, `guide 744` |
| P6 | **Seller tax status.** CNPJ sellers get buyer name/address/CPF from `INVOICE_PENDING`; CPF sellers never get name/CPF. | Confirm the shop is CNPJ (assumed, since the ERP issues NF-e). | `guide 382` |
| P7 | **Go Live** needs a product brief with demo credentials, redirect domains, the IP whitelist and an IT-assets declaration; 24 h review. | Prepare the demo credentials on staging. | `guide 741`, `guide 14` |
| P8 | **Authorization expiry** is 7–365 days at the seller's choice; `push 12` warns 7 days ahead. | Ask the seller to pick 365 on consent; surface expiry on the conta screen. | `guide 20`, `push 12` |

---

### 2.1 Decisions taken on 2026-09-03 (they supersede the recommendations above)

| # | Decision | Consequence in the plan |
|---|---|---|
| P1 | **ERP System, reusing the legacy production app.** A **new ERP System test app** is created so tests and live tests never touch the legacy app's callback, credentials or whitelist. | `mensagensPosVenda: 'nao'` and step 16 deferred (the type excludes Chat); `oauth/start` builds the consent URL (no console button); each app's redirect-URL domain registered in the console; the real shop's authorization to the legacy app is per app + shop and survives the cutover. A Test-status app holds test credentials only — live tests from staging need the test app's own Go Live (§7 q1). |
| P2 | **Static egress as cheaply as possible, ideally free tier.** The legacy app paid for a Serverless VPC connector + Cloud NAT. | Costed in §2.2: **option D** — a free-tier e2-micro forward proxy reached by internal IP through Direct VPC egress (`PRIVATE_RANGES_ONLY`), the VM's own static IPv4 doing the outbound hop, ≈ $3.65/month vs $18–97 for the legacy connector + NAT. Decision pending (§7 q2). Only the Shopee HTTP client goes through the proxy. |
| P3 | **Scale-to-zero** (decided 2026-09-03 after the worked examples below). | `minInstances: 0` on `apps/shopee`; the lost-push sweep and the push-health monitor (step 4) are the backstops; flip to `minInstances: 1` only if the monitor ever reports `Warning`. |
| P4 | **No chat in this migration.** The legacy app never had it; revisit after the cutover. | `mensagensPosVenda: 'nao'`, `origensConversa: []`, step 16 deferred; `webchat_push` is parked, not acked, in step 3. |
| P5 | Lucas creates the sandbox test partner + BR test shop. | Step 1's first verification runs against it. |
| P6 | **Simples Nacional** (a CNPJ seller). | Buyer name, address and CPF unmask from `INVOICE_PENDING`; NF-e is mandatory except on carriers without invoice support; `tax_info` on `add_item` uses the CSOSN side (CRT 1) taken from the produto's operação fiscal (step 11). |
| P7 | **No Go Live for production** — the legacy app is already live, so no product brief or demo. | Only the test app may need a Go Live, and only if live tests from staging are wanted (§7 q1). |
| P8 | **Authorization-expiry warning: a scheduled sweep that raises an in-app notification**, built together with the notification system in a parallel session. | **Weekly, not monthly** — a monthly run can miss a 30-day window. Source: `v2.public.get_shops_by_partner.expire_time`. Lives in step 2; `push 12` feeds the same path. |

**P3, rephrased with examples — what happens when a Shopee push reaches a sleeping server.**
Shopee delivers each push as a POST and waits **3 seconds** for a `2xx` with an empty body. `apps/shopee` runs on App Hosting, which is Cloud Run: at zero traffic it scales to **zero instances**, and the next request pays a **cold start** — a Next.js server booting takes roughly 2–6 s.

- *Example 1, the common case.* At 03:10 a buyer pays. Shopee POSTs `order_status_push`; the instance is cold; the reply arrives after 4 s. Shopee counts a **failure** and retries at +5 min, +30 min and +3 h. The +5 min retry usually finds the instance still warm (Cloud Run keeps an idle instance for several minutes), so the order lands about **five minutes late**. Nothing is lost.
- *Example 2, a campaign.* Forty pushes an hour keep the instance warm; nothing fails.
- *Example 3, the dangerous case.* More than **600 pushes in 6 hours** and fewer than **30 % succeed**: Shopee **disables** the subscription and never redelivers what it missed. Recovery is `get_lost_push_message` (3-day window) plus a manual re-enable. At a small seller's volume (tens of pushes a day) this case cannot occur.

So the real cost of scale-to-zero is a five-minute delay on the first push after an idle period, with the lost-push sweep (step 4) as the backstop for the rare push that fails all three retries. The alternative is `minInstances: 1` in `apphosting.yaml`, which keeps one container always warm and is billed by the hour whether or not it serves anything. **Decision (2026-09-03): zero.** Start with the sweep and the push-health monitor, and flip to one warm instance only if the monitor ever reports `Warning`.

### 2.2 P2 — static egress for the Shopee IP whitelist: options, costs, recommendation

Research of 2026-09-03 (134 agents: 3 readers, 122 price/claim checks held, 8 refuted); full brief with every URL in `gcp-egress-research.md`. USD list prices, 730 h/month, us-central1 or us-east1 (the only regions that are both Cloud Run Tier 1 and free-tier eligible), Shopee traffic under 1 GiB/month. Only the Shopee HTTP client needs the fixed IP.

| # | Option | Fixed $/month | Realistic total $/month | Verdict |
|---|---|---|---|---|
| A | Direct VPC egress + Cloud NAT + static IP | 3.65 (NAT IP) + 1.02 → 32.12 (gateway) | **4.67 – 35.77** | Needs `egress: ALL_TRAFFIC` + `networkInterfaces` on `apphosting.yaml`, a combination Firebase documents nowhere; and Google warns of **30 s+ cold starts** with NAT over Direct VPC egress — fatal for the 3-second push ack unless one instance is always warm. Pulls *all* egress through NAT. |
| B | Serverless VPC connector + Cloud NAT (**the legacy setup**) | 12.23 (2 × e2-micro) + 2.04 + 3.65 | **17.92 floor, ≈ 97 worst case** | The connector never scales back down ("decreasing the number of instances is not supported"): once it hits 10 instances it stays at 61.15/month until recreated. |
| C | Free-tier e2-micro forward proxy on the **public internet**, proxy auth | 3.65 (external IP) | **≈ 3.65** | Rejected: the proxy port must stay open to the internet behind a password, because Cloud Run's egress pool cannot be pinned in a firewall. |
| **D** | Free-tier e2-micro forward proxy reached by **internal IP** through Direct VPC egress, no NAT; the VM's own reserved static IPv4 makes the outbound hop | 3.65 (external IP) | **≈ 3.65** | **Recommended.** |
| E | Register Google's published ranges (`cloud.json`) | 0 | does not work | 19 million addresses, one `service` value for all of Google Cloud, regenerated continuously; Cloud Run's default egress is explicitly a dynamic pool. |

**Why D.** It uses the one App Hosting VPC shape Firebase documents (`runConfig.vpcAccess: { egress: PRIVATE_RANGES_ONLY, networkInterfaces: [{ network, subnetwork }] }`), so it cannot be rejected by the rollout pipeline; `PRIVATE_RANGES_ONLY` sends *only* internal addresses into the VPC, which is exactly the requirement — Firestore, Google APIs and everything else keep default egress; there is no NAT, so the NAT cold-start warning does not apply; and the IPv4 address is the whole bill. The e2-micro is free (one per billing account in us-west1/us-central1/us-east1, pd-standard ≤ 30 GB); the in-use static external IPv4 is billed at $0.005/h, and keeps billing while the VM is stopped.

**Design.** Custom-mode VPC (or delete the four `default-allow-*` rules); one e2-micro in the **same zone** as the backend (internal transfer free only same-zone); a forward proxy (tinyproxy/squid or a small Node CONNECT proxy) listening on the internal IP only, allowed by one ingress rule whose source is the Direct-VPC-egress subnet or a service account; admin by IAP TCP forwarding (never a public SSH rule, and never IAP as the data path). Node: undici `ProxyAgent` passed **per request** as `dispatcher` on the Shopee client only (`token: 'Basic …'`), never the process-wide `NODE_USE_ENV_PROXY`. Functions gen2: `--vpc-egress=private-ranges-only` on the same network/subnet. Region coupling: backend and subnet must share a region — keep `apps/shopee` and its functions in us-central1 or us-east1 (region read from the environment, per `no-hardcoded-gcp-region`).

**Operational cost, not financial.** One VM on the critical path: patching, the proxy daemon, a health check with retries in the Shopee client (live migration pauses the box for up to ~5 s), and above all the static IP must survive VM recreation — verify stateful IP retention **before** registering the IP with Shopee. Switch to A if App Hosting accepts `ALL_TRAFFIC` + `networkInterfaces` on a staging backend and you would rather pay ~5–36/month than run a VM; switch to B only if A's YAML is rejected and you still want a fully managed path.

**Unverified facts that gate the decision** (all in §4 of the brief): whether a Cloud Run instance counts for the NAT per-instance meter (the reason A is a range); whether App Hosting accepts the A combination; whether a recreated VM keeps its static IP; **whether the free-tier e2-micro is already consumed on this billing account** (it is pooled per billing account across all projects); **how many IPs Shopee's whitelist accepts** (with a single permitted IP every option is a single-IP design and D's SPOF argument evaporates).

**Infrastructure is a window step, not a PR** (§5): VPC, subnet, firewall rules, reserved IP and VM must exist before `apphosting.yaml` gains `vpcAccess`, and VPC access is runtime-only — a build step can never reach Shopee from the whitelisted IP.

## 3. Legacy (`.old`) — what constrains the port, what to keep, what NOT to port

**Corpus that exists (constrains the wire shape):** `integracao/{id}` flat fields (`shop_id`, `main_account_id`, `tabelasAtacado`, `depositoOuterRef`, `modalidadeFreteImportacao`, `filialIntegracaoPedidoOuterRef`, `tabelaNormal/PromocionalOuterRef`, `operacao(Devolucao)OuterRef`); `integracao/{id}/brandshopee`; `produtos/{id}/prodshopee` and `produtos/{childId}/variashopee` (typed in `shopeeLink.ts`); `grupoDeVariacoes.linksVariacoesShopee[]`; `tabMedi.tabelasMedidasShopee{contaId: [{categoryId, size_chart_id, name}]}`; `arquivos.externalIds[{externalId: image_id, integracaoPath}]`.

**Corpus that does NOT exist:** `pedidos/{id}/pedshopee` — the model was defined and rules-secured but **never written or read**. ⇒ **No order mirror.** The "which pedido owns order X" question is answered by `pedidos where integracaoPedidoOuterRef == conta AND numero == order_sn` plus one composite index.

**Replaced by shared seams (do not port):** `integracao/{id}/actokshopee` → `integracao/{id}/credenciais`; `integracao/{id}/pushshopee` → `notificacoesShopee` via `defineNotificationPipeline`; the multi-tenant relay map → nothing; the `produtos.marketplace[]`/`marketplaceIds` denorms (#961: drift by construction) → collectionGroup lookups on `prodshopee`/`variashopee`.

**Business rules to re-derive (not transcribe):** the order-status ladder (legacy mapped `TO_RETURN` to "awaiting payment" — wrong; needs the devolução overlay like #1322); payment-form mapping (Pix / Credit Card [Installment] / SParcelado / Boleto / ShopeePay) with parcelas from `instalment_plan`; `tarifas = |buyer_total_amount − escrow_amount(_after_adjustment)|`; cliente only when unmasked; `full_address` split on `', '` (fragile; the new schema has `district`/`town`/`zipcode` fields the legacy ignored); item→produto via `model_id` then `item_id` then SKUs; dispatch deadline (`pay_time` before 14:00 BRT Mon–Fri → same day); international → `bloquearEmissaoNFe`; the **extreme-coupon NF-e floor** (`max(shipping, 50 % items, R$5)` with a `<order_sn>-desconto` second pagamento) — a fiscal rule, **decision D7**; bulk price refuses to lower unless asked and verifies the echo (same ladder as ML `precoDraftSend`); size charts referenced by `{categoryId, size_chart_id}` with the tabela's first photo as image fallback; NF-e upload only when `aprovada` + `tpAmb 1`.

**Defects to fix, never port:** catalogued in the legacy survey and kept in the operator's private notes (the legacy app is still live in production until the cutover, so its defect list is not published); none of them is ported, and each re-derived rule above is written from the provider's documentation rather than from the legacy code.

---

## 4. Phase 2 — the master plan

Ordered by dependency. Each step: gate (caps fields) · trigger · wire operations · Firestore · shared seam · verification · what it deliberately does not do. **Dropped steps are listed in §4.24.** Every step gets a Phase 3 step-plan (re-read the pages, decide the nuances) before building.

### Step 0 — Prerequisites (P1–P8 above) — human, not code
Outcome (decisions of 2026-09-03 in §2.1): the legacy ERP System app kept for production; a **new ERP System test app** created in the console with its own test partner credentials, redirect-URL domain (staging App Hosting) and push callback (staging receiver); a BR sandbox shop authorized to the test app; the static-egress option chosen; no chat request for now.

### Step 1 — `apps/shopee` scaffold + `packages/integrations/shopee` + OAuth connect
- Gate: `auth: 'oauth2'`, `pkce: 'nao'`. Trigger: HTTP.
- Package (fetch-only): `sign.ts` (three base strings: public `partner_id+path+timestamp`, shop `+access_token+shop_id`, merchant `+merchant_id`; lowercase hex; 5-min timestamp window; **all common params in the query string for GET and POST** — `guide 16`), `hosts.ts` (prod `partner.shopeemobile.com`; sandbox to be verified), `api.ts` (typed operations, every response through `lerRespostaJson` + Zod; the `{error, message, warning, request_id, response}` envelope with `warning` as a partial-failure channel and the auth endpoints **without** the `response` wrapper), `oauth.ts` (authorize URL Format A for BR: `https://open.shopee.com.br/auth?partner_id&auth_type=seller&redirect_uri&response_type=code&state`; `POST /api/v2/auth/token/get` with `code` + `shop_id|main_account_id`), wire schemas (`types.ts`).
- App: `app/api/marketplace/shopee/oauth/start` (`PERM.integracao.write`; mints HMAC state via `@delfrance/data/admin/oauth-state`, **persists the attempt before returning the URL**), `app/api/oauth/shopee/callback` (public; verify → **single-use redeem in a transaction** → exchange → persist to `integracao/{id}/credenciais` → denormalize `shop_id`/`main_account_id` on the `integracao` doc), `app/api/marketplace/shopee/conta` (status via `get_shop_info`, plus **authorization expiry** date), `app/api/health`. `proxy.ts`/`verifyCaller` copied from ML (#1431 tracks the 4 copies).
- Firestore: `integracao` (existing flat fields), `integracao/{id}/credenciais` (admin-only). New composite index: none yet.
- Env: `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` (Secret Manager), `SHOPEE_STATE_SECRET`, `SHOPEE_PUBLIC_URL`, `SHOPEE_SANDBOX=1` (test host + test partner), `WEB_APP_URL`, `ALLOWED_ADMIN_ORIGINS`. Add to root `.env.example` and `apphosting.yaml`.
- **Two apps, one code path (decision 2026-09-03):** staging runs on the new **ERP System test app** (test partner id + key, sandbox host, sandbox shop); production runs on the **legacy ERP System app** (its live partner id + key, `partner.shopeemobile.com`, the real shop's existing authorization, which is per app + shop and survives the cutover). `SHOPEE_SANDBOX=1` selects the host; the credentials differ per environment, never per code. An ERP System app has **no console "Authorize" button**, so `oauth/start` builds the consent URL itself and the redirect-URL domain must be registered on each app in the console (staging domain on the test app; the production App Hosting domain on the legacy app — a migration-window item). ⚠️ A Test-status app only holds test credentials: to call the **real** shop from staging, the test app needs its own Go Live (question 1 in §7).
- Verification: sandbox consent round-trip; a replayed `state` is refused with `bad_state`; a wrong-HMAC `sign` gets `error_sign`.
- Does not: handle main-account (multi-shop) fan-out beyond storing `main_account_id` — a BR local seller authorizes one shop; the documented N-use first refresh (`guide 20`) is recorded as out of scope with the reason.

### Step 2 — Account context + token refresh + read cache
- Gate: always. Trigger: library.
- `core/shopee.ts` (`loadShopeeContext`: `integracao` doc behind `createCachedDocReader` 15-min TTL — **never the token**), `core/tokenStore.ts`: access 4 h (5-min grace after rotation), refresh **single-use rotating**, nominally 30 days but **capped by the seller-chosen authorization validity (as low as 7 days)** — "RefreshAccessToken must be called within the authorization validity period" (`guide 20`); pairs exist **per id class** (`shop_id` / `merchant_id` / `user_id` / `supplier_id`, refreshed separately) — for a BR local seller that is one `shop_id` pair, but the store must be keyed on the id, not on the conta. No documented concurrency ⇒ **serialize per id inside a transaction with a lease that EXPIRES** (a lock that cannot expire is the classic bug here), **persist the new pair before using it**, old doc deleted in the same transaction; assume a lost double-refresh burns the pair (no refresh grace is documented). ⚠️ **The spent-token error is undocumented** — the API's own example returns `error_auth: "Invalid refresh_token."` while its error list carries `refresh_token_expired`; treat the union as terminal ⇒ mark the conta as needing re-authorization and `defer` downstream work (the #808 lane). Never retry `shop_banned` / `shop_access_expired` / `shop_no_linked` as token problems. Class-B transaction in `firestore-transaction-inventory.test.js`.
- **Authorization-expiry sweep (P8, decided 2026-09-03):** `sweepShopeeAuthorizationExpiry`, **weekly rather than monthly** — a 30-day warning window with a monthly cadence can miss an expiry that falls between two runs (run on the 1st, expiry on the 29th of the next month: the first run sees 58 days, the second sees it already expired). `v2.public.get_shops_by_partner` → `expire_time` per authorized shop; below 30 days, write an operator notification through the in-app notification system (built in a parallel session; until it exists, log + e-mail alert), and `push 12` (Shopee's own 7-day warning, handled in step 3) feeds the same path. The conta screen shows the date and the re-authorize button (365 days).
- Firestore: `integracao/{id}/credenciais`. Seam: `@delfrance/data/admin/cache`.
- Verification: two concurrent refreshes produce one provider call; a failed refresh leaves the lease free after expiry; the sweep warns at 29 days and stays silent at 31.
- Does not: cache anything written back; cache a `tx.get()`.

### Step 3 — Inbound: push receiver + Cloud Tasks queue + code dispatch
- Gate: `notificacoes: 'push'`, `assinaWebhook: 'sim'`. Trigger: HTTP → Cloud Task.
- Receiver `app/api/webhooks/shopee/route.ts`: read the raw body **once**; verify `Authorization` = hex HMAC-SHA256(`SHOPEE_PARTNER_KEY`, `SHOPEE_PUSH_CALLBACK_URL + "|" + rawBody`) with `timingSafeEqual`; **secret unset ⇒ 503 (fail closed)**; bad signature ⇒ 401 before any enqueue. Log the received URL vs the configured one on the first live deliveries (the docs do not say which string Shopee signs). Parse with `parseNotificationBody` (normalize `code`, `shop_id`, `timestamp` with `asInt`/`asMillis`, spread the rest, bound the size). Enqueue. **Respond `204` with an empty body** — the only ack Shopee counts. Enqueue failure → `persistNotificationFailure` → still 204.
- Schema `packages/schemas/src/notificacaoShopee.ts` (`code`, `shop_id`, `timestamp` seconds→ms, `data` passthrough, `...notificationResilienceFields()`, **not** in `ALL_DOMAINS`); handle `notificacaoShopeeCollection`; index `(status, processedAt)`; `docIdOf` **derived** (no event id on the wire): `<code>:<shop_id>:<key>:<update_time>` where key = `ordersn` / `item_id` / `return_sn` / `package_number` / `conversation_id` per code, routed through the doc-id guard.
- Dispatch table on **`code` (push_code), not `push_api_id`**: 3 order status → step 5 · 4 tracking no, 30 package fulfillment, 47 package info → step 7 · 15 shipping-doc status → step 15 · 29 return updates → step 17 · 16 violation, 27 scheduled-publish failed → step 11 · 22 price echo → `ack` · 7/8/9 promotion/reserved stock → `ack` (informational; step 12 reads `get_item_promotion` live) · 1/2/12 shop authorization/cancel/expiry → step 1 conta status · 5 shopee_updates, 11 video, 13 brand → `ack` · 10 webchat → step 16 (or `park` until built) · unknown → `park` (the only signal a new code appeared). Every handler is idempotent by re-fetching the resource ("push says something changed", `guide 746`).
- Scheduler `lib/shopee/shopeeTasks.ts` (`SHOPEE_TASKS_REGION`, `SHOPEE_TASKS_DISABLED`), functions `processShopeeNotification` (`onTaskDispatched`, name === queue constant, `tasksInvoker.ts` copied verbatim, `TASKS_INVOKER_SA` define) and `reprocessShopeeNotifications` (`onSchedule` every 30 min, hot + deferred lanes).
- Verification: HMAC vectors from `guide 18`'s Python sample; sandbox "Push Test Data" for every code; `*.tasks.test.ts` through the tasks emulator (receiver → enqueue → real `onTaskDispatched` → Firestore).
- Does not: write Firestore on the happy path; answer JSON.

### Step 4 — Delivery backstops: lost-push sweep, order backfill, push-health monitor
- Gate: `notificacoes`. Trigger: `onSchedule`.
- `sweepShopeeLostPushes` every 2 h: `get_lost_push_message` (earliest 100 of a 3-day window, `data` is a **JSON string of the original envelope**) → re-parse each → enqueue onto the same queue as a webhook → **only then** `confirm_consumed_lost_push_message(last_message_id)` (a watermark that acks the whole batch — never confirm before every entry is durably enqueued). Partner-level pushes (codes 1/2/12) arrive with no `shop_id`.
- `backfillShopeeOrders` every 15 min per conta: `get_order_list` with `time_range_field=update_time`, 15-day max window, cursor paging, durable cursor + overlap, synthesizing a code-3 notification per `order_sn` so the import path stays the single writer. Also the only way to reach `PENDING`/`RETRY_SHIP`/`TO_CONFIRM_RECEIVE`/`TO_RETURN` orders, which the status filter cannot list.
- `monitorShopeePushConfig` daily: `get_app_push_config.live_push_status` (`Normal`/`Warning`/`Suspended`) → alert; **a Suspended subscription loses everything not yet in the lost queue**.
- Firestore: a per-conta cursor doc. Verification: a lost message with a failing handler is retried by the pipeline, not lost by the watermark.
- Does not: replay chat pushes (2-s timeout, guarantee 1, separate retry ladder) — recorded, since chat is conditional.

### Step 5 — Order → pedido import
- Gate: `importarPedido: 'sim'`, `consolidaPacote: 'nao'`, `dadosFiscaisSeparados: 'sim'`. Trigger: Cloud Task (code 3, synthetic backfill).
- Wire: `get_order_detail` (≤50 `order_sn`, **`response_optional_fields` must name** `item_list, recipient_address, buyer_cpf_id, buyer_username, buyer_user_id, pay_time, payment_method, payment_info, total_amount, package_list, invoice_data, actual_shipping_fee, estimated_shipping_fee, shipping_carrier, order_chargeable_weight_gram, cancel_by, cancel_reason, buyer_cancel_reason, edt, pickup_done_time, fulfillment_flag, return_request_due_date`; `request_order_status_pending=true`). Timestamps are **seconds** → the pedido stamps are µs (rule 7: units).
- Pedido discovery: `pedidos where integracaoPedidoOuterRef == conta and numero == order_sn` (new composite index), create with a deterministic id `sha256(contaId|shopee|order_sn)`; `pedido.itens` from `item_list` — ⚠️ **whether `model_original_price`/`model_discounted_price` are per unit or line totals is UNDOCUMENTED** (the "subtotal if quantity exceeds 1" sentence exists only on `get_escrow_detail.original_price`/`discounted_price`); settle it with one live order of quantity > 1 before writing the mapper, and prefer the escrow per-item figures, which ARE documented as subtotals; `model_discounted_price == 0` for bundle-deal lines ⇒ take it from `get_escrow_detail.items[]`; `get_order_list` returns bare `order_sn` unless `response_optional_fields=order_status` is passed; produto resolution via collectionGroup `variashopee.model_id` then `prodshopee.item_id` then SKUs (new collectionGroup indexes on `variashopee.model_id`, `prodshopee.item_id`); an unmatched line keeps `produtoUid: null` and is surfaced, never dropped. Completeness guard: `active_qty`/`cancelled_qty`/`returned_qty` per line must reconcile with `model_quantity_purchased`; a Shopee kit line (`is_kit`, `kit_items` in escrow) maps to the ERP kit produto linked on the kit `item_id`.
- Estado ladder (ENUMERATED, both directions): `UNPAID`→aguardando pagamento · `PENDING`→aguardando (with `pending_terms`) · `READY_TO_SHIP|PROCESSED|RETRY_SHIP|SHIPPED|TO_CONFIRM_RECEIVE`→`pago` (never beyond, as ML) · `IN_CANCEL`→processandoCancelamento · `CANCELLED`→cancelado + **release reservation** · `TO_RETURN`→devolução overlay (`aguardandoDevolucao`, the #1322 shape) · `COMPLETED`→finalizado, but **revisable**: `completed_scenario: RRAOC` reopens the money side. `INVOICE_PENDING` never appears in detail — never store it. Anything else → `error` (never "not on the ladder").
- Cliente and endereço: **capture inside the unmask window; fill-once per field; never write a masked value.** One shared predicate per field in `packages/schemas` (usable = non-empty and no `*` anywhere; `null`/`""`/`"-"` count as absent; CPF/CNPJ exactly 11 or 14 digits; phone never stored; `buyer_username` never a legal name); `findOrCreateCliente` only when name **and** CPF pass; fill-once **per field**; a masked or absent value is written nowhere and never becomes a key, an id or an embedding; an already linked cliente is never unlinked by a later masked import. On a masked first import (`UNPAID` masks everything) the pedido gets a capture-state stamp (pending, status, instant, attempts — no PII), `bloquearEmissaoNFe` stays on, and a "capture refused per field per status" counter feeds an alert. The window is `READY_TO_SHIP`/`PROCESSED` and `RETURN/REFUND`; the NF-e upload does not close it, the `SHIPPED` transition does, and outside it the data is unobtainable by API (human work, no infinite retry). Address from `full_address` + `district`/`town`/`city`/`state`/`zipcode` (the coarse fields usually arrive in clear even when the rest is masked; do not re-split on commas); `region != 'BR'` → estrangeiro + `bloquearEmissaoNFe`.
- Watermark: `data.update_time` (seconds, **1-s resolution**) — accept when strictly newer **or equal-and-different**; advance on the write that wins. Class-B transaction (outside decision + guard) → inventory.
- Freight: `freteInicial` with `externalOptionIntegracao: 'shopee'`, `valorCobrado = actual_shipping_fee ?? estimated_shipping_fee`, one volume per package with `order_chargeable_weight_gram` (no invented 10×10×10), `prazoDespacho` from `ship_by_date` (only if ≥ 2020-01-01; `push 44` moves it), `dataPrevisaoEntrega` from `edt`.
- Does not: consolidate orders (none exists for BR); ship anything (the **one-hour unilateral buyer-cancel window** after payment is step 15's guard); store `INVOICE_PENDING`.

### Step 6 — Payment → pagamento + settlement
- Gate: `importarPagamento: 'sim'`. Trigger: same task as step 5 (no payment event exists).
- `pay_time != null` is the payment signal — ⚠️ it is an **optional field** (must be named in `response_optional_fields`; its absence is not "unpaid"), and there is no `PAID` member in the status enum, so "left `UNPAID`" is the other half of the signal. **A BR-specific per-order payment resource exists**: `get_order_detail.payment_info` (a LIST, per NT 2025.001: `payment_method`, `payment_processor_register` = processor CNPJ, `card_brand`, `transaction_id`, `payment_amount`) — one `pedidos/{id}/pagamento/<order_sn>-<n>` per entry at a deterministic id; forma from `payment_method` (Pix, Cartão [parcelas from `instalment_plan`], SParcelado, Boleto, ShopeePay, outros). Fees: `get_escrow_detail_batch` (≤50 `order_sn`, 1–20 recommended; **floats**, BR-only `net_commission_fee`, `pix_discount`, `kit_items` with `proportional_price`) → `tarifas`/comissão; never reimplement the `escrow_amount` formula (it differs between the single and batch pages) — read the field. `escrow_amount` **changes until completion** — the "money is final" signal is `get_escrow_list` keyed on `escrow_release_time` (page_no paging, unlike orders), a weekly reconciliation sweep stamps the final values. Reads through `parseWireDecimal`.
- Does not: use the cross-border payout family (`get_payout_info`, which superseded `get_payout_detail`, and `get_billing_transaction_info`); treat a terminal payment status as a stock-release arm (Shopee has none — release lives on order status, step 5).

### Step 7 — Shipment → `freteInicial` + conference
- Gate: `rastreio: 'push'`. Trigger: Cloud Task (codes 4/30/47) + pull `get_tracking_info`.
- `push 2` (`tracking_no`, `package_number`; **no `update_time`**) → `codRastreio`; `push 33` (`fulfillment_status`, `update_time`) → `estadoFrete` via the 11-value `PackageFulfillmentStatus` (note `LOGISTICS_NOT_START` vs the push sample's `LOGISTICS_NOT_STARTED` — tolerate both); `push 44` → `ship_by_date`/`logistics_channel_id` changes; `get_tracking_info` returns **two fields both named `logistics_status` with two different enums** — the per-event one is the 36-value `TrackingLogisticsStatus`; never share one Zod enum across them. `is_shipment_arranged` is **not a shipped signal**: it is a duplicate-call guard valid only while the package is `LOGISTICS_READY` (`true` = arranged, tracking number not yet minted). Key channel logic on `logistics_channel_id`, never on the carrier string (Shopee renames carriers). State-preserving merge under a freshness policy (`POLITICA_FRESCOR_*` as data), with the null-tolerance direction written down (stored wins, as ML shipments). `historicoFtIni` rows appended (server-owned, per lint).
- Does not: downgrade a `checkFinalizado` frete; infer "shipped" from `order_status` alone — ⚠️ what `order_status` does after `ship_order` on the seller-fulfilled BR channels 90021/90026 is **UNDOCUMENTED** (the only citation is a `ship_order` update-log line whose promised description is absent from the page; the generic docs say `PROCESSED`) — observe it live and record it as a dated observation with `shop_id` and channel, not as documented behaviour.

### Step 8 — Stuck-reservation release sweep
- Gate: `importarPedido`. Trigger: `onSchedule` weekly. Re-driver only: `get_order_list` by `update_time` for pedidos still reserving stock past `MAX_IDADE_D`, enqueue synthetic code-3 events; the step-5 arms decide. Doubly flag-gated (`SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED`, `DRY_RUN`), never acts on an unverifiable read. Same shape as ML `pedidoTravadoSweep`.

### Step 9 — Product import + the resumable mass-import job
- Gate: `importarAnuncio: 'sim'`. Trigger: HTTP (`importar`, `importar-todos`) + Cloud Task chain.
- Wire: `get_item_list` (offset, `page_size` 100, **`item_status` required** as repeated query keys, `update_time_from/to` for deltas, `tag.kit`) → `get_item_base_info` (50 ids, `need_tax_info=true`) → `get_model_list` per `has_model` item (no batch; the throughput ceiling is unmeasured) → `get_kit_item_info` for kit items. Images by `image_url` into `Arquivo` via `@delfrance/storage/admin` (cache `image_id` on the arquivo per integração, replacing the legacy `externalIds`). Category ancestor chain from `get_category`. Tier options → `grupoDeVariacoes.linksVariacoesShopee` (`variation_id`/`variation_option_id`, 0 = custom).
- Firestore: `produtos` (deterministic hashed id for new ones, never the SKU), `prodshopee`/`variashopee` link docs (**the typed `shopeeLink.ts` shapes, byte-compatible with the corpus**), `categorias`, `arquivos`, `produtos.integracoesComProduto` maintained by the existing triggers. The job doc pattern is ML `mass-import/` (single checkpoint, keyset cursor, per-item checkpoint, class-B cancel-vs-finalize).
- Does not: create a produto from a `SELLER_DELETE`/`SHOPEE_DELETE` item (readable for 90 days only); import a kit as a simple produto.

### Step 10 — Categories, attributes, brands, limits, variations taxonomy (cached)
- Gate: `categoriasEAtributos: 'sim'`. Trigger: HTTP, read-cached (`createReadCache`, TTL per endpoint).
- `get_category` (leaf-only listing), `get_attribute_tree` (mandatory flags, `input_validation_type`, units; **stale enums in `guide 217` — use the API page**), `get_brand_list` (paged, "NoBrand" id 0; refresh `brandshopee`), `register_brand` + `push 13`, `get_item_limit` per category (`size_chart_limit`, `dimension_mandatory`, price/stock bands, DTS), `get_kit_item_limit`, `get_variations` (standardised 3-level tree), `category_recommend` and `get_weight_recommendation` **offered, never auto-applied** (#799).
- Firestore: `integracao/{id}/brandshopee`. Does not: cache anything per request without a TTL.

### Step 11 — Publish / listing lifecycle (+ pause / re-list, violations)
- Gate: `publicarAnuncio`, `variacoes`, `pausarAnuncio`. Trigger: HTTP (`publicar`, `link-anuncio`, `anuncio-status`, `reverificar-anuncio`) + Cloud Task (codes 16/27).
- Create: `media_space.upload_image` (multipart, ≤10 MB, JPG/PNG, **Public-type API: no `shop_id`/token**, per-file errors) → `add_item` (**`condition` required in BR since 2026-09-01**; `category_id` leaf; `logistic_info` from `get_channel_list`; `seller_stock` from `quantidadeParaPublicar`; `tax_info` **derived from the produto's operação fiscal**, never hardcoded — the seller is **Simples Nacional** (CRT 1), so the ICMS side is a `csosn` and the PIS/COFINS CST is whatever the operação carries, not the legacy hardcoded `99`; BR tax fields are all-or-nothing; `size_chart_info` from step 18; `item_status: 'UNLIST'` first, then re-list after models exist) → **wait ≥5 s** → `init_tier_variation` with `standardise_tier_variation` (`tier_variation` is deprecated; options from `get_variations`, `variation_option_id: 0` for custom) + `model[]` (`tier_index`, `original_price`, `seller_stock`, `model_sku`) → write `prodshopee` + `variashopee` (`model_id`, `tier_index`).
- Update: `update_item` is **field-wise merge, list-wise replace** — send full lists; **`update_tier_variation.model_list` must carry EVERY surviving model** (an omitted model is deleted — the #831 shape; guard in the planner AND at the wire); `init_tier_variation` on a depth change **invalidates every `model_id`** → re-read `get_model_list` and rewrite `variashopee`; `update_model` cannot set price/stock (steps 12/13); `model_status` is **read-only for BR** (no per-variation pause). `update_item` has no `logistic_info` — channel changes are a Seller Centre action, surfaced as such.
- Pause/re-list: `unlist_item` (≤50, per-entry results; blocked under promotion). **First task: verify `unlist:false` re-lists in sandbox** (`error_set_normal_unlisted_item`). Family status is a fold of members (close only when every observed member is closed).
- Violations: `push 18` / `get_item_violation_info` → `prodshopee.item_status` + `violations` (the exact legacy fields); `push 27` for scheduled-publish failures. Provider rejections parsed into the form control that can fix them (`publishFalhas` shape). **Every write validates the whole item** — an unrelated stale attribute can fail a price push; surface it as a listing problem, not a transport error.
- Does not: auto-apply category suggestions; publish a produto with variations as a kit; send `tier_variation`.

### Step 12 — Stock sync — the cost centre
- Gate: `estoque.*`. Trigger: `onSchedule` ×N tiers + Cloud Task (`sendShopeeStock`) + HTTP (manual push).
- **Axis 1 (read):** reuse the ML plan core shape (IO-free plan, `integracoesComProduto` anchor pre-filter, change-window from the ledger aggregate, durable cursor + continuation, indexes declared, kit quantity computed at query time per ADR 0014). Measure the scan before shipping; record it in the issue.
- **Axis 2 (write):** one Cloud Task per **item** carrying all its models' quantities (≤50) → one `update_stock`; parse `success_list`/`failure_list` per model (a non-empty top-level `error` can coexist with a populated `failure_list`). Pre-read `get_item_promotion` (50 items per call) inside the plan: quantity floor = `total_reserved_stock`; an **active/upcoming promotion, holiday mode (`get_shop_holiday_mode`), FBS (`is_fulfillment_by_shopee`) are DETERMINISTIC skip outcomes** with a reason code, never transient throws. `location_id` only when the shop is in the multi-warehouse whitelist (structure is sticky; per-conta `depositoOuterRef` → `location_id` map). **Kit items: no stock write** — verified in step 19; `quantidadeParaEnvio` is **one function** shared with publish (the #1087 lesson).
- No published rate limit ⇒ conservative `rateLimits` on the queue (start at ML's 2/s) and a 429/5xx pause-and-re-enqueue.
- Does not: send Shopee stock (`shopee_stock` is read-only); react to `push 5/7/8/9` (reserved-stock churn) beyond `ack`; materialize kit availability.

### Step 13 — Price sync (manual, batched)
- Gate: `enviarPreco: 'sim'`. Trigger: HTTP (`enviar-precos`, `atualizar-precos` job) + Cloud Task.
- Same eight-gate ladder as ML `precoDraftSend` (fresh read → skip-if-equal → status gate → decrease guard → build → PUT → **verify the echo** in `success_list` → write back), **per item** because the BR **4× max/min ratio across an item's models** is a whole-item invariant; 2 decimals; a promotion **refuses** the write (`error_cannt_edit_price_in_promotion`) → deterministic skip with reason; `push 22` echoes our own writes with no actor — ignore for our own job ids. Report rows store the code; wording rendered at read time (`precoMotivos` shape).
- Does not: run on a schedule (owner decision, as ML); touch `wholesale`.

### Step 14 — NF-e upload
- Gate: `enviarNfe: 'sim'`. Trigger: Firestore trigger on NF-e `aprovada` (`tpAmb 1`, XML present) → Cloud Task with a **≥5-minute delay** (SERPRO validation, `guide 382`).
- `upload_invoice_doc` multipart (`file_type: 4` XML, **1 MB**, one per order — the API's `limits [1,2,3]` metadata is stale) → verify with `get_order_detail(invoice_data)`: **`{}` means none, check `access_key`**. Deterministic skips: Correios orders (`logistic_id 90003` dropoff — "invoice status invalid" error #11 → ship without NF-e), international orders, FBS (Shopee issues the invoice — reversed direction). Zero-write happy path; a failure stamp under a monotonic watermark on `pedido.freteInicial`.
- Ordering: **before `ship_order`** — step 15 refuses to ship a non-Correios order without `invoice_data.access_key` (the legacy `lack_of_invoice_data` loop, made explicit).
- Does not: upload PDFs; use `get_pending_buyer_invoice_order_list` (contradicted by `guide 383`; the `get_order_list INVOICE_PENDING` filter is the BR path, used by step 4's backfill).

### Step 15 — Labels (etiqueta)
- Gate: `etiqueta: 'fetch'`. Trigger: HTTP (`etiqueta`, a user waits for bytes — hard 409s, no queue).
- Flow: `search_package_list` (`package_status 2`, `fulfillment_type 2`; `is_shipment_arranged: true` on a `LOGISTICS_READY` package means "already arranged, do not call `ship_order` again") → `get_shipping_parameter` (`info_needed`: pickup with `address_id`+`pickup_time_id`, `dropoff: {}` **sent, not omitted**, `non_integrated` with own tracking) → refuse if payment confirmation (`pay_time`, not `create_time` — Boleto/Pix pay days later) is < 1 h ago or the NF-e is missing on an order the `INVOICE_PENDING` filter still lists → `ship_order` → `get_tracking_number` (poll ≤5 min at 5-s intervals; empty is legitimate; some channels allow printing before the number exists) → **`get_shipping_document_parameter`** (read `selectable_shipping_document_type` / `suggest_shipping_document_type` per package — never hardcode the type) → `create_shipping_document` → `push 17` (preferred) or poll `get_shipping_document_result` (`READY|FAILED|PROCESSING`) → `download_shipping_document` (**PDF for NORMAL; ZIP{ZPL `.txt` + declaração de conteúdo PDF} for THERMAL; the MIME also depends on a Seller Centre print setting** → byte-sniff, the requested format only breaks ties; a 2xx with an empty body is a failed label). **The print window closes at `LOGISTICS_PICKUP_DONE`.** Batch: `download_shipping_document` merges up to 50 orders into one file; `batch_ship_order` only for channel 90003.
- Registers `INTEGRACAO_FRETE.shopee` in `lib/checkout/etiqueta/registry.ts` (provider with injected UI capabilities) and flips `FREIGHT_TIPO_CAPS.shopee` (`canFetchLabel`, `canPrint`, `canTrack`, `channel: 'shopee'`).
- Does not: design its own AWB (forbidden in BR); ship from a `LOGISTICS_READY` package with `is_shipment_arranged: true`; use "Logística do Vendedor" (a separate SPI app with a quotation URL — out of scope, recorded).

### Step 16 — Chat — DEFERRED (decision 2026-09-03: not in this migration)
- Gate: `mensagensPosVenda: 'nao'`. The production app is an **ERP System** app, which excludes the Chat API and the webchat push by app type (`guide 14`, `guide 18`); the legacy app never had chat either. Revisit after the cutover: it needs a **Seller In-house System** app (a new app, since the category cannot be edited) under the Registered Business Seller account, the RM-initiated grant against the same acceptance criteria (`FAQ 56`), and platform rules still forbid an auto-responder (`guide 34`).
- What survives now: nothing in `apps/web` — no `OrigemConversa` value, no inbox row, `origensConversa: []`. Post-purchase reviews (`get_comment` / `reply_comment`) are ungated and could become a small pedido-level step later; not scheduled.
- Kept so the door stays open: `webchat_push` (code 10) → `park` in the step-3 dispatch table rather than `ack`, so if a Seller In-house app ever subscribes, nothing is silently dropped; the chat-policy report (`chat-policy-result.md`) records the procedure.

### Step 17 — Returns / refunds / disputes (reclamações)
- Gate: `reclamacoes: 'sim'`. Trigger: Cloud Task (code 29) + HTTP (`reclamacao/acao`, `reclamacao/estado`).
- `get_return_list`/`get_return_detail` (1 order → N `return_sn`); `push 32` is the **best watermark in the whole API** (per-field `old_value`/`new_value`/`update_time`); `ReturnStatus` `REQUESTED|ACCEPTED|CANCELLED|JUDGING|CLOSED|PROCESSING|SELLER_DISPUTE` (terminal set unstated → enumerate `CLOSED`, `CANCELLED` and verify); actions `confirm` (full refund, no return), `get_available_solutions` → `offer`/`accept_offer`, `dispute` (`email` required, `dispute_reason_id` int from a string field, `image_list`), `upload_proof`, `cancel_dispute` (compensation only). One `Incidente` per `return_sn` on the pedido (kind `return`/`mediation`), written for every return; **no `Conversa`** — Shopee returns expose no message thread API; the dispute text is an action. `refundAmount` in reais; a `proposed_adjusted_refund_amount` is what the wire takes. `claimResolve` holds no `db` (single-writer, tier-0).
- Does not: guess terminal states; open a chat conversa.

### Step 18 — Tabela de medidas (reference, not CRUD)
- Gate: `tabelaDeMedidas: 'sim'`. Trigger: HTTP (`size-charts/list`, `size-charts/detail`).
- `get_item_limit.size_chart_limit` is the capability probe per category; `get_size_chart_list` (cursor, per category, ids only) + `get_size_chart_detail` (**column-oriented** table: `column_list[].measurement{display_name, input_type ∈ 'Single Dropdown'|'Input Single Number'|'Input Range Number', unit}` + parallel `measurement_value_list`; rows implicit — validate rectangularity). The `/medidas` picker stores `{categoryId, size_chart_id, name}` into `tabMedi.tabelasMedidasShopee[contaId]` (the corpus shape); step 11 attaches `size_chart_info.size_chart_id` (template wins over image); fallback `size_chart` image from the tabela's first photo via `upload_image`.
- Does not: create or edit a template (Seller Centre only — `update_size_chart` no longer exists); mirror ML's index-diffed sync.

### Step 19 — Kits virtuais (no reference implementation — planned from the docs alone)
- Gate: `kitVirtual: 'sim'`. Trigger: publish (step 11) + stock (step 12) + import (step 9).
- **First task, before design: a live probe on the sandbox/real shop** — create a kit from two component items, sell/adjust a component's `seller_stock`, read the kit's availability in Seller Centre and `get_item_base_info.stock_info_v2`; confirm the derivation rule, whether `update_stock` accepts a kit `item_id`, whether `delete_item` does, and that BR is supported (the docs never state a region; every sample is a `br-` asset).
- Mapping: `produto.ehKitVirtual` → `add_kit_item` (`item_setting`: name, images, `logistic_info`, weight, **1 tier, ≤9 kit variations**, each `model_list[]` with `original_price` and `component_list` of **2–10** `{component_item_id, component_model_id, quantity, main_component}` — read the real limits from `get_kit_item_limit`; exactly one main component supplies category/attributes/brand/DTS); `generate_kit_image` for the cover. `update_kit_item` can only **append** variations and edit image/price/SKU — **a recipe change means recreate**, and the plan says so in the UI. Link doc: `prodshopee` on the kit produto with `tag.kit`.
- Stock: no write; step 12 skips kit items with reason `kit-derivado`. Orders: step 5 maps a kit line to the kit produto (escrow `kit_items` carries the proportional split).
- Does not: send a component-min quantity for a kit (ML's behaviour, which is what an ML-shaped kit would oversell).

### Step 20 — `int_frete` sync (marketplace-owned freight)
- Gate: `etiqueta !== 'nenhuma'`. Trigger: Firestore trigger `onIntegracaoShopeeChanged` (`integracao` create/update/delete, tipo shopee) → materialise/deactivate the `int_frete` doc of tipo `shopee` (watermarked against the event time — Eventarc replays the original event). Same shape as ML `intFreteSync.ts`. Also re-drives deferred notifications when a `shop_id` lands on an active integração (the #808 lane, here for `shop_id`).
- Firestore: `int_frete`. Does not: register the push callback (one URL per app, set once in Console/`set_app_push_config` — a **migration-window step**, not per conta).

### Step 21 — `apps/web`: register, do not copy
- Conta CRUD `/canais/shopee` (replace `CanalCapsPanel` with `TableView`/`ObjectView` on `integracaoSchema`, `queryParams: { tipo: shopee }`, `fieldOverrides` for `shop_id`, `main_account_id`, `depositoOuterRef`, `tabelasAtacado`, authorization expiry badge); the OAuth connect panel is the **fourth** near-identical copy → do #563 (generic `ConnectionPanel`) as part of this step.
- Row/bulk actions: one provider file + one `PROVIDERS` row in `lib/marketplace/{estoque,preco,anuncioStatus}/registry.ts` and `lib/checkout/etiqueta/registry.ts`; `caps/registriesAlinhadas.test.ts` reds CI until they agree with the row. Job cards via `contaJobs` (`useContaJobFan`) for mass import and price jobs. `SidebarNav`/`StatusCanalBadge` already key on the row.
- Produto listing tab: the second channel that **unblocks #1432** — the Shopee tab is built by extracting what is really shared with the ML tab (title/category/attributes/status/variations) from the two real implementations, not by forking `MercadoLivreTab`.
- Inbox: an `OrigemConversa` + `ORIGEM_RULES` row only with step 16.

### Step 22 — CI lane, emulator configs, deploy isolation, docs
- `.github/workflows/ci-shopee.yml` with the `changes`/`gate` pattern (`ci-lanes` skill), check name `CI gate (shopee)` pinned; `ci.yml` excludes the shopee tests (an exclusion is a promise). `firebase.shopee.json` (firestore-only emulator) and `firebase.shopee.tasks.json` (firestore+functions+tasks) for `*.firestore.test.ts` / `*.tasks.test.ts`; `firebase.shopee.deploy.json` (functions codebase `shopee`, `prepare-deploy.mjs`, `tools/deploy-env/preflight.mjs shopee`, exact `firebase-admin 14.2.0`/`firebase-functions 7.3.2` in the artifact manifest); `apps/shopee/apphosting.yaml` (`next` literal `16.2.6`, `engines.pnpm` exact, `vpcAccess` per P2 option D, `minInstances: 0` — scale-to-zero per P3, with the push-health monitor as the only trigger to raise it); `apps/shopee/CLAUDE.md` + `functions/DEPLOY.md` (three IAM roles). Both rulesets regenerated + snapshots whenever a `*Meta` changes (steps 3, 9, 20 touch metas).

### 4.24 Dropped steps, with the `'nao'` that dropped them
- **Pack consolidation** (template step 5's `consolidaPacote`) — `'nao'`: one order → N packages only; `group_shipment_id` is read-only. The inverse (one order → several packages/labels) IS in scope.
- **Pre-sale questions** (template step 16's `perguntas`) — `'nao'`: Shopee has no public listing Q&A API.
- **Chat (step 16)** — `mensagensPosVenda: 'nao'`: the production app is an ERP System app, which cannot hold the Chat API; deferred to after the cutover (decision 2026-09-03).
- **Missed-feed replay by provider feed** (ML `missed_feeds`) — replaced by `get_lost_push_message` (step 4), a different contract (watermark ack, 3-day window).
- **Virtual kits as ML does them** — not dropped, inverted: step 19 sends no kit stock at all.
- **Per-variation pause** — `model_status` is read-only for BR; pause is item-level (step 11).
- **Logística do Vendedor / Entrega Expressa (quotation SPI)** — a separate app type with Shopee calling us; out of scope, recorded for the freight domain.

---

## 5. Migration-window items (rule 8 — surfaced, not done; issues only on your yes)

1. **Push callback URL** registered at Shopee (Console or `set_app_push_config`) must point at the deployed `apps/shopee` receiver — a one-time production step, and the sandbox URL is independent.
2. **Static-egress infrastructure (P2, option D):** custom-mode VPC + subnet in the backend's region, the reserved static IPv4, the free-tier e2-micro proxy VM in the backend's zone, its firewall rules and IAP access — all before `apphosting.yaml` gains `vpcAccess`; then register that IP in the app's **IP whitelist** and enable it (the whitelist blocks every call from any other IP the moment it is on).
3. **Re-authorization of the shop** against the new app (if P1 means a new `partner_id`): legacy `actokshopee` credentials do not carry over; the seller consents once with 365 days.
4. Legacy `integracao/{id}/pushshopee` documents: drop (no reader); legacy `actokshopee`: drop after re-auth.
5. `firestore.indexes.json` additions (pedido `(integracaoPedidoOuterRef, numero)`, collectionGroup `prodshopee.item_id`, `variashopee.model_id`, `notificacoesShopee (status, processedAt)`) — index deploy.
6. Both rulesets — deploy after regeneration (steps 3/9/20).

---

## 6. Definition of ready — checklist
- [x] Caps row with no `'desconhecido'`; every `'sim'` cites a page (§1).
- [x] Dropped steps listed with their `'nao'` (§4.24).
- [x] `estoque.protocolo` decided: `'por-anuncio'` (one item per call, ≤50 models); not `'feed-assincrono'`, so no submission-record protocol is needed.
- [x] `assinaWebhook: 'sim'` and the receiver fails closed (step 3).
- [x] Legacy checked: `prodshopee`/`variashopee`/`brandshopee`/`tabelasMedidasShopee`/`linksVariacoesShopee` constrain; `pedshopee` does not exist (§3).
- [ ] P1–P8 answered by Lucas (§2 / §7).
- [ ] Tracker + per-step issues opened — only after a yes.

---

## 7. Questions for Lucas (design, infra, scope)

Answered on 2026-09-03 and folded into §2.1: app category (ERP System, legacy app reused, same-type test app), chat (deferred), sandbox (Lucas creates it), tax regime (Simples Nacional, CNPJ), Go Live (not needed for the production app), authorization-expiry warnings (weekly sweep + in-app notification). Still open:

1. **Go Live for the new test app?** A Test-status app holds only test credentials against the sandbox; calling the real shop from staging requires that app's own Go Live (24 h review, product brief — `guide 14`). Recommendation: yes, submit it once the sandbox flow works — it is the only way to rehearse order and product import against real data before the cutover without touching the legacy app's push callback, and it costs one review.
2. **Static egress (P2).** Approve option D from §2.2 (free-tier proxy VM, ≈ $3.65/month)? Two checks first: is the free-tier e2-micro already consumed on your billing account (one per account, pooled across projects), and how many IPs does Shopee's whitelist accept?
3. ~~Receiver posture (P3)~~ — answered on 2026-09-03: scale-to-zero (§2.1).
4. **Seller facts still open:** do you use Correios for some orders (no NF-e path)? Is the shop in the multi-warehouse (`location_id`) whitelist? Do you sell kits on Shopee today?
5. **Fiscal rule.** Keep the legacy extreme-coupon NF-e floor (`max(shipping, 50 % of items, R$5)` with the `<order_sn>-desconto` pagamento)? A fiscal decision, not an API one — and under Simples Nacional the accountant's view matters.
6. **Price sync** stays manual-only, as on Mercado Livre?
7. **`auth` enum.** Keep `'oauth2'` with the comment, or add a `'proprietario'` value to `MarketplaceCapabilities.auth`?
8. **Two developer accounts.** Shopee's FAQ says one company registers one developer account and "do not apply for multiple accounts" (`FAQ 660`). Raise it with the RM before the test app's Go Live review, which is where a reviewer would see both.
9. **Issues.** May I open the tracker, the step issues (labels `shopee`, `marketplace`, a `task:` label per step), the migration-window items in #1208's format, and the parallel-session issue for the in-app notification system (P8)?

## Appendix — evidence files

All under `.master_plans/shopee/evidence/`, every one derived from Shopee's public documentation or from public Google Cloud pages: `survey-a-auth-push.md` (auth, signing, pushes) · `survey-b-orders-logistics.md` (orders, payments, logistics, NF-e, returns) · `survey-c-products-stock.md` (listings, variations, stock, price, size charts, kits) · `survey-d-chat-promos.md` (chat, promotions, reviews) · `caps-verify-result.md` (the 29-claim adversarial verification) · `chat-policy-result.md` (the Chat API access policy, verified) · `gcp-egress-research.md` (the P2 cost research). The docs reader `shopee-doc.mjs` sits beside them (`node shopee-doc.mjs guides|guide N|api NAME|push N|announcements`; it caches raw pages under `./cache/`, which is ignored). Operator decisions and legacy-code findings that must not be published live in the gitignored `.private/shopee/`.
