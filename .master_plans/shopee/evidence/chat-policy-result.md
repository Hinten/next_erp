# Shopee Chat API — status, access path in Brazil, and what to build meanwhile

## 1. Verdict

1. **Yes, it's real — but it's an application freeze aimed at two developer profiles, not a shutdown.** Shopee closed new Chat API access to "Individual Third Parties and Third-party Partner Platforms (ISV)" on **2024-11-18** [announcement 1026], on top of a 2021 whitelist-only freeze [announcement 507]. Nothing since has reopened it; the latest BR notice (2026-06-17) restates it, and the latest BR developer guide (2026-08-29) answers *"A Open Platform consegue liberar Chat API para minha aplicação?"* with a flat **"Não."** [announcement 1548].
2. **No, you cannot integrate chat "normally".** Every `v2.sellerchat.*` reference page is permission-gated (`error_auth`) — you can't even read the docs without an approved grant. The surviving route is **not** a Customer Service app: it is **Registered Business Seller → Seller In-house System app**, and in Brazil the request must be opened **by your Account Manager (RM)**, case-by-case, "**a aprovação está sujeita a critérios internos e não é garantida**" [announcement 1430].
3. **Yes, you have to request it — and the answer depends on a fact only you know: whether Delfrance is registered as a *Registered Business Seller* (in-house ERP for its own shop) or as an *ISV/Third-party Partner*.** The first has a narrow, non-guaranteed path. The second has **no path at all**, and the ERP System app type it gets is documented as *"All API except Chat API and Ads API"* [guide 14].

---

## 2. Policy timeline

### Access policy

| Date | Source | What changed |
|---|---|---|
| 2021-10-15 | [announcement 507] | First freeze: *"we will not be accepting new applications for access to our Chat API, and the Chat API will only be accessible to our existing whitelisted developers."* Closed with *"We will be providing further information once the policy has been finalized."* (The Chinese half is narrower — it closes *Customer Service app* applications specifically.) |
| 2022-03-29 | [announcement 547] | "Chat API abuse" added to prohibited behaviours in the Platform Partner Rules, alongside web-crawling and brushing. |
| **2024-11-18** (published 11-19) | [announcement 1026] | The operative closure, and it closes **two** things, both scoped to *Individual Third Parties and Third-party Partner Platforms*: *"Applications for Customer Service Apps … will be closed"* **and** *"New Chat OpenAPI applications … will be closed."* |
| 2025-05-16 | [FAQ 574] | Taiwan carve-**out**, stricter than global and with no route at all: *"TW does not offer Chat API to developers."* |
| 2025-12-12 | [FAQ 716] | *"This FAQ is only for developers who already have Chat API access. The Chat feature is no longer available for Third-party Partner Platform (ISV) developers."* |
| 2026-01-12 | [FAQ 56] | "How to apply Chat API document permission" — still documents a live 6-step ticket flow, under a banner saying applications have been closed since 2024-11-18. **Internally contradictory; see §3.** |
| 2026-03-26 | [announcement 1363] | Brazil carve-**in**: five conditions, plus *"Não abra ticket **imediatamente**"*. |
| 2026-06-17 | [announcement 1430] | Same five conditions, instruction hardened to *"**Não abra ticket**"*. Latest Chat-policy announcement; nothing supersedes it. |
| 2026-08-29 | [announcement 1548] | BR onboarding Q&A: *"Sou seller. Como solicito Chat API?" → "A solicitação deve ser feita pelo RM (Account Manager)."* · *"A Open Platform consegue liberar Chat API para minha aplicação?" → "Não."* · *"A Open Platform consegue verificar meu processo de aprovação?" → "Não. Esse fluxo é tratado internamente entre Seller e RM."* |

### Capability changes (the API kept being developed throughout — it is not abandoned)

| Date | Source | Change |
|---|---|---|
| 2022-04-29 | [announcement 562] | Deleted messages return `"This message was deleted"` via `get_message`; deletion then live in SG/TH/ID/MY only, and **not** callable from OpenAPI. |
| 2022-08-29 | [announcement 592] | Image messages scanned for blacklist keywords → `message_is_censored`, status `censored_blacklist`. |
| 2023-03-13 | [announcement 637] | `manage_offer`, `get_offer_detail`, `mute_conversation`, `unmute_conversation`; `get_message` gains `image_url`/`video_url` and batch retrieval. |
| 2024-06-28 | [announcement 925] | Frozen users blocked from sending / being sent to. |
| 2024-09-20 | [announcement 970] | Voucher messages; **new** `v2.sellerchat.delete_message` ("message recall **based on local regulations**" — no market list published); webchat push gains seller-sent messages (whitelist). |
| 2024-12-23 | [announcement 1052] | Video messages (`upload_video`, `get_video_upload_result`). |
| 2025-06-20 → **2025-07-30** | [announcement 1168] → [announcement 1197] | Send-validation mechanism (`reach_5_message_limit`, `user_is_forbidden`). ⚠️ 1168 said July 4, 1197 postponed "from July 5" to **July 30** — the two disagree on the original date; **2025-07-30 is the operative one**. |
| 2025-10-14 (pub. 10-15) | [announcement 1268] | Same message re-sent within 24h is blocked (documented for `send_message` only). |
| 2026-01-16 (gray release from 2026-01-29) | [announcement 1324] | **Chat Distribution** blocking → `shop_bound_subaccount`; new `v2.sellerchat.get_csat_msg_details`; `get_csat_details` deprecated Mar 30. |

**No announcement anywhere in the 552-item corpus rescinds or relaxes any of these restrictions, and none reopens applications.**

---

## 3. Who can still get access, and the exact Brazilian procedure

### Who

| Developer profile | App type it can create | Chat API |
|---|---|---|
| **Third-party Partner Platform (ISV)** | `ERP System` — *"All API except Chat API and Ads API"* [guide 14] | ❌ Closed since 2024-11-18 [1026]; *"no longer available for ISV developers"* [FAQ 716] |
| **Registered Business Seller** | `Seller In-house System` — *"All API including Chat API"* [guide 14] | ⚠️ **Only path in BR** — by request, via RM, not guaranteed |
| **Individual Seller** | `Seller In-house System` (globally) | ❌ In BR: *"Closed for BR"* [guide 12 §2]; and [1430] cond. 1 says *Registered Business Seller* only |
| *Individual Third Party* | — | Deprecated account type [guide 14] |

BR developer-account eligibility: *"Registered business sellers with valid business documents in Brazil, and at least 1 order in the last 30 days"* [guide 12 §3.1]. (The docs say "valid business documents", not CNPJ, in the eligibility criteria — though CNPJ is used elsewhere as a BR seller-type classifier.)

⚠️ **Trap:** if you ever upgrade the profile to ISV, [guide 14] states *"Once approved, your App type will automatically change from Seller In-house System to ERP System"* — which moves you into the "except Chat API" bucket. Do not upgrade to ISV if chat matters.

### The procedure in Brazil — verbatim [announcement 1430], identical in [1363]

> *"Para o Brasil, solicitações de acesso podem ser analisadas sob condições específicas: 1) Disponível apenas para sellers com perfil Registered Business Seller; 2) A solicitação deve ser feita via Gerente de Contas (Account Manager); 3) Cada caso será submetido a análise interna; 4) A aprovação está sujeita a critérios internos e não é garantida; 5) Permanece não havendo suporte para quaisquer outros modelos de solicitação (Individual ou Third-party)."*
>
> *"Caso você seja Registered Business Seller, elegível no Brasil: 1) **Não abra ticket**; 2) Entre em contato com seu Gerente de Contas para que o mesmo inicie o fluxo internamente."*

**DO:**
- Contact **your Account Manager / Gerente de Contas / RM** and ask them to open the flow internally.
- If you don't know who your RM is, ask **Atendimento ao Vendedor** (site or app) [announcement 1444].
- Make sure the shop meets the published performance criteria before asking (below).

**DO NOT:**
- **Do not open an Open Platform ticket.** [1430] says `Não abra ticket`. This directly overrides [FAQ 56] Step 1 (*"Please raise a ticket"*) — that FAQ is the **global** page and is stale for Brazil (it predates 1430 and 1548).
- Do not create a "Customer Service" app: [guide 14]'s matrix leaves that row blank for every account type, and [announcement 1400] states *"Não realizamos liberações adicionais, concessão de permissões extras ou alterações manuais em aplicativos já criados, pois essa possibilidade não existe."*
- Do not expect Open Platform support to grant it or to tell you the status — both answers are `Não` [announcement 1548].
- **Hard stop:** *"O time de Open Platform não possui visão sobre RMs de cada conta … se não tiver RM, não é possível prosseguir."* [guide 735 §2]. **No RM = no path.**

### Retention criteria (also what's reviewed) — [FAQ 56]

> *"To continue having access to Chat API, you have to meet the criteria of the market you're operating in:"*
> 1. ISV last-30-day average orders of authorized shops **> 100** (*"Seller order quantity needs to be >21"*)
> 2. Shop's area of performance, each *"overall OR in any market of operation"*: **NFR < 3%**, **LSR < 3%**, **pre-order listings < 20%**, **average preparation time < 2 days**
>
> *"…if Shopee detects any abnormal behavior, or if you do not meet the criteria above, we reserve the right to remove your access to the Chat API function."*

Global (non-BR) timings, for reference only: 5–7 working days qualification review, then 2–3 working days to open the document permission [FAQ 56 steps 2 & 4]. **No SLA is published for the BR RM route.**

---

## 4. What the ERP can build **without** the permission

**The gate is narrow and precisely observable.** Sweeping the entire public API catalogue — 454 names across 30 modules — **444 return full documentation anonymously and *zero* return `error_auth`**. The only gated things are:

| Gated (needs the grant) | Evidence |
|---|---|
| All 18 attested `v2.sellerchat.*` endpoints — `send_message`, `send_autoreply_message`, `get_message`, `delete_message`, `get_conversation_list`, `get_one_conversation`, `get_unread_conversation_count`, `read/unread/mute/unmute/pin/unpin/delete_conversation`, `upload_image`, `upload_video`, `get_video_upload_result`, `get_csat_msg_details` | `{"code":10,"error":"error_auth","msg":"You have no permission of this document. Please login first…"}` |
| **Webchat Push (code 10)** — the inbound chat webhook | `push_api_id=10` `app_rules: [3,8,1,16]` = Seller In House System(3), Customer Service(8), Original(1), Ads Service App(16). **ERP System (2) is absent.** [guide 18]: *"ERP System \| All Push notifications except Webchat Push (Code:10)"* |
| Developer guide 38 "Chat API best practices" | `error_auth` |

### Is `webchat_push` receivable without the permission?

**No — not by an `ERP System` app.** It is documented publicly (the full payload schema for `push_api_id=10` is anonymously readable: `conversation_id`, `message_id`, `shop_id`, `from_id`/`to_id`, `message_type` — `text`/`video`/`image`/`item`/`faq_liveagent`, plus an undocumented sixth value `bundle_message` — `created_timestamp`, `sub_account_id`, `quoted_msg`, `business_type`, `status`). But **readable ≠ subscribable**: the `app_rules` list excludes ERP System, and [guide 18] says so in prose. A `Seller In-house System` app *does* get "All Push notifications", i.e. including Webchat Push — but per §3 the send/read APIs still need the grant.

> Note: Webchat Push **is** listed in the Sandbox V2 push-support table [announcement 1249, `Webchat Push | webchat_push | 10`], even though Chat is absent from the Sandbox Open-API module list. That's about sandbox coverage, not app-type eligibility.

### `get_comment` / `reply_comment` — are they separate?

**Not attested in the verified corpus, and I won't invent them.** What *is* established: the only `error_auth` pages in the entire public catalogue are `v2.sellerchat.*` (plus guide 38). So **anything that is not `v2.sellerchat.*` is outside this gate by construction** — if a product-comment/Q&A API exists in the Shopee catalogue, it is publicly documented and unaffected by the Chat closure. Verify with `GET /opservice/api/v1/doc/module/?version=2` and grep the 454 names before designing around it. Treat as **UNKNOWN** until checked.

### Everything else is unaffected

Orders, Product, GlobalProduct, Logistics, FirstMile, Returns, Payment, Shop, Merchant, Media/MediaSpace, Discount, Voucher, Bundle/Add-On Deal, ShopFlashSale, TopPicks, ShopCategory, AccountHealth, Ads, Push, SBS, FBS, Livestream, BrandPortal, AMS, Video — all readable and callable on an `ERP System` app. A full Shopee integration (listings, stock, price, orders, freight/labels, returns, NF-e upload) is buildable today; **only the conversational layer is gated.**

---

## 5. Operational constraints once granted

Six blocking mechanisms accumulated, none of them ever rescinded:

| Error / behaviour | Condition | Since |
|---|---|---|
| `shop_bound_subaccount` | Seller has **Chat Distribution** ON **and** a main/sub-account configured to receive inquiries → `send_message` **and** `send_autoreply_message` blocked. Remedy is seller-side: toggle Chat Distribution OFF in the Sub-account Platform. If the toggle is on but nobody participates, OpenAPI still sends. | gray release 2026-01-29 [1324] |
| `reach_5_message_limit` | More than 5 messages sent without any buyer reply. | 2025-07-30 [1168]/[1197] |
| `user_is_forbidden` | Buyer never messaged, or last messaged **>7 days ago**, **AND** no order in last 30 days, **AND** no ongoing return/refund case. | 2025-07-30 |
| *(repetitive message blocking)* | Same message re-sent within 24 h → second one blocked. Documented for `send_message` only. | 2025-10-14 [1268] |
| *(frozen users)* | Frozen user cannot send, and cannot be sent to. Both send APIs. | 2024-06-28 [925] |
| `message_is_censored` | Image contains a blacklist keyword; retrievable afterwards with status `censored_blacklist`. Extends the pre-existing text censoring. | 2022-08-29 [592] |

**Rate limits [FAQ 716]:** BR daily send limit **6,000** non-whitelisted / **2,000,000** whitelisted. The whitelist is *also* requested through the Account Manager — a separate grant from access itself. (TW shows `/` — no limit because no access.)

**Conduct rules [guide 34] / [FAQ 56] — these are penalty-bearing, and penalties include app suspension with authorized-shop permissions revoked:**
- ❌ Proactive order updates via chat
- ❌ Promotional chat broadcasts
- ❌ **Chatbot replies** ← relevant if you were planning an AI responder
- ❌ Disguising automated messages as manual, or vice versa
- Use Push Mechanism notifications for real-time updates instead [guide 18]
- Do not process chat data for purposes other than responding to buyers; comply with the Data Protection Policy [guide 32]

**CSAT migration:** `v2.sellerchat.get_csat_details` → `v2.sellerchat.get_csat_msg_details` (deprecated Mar 30). The replacement is **not** a like-for-like swap: it accepts `csat_result` Good/Bad/Average (the old one covered negative only) and has **two** range limits — 180-day lookback **but max 15-day window per query**, defaults `time_from` = T-2, `time_to` = T-1 [1324].

**`delete_message` caveat:** announced as message recall *"based on local regulations"* with **no market list published anywhere**. The only enumerated list is the 2022 webchat/app-side one (SG, TH, ID, MY), which predates the OpenAPI endpoint. **Probe it and handle refusal; do not assume it works.**

---

## 6. Is there an official Shopee MCP server?

**No.** The terms *MCP*, *Model Context Protocol*, *AI agent*, *agentic*, *LLM*, *connector* appear **zero times** across the complete public developer corpus: 552 announcements (2018-06-14 → 2026-09-01), 159 FAQ entries, 68 developer guides (en + pt-br), 29 API modules / 454 API names, 34 push docs. Probing `v2.mcp.*` / `v2.ai.*` returns `error_not_exists`.

What Shopee *does* ship: an **AI Assistant in the developer console** that searches docs and triages before ticket submission (live 2026-07-23, [announcements 1484/1485/1448]), and a **Shopee Open Platform Chatbot** with per-market Terms of Service [guide 723]. Neither is an API or a connector.

Sea Ltd's AI partnerships are consumer/seller/builder-facing, **not** Open Platform endpoints: the Google MOU (2026-02-19) says the two *"will jointly explore the building of an AI agentic shopping prototype"* — exploratory, not shipped — and Monee will give *"expert feedback"* on the Agent Payments Protocol (AP2), a payments protocol, not MCP. The OpenAI release (2026-06-22) puts the **Shopee App in ChatGPT** (incl. Brazil) and brings ChatGPT for Business to sellers. Neither release mentions "API", "Open Platform", "connector" or "SDK" even once.

Third-party/community Shopee MCP servers do exist (PulseMCP, LobeHub, GitHub listings; plus commercial ones in Brazil), **but that is third-party registry evidence, not Shopee's** — and none of them can grant Chat API access, since the gate is on the Shopee side.

**Note also Shopee's own posture:** [guide 34] lists *"chatbot replies"* via Chat Open API as prohibited abuse. Any AI-agent chat design here runs against the platform rules even *with* the permission.

---

## 7. What only you can answer

These three determine whether anything above is actionable — I can't resolve them from public sources:

1. **Which developer profile is the Delfrance account registered under?**
   `Registered Business Seller` (in-house ERP for your own shop) or `Third-party Partner Platform (ISV)`? Check *Account Information* in the Open Platform console. If ISV → **chat is closed, full stop**; record the capability as unavailable, not pending. If Registered Business Seller → §3's RM route applies. Given this repo is a **single-company in-house ERP**, Registered Business Seller is the correct profile *and the one that keeps chat reachable* — worth confirming before anyone "upgrades" anything.

2. **Do you have an assigned Account Manager (RM), and who is it?**
   Without one there is literally no path — *"se não tiver RM, não é possível prosseguir"*. If unknown, Atendimento ao Vendedor is where to ask; Open Platform cannot tell you.

3. **Does the existing app already hold the Chat permission?**
   Two cheap tests, in order:
   - Log into the Open Platform console with the developer account and see whether the **Chat API documents are visible** ([FAQ 56] step 5: *"you will see the Chat API document"*). Anonymously they are all `error_auth`.
   - Check the app's **type** — `ERP System` cannot have it by definition; `Seller In-house System` can. And per [FAQ 56] step 5, *"If you have created such an app before, you can also use that to call the Chat API"* — an existing Seller In-house System app can be reused if the grant lands.

   ⚠️ If the app pre-dates 2024-11-18 and the account is/was an ISV, whether legacy access still *works* is genuinely **UNKNOWN**: [FAQ 716] says *"no longer available for ISV developers"* while [FAQ 56] (newer) still publishes *continuing*-access criteria for ISVs and [1324] still tells sellers how to keep *"using ISV/ERP for replies"*. No announcement declares a revocation. Only a live call or the RM can settle it.

**Additional unknowns worth carrying into any plan:** no approval SLA is published for the BR route; approval rate is unobservable (*"não é garantida"*, and Open Platform has no visibility into the outcome); and whether an approved BR request attaches the permission to an **existing** Seller In-house System app or requires a new one is not stated — which matters, since app categories are irreversible and you are capped at 10 apps [guide 14].