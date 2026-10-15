# Shopee Open Platform v2 — Survey D: chat, promotions/stock, account health, hidden modules

Source: Shopee's public docs JSON API (`open.shopee.com/opservice/api/v1`), fetched
via `shopee-doc.mjs`, no login. All quotes below are from that API's rendered text;
paraphrases are marked as such. Every "exists / does not exist" verdict is based on
comparing the JSON error code returned, not on guessing from names.

**How existence was determined.** The docs API returns three distinct signals for
an `api` lookup:
- Full content (HTTP 200, populated fields) → the API is publicly documented.
- `{"code":4,"error":"error_not_exists","msg":"Api does not exist"}` → the name is
  not a real API. Verified against a deliberately bogus control name
  (`v2.totally.nonexistent_api_xyz`), which returns the identical code/error/msg.
- `{"code":10,"error":"error_auth","msg":"You have no permission of this document.
  Please login first to confirm your identity"}` → **the API exists, but its doc
  page is gated behind a logged-in Open Platform account** (distinct from
  "does not exist" — different `code`, different `error`, different `msg`).

## Part 1 — Chat

### 1a. Does a chat module exist?

The public module index (`node shopee-doc.mjs modules`) has no "Chat" or
"Sellerchat" module — confirmed by grepping the full index for "chat" (only hits
are `v2.livestream.get_latest_comment_list` / `post_comment` /
`ban_user_comment` / `unban_user_comment`, which are livestream comments, not
buyer chat).

However, the **push category list** (`push-list`) has its own top-level category
that the module index omits entirely:
```
[1004] Webchat Push
   push_api_id=10  webchat_push
```
This proves a chat feature exists and pushes to sellers, even though it isn't
surfaced in `modules`.

Probing the 14 given `v2.sellerchat.*` names individually:

| API name | Result |
|---|---|
| `v2.sellerchat.get_conversation_list` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.get_one_conversation` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.get_message` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.send_message` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.upload_image` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.read_conversation` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.unread_conversation` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.pin_conversation` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.delete_conversation` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.get_unread_conversation_count` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.send_autoreply_message` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.mute_conversation` | **exists**, doc gated (`error_auth`) |
| `v2.sellerchat.get_offer_detail` | **does not exist** (`error_not_exists`, same as bogus control) |
| `v2.sellerchat.reply_offer` | **does not exist** (`error_not_exists`, same as bogus control) |

**Verdict: 12 of 14 `v2.sellerchat.*` names are real, currently-live APIs**, under a
module ("Sellerchat" / "Webchat") that the public `modules` index simply does not
list — this is exactly the kind of undocumented-in-the-index module the task asked
to probe for. `get_offer_detail` / `reply_offer` are **not** real API names under
this exact spelling (an "offer" concept — e.g. price-negotiation offers inside
chat — may or may not exist under a different name; UNKNOWN — docs do not say).

Because the 12 real sellerchat docs are login-gated, **their request/response
param shapes, message-type enum, attachment mechanics, and any reply-time-window
or message-length limits are UNKNOWN from this unauthenticated docs API** — the
guide `718: Requesting Access to Sensitive Data` (category "Getting Started")
describes a *different* gate (penetration-test report + IP whitelisting, required
to unmask PII like buyer name/phone/email/address in API responses generally) and
does not by itself explain why the sellerchat *documentation pages* require login
while e.g. `v2.product.get_comment` does not. Whether that also means the sellerchat
*API calls themselves* (not just their doc pages) need extra approval is UNKNOWN —
not stated anywhere reachable without login.

One confirming side artifact: guide `723: Chatbot Terms of Service` (category
"Terms of Use") exists and explicitly lists a Brazil-region link
(`https://help.shopee.com.br/portal/4/article/159634`, "Termos de serviço do
chatbot"), confirming Shopee operates a seller-side chat/chatbot product in BR.

### 1b. What `webchat_push` (push 10) carries

Full param tree and description (`node shopee-doc.mjs push 10`), category
`[1004] Webchat Push`, `push_code=10`, `timeout=2`, `guarantee=1`:

> Description: "Get the chat message"

`data.type` is `notification` or `message`. **When `type=message`, the push
carries the full message content inline — not just a pointer/id to fetch.**
Relevant fields under `data.content` (message type):

- `message_id`, `conversation_id`, `from_id`/`from_user_name`,
  `to_id`/`to_user_name`, `shop_id` (`to_shop_id`), `from_shop_id`,
  `created_timestamp`, `region`, `is_in_chatbot_session`,
  `sub_account_id`/`sub_account_name` (which sub-/main-account sent it),
  `business_type` — **0 = buyer↔seller conversation, 11 = affiliate↔seller
  conversation**.
- `message_type`: **`text` / `video` / `image` / `item` / `faq_liveagent`**
  — no `sticker`, `order`, or `offer` message type appears anywhere in this
  push doc (task's list of possible types was broader than what the doc shows;
  the rest is UNKNOWN, not confirmed absent).
- `content` (message-type-specific):
  - `text`: `{ text, translation:{text,source,target_language,source_language}, mid:{...} }`
  - `image`: `{ url, thumb_url, thumb_height, thumb_width, file_server_id }`
  - `video`: `{ video_url, thumb_url, thumb_width, thumb_height, duration_seconds }`
  - `item`: `{ shop_id, item_id }` — **this is the order/item-linkage
    mechanism**: a chat message can carry a referenced product `item_id`
    (and `shop_id`).
  - `faq_liveagent`: `{ text, pass_through_data }` — one of the four samples
    for this type has `"source_content":{"order_sn":"220818EGS328B9"}`,
    i.e. **a message can be linked to an order via `source_content.order_sn`**
    on top of the `conversation_id`. (`source_content.item_id` also appears
    for `message_type=item`.) So conversation↔order and conversation↔item
    linkage both exist, via `source_content`, at least for these two message
    types; whether every conversation carries an `order_sn`/`item_id` or only
    ones that originated from an order/item click is UNKNOWN.
  - `bundle_message`/`messages` (string[] of message ids) and
    `shopee_chatbot_replied` (boolean) appear as fields too, implying a
    "bundle_message" grouping type exists even though it isn't itself listed
    under `message_type`'s described values (UNKNOWN whether it's a distinct
    `message_type` or a wrapper).
- `status` (string): **`normal; auto_reply; blocked; user_chat; web_chat;
  censored_whitelist; censored_blacklist; offwork_autoreply`** — confirms
  Shopee has its own auto-reply and off-work-auto-reply behaviour, and a
  censorship/blocklist layer, independent of anything the ERP sends.
- `quoted_msg[].message_id` — a message can quote/reply to a prior message.

Two full samples (message type=item, and faq_liveagent) are quoted in the
"Sample" section of the push doc; reproduced here abbreviated:
```
message_type=item → content: {"shop_id":109157255,"item_id":9112503530}
message_type=faq_liveagent → content:{"text":"Chat dengan Penjual","pass_through_data":""},
  source_content:{"order_sn":"220818EGS328B9"}
```

Update log shows this push has been actively extended: 2024-09-04 (redefined
`shop_id` semantics inside `content`), 2024-09-23 (`sub_account_id`/`name`,
`quoted_msg`), 2024-11-05 (`business_type`, `bundle_message`,
`shopee_chatbot_replied`), 2025-04-18 (`from_shop_id`/`to_shop_id`/`status`).

**No `send_message` request shape could be retrieved** — its doc page is
login-gated (see table above). UNKNOWN — docs do not say (without login).

**Message length limits / reply-time windows: UNKNOWN — docs do not say**
(the only doc that would carry this, `v2.sellerchat.send_message`, is
login-gated).

### 1c. Pre-sale public question vs. private chat

Nothing in the reachable docs describes a Mercado-Livre-style *public*
pre-sale Q&A distinct from chat. The only two buyer-facing text surfaces found
are: (1) private seller chat (`sellerchat`/webchat, gated) and (2) post-purchase
product comments/ratings (`v2.product.get_comment`/`reply_comment`, public,
see 1d). **UNKNOWN whether Shopee has a third, public "ask a question on this
listing" concept** — not found under any probed or module-indexed name.

### 1d. Product comments (`v2.product.get_comment` / `reply_comment`)

Both are public, fully documented — **these are post-purchase reviews/ratings,
not a chat surface**:

- `get_comment`: "Use this api to get comment by shop_id, item_id, or
  comment_id, get up to 1000 comments." Paginated (`cursor` + `page_size`,
  1–100; response `more` + `next_cursor`; **capped at 500 comments returned
  through OpenAPI even if `more` stays true beyond that**). Each comment
  carries `order_sn`, `comment_id`, `comment` (text), `buyer_username`,
  `item_id`, `model_id_list`, **`rating_star`** (1–5), `hidden`, `create_time`,
  `media.image_url_list` / `media.video_url_list` (buyer-uploaded media on the
  review), and `editable`: **`EXPIRED` / `EDITABLE` / `HAVE_EDIT_ONCE`** (buyer
  can edit their review once), and a nested `comment_reply` object
  (`reply`, `hidden`, `create_time`) if the seller already replied.
- `reply_comment`: "Use this api to reply comments from buyer in batch" —
  batch of 1–100 `{comment_id, comment}` pairs. **One reply per comment is
  enforced**: error sample is `product.duplicate_request` /
  `"You has replied this comment already."` — confirms replying twice is
  rejected, consistent with `editable`'s `HAVE_EDIT_ONCE` semantics on the
  buyer side.

So: **product comments = star-rated, post-purchase reviews tied to an
`order_sn`/`item_id`, one seller reply allowed, entirely separate API surface
from seller chat.**

## Part 2 — Promotions that touch price/stock

### 2a. Discount (`v2.discount.*`)

- `add_discount`: creates only a shell — `discount_name`, `start_time`,
  `end_time` → returns `discount_id`. Start time must be ≥1h in the future;
  discount period must be <180 days (matches CLAUDE.md's own #785 note about
  180-day-scale windows being a recurring Shopee pattern — unrelated system,
  same order of magnitude).
- `add_discount_item` / `update_discount_item`: attach existing `item_id`s (by
  `model_id` for variants) to the shell, each with its own
  `item_promotion_price` / `model_promotion_price`, an optional
  `item_promotion_stock` / `model_promotion_stock` (**reserved stock for the
  promo**), and `purchase_limit`. Explicit note: **"To edit the promotion
  stock, you need to delete the exist discount and re-add again"** — promo
  stock is not mutable in place once set.
- `get_discount_list`: paginated (`page_no`+`page_size`≤100), filter by
  `discount_status` = upcoming/ongoing/expired/all, plus an optional
  `update_time_from/to` window capped at 30 days.
- `get_discount` / `end_discount`: read one / end one by `discount_id`.

**Discount = a per-existing-SKU promotional price override + optional reserved
promo stock, not a new SKU.** No bundled/derived-stock concept anywhere in
this module.

### 2b. Bundle Deal (`v2.bundle_deal.*`)

`add_bundle_deal` definition explicitly frames it as a **buy-N-get-discount
rule over existing items**, not a bundled SKU:
- `rule_type`: `1=FIX_PRICE, 2=DISCOUNT_PERCENTAGE, 3=DISCOUNT_VALUE`
- `min_amount`: quantity of items the buyer must combine-purchase to qualify
- `additional_tiers` (max 2 more): escalating discount by quantity, e.g. "buy 2
  get 10% off, buy 3 for 15% off, buy 4 for 20% off" (verbatim from
  `get_bundle_deal`'s field doc)
- `purchase_limit`: max bundle-deal purchases per buyer

`add_bundle_deal_item` attaches items with only `{item_id, status}` (enable=1/
disable=0) — **no price, no stock field on the item-attach call at all.** One
documented failure mode: `bundle.bundle_deal_no_shipping_channel` ("This
product does not set shipping channel").

**Verdict: bundle deal is unambiguously a promotion (a purchase-quantity
discount rule) applied over pre-existing item listings, never a bundled SKU
with its own derived stock.** Nothing in `add_bundle_deal`/`add_bundle_deal_item`/
`get_bundle_deal` mentions a new item_id, a new stock pool, or stock
aggregation across the bundle's components.

### 2c. Add-on Deal (`v2.add_on_deal.*`)

`add_add_on_deal`: `promotion_type` is **0 = "add on discount", 1 = "gift with
min spend"**; fields `purchase_min_spend`, `per_gift_num`,
`promotion_purchase_limit`. Same shape confirmed by `get_add_on_deal`'s
response, which additionally exposes `sub_item_priority` (ordering of add-on
sub-items) and a `source` field (undocumented meaning beyond the field name —
UNKNOWN). Again: **a rule attaching existing "main"/"sub" items
(`add_add_on_deal_main_item`/`add_add_on_deal_sub_item`, present in the module
index but not individually read for this survey), not a bundled SKU.**

### 2d. Shop Flash Sale (`v2.shop_flash_sale.*`) — stock reservation

`get_item_criteria`: returns eligibility rules per category (`min_product_rating`,
`min_likes`, `must_not_pre_order`, `min_order_total`, `max_days_to_ship`,
`min_repetition_day`, `min_promo_stock`/`max_promo_stock`,
`min_discount`/`max_discount`, `min_discount_price`/`max_discount_price`,
`need_lowest_price`) plus `overlap_block_category_ids` ("Due to regulations, the
promotion of some products in these categories are prohibited in this region" —
BR-relevant, exact category ids UNKNOWN without a live category tree).

`add_shop_flash_sale_items`: each item/model entry requires `stock` (min 1) —
description: **"Campaign Stock, Campaign stock can only be reserved from
either Shopee stock or Seller stock."** A documented failure:
`"err_msg":"This item cannot be added as there is insufficient stock."` —
**confirms flash-sale enrollment reserves stock out of the seller's existing
stock pool; it does not create separate inventory.**

### 2e. Does a promotion reserve stock, and how does that interact with a
periodic `update_stock` push?

Yes — and the docs are explicit and consistent across three separate sources:

1. **`push 6` (`item_promotion_push`)**, "Push logic": *"1. When the item was
   added in promotion, the normal stock will deduct the stock set by the
   promotion stock, At this time, the promotion stock is also reserved_stock.
   action will return promo_lock_stock. 2. When the promotion ends or
   promo_cancelled, the remaining promotion stock will be added back to the
   normal stock."* — i.e. Shopee **splits** total stock into
   normal-stock + reserved_stock while a promo (flash_sale and other types
   listed in `promotion_type`) is active, and returns it on
   end/cancel.
2. **`push 5` (`reserved_stock_change_push`)** fires on every order
   placed/cancelled against the reserved pool (`action`:
   `place_order`/`cancel_order`), with the exact `old`→`new` delta of
   `reserved_stock` per `item_id`/`variation_id`, tagged with `promotion_type`
   (`flash_sale`, `bundle_deal`, `add_on_deal_main`, `add_on_deal_sub`,
   `seller_discount`, `group_buy`, `Campaign`, several `product_promotion_<CC>`
   region variants, live-streaming variants, etc.) and `promotion_id`.
3. **`v2.product.update_stock`**'s own definition states: *"Whenever there is a
   promotion ongoing or upcoming, the total stock must be larger than or equal
   to real-time 'reserved_stock' promotion stock."* Its error list confirms
   this is enforced, not advisory — a periodic ERP stock push **can be
   rejected or must be clamped**:
   - `"Total stock must be more than reserved stock."` (`error_auth`)
   - `"Can not update item with stock less than reserved stock"` (`error.param`)
   - `"Can not update item with stock less than reserve stock"` (`error_param`,
     near-duplicate wording — two separate error entries in the doc)
   - `"Stock should be larger than reserved stock."` (`error_auth`)
   - Separately, and seemingly a *stricter* blanket rule for at least some
     promotion states: `error_cannt_edit_stock_in_promotion` /
     `error_promotion_cantnot_update_stock`: *"Normal_stock cannot be edited
     when item is under promotion."* / *"Cannot change stock when item is
     under promotion."* **This reads as a flat block, not just a floor-clamp
     against `reserved_stock` — the doc does not reconcile these two framings
     (floor vs. outright block) into one rule; which applies for which
     promotion type/state is UNKNOWN from the docs as written.**
   - Also unrelated-but-adjacent stock-blocking conditions on the same
     endpoint: `error_holiday_mode_change_stock` ("Cannot change stock in
     holiday mode" — see Part 3) and FBS-specific
     (`"the current item belong to the full FBS shop, so normal stock must be
     equal to 0"`).

   **Practical implication for the ERP's periodic stock sync: `update_stock`
   is not a blind overwrite while any promotion touches the item — it can
   fail outright, and the safe total to send is `own_stock_estimate +
   reserved_stock` (read via `get_item_promotion`/`reserved_stock_change_push`),
   never a value that ignores the active reservation.**

### 2f. Does a running discount change what `update_price` does?

Yes — **`original_price` is explicitly locked while a promotion is active**,
independent of the update_stock findings above. From `v2.product.update_price`'s
error list:
- `error_cannt_edit_price_in_promotion`: *"Original_price cannot be edited
  when item is under promotion."* (listed twice, i.e. applies at both item and
  model granularity in the doc's error catalogue)
- `error_in_item_promotion_item_price_lock`: *"Can't update price when item is
  under promotion."*
- `error_cannot_update_price_in_promotion`: *"Price cannot be changed when
  model is under promotion."*
- A related but distinct error, `error_related_product_in_promotion`: *"Asku
  has upcoming or ongoing promotion, can't update global product price… pls
  update price in shop sku"* — global-product-vs-shop-sku price editing has
  its own promotion carve-out (only relevant if this ERP ever uses Shopee's
  global-product feature; UNKNOWN whether it will).

**So: a seller-side price sync from the ERP must check for an active/upcoming
promotion on the item before calling `update_price`, or expect the call to be
rejected outright while the promo runs — this mirrors the update_stock
constraint in 2e (price is locked, stock has a floor) but they are two
independently-enforced rules, not one.**

### 2g. `get_item_promotion` — what it returns per model

`item_id_list` (1–50) → per item, `promotion[]` list, each entry:
`promotion_type`, `promotion_id`, `model_id`, `start_time`, `end_time`,
`promotion_price_info.promotion_price`, `promotion_staging` (**`ongoing` or
`upcoming`** — not itself telling you `ended`/`cancelled`; that transition is
what `push 7` communicates instead), and `promotion_stock_info_v2.
total_reserved_stock`. This is the read-side complement to the two pushes
above and the natural pre-check before calling `update_price`/`update_stock`.

## Part 3 — Account health and misc

All four Account Health reads are `type=Shop`, i.e. per-connected-shop.

| API | Paginated? | Notes |
|---|---|---|
| `get_shop_performance` | **No** `page_no`/`page_size` in request params — returns the full `metric_list` in one call | `overall_performance.rating`: 1=Poor…4=Excellent, plus per-type failed-metric counts (fulfillment/listing/customer-service). `metric_list[]` includes **Chat Response Rate (id 11), No. of Non-Responded Chats (id 23), Response Time (id 21), Average Response Time (id 29)** under "Customer Service Performance" — chat responsiveness is a scored account-health input, not merely cosmetic. |
| `get_listings_with_issues` | Yes (`page_no`+`page_size`≤100, default 10) | Per-listing `reason` code 1–7 (Prohibited/Counterfeit/Spam/Inappropriate Image/Insufficient Info/Mall Listing Improvement/Other) + `total_count` — directly usable for an ERP "listings with problems" screen. |
| `get_late_orders` | Yes (same shape) | `order_sn`, `shipping_deadline`, `late_by_days`, `total_count` — directly usable for an ERP "late orders" screen. |
| `get_penalty_point_history` | Yes (same shape) + optional `violation_type` filter | Huge `violation_type` enum (70+ codes) covering everything from late shipment to **chat behaviour** (`21` High No. of Non-responded Chat, `22` Rude chat replies, `3048` Chat Spam, `3074` Direct transactions outside Shopee platform via chat) and **review behaviour** (`24` Rude reply to buyer's review, `3052` Privacy breach in buyer's review reply) — ties Part 1's chat/comments surfaces directly into account-health scoring. Also `latest_point_num` vs `original_point_num` (post-appeal adjustment). |

**Verdict: `get_listings_with_issues` and `get_late_orders` are exactly the
"operational problem list" shape the ERP would want (paginated, actionable
item/order references), while `get_shop_performance` is a dashboard/scorecard
read (single call, no paging) and `get_penalty_point_history` is an audit-log
read (paginated, filterable by violation type).**

`push 31` (`shop_penalty_update_push`, category `[1003] Shopee Push`,
`push_code=28`) — *"Get notified when shop's penalty such as penalty point or
punishment tier are updated"* — `action_type`: 1=Penalty Point Issued,
2=Penalty Point Removed, 3=Punishment Tier Update; carries the same
`violation_type` enum, plus `tier_update_data.{old_tier,new_tier}` and, for
removals, `removed_reason` (Shopee System Error, 3PL issue, weather, special
exemption, etc.).

`v2.shop.get_shop_notification`: **paginated by cursor**, not
`page_no`/`page_size` (`cursor` = last `notification_id` seen; `page_size`
default 10, max 50). Doc: *"get Seller Center notification, the permission is
controlled by App type."* Returns `title`/`content`/`create_time`/optional
`url` — generic seller-center announcements, not scoped to any one domain
(promotions, health, policy, etc. all UNKNOWN split — the doc doesn't
categorize notification content).

`v2.shop.get_shop_holiday_mode`: **not paginated** (single shop-state read).
`holiday_mode_on`, `holiday_mode_type` (1=Partial — can still receive orders;
0=Full — cannot), `holiday_mode_start_time`/`end_time`, `holiday_mode_mtime`,
`holiday_mode_description`. Directly relevant to Part 2: `update_stock`'s own
error list includes `error_holiday_mode_change_stock`: *"Cannot change stock
in holiday mode"* — so an ERP's periodic stock push should check holiday mode
too, alongside the promotion-reserved-stock floor.

## Part 4 — Probing for hidden modules

| Name probed | Result |
|---|---|
| `v2.product.get_item_list` (control) | exists (full doc) |
| `v2.chat.get_conversation_list` | **does not exist** (`error_not_exists`) — confirms the real module is named `sellerchat`, not `chat` |
| `v2.livestream.get_session_detail` (control) | exists (full doc) |
| `v2.order.get_order_detail` (control) | exists (full doc) |
| `v2.logistics.get_shipping_document_parameter` (control) | exists (full doc) |
| `v2.payment.get_escrow_detail` (control) | exists (full doc) |
| `v2.product.get_size_chart_list` (no trailing space) | exists |
| `v2.product.get_size_chart_list ` (with trailing space) | exists — **resolves to the same API**; the API's own canonical name, as rendered from its doc record, itself carries a trailing space (`# v2.product.get_size_chart_list    [Product] …`), and it is listed that way (`v2.product.get_size_chart_list ` with trailing space) in the public module index too (`out_modules.txt` line 96) — this is a pre-existing quirk of Shopee's own docs data, not something this probe introduced, and it is **not** a hidden module (it's the documented Product-module size chart API). |

All five controls behave as expected (full docs, no gating), which validates
that the `error_not_exists` / `error_auth` distinction used throughout this
survey is meaningful and not an artifact of the fetch method.

**The one genuinely hidden (index-omitted but real) surface found in this pass
is the Sellerchat/Webchat module** (Part 1): 12 real, login-gated API doc pages
plus a real, fully-documented push category, none of it listed under
`node shopee-doc.mjs modules`.

## Summary of UNKNOWNs (docs do not say, without a login)

- `sellerchat` request/response param shapes for all 12 real endpoints
  (`send_message` shape, `get_conversation_list`/`get_message` shapes,
  `upload_image` constraints, `mute`/`pin`/`read`/`unread`/`delete`
  semantics, `send_autoreply_message` shape).
- Message length limits, reply-time windows/SLAs, attachment size/type limits.
- Whether `sellerchat` API *calls* (not just doc pages) require an extra
  approval step beyond standard OAuth, and if so what it is.
- Whether a "sticker" or "order" message type exists (only
  text/video/image/item/faq_liveagent are confirmed via `webchat_push`).
- Whether an "offer" (price negotiation) concept exists under some other name
  than `get_offer_detail`/`reply_offer` (those two specific names do not
  exist).
- Whether a public pre-sale Q&A distinct from private chat exists at all.
- Which exact category ids are in `overlap_block_category_ids` for BR flash
  sales.
- Whether the "stock floor" (`>= reserved_stock`) and the "blocked outright
  while under promotion" `update_stock` error families apply to different
  promotion types/states or are alternate wordings of the same rule — the
  docs give both without reconciling them.
- `get_shop_notification` content categorization (whether promotion/health/
  policy notifications are distinguishable by type — no type field documented).
