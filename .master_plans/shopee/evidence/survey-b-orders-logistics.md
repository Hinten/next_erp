# Shopee Open Platform v2 — Phase 0 survey (slice B)
### Orders · payments/escrow · logistics/labels/tracking · NF-e + BR masking · returns · order pushes

Every claim below carries a citation to a page actually read: `guide N`, `api <name>`, or `push N`.
Where the documentation does not answer the question, the line says **UNKNOWN — docs do not say**.
Nothing here is inferred from Mercado Livre or from any other integration.

Docs read (all fetched 2026-09-03 from `open.shopee.com/opservice/api/v1`):
guides **31** (V2.0 Data Definition — found during the survey, it is the authoritative enum page), **225, 227, 229, 286, 290, 292, 382, 383, 568, 677, 697**;
21 order/payment APIs, 24 logistics APIs, 11 returns APIs, pushes **1, 2, 17, 32, 33, 34, 44**.

> **Language note.** The helper's `pt-br` and `en` fetches return **byte-identical** content for all eleven
> guides (`diff` is empty). `language_code` is accepted but does not switch the body — the BR guides are
> authored in Portuguese and served as-is under both codes. So "try pt-br then en" is moot.

---

## 0. Two documentation hazards that colour everything below

**(a) The BR guides contradict the API reference, and the API reference is newer.** Three cases, all
load-bearing, detailed in their own sections:

| Claim | Source saying it | Source contradicting it |
|---|---|---|
| `upload_invoice_doc` is *not used* for BR integrations | `guide 383` §FAQ-1 | `guide 382` (whole guide is a BR walkthrough of it) + `api v2.order.upload_invoice_doc` ("for PH and **BR** local seller") |
| Send the NF-e with `v2.order.add_invoice_data` | `guide 292` §5 | **that API does not exist** — it is absent from the module listing for module 94 (Order) |
| FBS invoices "can only be downloaded via Seller Center" | `guide 568` §FAQ (updated 2024-11-18) | `api v2.order.generate_fbs_invoices` / `get_fbs_invoices_result` / `download_fbs_invoices` — all three "New API 2025-07-11" |

**(b) The enum authority is `guide 31`, not the per-API text — and even `guide 31` is incomplete.**
`ShippingDocumentType` in `guide 31` lists four values; the create/result/download APIs and `guide 677`
all accept a fifth, `THERMAL_UNPACKAGED_LABEL`, which `guide 31` never mentions.

---

## 1. Order model

### 1.1 `order_status` — the full enum

Verbatim from `guide 31` §OrderStatus (the only place with meanings attached):

```
UNPAID:            Order is created, buyer has not paid yet.
PENDING:           Order is pending and cannot proceed to shipment arrangement yet.
READY_TO_SHIP:     Seller can arrange shipment.
PROCESSED:         Seller has arranged shipment online and got tracking number from 3PL.
RETRY_SHIP:        3PL pickup parcel fail. Need to re arrange shipment.
SHIPPED:           The parcel has been drop to 3PL or picked up by 3PL.
TO_CONFIRM_RECEIVE: The order has been received by buyer.
IN_CANCEL:         The order's cancelation is under processing.
CANCELLED:         The order has been canceled.
TO_RETURN:         The buyer requested to return the order and order's return is processing.
COMPLETED:         The order has been completed.
```

That is **11** values. Three qualifications:

- **`INVOICE_PENDING` is a twelfth value that exists only as a `get_order_list` filter.** It is listed in
  `api v2.order.get_order_list` (`Available value: UNPAID/READY_TO_SHIP/PROCESSED/SHIPPED/COMPLETED/IN_CANCEL/CANCELLED/INVOICE_PENDING`)
  and `guide 383` §2 states it explicitly: *"Esse status atualmente aparece apenas na API v2.get_order_list"*.
  `guide 382` §⚠️Nota is even blunter — after uploading the NF-e the order **still reads `READY_TO_SHIP`** in
  `get_order_detail`; only the `get_order_list` filter changes behaviour. **So `INVOICE_PENDING` must never be
  stored as an order state read back from `get_order_detail` — it will never appear there.**
- **`PENDING` is opt-in.** Both `get_order_list` and `get_order_detail` take
  `request_order_status_pending` (boolean): *"Compatible parameter during migration period, send True will let
  API support PENDING status and return `pending_terms`, send False or don't send will fallback to old logic"*
  (`api v2.order.get_order_detail`). Sending `false`/omitting it means Shopee maps pending orders onto some
  other status — **which one is UNKNOWN — docs do not say**.
  `pending_terms` values: `SYSTEM_PENDING`, `KYC_PENDING` (TW CB only), `ARRANGE_SHIPMENT_PENDING`
  ("Temporarily held due to 3PL capacity constraints … Label print will be available within 4 days after buyer paid").
- **`guide 383` §"Status das orders" is unreliable.** It announces *"8 diferentes status"* then lists **9**;
  it spells `SHIPPED` as "SHIPEED"; and its OpenAPI↔SellerCenter comparison table is **misaligned by rows** —
  it maps `TO_RETURN`→"Enviado", `TO_CONFIRM_RECEIVE`→"Devolução Reembolso", `COMPLETED`→"Shipping (Shipped)",
  which is self-evidently wrong against `guide 31`. Use `guide 31`.

**Terminal statuses.** `CANCELLED` and `COMPLETED` are the two end states in `guide 31`'s wording
("has been canceled" / "has been completed"). But **`COMPLETED` is not final in practice**: `push 1`
carries `completed_scenario` precisely because a return/refund can be raised *after* completion —
`NORMAL` = "The order has been completed", `RRAOC` = "The whole RRAOC (raise return&refund after order
completed) progress has been completed" (`push 1`). `get_order_detail` reinforces this with
`return_request_due_date`, returned only when *"The status of the order is COMPLETED"* and the order is
return-eligible. So an order can move `COMPLETED` → (return flow) → `COMPLETED`+`RRAOC` and its escrow can
change afterwards. **Treat `COMPLETED` as settled-but-revisable, not immutable.**
There is **no state diagram in text** — `guide 229` §2 and §3 are `[image]` only, so the exact legal
transitions are **UNKNOWN — docs do not say**.

### 1.2 ⚠️ `get_order_detail` and `get_package_detail` can disagree on the same order

`guide 697` §"Arrange Shipment", for Entrega Expressa:

> "order_status will be updated to PROCESSED status after arranging shipment, and will be returned in
> get_package_detail API. **get_order_detail order_status will still return READY_TO_SHIP.**"

Corroborated independently by `api v2.logistics.ship_order` §Update log, `2025-09-18`:
*"Updated description to indicate the order_status logic of BR Seller Logistics channel
(logistics_channel_id: 90021) and BR Instant Delivery channel (logistics_channel_id: 90026)"* — note the
changelog announces a description change that **is not present in the current description text**, so the
only surviving statement of this behaviour is in `guide 697`.

Caveat on the wording: `get_package_detail` has **no `order_status` field at all** (its package-level state
field is `fulfillment_status`). So `guide 697` names a field that does not exist on the endpoint it cites.
The substance — *for BR channels 90021/90026, `get_order_detail.order_status` stays `READY_TO_SHIP` after a
successful `ship_order`* — is what the two sources agree on. **A poller that decides "did my ship_order land?"
from `get_order_detail.order_status` will conclude "no" forever on these channels and re-ship.**
The reliable signal is package-level `fulfillment_status` plus `is_shipment_arranged` (§5.4).

### 1.3 Order detail shape — items and prices

`api v2.order.get_order_detail`, `response.order_list[].item_list[]`, the fields that matter for an ERP:

```
item_id (int64), item_name, item_sku          ← "parent SKU", seller-defined
model_id (int64), model_name, model_sku       ← variation-level, seller-defined
model_quantity_purchased (int32)
model_original_price (float)
model_discounted_price (float)
weight (float)
order_item_id (int64)    ← SAME id shared by all items of one bundle deal
line_item_id (int64)     ← unique per order item even inside a bundle (added 2026-07-17)
promotion_group_id (int32), promotion_type, promotion_id
promotion_list[] { promotion_type, promotion_id }
add_on_deal (bool), add_on_deal_id, main_item (bool), wholesale (bool)
image_info { image_url }
product_location_id (string)   ← multi-warehouse
active_qty / cancel_requested_qty / cancelled_qty / return_requested_qty / returned_qty (int32)
```

**Are the prices per unit or line totals? Line totals.** Both `model_original_price` and
`model_discounted_price` are documented identically: *"It returns the subtotal of that specific item if
quantity exceeds 1."* (`api v2.order.get_order_detail`; the same sentence appears on `original_price`,
`selling_price` and `discounted_price` in `api v2.payment.get_escrow_detail`). So for `quantity = 3` the
field is the **line total, not the unit price** — dividing is the caller's job.

⚠️ **`model_discounted_price` is `0` for bundle-deal items — by design, not as an error.**
*"In case of bundle deal item, this value will return 0 as by design bundle deal discount will not be
breakdown to item/model level. Due to technical restriction, the value will return the price before bundle
deal if we don't configure it to 0. **Please call GetEscrowDetails if you want to calculate item-level
discounted price for bundle deal item.**"* (`api v2.order.get_order_detail`). A naive "revenue = sum of
`model_discounted_price`" therefore reports **zero** for a bundle order.

Order-level: `total_amount` (float) — *"This value will only return after the buyer has completed payment"*,
`currency`, `cod` (bool), `estimated_shipping_fee`, `actual_shipping_fee` +
`actual_shipping_fee_confirmed` (bool), `reverse_shipping_fee`, `order_chargeable_weight_gram`.

**Fulfilment-mapping bundles (whitelisted shops only).** `is_fulfillment_mapping` / `bundle_sku_id` /
`components[] { parent_sku_id, barcode_upc, quantity, warehouse_id, mapping_type }` — the component
explosion of a Shopee-side bundle SKU, "used by WMS/ERP for physical picking". `mapping_type`: `1: Group`,
`2: Lucky bag`, `3: Mapping List`. Returned **only if the shop is whitelisted** and
`is_fulfillment_mapping` is true (`api v2.order.get_order_detail`, added 2026-08-27).

### 1.4 `package_list` — can one order have several packages? can several orders share one shipment?

**Both, yes.** `guide 229` §1 defines the entities verbatim:

> "Order: Created after checkout. 1 order can contain multiple items.
> **Package**: Created after the order is generated. It represents the unit for shipment. **1 order can be
> split into multiple packages, and 1 package can contain multiple items.**"

And several orders *can* share one parcel: `package_list[].group_shipment_id` (int64) —
*"The common identifier for **multiple orders combined in the same parcel**"* (`api v2.order.get_order_detail`
and `api v2.order.get_package_detail`). See §10 for what this does and does not let you do.

`package_list[]` per-package fields: `package_number` (string), `logistics_status`,
`logistics_channel_id` (int64), `shipping_carrier`, `allow_self_design_awb` (bool),
`item_list[] { item_id, model_id, model_quantity, order_item_id, promotion_group_id, product_location_id }`,
`parcel_chargeable_weight`, `group_shipment_id`, `sorting_group` (TW 30029).

⚠️ **`package_list` is an optional field** — it is in the `response_optional_fields` list, so an order fetched
without asking for it comes back with **no packages at all**, not an empty array with a warning.

### 1.5 Timestamp units

**All order/logistics/returns timestamps are UNIX seconds, not milliseconds.** `guide 31` §Basic Data Type
is explicit: `timestamp: uint32`. A uint32 of milliseconds would overflow in 1970, so the type alone
settles it. Corroborated by every sample value read: `create_time: 1712601591`, `update_time: 1713139948`,
`pay_time: 1712817766`, `pickup_done_time: 1712726577`, `ship_by_date: 1712671200`
(`api v2.order.get_order_detail` response sample) — all ten-digit second timestamps.
`pickup_done_time` is documented as *"The timestamp when pickup is done"* and its sample default is `0`
(not null) when not yet picked up.
Pushes are the same: `push 1` `update_time: 1660123127`, `push 44` `ship_by_date: 1764746165`.
The one type inconsistency is cosmetic: `get_package_detail` declares `update_time`, `ship_by_date`,
`pickup_done_time` as `int64` while `get_order_detail` declares the same concepts as `timestamp`;
both carry seconds.

### 1.6 `response_optional_fields` — what must be asked for explicitly

Verbatim from `api v2.order.get_order_detail`:

```
buyer_user_id, buyer_username, estimated_shipping_fee, recipient_address, actual_shipping_fee,
goods_to_declare, note, note_update_time, item_list, pay_time, dropshipper, dropshipper_phone,
split_up, buyer_cancel_reason, cancel_by, cancel_reason, actual_shipping_fee_confirmed,
buyer_cpf_id, fulfillment_flag, pickup_done_time, package_list, shipping_carrier, payment_method,
total_amount, buyer_username, invoice_data, order_chargeable_weight_gram, return_request_due_date,
edt, payment_info, international_label
```

(`buyer_username` appears **twice** in Shopee's own list — harmless, but a hint at how the list is maintained.)

⚠️ **`item_list` is optional.** So is `recipient_address`, `buyer_cpf_id`, `invoice_data`, `package_list`,
`payment_info`, `total_amount`. An unspecified call returns a nearly useless order. `guide 229` §9 FAQ
confirms this is the #1 support question: *"Call get_order_detail API, many response fields are missing,
what should I do? — Please check whether the response_optional_fields field is selected."*
Note the FAQ calls the parameter `response_optional_fields` in one sentence and **`response_optional_field`**
(singular) elsewhere in `get_order_detail`'s own `is_international` description — the correct name is the plural.

**Returned by default** (no request needed), per the "Return by default" markers: `order_sn`, `region`,
`currency`, `cod`, `order_status`, `message_to_seller`, `create_time`, `update_time`, `days_to_ship`,
`ship_by_date`, `booking_sn`.

### 1.7 Batch limits and paging

- **`get_order_detail`: `order_sn_list` limit `[1,50]`**, comma-joined (`api v2.order.get_order_detail`).
- **`get_order_list` paging is cursor-based**: `cursor` in, `next_cursor` + `more` out; `page_size` 1–100.
- **Time window: 15 days max.** *"The maximum date range that may be specified with the time_from and
  time_to fields is 15 days."* `time_range_field` is **REQUIRED** and takes `create_time` or `update_time`
  (`api v2.order.get_order_list`). For an incremental sync, `update_time` is the one that catches
  status changes on old orders.
- **Yes, it filters by status** — `order_status`, one value per request:
  `UNPAID/READY_TO_SHIP/PROCESSED/SHIPPED/COMPLETED/IN_CANCEL/CANCELLED/INVOICE_PENDING`.
  ⚠️ Note this filter list **omits** `PENDING`, `RETRY_SHIP`, `TO_CONFIRM_RECEIVE` and `TO_RETURN`, which
  are legal `order_status` values from `guide 31`. **There is no documented way to list orders in those four
  states** — you reach them by fetching detail on order_sns found some other way (an `update_time` sweep, or
  a push). Whether the filter silently accepts them is **UNKNOWN — docs do not say**.
- `logistics_channel_id` filter on `get_order_list` is **"Valid only for BR"** — `guide 568` names `91007`
  as the Fulfilled-by-Shopee channel to filter on.
- `get_order_list` returns `order_sn` + optionally `order_status` and `booking_sn` — **nothing else**, so a
  two-step list→detail fan-out at 50/call is mandatory.

---

## 2. Buyer identity in Brazil

### 2.1 `recipient_address`

```
name, phone, town, district, city, state, region (2-letter), zipcode, full_address,
geolocation { latitude, longitude }   ← "Only available for logistics_channel_id 90026"
```

*"Different parameters might be masked according to each market and kind of seller."*
(`api v2.order.get_order_detail`). The VN response sample shows what masking looks like on the wire —
**not nulls, but partially-starred strings**:

```json
"recipient_address": {
  "city": "Huyện Phước Long", "district": "Xã Phong Thạnh Tây B",
  "full_address": "Ấp******", "name": "P******n", "phone": "******64",
  "region": "VN", "state": "Bạc Liêu", "town": "", "zipcode": ""
}
```

`api v2.order.get_package_detail` samples the fully-masked form: `name: "b***r"`, `phone: "******78"`,
`city/state/region/zipcode: "****"`, `full_address: "******11"`.
**A masked field is a non-empty string that parses as a valid value** — length checks and truthiness both
pass. Anything downstream that treats "has a name" as "has a usable name" will silently ship `P******n`
onto a label.

### 2.2 CPF/CNPJ — where it lives

**`buyer_cpf_id`** on `get_order_detail`: *"Buyer's CPF number for taxation and invoice purposes. **Only for
Brazil order.**"* It is an **optional** response field — it must be named in `response_optional_fields`.
The response sample shows `"buyer_cpf_id": null` (a VN order).

Two candidates ruled out:
- **`get_buyer_invoice_info` does NOT serve Brazil.** *"API to obtain buyer submitted invoice info for
  **VN, TH and PH** local sellers only."* (`api v2.order.get_buyer_invoice_info`). Same for
  `get_pending_buyer_invoice_order_list`: *"only for PH and BR local sellers"* — that one **does** include BR,
  but returns only `order_sn`, no buyer data.
- **`invoice_data` is the NF-e you uploaded**, not buyer identity — `{ number, series_number, access_key,
  issue_date, total_value, products_total_value, tax_code, status, pending_reason }`.

### 2.3 Masking rules — exactly what unmasks and when (`guide 382`)

`guide 382` §"Dados Necessários do Comprador para Emissão de NF-e", effective **28 December**
(year not stated in the text):

**Seller CPF (individual):**
- Only the buyer's **Endereço** (address) is available, and only for orders in
  `READY_TO_SHIP`, `PROCESSED`, and `RETURN/REFUND` ("TO_SHIP" and "R/R" in Seller Center).
- **Nome, telefone and CPF are never available, in any order status** — *"pois não é necessário"*.

**Seller CNPJ (company):**
- **Nome, Endereço and CPF** are available for orders in
  `INVOICE_PENDING`, `READY_TO_SHIP`, `PROCESSED`, and `RETURN/REFUND`.
- **Telefone is never available, in any order status.**

So: **the buyer's CPF is obtainable only by a CNPJ seller, and only in those four states.** A CPF seller
never sees it. And `INVOICE_PENDING` — the one state in which you actually need the CPF to emit the NF-e —
is, per §1.1, **a `get_order_list` filter that never appears in `get_order_detail`**; you fetch detail for
those order_sns while the order still reads `READY_TO_SHIP`.

⚠️ **A second, undocumented-in-382 gate: the IP whitelist.** `guide 290` §FAQ-3, on masked data in
`get_order_detail`:

> "b) **If the IP Whitelist (from the Open Platform Console) is not filled in at the APP level, the data can
> be masked**, once filled in, it should automatically be available (as long as it is in the correct status)."

That is an Open Platform Console configuration step with **no API and no error signal** — the data simply
comes back starred, exactly as it would for a legitimately-masked order. `guide 290` §FAQ-3(a) also gives a
*narrower* status list than `guide 382` — *"only made available when the order is in **READY_TO_SHIP and
TO_RETURN** status"* — omitting `PROCESSED` and `INVOICE_PENDING`. The two guides disagree; `guide 382` is
the NF-e-specific one and is the more recent (2026-07-19 vs 2026-07-19, same date, different lists).
**Treat the intersection as safe and expect masking anywhere else.**

Note also `guide 382`'s stated purpose for the rule: *"Essa nova regra não deve afetar os atuais fluxos da
order pois os dados não são obrigatórios para nenhuma etapa do processo."* — Shopee's position is that no
API step *requires* buyer identity. NF-e emission does, which is the tension the whole guide exists to manage.

### 2.4 Are `buyer_user_id` / `buyer_username` stable across orders?

**UNKNOWN — docs do not say.** Neither field carries any statement about cross-order stability.
What the docs *do* say: `buyer_user_id` (int64) is *"The user id of buyer of this order, will be empty if it
is a non-integrated order in TW region"*; `buyer_username` is *"The name of buyer, will be masked as '****'
if it is a non-integrated order in TW region"* (`api v2.order.get_order_detail`). Both are optional fields.
`api v2.payment.get_escrow_detail` returns `buyer_user_name` (note the **different spelling** —
`buyer_user_name` with an underscore, vs `buyer_username` on the order) with no id at all.
`api v2.returns.get_return_detail` returns `user { username, email, portrait }` — a masked email
(`********oo@shopee.com`), no id.
**No documented stable buyer key exists for BR.** The only identity anchor the docs promise for Brazil is
`buyer_cpf_id`, which is unavailable to CPF sellers and masked outside four states.

---

## 3. Money / settlement

### 3.1 Is there a payment event?

**No dedicated payment push exists.** The Order Push category (`push-list`, category 1001) contains
`order_status_push`, `order_trackingno_push`, `shipping_document_status_push`, `booking_*`,
`package_fulfillment_status_push`, `courier_delivery_binding_status_push`, `package_info_push` —
**no payment or escrow push anywhere in any category**. Payment is observed as a status transition:
`pay_time` is *"The time when the order status is updated from **UNPAID to PAID**. This value is NULL when
order is not paid yet"* (`api v2.order.get_order_detail`).

Note "PAID" is **not** a value in the `order_status` enum — `guide 31` describes the transition as
*"order status changed from 'Paid' to 'Completed'"* on `update_time`, but no `PAID` state is listed. In
BR terms `guide 383` §3 resolves it: `READY_TO_SHIP` means *"orders Correios que já tiveram sua confirmação
de pagamento, ou para orders não correios onde os dados de invoice já foram enviados com sucesso"* — i.e.
`READY_TO_SHIP` conflates "paid" (Correios) with "paid **and** invoiced" (everything else). **The correct
payment signal is `pay_time` being non-null, not the status.**

### 3.2 `get_escrow_detail` — shape

`api v2.payment.get_escrow_detail`, request: **`order_sn` (single, required)**. Response:

```
response {
  order_sn, buyer_user_name, return_order_sn_list[],
  order_income { …~90 fields… , items[] { …per-item… } },
  buyer_payment_info { …checkout snapshot… }
}
```

**All amounts are JSON numbers (`float`), not strings** — confirmed by both the type column and the response
sample (`"escrow_amount": 100`, `"commission_fee": 0.1`, `"final_shipping_fee": -10`). Note `100` and `-10`
serialise **without a decimal point**, and `final_shipping_fee` can be **negative** by design
(*"This amount could be negative or positive"*).

**Both per-order and per-item.** Order level carries the ~90 aggregate fields; `order_income.items[]` gives
the per-item breakdown: `item_id, item_name, item_sku, model_id, model_name, model_sku, line_item_id,
original_price, selling_price, discounted_price, seller_discount, shopee_discount, discount_from_coin,
discount_from_voucher_shopee, discount_from_voucher_seller, activity_type, activity_id, is_main_item,
quantity_purchased, ams_commission_fee, promotion_list[]`.

The fields the question names, verbatim:
`commission_fee`, `service_fee`, `seller_transaction_fee`, `buyer_transaction_fee`,
`buyer_paid_shipping_fee`, `actual_shipping_fee`, `estimated_shipping_fee`, `final_shipping_fee`,
`escrow_amount`, `buyer_total_amount`, `seller_discount` / `order_seller_discount`,
`voucher_from_seller` / `voucher_from_shopee` / `voucher_from_external_party`, `coins`,
`seller_coin_cash_back`, `shopee_shipping_rebate`, `reverse_shipping_fee`, `seller_lost_compensation`,
`drc_adjustable_refund`, `seller_return_refund`, `cost_of_goods_sold`, `original_cost_of_goods_sold`.

`escrow_amount`'s own formula is given in full in the doc — a 40-term subtraction chain — and is prefaced
*"the total amount that the seller is expected to receive for the order and **will change before order is
completed**"*. So escrow is a **moving number**, not a settlement.

**BR-only fields worth naming** (all `api v2.payment.get_escrow_detail`):
- `is_kit` (bool) + `kit_items { original_product_id, original_model_id, total_qty, original_price,
  proportional_price }` — *"only applicable for BR local seller"*. This is Shopee's kit explosion with a
  **proportional price allocation** already computed. (Field names were **renamed on 2026-07-17** from
  `mt_item_id`/`mt_model_id`/`parent_item_price`/`item_price_prorated` — anything written against older docs
  is broken.)
- `net_commission_fee` / `net_service_fee` + `net_commission_fee_info_list[] { rule_id, fee_amount,
  rule_display_name }` / `net_service_fee_info_list[] { …, category }` — *"only for BR local sellers"*, the
  fee **after** proportional rebate deduction.
- `seller_product_rebate { amount, commission_fee_offset, service_fee_offset }` — BR only.
- `pix_discount`, `prorated_pix_discount_offset_return_items`, `remaining_voucher` — BR only.
- `buyer_payment_info.icms_tax_amount`, `.iof_tax_amount`, `.discount_pix` — BR only.
- *"buyer instant fee"* field added for BR local shops 2026-08-28 (named only in the changelog).

### 3.3 When does escrow become available?

**UNKNOWN — docs do not say**, at least not directly. `api v2.payment.get_escrow_detail` states no
precondition status and its error list has no "not yet available" entry. Two indirect anchors:
- `escrow_amount` *"will change before order is completed"* — so it is readable **before** completion, but
  not final.
- `api v2.payment.get_escrow_list` is keyed on **`escrow_release_time`** (`release_time_from`/`_to`,
  both REQUIRED) and returns `{ order_sn, payout_amount, escrow_release_time }`. An order appears in that
  list only once released. **That list is the reliable "money is final" signal**, and it is the only place
  `escrow_release_time` is exposed — `get_escrow_detail` does not return it.

### 3.4 Paging and batching quirks in the payment module

- `get_escrow_detail` — **one order per call**, no batching.
- `get_escrow_detail_batch` — `order_sn_list` limit `[1,50]`, but *"The number of **recommended** requests
  ranges from 1 to 20 orders."* (so 50 is allowed and 20 is advised).
- `get_escrow_list` — **`page_no`/`page_size`, not cursor** (max 100, default 40), window on
  `escrow_release_time`, no stated max span. This is a **different paging idiom from `get_order_list`**,
  which is cursor-based. Both live one module apart.
- ⚠️ **`get_payout_detail` and `get_billing_transaction_info` are Cross-Border-only.** Both open
  *"This API is applicable for **Cross Border (CB) sellers only**"*. **Neither is usable by a BR local seller.**
  `get_payout_detail` additionally caps `payout_time_from`/`_to` at 15 days.
- `get_payment_method_list` — *"no authentication required"*, returns `[{ payment_method[], region }]`.
  The response sample shows ID/MY/PH/SG blocks; whether a `BR` block exists is **UNKNOWN — docs do not say**.
  `guide 31` §PaymentMethod lists per-region methods and its excerpt shows no BR entries either.

---

## 4. NF-e (Brazil)

### 4.1 The upload API

`api v2.order.upload_invoice_doc` — *"This endpoint is for **PH and BR** local seller. Upload the invoice document"*.

```
POST /api/v2/order/upload_invoice_doc      (multipart/form-data)
  order_sn   (string, REQUIRED)
  file_type  (int,    REQUIRED)   1:pdf  2:jpeg  3:png  4:xml
  file       (file,   REQUIRED)   File size limit to 1MB.
```

- **XML is `file_type = 4`**, and that is what `guide 382` §"Adicionando o Invoice" instructs for BR:
  *"file_type: o tipo de arquivo, que para XML é '4'"*, with a working cURL using `--form`.
- ⚠️ **The API reference's own metadata contradicts its description**: `file_type` carries
  `limits: [1,2,3]` while the description enumerates `1:pdf 2.jpeg 3.png. **4.xml**`. The limits field is
  stale; `guide 382` confirms 4 works. Do not let a schema generated from `limits` reject the only value BR needs.
- **Size limit: 1 MB.** One call carries **one `order_sn` and one file** — so it is **one per order**, not
  per package. There is no package_number parameter.
- **Do not call it immediately.** *"Solicitamos que essa API seja chamada com um **delay de 5 minutos** após a
  criação da NF-e. Por conta da nova validação na SERPRO, é necessário que a NF-e esteja válida no sistema
  deles."* (`guide 382`). Shopee validates the key against SERPRO; a freshly-authorised NF-e is not yet there.
- The response is `{ request_id, error, message }` — **no invoice echo, no id**. Confirmation requires a
  follow-up `get_order_detail` with `response_optional_fields=invoice_data`.

### 4.2 When must it be uploaded, relative to shipping?

**Before `ship_order`.** `guide 292` §5: *"Nos casos em que for necessário, a NF-e deve ser informada **antes
da chamada v2.logistics.ship_order**."* And `guide 383` §3 explains the state machine: an order reaches
`READY_TO_SHIP` — the only status from which `ship_order` is legal — either because it is a Correios order
that got paid, **or** because *"os dados de invoice já foram enviados com sucesso"*. So for non-Correios BR
orders the NF-e upload is what *unlocks* shipping. It therefore also precedes `create_shipping_document`,
which requires a tracking number, which requires `ship_order`.

⚠️ **Correios orders cannot take an NF-e at all.** `guide 292` §FAQ: *"Pedidos dos Correios não possuem a
função para informar a NF-e."* Attempting it returns error #11 (§4.4): *"The invoice status is invalid to
upload invoice data"*, whose stated fix is *"basta organizar o envio da order através do endpoint
v2.logistics.ship_order"* — i.e. **skip the upload and ship**. `guide 382`'s opening sentence frames the
whole rule: NF-e is required for CNPJ sellers *"exceto para pedidos com o parceiro logístico que não tem
suporte a Nota Fiscal, como por exemplo o Correios."*

### 4.3 Pending-invoice list semantics

Two different mechanisms, both documented:

1. **`get_order_list` with `order_status=INVOICE_PENDING`** — `guide 382` §"Verificando pedidos que precisam
   da NF-e" and `guide 292` §5 both recommend this. Returns bare `order_sn`s. This is the BR path.
2. **`api v2.order.get_pending_buyer_invoice_order_list`** — *"only for PH and BR local sellers only"* [sic],
   cursor + `page_size` 1–100, returns `{ more, next_cursor, order_list[{ order_sn }] }`.
   ⚠️ But **`guide 383` §FAQ-1 explicitly lists this API among those "que não são usadas para integrações no
   Brasil"** — alongside `upload_invoice_doc`, which the rest of the BR documentation is built on. The FAQ
   is not trustworthy (§0a); the API's own text says BR is in scope.

**Verifying an upload landed:** `get_order_detail` with `response_optional_fields=invoice_data`.
`guide 382` gives both shapes verbatim — populated (`{number, series_number, access_key, issue_date,
total_value, products_total_value, tax_code}`) versus **`"invoice_data":{}` — an empty object, not null**,
when no NF-e is attached. ⚠️ **`if (invoice_data)` is true for the empty case.** Check `access_key`.
(`get_order_detail`'s own sample shows a third form, `"invoice_data": null`, for a non-BR order — so the
field is tri-valued: `null`, `{}`, or populated.)
As noted in §1.1, **`order_status` does not change after a successful upload** — it stays `READY_TO_SHIP`
both before and after; only the `get_order_list` filter reflects it (`guide 382` §⚠️Nota).

### 4.4 Upload validation errors (`guide 382`, 17 cases)

The value of this list is that most of these are *configuration* mismatches, not payload bugs:

| # | Error message | Cause |
|---|---|---|
| 1 | `Invalid CNPJ. The access key CNPJ must be the same as the registration.` | NF-e issuer CNPJ ≠ CNPJ registered at Shopee |
| 2 | `Invalid UF. The access key UF must be the same as the registration.` | issuer UF ≠ registered UF |
| 3 | `Invalid State Registration Number…` | inscrição estadual mismatch |
| 4 | `Don't support Invoice Issuer now, please switch Shop Default to upload invoice.` | seller chose **Shopee** as Invoice Issuer; fix in Seller Center → Shop Profile → Invoice Setting → Edit → Other |
| 5 | `Invalid NF-e.` | not valid — **or valid but <5 min old** (retry after 5 min) |
| 6 | `Canceled NF-e.` | NF-e was cancelled |
| 7 | `Access Key duplicated, please do not use duplicated Access Key.` | that key is already on another order |
| 8 | `access_key must be 44 characters in length.` | wrong key length |
| 9 | `access_key is a required field.` | key missing from request |
| 10 | `Invalid issue date. The NF-e issue date cannot be greater than the current date.` | future-dated emission |
| 11 | `The invoice status is invalid to upload invoice data.` | **Correios (or other non-NF-e carrier), or the order is cancelled** |
| 12 | `Invalid access key.` | key invalid |
| 13 | `order_sn is a required field.` | |
| 14 | `Invalid NF-e model. Only model 55 is accepted.` | XML `mod` ≠ 55 |
| 15 | `CFOP invalid, please confirm it` | see the allow-list below |
| 16 | `Please upload a valid Invoice XML file` | not well-formed XML |
| 17 | `File Error` | XML lacks the `<?xml version="1.0" encoding="UTF-8"?>` declaration (Shopee notes this check was to be dropped from 2024-04-01) |

⚠️ **Errors 8, 9 and 12 all name `access_key` as a request field — but `upload_invoice_doc` has no
`access_key` parameter.** Its three parameters are `order_sn`, `file_type`, `file`. Shopee is parsing the key
out of the uploaded XML and reporting it as if it were a field. These messages are also the fingerprint of
the older `add_invoice_data`-style API that `guide 292` still cites (§0a) and which no longer exists.

**The CFOP allow-list** (error 15) — the only accepted values, verbatim:
```
6108 6102 5102 6107 6101 5101 5405 6404 6403 6106 5403 5106 6104 6109 6115 6103 6105 6401 5115
6120 5103 5105 5104 5109 6402 5120 6118 5401 5402 5112 5114 6112 5117 6117 5118 6113 6114 6119
5111 6123 6116 5116 5119 5113 6111
```
(45 values. Model **55 only**.)

### 4.5 The NF-e total — Shopee's own formula

`guide 382` §"Cálculo para Emissão de NF-e", from `get_escrow_detail`:

```
Valor total da NF = original_price − seller_discount − discount_from_voucher_seller + buyer_paid_shipping_fee
```

with the caveat *"isso é apenas uma das formas de calcular o valor da NF, caso seu time Fiscal apresente
outra forma, não necessariamente estará incorreta."*
⚠️ Note the formula **mixes scopes**: `original_price` and `seller_discount` exist at *both* order level and
inside `items[]`, while `discount_from_voucher_seller` exists **only per item** and `buyer_paid_shipping_fee`
**only at order level**. The guide does not say which level to read. Also note `guide 292` §FAQ adds a
validation Shopee performs that the formula does not mention: *"Se a data da NF-e é posterior à data de
pagamento do pedido pelo comprador."*

### 4.6 Must the DANFE be printed with the label?

**UNKNOWN — docs do not say**, in that no guide states a DANFE-with-label obligation. But there is one
strong hint about how it is delivered: `guide 292` §7a describes the thermal label package as
*".zip (contendo a etiqueta em um .txt em formato ZPL + **PDF com a declaração de conteúdo**)"* — the ZIP
bundles a content declaration, not a DANFE. No API in this slice returns a DANFE.

### 4.7 The FBS variant — the direction reverses

Under **Fulfilled by Shopee**, Shopee issues the fiscal documents and the seller **downloads** them:

> "All invoices and documents for 'Fulfilled by Shopee' orders **will be issued by Shopee**… Shopee will
> automatically handle shipping arrangements, label generation, and the entire logistics process **without
> seller involvement**." (`guide 568`)

Identification: `get_order_detail.fulfillment_flag` ∈ `{fulfilled_by_shopee, fulfilled_by_cb_seller,
fulfilled_by_local_seller}`; or filter `get_order_list` by `logistic_channel_id = 91007`; or
`v2.shop.get_shop_info` returning `shop_fulfillment_flag = "PFF - FBS Shopee"` (`guide 568`).
⚠️ `guide 568` warns: *"ERP/HUB systems must identify orders under Fulfilled by Shopee to avoid deducting
inventory from the seller's incorrect stock."*

⚠️ **`guide 568`'s FAQ is stale.** It answers *"Can documents and invoices be downloaded via OpenAPI for
Fulfilled by Shopee? **A: No**, currently, invoices and documents can only be downloaded via Seller Center."*
— but three APIs shipped **2025-07-11**, eight months after that guide's last update (2024-11-18):

```
v2.order.generate_fbs_invoices → v2.order.get_fbs_invoices_result → v2.order.download_fbs_invoices
```

`generate_fbs_invoices` takes `batch_download { start, end (YYYYMMDD ints), document_type, file_type,
document_status }`:
- `document_type`: `1 = Remessa, 2 = Return, 3 = Symbolic Return, 4 = Sale, 5 = Entrada, 6 = Symbolic Remessa, 7 = all`
- `file_type`: `1 = xml only, 2 = pdf only, 3 = both`
- `document_status`: `1 = authorized only, 2 = cancelled`; omitted/empty ⇒ **both**
Returns `result_list[{ request_id, fail_error, fail_message }]`; poll `get_fbs_invoices_result` for
`status` (sample `"Available"`) then `download_fbs_invoices` for a `file_link`.
⚠️ **"The download link for the document will expire 30 minutes after being generated."**
⚠️ The status vocabulary is inconsistent across the three: `get_fbs_invoices_result` samples `"Available"`
while `download_fbs_invoices` says *"can only be downloaded once the task status is **'READY.'**"*
Which string actually appears is **UNKNOWN — docs do not say**.
⚠️ These three also break the module's error convention: `error` is an **`int32`** with a companion
`error_msg`, whereas every other Order API returns `error` as a **string** with `message`.

There are also FBS-specific pushes (`push-list` category 2085): `fbs_br_invoice_error_push` (38),
`fbs_br_invoice_issued_push` (41), `fbs_br_block_shop_push` (39), `fbs_br_block_sku_push` (40),
`fbs_sellable_stock` (36) — not read in this slice.

---

## 5. Shipping / labels

### 5.1 The seller-fulfilment flow, step by step

From `guide 229` §8.1, condensed but complete:

1. **List packages to ship** — `v2.order.search_package_list` with `package_status = 2 (ToProcess)`.
   *"This api is preferred to fetch packages for shipment."* (`guide 229` §7)
2. **Get shipping parameters** — `v2.logistics.get_shipping_parameter` (single) or
   `get_mass_shipping_parameter` (batch, same channel + warehouse). Read `info_needed`, which tells you
   which of `pickup` / `dropoff` / `non_integrated` this package supports and which sub-fields to send.
3. **Arrange shipment** — `v2.logistics.ship_order` / `mass_ship_order` / `batch_ship_order`.
   *"After the API call is successful, the package fulfillment status of pickup/dropoff mode will
   automatically update from `LOGISTICS_READY` to `LOGISTICS_REQUEST_CREATED`, and for the **non_integrated**
   mode, package fulfillment status will be **immediately updated to `LOGISTICS_PICKUP_DONE`**."*
   ⚠️ Non-integrated therefore **skips two states** — a state machine expecting `REQUEST_CREATED` will never
   see it.
4. **Get the tracking number** — `v2.logistics.get_tracking_number` / `get_mass_tracking_number`.
5. **Print the AWB** — *"The airway bill can only be printed **after** the package is arranged shipment
   successfully **and before** the package fulfillment status is `LOGISTICS_PICKUP_DONE`."* — a **closing
   window**, not just a precondition.
6. **Shopee-generated AWB** = four calls in order:
   `get_shipping_document_parameter` → `create_shipping_document` → `get_shipping_document_result` →
   `download_shipping_document`.

The three `ship_order` request shapes, verbatim from `guide 229` §8.3.2:
```json
{"order_sn":"2112132KQ1MK9N","pickup":{"address_id":2826,"pickup_time_id":"1639472400"}}
{"order_sn":"220301QQY0WASP","dropoff":{}}
{"order_sn":"220301QQY0WASP","non_integrated":{"tracking_number":"AK224200239740W"}}
```
⚠️ *"some channels for dropoff methods have a direct return of empty fields, **you need to pass in the empty
field**"* — `"dropoff":{}` must be sent, not omitted.

**BR specifics** (`guide 292` §6): *"Se for dropoff (hoje só temos os **Correios** como dropoff)"*;
*"Se for pickup (hoje **todos os outros** são pickup, incluindo Coleta Correios)"*.

**Timing.** `ship_order`: *"It's recommended to initiate logistics **one hour** after the orders were
placed"*; `batch_ship_order` and `mass_ship_order` give the reason: *"since there is **one-hour window buyer
can cancel any order without request to seller**"*. `guide 383` §3 repeats it for BR.

**Days to ship.** `days_to_ship` (int32) = *"Shipping preparation time set by the seller when listing item"*;
`ship_by_date` (timestamp) = *"The deadline to ship out the parcel"*. Both are returned **by default** on
`get_order_detail` and also appear on `get_package_detail`. `guide 229` §9 FAQ: if no pickup time slot comes
back, *"the order may have been shipped or ship_by_day has passed."*
`push 44` fires on **`ship_by_date` changes** — Shopee moves the deadline (see §6).

### 5.2 Who mints the label?

**Shopee mints it; you download it. In Brazil this is mandatory.** `guide 292` §FAQ, unambiguous:

> "**Todas as etiquetas de envio são geradas pela Shopee, um vendedor ou Integradora/ERP nunca deve gerar a
> etiqueta por conta própria ou alterar a etiqueta da Shopee para nenhum canal de envio.**"

and §7: *"Todas as etiquetas de envio de pedidos da Shopee devem ser geradas pela Shopee."*

Globally there is a self-print path — `guide 229` §8.1.4 offers *"self-print or Shopee generated"*, and
`get_shipping_document_data_info` exists *"for self-design AWB printing"* — gated per package by
**`allow_self_design_awb`** (bool) on both `get_order_detail.package_list[]` and `get_package_detail`:
*"if allow_self_design_awb returns false… only the system-AWB can be used."*
⚠️ **For BR, `guide 292` forbids self-design regardless of that flag.** Treat the BR rule as binding.

Notably, `get_shipping_document_data_info` returns recipient address fields **as base64 PNG images**, not
text — `recipient_address_info[] { key, image: "data:image/png;base64,…" }` with a style object
(`text_style` bold/italic, `font_size` 1–108, `text_color`, `image_width` 0.1–30 cm, `h_align`). That is how
Shopee lets a self-designed label carry an address the API will not hand over in plaintext (§2.3).

### 5.3 Label formats and `shipping_document_type`

`guide 31` §ShippingDocumentType lists **four**:
```
NORMAL_AIR_WAYBILL
THERMAL_AIR_WAYBILL
NORMAL_JOB_AIR_WAYBILL
THERMAL_JOB_AIR_WAYBILL
```
⚠️ **A fifth exists and is missing from that enum: `THERMAL_UNPACKAGED_LABEL`.** It is listed in
`create_shipping_document`, `get_shipping_document_result`, `download_shipping_document` and
`create_shipping_document_job`, and `guide 677` §5.2 says channel 30029 *"only supports
'THERMAL_UNPACKAGED_LABEL'"*.

**Which type to use is per-package, and you ask:** `get_shipping_document_parameter` returns per order
`suggest_shipping_document_type` *"If you don't select any shipping document type, Shopee will use this as
default"* and `selectable_shipping_document_type[]`.

**File formats** — `guide 229` §9 "Airway Bill related", verbatim:
> "There are three formats:
> - Most orders' airway bill are **PDF** file.
> - TW C2C channels all return airway bills is **html** format, B2C channels except 7-ELEVEN (30005), Family
>   Family (30006), Lai Erfu (30007), Family Family Frozen Super Pickup (30011), OK Mart (30014) are printed
>   in pdf format, and others are returned html.
> - If the printing method set **in the seller center** is thermal printing, the **zip** format folder is returned."

⚠️ That last one is the trap: **the returned MIME type depends on a Seller Center setting your code cannot
read.** For BR, `guide 292` §7a makes the ZIP contents concrete:
*"'selectable_shipping_document_type': ['NORMAL_AIR_WAYBILL','THERMAL_AIR_WAYBILL'] informa que a etiqueta
pode ser gerada respectivamente em formato **.pdf** ou **.zip** (contendo a etiqueta em um **.txt em formato
ZPL** + PDF com a declaração de conteúdo)."*
So: `NORMAL_AIR_WAYBILL` → PDF; `THERMAL_AIR_WAYBILL` → ZIP{ZPL .txt + declaração PDF}.
**No page states physical label dimensions** — **UNKNOWN — docs do not say**.

### 5.4 Async vs sync, and the "did it already ship?" trap

`create_shipping_document` is **async**: it *"create[s] shipping document task"*, `get_shipping_document_result`
returns `status ∈ {READY, FAILED, PROCESSING}`, and `guide 229` §9 advises *"call the API cyclically until you
get to the 'READY' status."* Better: subscribe to **`push 17` `shipping_document_status_push`**, which
carries `{ order_sn, package_number, status: READY|FAILED }` — note the push has only **two** values where
the pull has three.

Batch shapes: `get_shipping_document_parameter`, `create_shipping_document`, `get_shipping_document_result`
and `download_shipping_document` all take `order_list` limit `[1,50]`. `download_shipping_document` returns a
single `waybill (file)` for the whole list — **a merged document, not per-order files**.
Per-entry failures come back as `fail_error`/`fail_message` **inside `result_list[]` alongside successes** —
a 200 with a partial failure, plus a separate top-level `warning[]` array. **Never treat HTTP 200 as
"all labels created".**

⚠️ **The `is_shipment_arranged` trap.** On both `search_package_list` and `get_package_detail`:
> "Only effective when the package's logistics_status/fulfillment_status is `LOGISTICS_READY`. This parameter
> further distinguishes between two scenarios: **true**: Package shipment has been arranged (Seller has
> processed shipment, system is generating tracking number, not yet updated to `LOGISTICS_REQUEST_CREATED`,
> **no duplicate action needed**) — **false**: Package awaiting shipment arrangement."

So `LOGISTICS_READY` is **ambiguous**: it means both "not yet shipped" and "shipped, tracking number
pending". A retry loop keyed on status alone **double-ships**. Check `is_shipment_arranged`.

A separate **pre-print job** flow exists (`guide 677` §6.1) for labels *before* an order exists:
`create_shipping_document_job` → `get_shipping_document_job_status` → `download_shipping_document_job`,
keyed on `job_id`, accepting either `unpackaged_sku_requests[]` or `package_list[]` (**not both**),
max **600** labels total.

### 5.5 Retry, reschedule, and `RETRY_SHIP`

`update_shipping_order` (pickup only) updates `address_id` + `pickup_time_id` for packages whose
fulfillment status is `LOGISTICS_PICKUP_RETRY`, or `LOGISTICS_REQUEST_CREATED` meeting "Instant Order
Reschedule Pickup conditions". `guide 229` §8.3.3 says *"Applicable to orders in **RETRY_SHIP** status."*
— i.e. the order-level `RETRY_SHIP` and the package-level `LOGISTICS_PICKUP_RETRY` are the same event seen
at two levels.

### 5.6 Brazil channel specifics

**Channel ids seen in the docs:** `90003` Padrão · `90021` BR Seller Logistics · `90022` Shopee Entrega
Direta · `90025` Samsung · `90026` BR Instant Delivery / Entrega Expressa · `91007` Fulfilled by Shopee ·
`30029` Shopee Xpress Package-free (**TW**, not BR).

**`batch_ship_order` is BR-and-one-channel-only**: *"**Only channel 90003 - Padrão in Brazil** has the
permission of this API."* — `order_sn` *"Limit 150"*. `mass_ship_order` is the general batch (limit `[1,50]`,
same `product_location_id` + `logistics_channel_id`).

**Shopee Entrega Direta (90022)** — `guide 290`: same-day/next-day in **São Paulo city only**; managed
sellers only; `shipping_carrier` reads *"Shopee Entrega Direta"*; the ship-by deadline is driven by a
seller-defined cut-off time so `ship_by_date` must be honoured; **it never appears alone** — *"This channel
will never be the only one available to a seller… Attempting to create an item with only one active
logistics channel, namely Shopee Direct Delivery, will not be possible"*. §FAQ-2: *"o canal requer envio de
invoice, organizando envio e gerando etiqueta normalmente."* — full NF-e + label flow applies.

**Shopee Xpress Package-free (30029)** — `guide 677`. **TW**, included here because its mechanics are the
sharpest illustration of the package model:
- **Automatic quantity-level splitting**: *"when the order status becomes 'READY_TO_SHIP', the system will
  automatically split the order into multiple packages based on the quantity of each item… if an order
  contains 3 bottles of milk tea and 2 bottles of black tea, the system will automatically split it into **5
  packages**, each containing 1 quantity."*
- ⚠️ *"the 'shipping_carrier' field at the **outer level** of get_order_detail **will not display a value**.
  Please retrieve the 'shipping_carrier' field from each package in the 'package_list'."*
- Every logistics call **must** carry `package_number` or it errors.
- Two label kinds: the per-item `THERMAL_UNPACKAGED_LABEL`, and a per-carton **TO label** via
  `download_to_label` (`sorting_group` `1:North`/`2:South`, `quantity` ≤ 20, *"each TO label is unique…
  duplicate packing lists will affect the drop-off process"*).

### 5.7 "Logística do Vendedor" — yes, own carrier and own tracking number

**Yes.** `guide 286` §"O que é o canal Logística do vendedor":
> "Este canal permite que o vendedor utilize **sua própria logística** para cotação e envio de pedidos.
> A cotação de frete é feita a partir da URL de cotação disponibilizada pelo vendedor. O preço de envio e
> prazo de entrega são fornecidos pelo próprio vendedor. O rastreamento… ficando sob responsabilidade do
> vendedor enviar os eventos de 'despachado', 'entrega' ou 'falha na entrega' via OpenAPI."

Two halves, and **both are mandatory**: *"Todos que desenvolverem a API de cotação, também devem desenvolver
a API de atualização de status"*, and without them *"os pedidos serão cancelados, pois o fluxo não pode ser
realizado via Central do Vendedor de forma manual."*

**(a) The quotation URL** — Shopee calls **you**. `POST` to a seller-supplied URL, query
`partner_id`/`timestamp`/`sign` (HMAC-SHA256 over `"{}{}{}" % (partner_id, api full path, timestamp)`),
body `{ shop_id, origin_zip_code, destination_zip_code, items[{ item_id, sku, model_id, category_id,
quantity, price, dimensions{length,width,height,weight} }] }` (cm and **grams**).
Response `{ quotation_id, destination_zip_code, packages[{ dimensions, items[], quotations[{ price,
handling_time, shipping_time, promise_time, service_code }] }] }`.
⚠️ *"nas cotações da PDP, o `model_id` e `category_id` são enviados como **zero**"* — zero is a real value on
the product page, populated only at checkout.
⚠️ **Response-time limit is stated three different ways across two guides**: `guide 286` §Requisitos says
**400ms**; `guide 286` §"Tempo de resposta limite" says **1s**; `guide 697` (Entrega Expressa) says **200ms**.
Assume the strictest that applies to your channel.
Error contract: HTTP **403** for mapped errors (~20 enumerated), HTTP **500** for unmapped —
and only the 500 row has `AtivaContingência = True`, i.e. **only a 500 triggers the contingency table**;
a 403 does not. Contingency delivery time is fixed at min 10 calendar / max 20 business days.
A validation endpoint is provided: `https://seller-quotation-api.uat.shps-br-services.com/validate_quotation_endpoint`.

**(b) The status-update API** — `v2.logistics.update_tracking_status`:
> "Only available for Brazil sellers. This API is only available for orders/parcels which are fulfilled by
> **BR Seller Logistics channel (90021), Samsung (90025) and BR Instant Delivery channel (90026)**."

```
order_sn        REQUIRED
logistics_status REQUIRED ∈ { logistics_pickup_done, logistics_delivery_done, logistics_delivery_failed }
tracking_number  optional — "Can only be sent when updating logistics_status to 'logistic_pickup_done'"
tracking_url     optional — same restriction, max 2048 chars
failed_reason    optional — required for 90026 on delivery_failed
                 ∈ { buyer_unreachable, buyer_unresponsive, no_delivery_location_consensus }
```
`delivery_done` and `delivery_failed` are **terminal** — *"após envio dos status Pedido Entregue ou Falha na
Entrega **não será mais permitida atualização de status**"* (`guide 286`), and both require the order to
already be at "Enviado".

⚠️ **This API reports failure with `error: ""` and HTTP success.** Its own §Error example:
```json
{"error":"","message":"","request_id":"07ee…","response":{"update_result":"failed"}}
```
versus the success sample, identical except `"update_result":"succeed"`. **The only failure signal is
`response.update_result`.** Checking `error` — the convention everywhere else in the API — reports every
failure as a success.
⚠️ Minor but real: the enum is spelled `logistics_pickup_done` in the parameter description and
**`logistic_pickup_done`** (no `s`) in the request sample and in the `tracking_number` restriction text.
Which the server accepts is **UNKNOWN — docs do not say**.

**How the channel shows up on an order** (`guide 286` §FAQ-2): `service_code` is appended to
`shipping_carrier` — `"Logística do vendedor - Canal X"`; when the **contingency table** fired, it is bare
`"Logística do vendedor"`. Corroborated by `get_order_detail`: *"If logistics_channel_id is 90021, 90025 or
90026, service_code will be appended, e.g., **Entrega Turbo - M1020**."*
⚠️ Two separate Open Platform APPs are required: *"O APP Seller Logistics, só é usado para URL de cotação,
para usar qualquer API é necessário a criação de um segundo APP"*, and one `shop_id` may bind to only one
quotation URL. Onboarding is gated on a Shopee ticket + two live test orders (one to `delivery_done`, one to
`delivery_failed`) and ~15 business days of internal setup.

**Entrega Expressa (90026)** — `guide 697`, same architecture with additions: `channel_id` and
`destination_lat_long` in the quote request; a separate **fallback** quote shape returning
`fallback_promise_time` in **minutes**; mandatory serviceable-area **KML polygon** upload
(`upload_polygon` → `check_polygon_update_status`) *"mandatory before toggling on Entrega Expressa… Without
serviceable area settings set, channel will always display as unsupported to buyer"*.
⚠️ **`guide 697` requires an OTP that the API no longer accepts.** The guide says *"it is mandatory for
seller to retrieve OTP code from buyer, and send it in API request when attempting to update tracking_status
to logistics_delivery_done."* But `update_tracking_status` §Update log records **`2025-12-03: Remove
opt_code` [sic]** and the current parameter list has **no OTP field at all** (it was added 2025-09-18 and
removed 2025-12-03). `guide 697` was last updated 2025-09-22 — inside that window. **The guide is stale;
there is no OTP parameter.**

### 5.8 First Mile Binding (`guide 225`) — not applicable to a BR local seller

*"This article only applies to **cross-border sellers**"* — specifically Mainland China and South Korea.
Recorded for completeness: modes `Pick up` / `Drop off` / `Self deliver`; order is
**ship → print AWB → bind first mile** (*"The correct order is to ship the order first, then print the
airway bill, then bind"*); binding across shops is allowed if same transshipment warehouse but **one shop
per call**; after binding + scanning, *"the order status of all orders being bound will be updated from
**PROCESSED to SHIPPED**"*. First-mile status enum: `ORDER_RECEIVED`, `PICKED_UP`, `DELIVERED` — bind is
blocked once `PICKED_UP` or `DELIVERED`. `push 34` (`courier_delivery_binding_status_push`) carries a
**longer** enum than `guide 225`: `CANCELED, CANCELING, DELIVERED, NOT_AVAILABLE, ORDER_CREATED,
ORDER_RECEIVED, PICKED_UP`.

---

## 6. Tracking — push vs pull

### 6.1 The pull

`v2.logistics.get_tracking_number` (`order_sn` + optional `package_number`) returns
`tracking_number`, plus on request (`response_optional_fields`) `plp_number`
(*"The unique identifier for package of **BR correios**"*), `first_mile_tracking_number` (CB only),
`last_mile_tracking_number` (*"Only for **Cross Border BR** seller"*), and `hint`
(*"Indicate hint information if cannot get some fields under special scenarios"*).
⚠️ **It can legitimately return an empty tracking number**: *"The api response can return tracking_number
empty, since this info is dependent from the 3PL, due to this it is allowed to keep calling the api within
**5 minutes interval**, until the tracking_number is returned."*

`v2.logistics.get_tracking_info` returns `logistics_status` (package-level) plus
`tracking_info[] { update_time, description, logistics_status, return_code }`, and for failed cross-border
deliveries `reversed_tracking_number`, `reversed_courier_name`, `reversed_tracking_info[]`.

⚠️ **The two `logistics_status` fields in that one response use different enums.** Both are documented
*"See Data Definition- LogisticsStatus"*, but the per-event sample value is **`FAILED_DELIVERED`**, which is
in `guide 31` §**TrackingLogisticsStatus** (36 values: `INITIAL, ORDER_INIT, ORDER_SUBMITTED,
ORDER_FINALIZED, ORDER_CREATED, PICKUP_REQUESTED, PICKUP_PENDING, PICKED_UP, DELIVERY_PENDING, DELIVERED,
PICKUP_RETRY, TIMEOUT, LOST, UPDATE, UPDATE_SUBMITTED, UPDATE_CREATED, RETURN_STARTED, RETURNED,
RETURN_PENDING, RETURN_INITIATED, EXPIRED, CANCEL, CANCEL_CREATED, CANCELED, FAILED_ORDER_INIT,
FAILED_ORDER_SUBMITTED, FAILED_ORDER_CREATED, FAILED_PICKUP_REQUESTED, FAILED_PICKED_UP, FAILED_DELIVERED,
FAILED_UPDATE_SUBMITTED, FAILED_UPDATE_CREATED, FAILED_RETURN_STARTED, FAILED_RETURNED,
FAILED_CANCEL_CREATED, FAILED_CANCELED`) — **not** in `LogisticsStatus`. **Parsing per-event statuses against
the `LogisticsStatus` enum will reject every value.**

### 6.2 The three status enums that are almost but not quite the same

`guide 31` defines **`LogisticsStatus`** (13 values, order-level) and **`PackageFulfillmentStatus`**
(11 values, package-level). They overlap heavily but are **not identical**:
`LogisticsStatus` has two values `PackageFulfillmentStatus` lacks — **`LOGISTICS_PENDING_ARRANGE`** and
**`LOGISTICS_COD_REJECTED`**. Everything else matches name-for-name. Plus `TrackingLogisticsStatus` (36),
plus `Reverse Logistics Status` and `Post Return Logistics Status` for returns (§8). **Five enums, three of
them sharing a `LOGISTICS_*` prefix.**

### 6.3 The pushes

| push | fires on | payload |
|---|---|---|
| **2** `order_trackingno_push` | tracking number assigned | `{ ordersn, forder_id, package_number, tracking_no }` |
| **33** `package_fulfillment_status_push` | package fulfillment status change | `{ ordersn, package_number, fulfillment_status, update_time }` |
| **44** `package_info_push` | **`ship_by_date` / `logistics_channel_id` / `return_code` change** | `{ order_sn, package_number, changed_fields[], old{…}, new{…}, update_time }` |

`push 2`'s stated purpose: *"avoid having to query the v2.logistics.get_tracking_number API repeatedly.
This can be useful when logistics partners take some time to update tracking numbers."*
⚠️ `push 2` carries `forder_id`, documented as **"Coming offline"** — do not depend on it.

`push 44` is the one that is easy to miss: **Shopee unilaterally changes the ship-by deadline and the
logistics channel of an existing package**, and this is the only notification. `changed_fields` ∈
`{ship_by_date, logistics_channel_id, return_code}`, and *"Both values will be returned if both fields have
been updated."* `return_code` is an ID-region SPX Instant/Sameday RTS OTP and is *"generated only once and
will not change, [so] this field will always be **empty** when return_code is pushed"* in `old`.

**All seven pushes share the same delivery contract**: `push_timeout = 3` seconds, `push_guarantee = 0`,
retry schedule **`300, 1800, 10800`** seconds (5 min → 30 min → 3 h) — **three retries, then dropped**.
`guide 383` §1 gives the ack requirement: *"Incluir código de status **2xx**; Incluir um corpo **vazio**
(método POST)."*
⚠️ **`push_guarantee = 0` on every one of them.** Combined with 3 retries and a 3-second timeout, **pushes
are lossy by design** — a reconciliation sweep against `get_order_list` by `update_time` is not optional.

---

## 7. Cancellations

### 7.1 Seller-initiated

`api v2.order.cancel_order` — *"This action can only be performed **before the order has been shipped**."*
`guide 383` §"Cancelamento de pedidos" sharpens it: *"Não é possível cancelar uma order após a organização de
envio e **geração do tracking_number**"*, and the error is `Can not cancel this order.` — meaning either
tracking already exists, or it is already cancelled.

**`cancel_reason` — the enum depends on which page you read:**
- `api v2.order.cancel_order`: `OUT_OF_STOCK`, `CUSTOMER_REQUEST`, `UNDELIVERABLE_AREA` *(Note: Only apply
  for TW and MY)*, `COD_NOT_SUPPORTED` — **four**.
- `guide 383` (BR): the same four, with `COD_NOT_SUPPORTED` glossed *"Cash in Delivery, **não disponível para
  o Brasil**"* and `UNDELIVERABLE_AREA` as *"Quando o endereço solicitado não está dentro da sua área de
  entrega"* — i.e. the BR guide presents as usable a value the API restricts to TW/MY.
- `guide 31` §CancelReason（Seller）: only **`OUT_OF_STOCK`** and **`UNDELIVERABLE_AREA (only for TW and MY)`**.

Reconciling: for a **BR** seller the safely-available reasons are `OUT_OF_STOCK` and `CUSTOMER_REQUEST`.
⚠️ `item_list` is *"Required when cancel_reason is `OUT_OF_STOCK`"* — a conditional requirement the schema
marks merely "optional". ⚠️ And in that list `item_id` is typed **`int32`** while it is `int64` in every
other API — a real overflow risk on large item ids.

**Partial cancellation** (newer): `partial_cancel_item_list[] { item_id, model_id, order_item_id,
promotion_group_id, model_quantity }`, previewed by `v2.order.get_estimate_cancel_value` which returns
`cancel_value_price`. Gated by three `get_order_detail` fields: `can_full_cancel_order`,
`can_partial_cancel_order`, and **`buyer_preference_for_partial_cancellation`**:
`0 = Ship Available Items Only`, `1 = Cancel The Entire Order` — *"The buyer does not allow partial
cancellation. If any item is unavailable, the seller should cancel the entire order instead."*
**The buyer decides whether partial cancellation is even offered.**
⚠️ `cancel_value_price` is typed **`string`** (sample `"1000"`) while every escrow amount is a float.

`guide 31` §CancelReason (the *display* list, 22 values, distinct from the seller-input enum) shows who else
cancels: `Unpaid Order`, `Underpaid Order`, `Unsuccessful / Rejected Payment`, `Logistics Request is
Cancelled`, `3PL pickup Fail`, `Failed Delivery`, `COD Rejected`, `Seller did not Ship`, `Parcel is Lost`,
`Transit Warehouse Cancelled`, `Inactive Seller`, `Auto Cancel`, … `get_order_detail.cancel_by` ∈
`{buyer, seller, system, Ops}`.

### 7.2 Buyer-initiated

`api v2.order.handle_buyer_cancellation` — `{ order_sn, operation: ACCEPT | REJECT }`.
Its error list pins the precondition twice: *"Invalid order_status. The order status should be
**`IN_CANCEL`**."* So the flow is: buyer requests → order enters `IN_CANCEL` → seller ACCEPTs (→ `CANCELLED`)
or REJECTs. `get_order_detail.buyer_cancel_reason` carries the buyer's stated reason
(`guide 31` §BuyerCancelReason lists 21 free-text-looking values, with visible duplicates differing only in
capitalisation — `"Need to change delivery address"` appears three times in two casings).

### 7.3 The unilateral window

**One hour from order placement.** Stated identically in `api v2.logistics.batch_ship_order` and
`api v2.logistics.mass_ship_order`: *"It's recommended to initiate logistics one hour after the orders were
placed **since there is one-hour window buyer can cancel any order without request to seller**."*
`guide 383` §3 says the same for BR: *"é recomendado iniciar a organização de envio (ship_order) após 1 hora
da confirmação de pagamento, pois dentro desse período o Buyer pode cancelar a pedido **sem aprovação do
Seller**."*
⚠️ **The two anchor the hour differently** — `batch_ship_order` counts from *order placement*,
`guide 383` from *payment confirmation*. For a boleto/Pix order those can be days apart.

### 7.4 What `order_status_push` sends for a cancellation

`push 1` is explicitly scoped to include them: *"This includes **order cancellations that occur before
shipping**, so that you can take the necessary steps in time."* The payload is the ordinary one —
`{ ordersn, status, completed_scenario, update_time }` — so a cancellation arrives as
`status: "CANCELLED"` (or `"IN_CANCEL"` for a pending request) with **no reason attached**.
`cancel_reason` / `cancel_by` / `buyer_cancel_reason` require a `get_order_detail` follow-up with those
optional fields named. `push 33` mirrors it at package level: *"This includes package cancellations that
occur before shipping."*

---

## 8. Returns / refunds

### 8.1 Keying

**Yes — a return is keyed by `return_sn` and carries `order_sn`.** `guide 227` §2.1:
*"Each application will return a `return_sn` as a unique ID. **Buyers may submit multiple `return_sn` for the
same order.** The return parameter contains `order_sn`, which is the order number associated with this return
refund application."* So the relation is **1 order → N returns**. `get_escrow_detail` closes the loop from
the money side with `return_order_sn_list[]`.

### 8.2 `ReturnStatus`

`guide 31` and `guide 227` agree exactly (the only enum where they do):
```
REQUESTED  ACCEPTED  CANCELLED  JUDGING  CLOSED  PROCESSING  SELLER_DISPUTE
```
No meanings are given for any of them, and the status-flow diagram (`guide 227` §1) is `[image]`.
**Which are terminal is UNKNOWN — docs do not say** (`CLOSED` and `CANCELLED` read as terminal, but no page
states it).

### 8.3 Seller actions

| API | What it does | Precondition |
|---|---|---|
| `v2.returns.confirm` | *"Confirm refund"* — agree to the buyer's request. `guide 227` §2.2: *"only for the **Full Refund** type, the buyer does not need to return the product. Once agreed, the status will be updated to **Accepted**."* | (not stated) |
| `v2.returns.get_available_solutions` | *"Get the available solutions offered to buyers."* | — |
| `v2.returns.offer` | Seller proposes: `{ return_sn, proposed_solution ∈ ReturnSolution, proposed_adjusted_refund_amount (float, optional) }` | — |
| `v2.returns.accept_offer` | Seller accepts the buyer's proposal | — |
| `v2.returns.dispute` | Escalate to Dispute Center: `{ return_sn, email (REQUIRED), dispute_reason_id (int32), image_list[], dispute_text_reason }` | *"Support to raise dispute when return_status in **REQUESTED / PROCESSING / ACCEPTED**"* |
| `v2.returns.cancel_dispute` | `{ return_sn, email }` — ⚠️ *"Sellers can only cancel **compensation** disputes, not normal disputes… only when the return_status is `ACCEPTED` and the compensation_status is `COMPENSATION_REQUESTED`."* | |
| `v2.returns.upload_proof` | `{ return_sn, photo[{ url, thumbnail }], description }` | |
| `v2.returns.get_return_dispute_reason` | Per-return reason list + required evidence modules | |

⚠️ **`guide 227` is behind the APIs on two points.** It says *"At present, Open API only supports two
statuses of **REQUESTED and PROCESSING** to dispute"* — the API says three, adding `ACCEPTED`. And it says
*"After a dispute is raised, the seller can upload evidence images through API, but **uploading videos is not
currently supported**"* — while `upload_proof` says *"including text and pictures **and videos** converted
into URLs"* and `get_return_detail` returns `buyer_videos[{ thumbnail_url, video_url }]`.

⚠️ **`dispute_reason_id` type mismatch.** `get_return_dispute_reason` returns `dispute_reason` as a
**string** (sample `"50"`); `v2.returns.dispute` requires `dispute_reason_id` as an **int32** (sample `50`).
A cast is mandatory between the two calls.

### 8.4 Solutions

`guide 31` / `guide 227` §ReturnSolution — **strings**: `RETURN_REFUND`, `REFUND`.
⚠️ But `get_return_list.return_solution` is an **`int32`**: *"`0`: Return and Refund, `1`: Refund Only"*,
with the caveat *"this is **not** the solution during negotiation"* — it is the latest agreed solution.
Meanwhile `v2.returns.offer.proposed_solution` takes the **string** form.
**Same concept, two encodings, in the same module.** And `push 32` reports `return_solution` changes as
`old_value`/`new_value` **strings** without saying which encoding.

### 8.5 Reasons and dispute reasons

⚠️ **`ReturnReason` is spelled differently in the two guides that define it.** Same concept, incompatible
literals:

| `guide 31` §ReturnReason | `guide 227` §ReturnReason and Reassessed Request Reason |
|---|---|
| `NONRECEIPT` | `NOT_RECEIPT` |
| `DIFF_DESC` | `DIFFERENT_DESCRIPTION` |
| `MUITAL_AGREE` *(sic — typo for MUTUAL)* | `MUTUAL_AGREE` |
| — | `NONE` |
| `ITEM_WRONGDAMAGED` | `ITEM_WRONGDAMAGED(only for Vietnam)` |

`guide 31` lists **31** values (adding `USED, NO_REASON, SUSPICIOUS_PARCEL, EXPIRED_PRODUCT,
WRONG_ORDER_INFO, WRONG_ADDRESS, CHANGE_OF_MIND, SELLER_SENT_WRONG_ITEM, SPILLED_CONTENTS, BROKEN_PRODUCTS,
DAMAGED_PACKAGE, SCRATCHED, DAMAGED_OTHERS, SIZE_DEVIATION, LOOK_DEVIATION, DATE_DEVIATION,
DIFFERENT_DESCRIPTION` …), `guide 227` lists **14**. The sample values in the actual APIs use
**`guide 227`'s** spelling (`get_return_detail` samples `reason: "NOT_RECEIPT"`) *and* `guide 31`'s
(`get_return_list` samples `reason: "PHYSICAL_DMG"`). **Neither list is complete or authoritative.** Parse
permissively.

Note also `reassessed_request_reason` — *"There may be cases where Shopee Agent updates the return request
with a 'Reassessed Return Reason' after reviewing more details… If no reassessment has been made, the value
will be **`NONE`**"* — the string `NONE`, not null. **The reason you first stored can be overruled by Shopee
later**, and the original stays in `reason`.

**Dispute reasons**: `guide 31` §ReturnDisputeReasonId maps **numeric ids to English (and Chinese) text** —
ids 1–13, 41–56, 81–89, non-contiguous. `guide 227` §ReturnDisputeReason instead lists **symbolic** values
`NON_RECEIPT / OTHER / NOT_RECEIVED / UNKNOWN`. And `get_return_list.dispute_reason` is a **`string[]`**
sampled `["UNKNOWN"]` in one API and `["dispute_reason_1","dispute_reason_2"]` in another. **Three
incompatible representations.** Only `get_return_dispute_reason` is per-return and current — use it, do not
hardcode.

### 8.6 Evidence

`get_return_dispute_reason` returns per reason: `dispute_requirement` (prose), `sample_evidence[{ type: 1=Image,
url, thumbnail }]`, and `evidence_module_list[{ module_index, requirement, is_required }]`.
`v2.returns.dispute`'s `image_list[]` must echo `module_index` + `requirement` + `image_url[]` back —
so evidence is **structured per module**, not a flat bag. Images should come from `v2.returns.convert_image`
(named in `guide 227`; not read in this slice). `image_list` is *"mandatory input field for all dispute
reasons **except** 'Did not receive the return product'"*.
`SellerProofStatus`: `guide 31` has **four** (`NOT_NEEDED, PENDING, UPLOADED, OVERDUE`), `guide 227` has
**three** (drops `NOT_NEEDED`).

### 8.7 Time limits

Four due-date fields, all timestamps, on `get_return_list` / `get_return_detail`:
- `due_date` — *"The last time seller deal with this return."*
- `return_ship_due_date` — *"The due date for buyer to ship order."*
- `return_seller_due_date` — *"The due date for seller to deal with this return when buyer have shipped order."*
- and on the order, `return_request_due_date` — *"the deadline for buyers to initiate returns and refunds
  **after order is completed**"*, returned only when the order is `COMPLETED` and return-eligible.

**No fixed numeric windows are published** — every limit is a per-return server-supplied timestamp.
**UNKNOWN — docs do not say** what the underlying durations are.

### 8.8 Return validation, request types, and reverse logistics

`return_refund_request_type` (int32): `0` Normal RR · `1` In-Transit RR (raised while in transit) ·
`2` Return-on-the-Spot (*"raised by the **driver** after buyer rejected parcel at delivery"*).
`validation_type`: `seller_validation` (parcel comes to you; you decide refund-or-dispute) vs
`warehouse_validation` (parcel goes to a Shopee warehouse). Under warehouse validation there are **two
reverse legs**, and `get_reverse_tracking_info` splits them: leg 1 buyer→warehouse
(`reverse_logistics_status`, `tracking_number`, `tracking_info[]`), leg 2 warehouse→seller
(`post_return_logistics_status`, `rts_tracking_number`, `post_return_logistics_tracking_info[]`).
⚠️ *"For Cross-Border Returns, if the second segment exists, the API returns information for **both**…
For **Local** Returns, if the second segment exists, the API prioritizes and returns **only the second**
segment information."* — for a BR local seller the first leg **disappears** once the second exists.
`is_arrived_at_warehouse`: `1` Pending Inbound · `2` Rejected · `3` Inbound · `4` Cancelled.
Reverse status enums differ by request type: Normal RR uses the `LOGISTICS_*` vocabulary; In-transit RR and
Return-on-the-Spot use **`Preparing / Delivered / Delivery Failed / Lost`** — human-readable strings with
spaces and mixed case, a completely different shape.
`is_seller_arrange` — *"This would only be True for **TW and BR**"* — plus `is_shipping_proof_mandatory`.
Tracking events carry `epop_image_list` / `epod_image_list` (proof of pickup / delivery).

### 8.9 `push 32` `return_updates_push`

*"Get notified when the following fields of Return Refund change: `return_status`, `return_solution`,
`seller_proof_status`, `logistics_status`"*. Payload:
```json
{"data":{"order_sn":"241128EDQ9YKJ0","return_sn":"2411280EDT4JRV5",
  "updated_values":[{"update_field":"return_status","old_value":"JUDGING","new_value":"PROCESSING","update_time":1732796767},
                    {"update_field":"logistics_status","old_value":"LOGISTICS_NOT_STARTED","new_value":"LOGISTICS_PENDING_ARRANGE","update_time":1732796767}]},
 "shop_id":220004993,"code":29,"timestamp":1732796767}
```
This is the **only push in the set that carries old→new transitions and a per-field `update_time`** — it is
the best watermark source in the whole slice.
⚠️ Its sample `old_value` is **`LOGISTICS_NOT_STARTED`** — with a **`D`**. Every enum in `guide 31` spells it
**`LOGISTICS_NOT_START`**. One of the two is wrong and the push sample is what you will actually receive.

### 8.10 Money side of a return

`get_escrow_detail` carries `seller_return_refund`, `drc_adjustable_refund` (*"The adjustable refund amount
from Shopee **Dispute Resolution Center**"*), `reverse_shipping_fee`, `rsf_seller_protection_fee_claim_amount`,
`final_return_to_seller_shipping_fee`, and a family of `prorated_*_offset_return_items` fields, each of which
*"will only be updated when there is an **adjustable RR**. If it's a full RR or normal order will response 0."*
`escrow_amount`'s own note: *"Return refund amount = if adjustable RR, will equal to `drc_adjustable_refund`."*
`SellerCompensationStatus` has 9 values (`guide 31`), filterable on `get_return_list`.

---

## 9. Order pushes

### 9.1 Which statuses does `push 1` fire for?

**Not enumerated — UNKNOWN — docs do not say** *which* statuses. The scope is stated only qualitatively:
*"Get notified immediately on **all order status updates**. This includes order cancellations that occur
before shipping"* (`push 1`). `guide 383` §1 describes it as firing *"sempre que uma nova order for criada
ou mudar de status"* — **creation as well as transitions**. No list of triggering values exists on any page.

### 9.2 Does it carry items?

**Documented payload: no items.** `push 1` §Params lists exactly `data { ordersn, status,
completed_scenario, update_time }` + `shop_id` + `code` + `timestamp`.

⚠️ **But its own sample contains an undocumented `items` field:**
```json
{"data":{"items":[],"ordersn":"220810QSK8S7BX","status":"PROCESSED","completed_scenario":"","update_time":1660123127},
 "shop_id":727720655,"code":3,"timestamp":1660123127}
```
`items` appears in the sample and **nowhere in the parameter table**. Whether it is ever non-empty is
**UNKNOWN — docs do not say**. Treat it as absent and always fetch `get_order_detail`.

Note also `completed_scenario` is `""` (empty string) in the sample for a non-`COMPLETED` status — it is only
meaningful when `status == COMPLETED`, where it distinguishes `NORMAL` from `RRAOC`.

### 9.3 Is `update_time` a usable staleness watermark?

**Partly — with two caveats.**

In favour: `update_time` is documented identically on the push and on `get_order_detail` —
*"Timestamp that indicates the last time that there was a change in value of order, such as order status
changed from 'Paid' to 'Completed'."* It is UNIX **seconds** (§1.5), it is `get_order_list`'s
`time_range_field` option, and comparing a stored `update_time` against an incoming one is exactly the
event-clock comparison a watermark needs.

Against:
1. **One-second resolution.** Two changes within the same second are indistinguishable, so the guard must be
   *strictly newer OR equal-and-different*, not `>`.
2. **The envelope `timestamp` is a different clock.** Top-level `timestamp` is *"the message was sent"*;
   `data.update_time` is when the order changed. In `push 1`'s sample they are equal (`1660123127`); in
   `push 44`'s they differ by one second (`1764569831` vs `1764569832`). **Only `data.update_time` is the
   event clock.**
3. **`push 33` and `push 44` carry `update_time` but `push 2` and `push 17` do not** — those two have no
   ordering field at all, so tracking-number and label-status events cannot be watermarked from the push
   alone.

`push 32` (returns) is the best-behaved: **per-field** `update_time` with explicit `old_value`/`new_value`.

---

## 10. Order splitting, packages, consolidation

### 10.1 Can several orders be consolidated into one shipment/label?

**The data model says yes; no seller-facing API to do it appears in these docs.**

- `package_list[].group_shipment_id` (int64) — *"The common identifier for **multiple orders combined in the
  same parcel**"* — exists on both `get_order_detail` and `get_package_detail`. It is **read-only**: no API in
  the Order or Logistics module listing takes or sets it, and no guide explains who populates it. Its sample
  values are `null` (`get_order_detail`) and `0` (`get_package_detail`) — **two different empty encodings for
  the same field**.
- **Whether a seller can request consolidation, and under what conditions Shopee performs it, is
  UNKNOWN — docs do not say.**
- `download_shipping_document` accepts an `order_list` of up to 50 and returns **one merged `waybill` file** —
  but that is batched *printing*, not a shared shipment: each order still has its own AWB inside.
- The one true many-to-one grouping documented is **First Mile Binding** (`guide 225`) — many orders bound to
  one `first_mile_tracking_number`, *"Yes, but make sure that orders across shops use the same transshipment
  warehouse"* — and that is **cross-border sellers only** (CN/KR), so not available to a BR local seller.
- `guide 677`'s TO label groups many **packages** into one carton by `sorting_group` — again TW-only, and it
  is a physical carton, not a shared shipment record.

So the honest answer for a BR local seller: **it is strictly one order → one or more packages.** The reverse
direction (many orders → one parcel) exists in the schema but not in any documented seller action.

### 10.2 Splitting: one order → N packages

`v2.order.split_order` (`guide 229` §6.1, `api v2.order.split_order`):
- **Only from `READY_TO_SHIP`.** *"Orders can be split only when the order status is 'READY_TO_SHIP'"*.
- **Shop-level permission, off by default**: *"If you get the error 'You don't have the permission to split
  order.'… please contact Shopee business manager to apply."*
- **The request must contain every item in the order**, distributed across ≥2 `item_list`s.
- **Max 30 parcels in TW, 5 elsewhere.**
- **Item-level and model-level only by default**: *"If buyers buy more than one items of the same `item_id`
  and `model_id`, the order **can not** be split… For example, if a buyer buys a cell phone A (blue) and a
  cell phone A (red), the order can be split into two packages. If you buy **two cell phones A (blue), you
  can not split them**."* Quantity-level splitting (`model_quantity`) is whitelist-only —
  *"only eligible for the shop whitelisted to the unit-level split in **SG/TH/TW/MY** markets"* (**BR absent**).
- Bundle-deal and add-on-deal items **cannot be split apart** unless whitelisted; identify them by shared
  `order_item_id` (bundle) or shared `add_on_deal_id`.
- Orders with installation services cannot be split by quantity.
- `v2.order.unsplit_order` reverses it, **only while `READY_TO_SHIP`** — *"if any parcel has been shipped, the
  order can not be splitting anymore"*.
- Live eligibility is exposed per package as **`can_split_order` / `can_unsplit_order`** on
  `get_package_detail` — prefer those over inferring from status.

⚠️ **`guide 383` §FAQ-1 lists `split_order` and `unsplit_order` among the APIs "que não são usadas para
integrações no Brasil"** — consistent with BR's absence from the unit-level-split whitelist, and consistent
with §0a's warning that this FAQ also (wrongly) excludes `upload_invoice_doc`. Treat "splitting is not a BR
flow" as **plausible but unconfirmed**.

**Automatic splitting also happens without you** — `guide 677`: channel 30029 splits by quantity at
`READY_TO_SHIP` with no seller action (TW only). `get_order_detail.split_up` (bool) and
`get_package_detail.is_split_up` flag it.

### 10.3 What `search_package_list` adds

It is the **package-native, ship-oriented list**, and `guide 229` §7 says to prefer it:
*"Search package list that have not been SHIPPED to arrange shipment, with various filters and sort fields.
**This api is preferred to fetch packages for shipment.**"*

Over `get_order_list` it adds:
- **`package_status`** filter: `0 All · 1 Pending · 2 ToProcess · 3 Processed` (default **2**)
- **`fulfillment_type`**: `0 None · 1 Shopee · 2 Seller` (default **2**) — the FBS/self split of §4.7
- **`invoice_pending`** (bool) — the NF-e queue at package granularity
- `product_location_ids[]`, `logistics_channel_ids[]`, `sorting_group`, `order_type`
  (`1 Regular / 2 Instant`), `is_pre_order`
- **`shipping_priority`**: `0 All · 1 Overdue · 2 Ship by Today · 3 Ship by Tomorrow`
  (or `2 Within 24h / 3 Beyond 24h` depending on shop tier)
- **sorting**: `sort_type` `1 ShipByDate · 2 CreateDate · 3 ConfirmedDate` + `ascending`
- `pagination.total_count` — a count `get_order_list` never gives
- **`is_shipment_arranged`** — the double-ship guard of §5.4

⚠️ **It has no time-range filter at all** — no `create_time`/`update_time` window, unlike `get_order_list`'s
mandatory 15-day one. It is a *work queue*, not a sync feed. And its response is deliberately thin
(`order_sn`, `package_number`, `logistics_channel_id`, `product_location_id`, `sorting_group`,
`is_shipment_arranged`) — enrich via `get_package_detail` (`package_number_list`, limit `[1,50]`).

Compare `v2.order.get_shipment_list` — the older, dumber sibling: *"get order list which order_status is
`READY_TO_SHIP` or `RETRY_SHIP`"*, cursor paging, no filters, returns only `{order_sn, package_number}`.

---

## Appendix A — response envelope and error conventions

Standard success/error envelope on Order, Logistics, Returns and Payment:
```json
{ "request_id": "…", "error": "", "message": "", "response": { … }, "warning": [ … ] }
```
- `error` is *"Indicate error type if hit error. **Empty if no error happened.**"* — so the success test is
  `error === ""`, not HTTP status.
- **Three documented exceptions to that rule**, each a distinct trap:
  1. `v2.logistics.update_tracking_status` — failures return `error: ""` and
     `response.update_result: "failed"` (§5.7).
  2. The three FBS invoice APIs — `error` is an **int32** with `error_msg`, not a string with `message` (§4.7).
  3. Every batch API (`create_shipping_document`, `get_shipping_document_parameter`,
     `get_shipping_document_result`, `generate_fbs_invoices`, `get_buyer_invoice_info`) — per-entry
     `fail_error`/`fail_message` **inside `result_list[]`**, with a top-level `error: ""`.
- Common params on **every** call: `partner_id`, `timestamp` (**expires in 5 minutes**), `access_token`
  (**valid 4 hours**), `shop_id`, `sign` (HMAC-SHA256 over partner_id + api path + timestamp + access_token +
  shop_id, keyed by partner_key).
- `rate_limit` is published as `[0,0,0]` on every API read — **no published rate limits**.
- `api_permission` on the order APIs includes `"ERP System"`; `guide 290` advises creating an app of that
  category *"preferably an ERP System type to have access to all OpenAPI functionalities"*.

## Appendix B — the contradictions, collected

For anyone building against these docs, the list of places where two Shopee pages disagree:

1. `upload_invoice_doc` is BR-applicable (`guide 382`, API text) vs not-used-in-BR (`guide 383` FAQ).
2. `add_invoice_data` (`guide 292`) — **API does not exist**.
3. FBS invoices Seller-Center-only (`guide 568`) vs three download APIs (2025-07-11).
4. `file_type` `limits: [1,2,3]` vs description `4.xml` vs `guide 382` requiring 4.
5. `guide 383`'s OpenAPI↔SellerCenter status table is row-misaligned; "8 status" over a list of 9.
6. `ShippingDocumentType` — `guide 31` omits `THERMAL_UNPACKAGED_LABEL`.
7. `get_order_list`'s status filter omits 4 legal `order_status` values.
8. Quotation response-time limit: 400ms vs 1s (`guide 286`) vs 200ms (`guide 697`).
9. `guide 697` mandates an OTP that was removed from `update_tracking_status` on 2025-12-03.
10. `logistics_pickup_done` vs `logistic_pickup_done` in one API's own text.
11. `LOGISTICS_NOT_STARTED` (`push 32` sample) vs `LOGISTICS_NOT_START` (`guide 31`).
12. `ReturnReason` spelled incompatibly in `guide 31` vs `guide 227`.
13. `ReturnSolution` string enum vs `return_solution` int32 in the same module.
14. `dispute_reason` string out, `dispute_reason_id` int32 in.
15. `dispute` allowed from `ACCEPTED` (API) vs only REQUESTED/PROCESSING (`guide 227`).
16. Video evidence unsupported (`guide 227`) vs supported (`upload_proof`, `buyer_videos`).
17. `SellerProofStatus` 4 values (`guide 31`) vs 3 (`guide 227`).
18. Masking status list: `guide 382` (4 states) vs `guide 290` (2 states).
19. Cancel-window anchored at order placement (`batch_ship_order`) vs payment confirmation (`guide 383`).
20. `cancel_reason` enum: 4 values (API) vs 2 (`guide 31`) vs 4-with-BR-caveats (`guide 383`).
21. Per-event tracking `logistics_status` documented as `LogisticsStatus`, sampled from `TrackingLogisticsStatus`.
22. FBS job status `"Available"` vs `"READY"`.
23. Money types: `float` (escrow, refund_amount) vs `string` (`cancel_value_price`,
    `activity[].refund_amount`, `activity[].original_price`).
24. `group_shipment_id` empty as `null` vs `0` in the two APIs that return it.
25. `item_id` typed `int32` in `cancel_order.item_list` vs `int64` everywhere else.
26. `push 1` sample carries an `items` field absent from its parameter table.
27. `ship_order`'s changelog announces a description change that is not in the description.
28. `upload_invoice_doc` error messages reference an `access_key` request field the API does not have.
