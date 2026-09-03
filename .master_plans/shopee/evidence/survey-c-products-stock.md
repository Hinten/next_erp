# Shopee Open Platform v2 — Phase 0 survey, slice C: products, variations, stock, price, size charts, kits, media

Sources: Shopee Open Platform developer guides and API reference, fetched 2026-09-03 via
`shopee-doc.mjs` (the SPA's own JSON API). Citations are `guide N`, `api <name>`, `push N`.
Every claim below comes from a page actually read. Where the docs are silent the entry says
**UNKNOWN — docs do not say**. Nothing here is inferred from another marketplace.

Raw fetched pages are in `./C/` (`g_<id>.txt`, `a_<api>.txt`, `p_<push>.txt`).

---

## 0. Documentation health warnings (read first)

These matter because several of them will silently make an implementation wrong.

1. **`tier_variation` is DEPRECATED as a request structure.**
   `api v2.product.init_tier_variation` update log, 2025-09-12:
   *"The tier_variation structure in the documentation has been deprecated. Please use the
   standardise_tier_variation structure when uploading variations."*
   The **request parameter table** of `init_tier_variation` now lists only
   `item_id`, `model`, `standardise_tier_variation` — `tier_variation` is **gone from the request
   schema**. Its **response** still returns `tier_variation`. But `guide 211` (updated 2025-09-19)
   and `guide 219` (updated 2024-05-28) still teach `tier_variation` everywhere, and
   `api v2.product.update_tier_variation`'s request table also lists only
   `item_id`, `model_list`, `standardise_tier_variation`. The guides are stale relative to the
   API reference. **Design against `standardise_tier_variation` + `v2.product.get_variations`.**
2. **`v2.product.support_size_chart` and `v2.product.update_size_chart` NO LONGER EXIST.**
   `guide 209 §5` and `guide 221 §7/§14` both link to them, but neither name is in the Product
   module listing (`shopee-doc.mjs modules` → module 89) and fetching either returns nothing.
   Their replacements are `get_item_limit.response.size_chart_limit` (capability probe) and the
   `size_chart_info` object on `add_item` / `update_item` (attach). See §6.
3. **`guide 221 §5` says `update_item` cannot update the size chart.** That is false today:
   `api v2.product.update_item`'s request table contains `size_chart_info`. The guide is from
   2022-11-01; the API reference is current.
4. **`guide 211 §4` price wording is self-contradictory** ("Except for SG/MY/BR/MX/PL markets, we
   support sellers to upload two decimal prices … for other marketplaces, only integers"). The
   API reference is unambiguous and wins — see §4.2.
5. **`api v2.product.update_item` update log claims a 2025-11-17 request field `has_promotion`**;
   no such field exists in its request parameter table. Ignore it.
6. **`push 4` does not exist.** `shopee-doc.mjs push 4` → `{"code":4,"error":"error_not_exists",
   "msg":"This push mechanism does not exist."}`, and `push-list` category 1000 (Product Push)
   contains only 5, 11, 13, 18, 25, 30. See §10.
7. **No rate limit is published for any API in this slice.** Every page in `./C/` reports
   `rate_limit: [0, 0, 0]` or an empty value. **UNKNOWN — docs do not say.**
8. **`guide 217`'s "Data Definition" enums are stale** for `item_status`, `input_type` and
   `input_validation_type`. Use `guide 209` / the API reference instead (§1.4, §5.2).

---

## 1. Listing model: item vs model

### 1.1 `v2.product.add_item` (`POST /api/v2/product/add_item`, type=Shop)

Required request fields (`api v2.product.add_item`):

| field | type | note |
|---|---|---|
| `item_name` | string | REQUIRED |
| `description` | string | REQUIRED when `description_type` is `normal` |
| `original_price` | float | REQUIRED |
| `weight` | float | REQUIRED, **kg** |
| `category_id` | int32 | REQUIRED, **leaf only** (`guide 211 §2.1`: non-leaf → "Invalid category id") |
| `image.image_id_list` | string[] | REQUIRED |
| `logistic_info[]` | object[] | REQUIRED; each entry needs `logistic_id` + `enabled` |

Optional but load-bearing:

- `item_status` — *"Item status, could be UNLIST or NORMAL"* (only those two on create).
- `dimension {package_length, package_width, package_height}` (cm) — optional at the API level,
  but **mandatory when the chosen channel's `fee_type` is `SIZE_INPUT`** (`guide 211 §6`), and
  `get_item_limit.dimension_limit.dimension_mandatory` says whether the category forces it.
  Error `error_param: dimension is required` exists.
- `attribute_list[]` — *"Must contain all mandatory attribute"*; see §5.2.
- `brand {brand_id, original_brand_name}` — both children are REQUIRED **inside** the object.
- `item_sku` — parent SKU, free string.
- `condition` — `NEW`/`USED`. **`api v2.product.add_item` update log 2026-09-01: "Condition is
  required for BR".** The field description also says *"Required for BR"*.
- `description_type` (`normal` | `extended`) + `description_info.extended_description.field_list[]`
  — *"Only whitelist sellers can use it"*.
- `seller_stock[] {location_id?, stock}` — the ONLY stock field. `location_id` is omitted unless
  the shop has warehouses (`guide 211 §5`: *"If the seller does not have a stock warehouse
  (currently only used by whitelist users) then there is no need to upload the location_id
  field"*). The Java code sample still shows a stale `"normal_stock": 33`; `normal_stock` was
  taken offline 2022-10-31 (`api v2.product.update_stock` update log).
- `pre_order {is_pre_order, days_to_ship}` — `days_to_ship` range from
  `get_item_limit.dts_limit` (`guide 209 §4`).
- `size_chart_info {size_chart, size_chart_id}` — see §6.
- `gtin_code`, `wholesale[]`, `video_upload_id[]` (one only), `promotion_images`,
  `purchase_limit_info`, `compatibility_info` (auto parts, `guide 378`),
  `scheduled_publish_time`, `authorised_brand_id`, `certification_info` (PH/TW),
  `tax_info` (large BR-specific block: `ncm`, `cest`, `csosn`, `origin`, `same_state_cfop`,
  `diff_state_cfop`, `measure_unit`, `pis`, `cofins`, `icms_cst`, `pis_cofins_cst`,
  `federal_state_taxes`, `operation_type`, `ex_tipi`, `fci_num`, `recopi_num`,
  `additional_info`, `group_item_info`, `export_cfop`).
  Error: `error_param: all BR tax field should be empty or be filled at same time`.
- `complaint_policy` — *"Only required for local PL sellers, ignored otherwise"*.
- `item_dangerous` — ID/MY only. `medicine_id` — ID only.

**Request shape (from the doc's own Payload sample, trimmed):**

```json
{
  "item_name": "Item Name Example",
  "description": "item description test",
  "original_price": 123.3,
  "weight": 1.1,
  "category_id": 14695,
  "item_status": "UNLIST",
  "condition": "NEW",
  "item_sku": "-",
  "dimension": { "package_height": 11, "package_length": 11, "package_width": 11 },
  "image": { "image_id_list": ["<image_id>"] },
  "logistic_info": [
    { "logistic_id": 80101, "enabled": true, "is_free": true, "size_id": 0, "shipping_fee": 23.12 }
  ],
  "attribute_list": [
    { "attribute_id": 4990,
      "attribute_value_list": [ { "value_id": 32142, "original_value_name": "Brand", "value_unit": " kg" } ] }
  ],
  "brand": { "brand_id": 0, "original_brand_name": "nike" },
  "pre_order": { "is_pre_order": true, "days_to_ship": 3 },
  "seller_stock": [ { "location_id": "-", "stock": 0 } ],
  "wholesale": [ { "min_count": 1, "max_count": 100, "unit_price": 28.3 } ],
  "video_upload_id": ["sg_f4bde9bc-…_000000"],
  "size_chart_info": { "size_chart": "<image_id>", "size_chart_id": 700024641 },
  "tax_info": { "ncm": "…", "cest": "…", "csosn": "…", "origin": "…" },
  "description_type": "normal"
}
```

**Response** (`api v2.product.add_item` → `response`): echoes the item plus
**`item_id` (int64)** — the unique identifier. Also `item_status`, `price_info
{current_price, original_price}`, `images {image_id_list, image_url_list}`, `attribute[]`,
`seller_stock[]`, `video_info[]`, `brand`, `dimension`, `condition`, `logistic_info[]`.

```json
{ "error": "", "message": "", "warning": "", "request_id": "98eae…",
  "response": { "item_id": 3000142341, "item_status": "NORMAL",
                "price_info": { "current_price": 148.02, "original_price": 148.02 },
                "images": { "image_id_list": [], "image_url_list": [] },
                "seller_stock": [ { "location_id": "", "stock": 0 } ] } }
```

### 1.2 Do item-level price/stock apply only to a no-model item? — **Yes.**

Not stated in prose, but pinned by four error strings:
- `api v2.product.update_price` → `error_edit_item_price_for_item_has_model: Can't edit item price
  directly while item has models.`
- `api v2.product.update_stock` → `error_edit_item_stock_for_item_has_model: Can't to edit item
  stock directly while item has models.` and
  `error_in_item_promotion_nomodel_to_models: Can't to edit item stock directly while item has models.`
- `api v2.product.get_item_base_info` → `price_info`: *"If the item has models, price_info will not
  be returned. Please get the price of each model through the get_model_list api"*.

Both `update_price` and `update_stock` also accept `model_id: 0` meaning *"0 for no model item"*.

### 1.3 Length / count limits

All from `api v2.product.get_item_limit` (see §11). Values there are **samples**, not constants:
name 5–100, description 10–2000, images 1–9, price 5.5–10 000 000, stock 5–10 000 000,
tier variation name ≤ 14, tier option ≤ 20, item count ≤ 50 001.
Image file constraints from `guide 211 §1.1`: **max 10 MB, JPG/JPEG/PNG**; ratio `1:1` default and
`3:4` whitelist-only (`api v2.product.add_item` → `image.image_ratio`).

### 1.4 `item_status` enum

`NORMAL, BANNED, UNLIST, SELLER_DELETE, SHOPEE_DELETE, REVIEWING` — from
`api v2.product.get_item_base_info`, `api v2.product.get_item_list` (`item_status` filter),
`api v2.product.search_item`, `api v2.product.get_item_violation_info`,
`api v2.product.get_kit_item_info`, and `push 18`.
`guide 217`'s "Data Definition" lists only the older four (`NORMAL, DELETED, BANNED, UNLIST`) —
stale; use the six-value enum.
On **create**, `add_item.item_status` accepts only `UNLIST` or `NORMAL`.

### 1.5 `unlist_item` — reversible? (**pausarAnuncio**)

`api v2.product.unlist_item` (`POST /api/v2/product/unlist_item`) takes a **batch**:

```json
{ "item_list": [ { "item_id": 2300069665, "unlist": true },
                 { "item_id": 2400143710, "unlist": false } ] }
```
`item_list` *"Length should be between 1 to 50"*. Response is per-item
`success_list[{item_id, unlist}]` / `failure_list[{item_id, failed_reason}]`.

**Reversible — yes, by the same call.** `guide 221 §6`: *"'unlist' : true means the product will be
unlist, 'unlist' : false, means the product will be re-listed."*

Caveats, all from `api v2.product.unlist_item`'s error list:
- **A running promotion blocks it**: `error_cannt_unlisted_in_promotion`,
  `error_in_item_promotion_unlsit_lock`, `error_unlist_in_promotion`
  ("Item cannot be unlisted when item is under promotion"); the doc's own response sample shows
  `failed_reason: "Can't unlist item when item is under promotion"`.
- `error_busi_cannot_delist_reviewing_or_banned_item: Banned and Reviewing Products cannot be delisted`.
- ⚠️ `error_set_normal_unlisted_item: Cannot change unlisted item status to normal directly, need to
  publishdelisted item first.` — this string is in `unlist_item`'s own error list and appears to
  contradict the `unlist:false` re-list path. The docs do not reconcile the two.
  **Treat re-list as needing a live test.**

`delete_item` is separate and is **not** the pause primitive: `guide 221 §6` — deletion makes the
item un-updatable and invisible in Seller Centre; deleted items stay readable via API for **90
days**, then are permanently removed. `api v2.product.update_stock` Definition: *"Items that are
deleted will not be allowed to modify stock."* `delete_item` also fails while a promotion runs
(`error_cannt_delete_in_promotion`, `error_in_item_promotion_delete_lock`,
`error_in_model_promotion_delete_lock`, `error_slash_price_item_delete_lock`).

---

## 2. Variations (tier variations / models)

### 2.1 Which API does what (`guide 219` Summary)

| API | Does |
|---|---|
| `init_tier_variation` | **Changes the tier STRUCTURE**: 0↔1 tier, 0↔2, 1↔2, 2↔1. Re-declares every model. |
| `update_tier_variation` | **Same structure only**: add / delete / rename options, reorder, set option image. Carries `model_list[{model_id, tier_index}]` to re-anchor surviving models. |
| `add_model` | Adds price/stock/SKU for new `tier_index` positions. |
| `update_model` | Updates `model_sku`, `pre_order`, `gtin_code`, `model_status`, `weight`, `dimension`. **Not price. Not stock.** |
| `delete_model` | Deletes one model (`item_id` + `model_id`, one per call). |

### 2.2 Limits

- **Max 2 tiers.** `api v2.product.init_tier_variation` Definition: *"Defining only color creates one
  tier, while color + size creates two tiers (maximum supported)."* `guide 211 §7` note 1:
  *"Shopee currently only supports the definition of up to 2-tier variation."*
- **Max 50 models total.** `guide 219` opening: *"The total number of variants cannot exceed 50."*
  `init_tier_variation.model` — *"Model info list, model number at most 50"*; `add_model.model_list`
  — `limits: [1,50]`; `update_model.model` — *"Length should be between 1 to 50"*.
- **Max options per tier: UNKNOWN — docs do not say.** Only the 50-model product is bounded, and
  option *string length* via `get_item_limit.tier_variation_option_length_limit` (sample max 20)
  and name length `tier_variation_name_length_limit` (sample max 14).
- `tier_index` must start at 0 and not overflow (`guide 211 §7` note 3).
- **Wait ≥ 5 s after `add_item` before `init_tier_variation`** — `guide 211 §7` note 4 and the
  `init_tier_variation` Definition: *"processing may be delayed."*

### 2.3 Model fields

`init_tier_variation.model[]` / `add_model.model_list[]`:
`tier_index` (int32[], REQUIRED), `original_price` (float, REQUIRED),
`seller_stock[{location_id?, stock}]` (REQUIRED), `model_sku` (≤ 100 chars),
`gtin_code`, `weight` (kg, model-level override), `dimension` (model-level override),
`pre_order {is_pre_order, days_to_ship}` (model-level DTS, added 2024-06-21).
*"If don't set the weight of this model, will use the weight of item by default. If set the
dimension of this model, them must set the weight of this model."*

`guide 211 §7` Scenario 2 uses `global_model_sku` in one sample and `model_sku` in the other — the
shop-level API param is **`model_sku`**; `global_model_sku` belongs to the GlobalProduct module.

### 2.4 Images per tier option

`guide 211 §7` note 2: *"You can define an image for each variant. If it is a 2-tier variation
product, you can only define the first layer of options … **Once you want to add variant images,
all the options in the first layer need to define the image.**"* Image must be uploaded via
`v2.media_space.upload_image` first. In the deprecated shape the field is
`tier_variation[].option_list[].image.image_id`; in the standardised shape it is
`standardise_tier_variation[].variation_option_list[].image_id`.

### 2.5 Renaming an option

**Yes**, and it preserves models. `guide 219 §6` Scenario 7: `update_tier_variation` with the new
option name plus `model_list` mapping each `tier_index` to its existing `model_id`.
Reordering options is the same call (`guide 219 §5` Scenario 6).

### 2.6 What happens to models when the tier structure changes

`guide 219 §2`: *"Because the tier structure has been changed, the original model information will
be removed after calling API: v2.product.init_tier_variation, which means the original
model_id: 10000 and model_id: 20000 will be invalid."*
→ **`init_tier_variation` destroys every `model_id` and mints new ones.** Any local
model_id ↔ SKU mapping must be re-read from `get_model_list` afterwards.

`guide 219 §3` Scenario 3 also shows the *deletion* trap: to delete the middle option you must
**overwrite** the vacated `tier_index` with the surviving model's `model_id`, because indices are
positional and cannot have holes. Omitting a model from `model_list` **deletes** it
(`guide 219 §3` Scenario 4 — omitting `[1,0]`/`[1,1]` removes the blue variants).
Same overwrite-by-omission hazard as `compatibility_info` (`guide 378`, §12).

### 2.7 `standardise_tier_variation` and `v2.product.get_variations`

`api v2.product.get_variations` (`category_id` → leaf) returns *"the standardized tier variation
defined by Shopee, which is currently a three-layer tree structure. The top layer is variations,
the second layer is groups, groups are used to divide options, and the third layer is options."*

```json
{ "data": { "standardise_variation_list": [
  { "variation_id": 101054, "variation_name": "Color",
    "variation_group_list": [
      { "variation_group_id": 849982774362112, "variation_group_name": "group 1",
        "variation_option_list": [ { "variation_option_id": 6245, "variation_option_name": "color-Green" } ] } ] } ] } }
```

`init_tier_variation`'s own Payload sample uses `variation_id: 0`, `variation_group_id: 0`,
`variation_option_id: 0` with free-text `variation_name` / `variation_option_name` — i.e. **0 appears
to mean "custom, not from the standard tree"**, the same convention as `attribute value_id: 0`.
This is shown only by example; **the docs never state it.**

### 2.8 `get_model_list` shape

`GET /api/v2/product/get_model_list`, request `{ "item_id": 178312 }` (one item, no batch form).

```json
{
  "request_id": "75c2b…", "error": "", "message": "", "warning": "",
  "response": {
    "tier_variation": [
      { "name": "Color",
        "option_list": [ { "option": "testsku1", "image": { "image_id": "…", "image_url": "…" } } ] }
    ],
    "standardise_tier_variation": [
      { "variation_id": 0, "variation_name": "Color", "variation_group_id": 0,
        "variation_option_list": [
          { "variation_option_id": 0, "variation_option_name": "Red", "image_id": "…", "image_url": "…" } ] }
    ],
    "model": [
      {
        "model_id": 2000458802,
        "tier_index": [0, 1],
        "model_sku": "blue bag",
        "model_status": "MODEL_NORMAL",
        "promotion_id": 0,
        "has_promotion": true,
        "price_info": [
          { "currency": "TWD", "current_price": 100.0, "original_price": 100.0,
            "inflated_price_of_current_price": 100.0, "inflated_price_of_original_price": 100.0,
            "sip_item_price": 100.0, "sip_item_price_source": "manual", "sip_item_price_currency": "CNY",
            "local_price": 122.02, "local_promotion_price": 122.02 }
        ],
        "stock_info_v2": {
          "summary_info": { "total_reserved_stock": 0, "total_available_stock": 389 },
          "seller_stock": [ { "location_id": "IDZ", "stock": 90, "if_saleable": true } ],
          "shopee_stock": [ { "location_id": "IDG", "stock": 99 } ],
          "advance_stock": { "sellable_advance_stock": 0, "in_transit_advance_stock": 0 }
        },
        "pre_order": { "is_pre_order": false, "days_to_ship": 3 },
        "gtin_code": "…",
        "weight": "1.1",
        "dimension": { "package_height": 11, "package_length": 11, "package_width": 11 },
        "is_fulfillment_by_shopee": false
      }
    ]
  }
}
```

Notes:
- `price_info` is an **array**, not an object.
- `weight` comes back as a **string** (`"1.1"`) while it is sent as a float. Wire-type asymmetry.
- `shopee_stock[].stock` is documented as **string** in `get_model_list` but **int32** in
  `get_item_base_info`. Doc inconsistency; parse tolerantly.
- `model_status`: `MODEL_NORMAL` | `MODEL_UNAVAILABLE`. *"MODEL_NORMAL models can be sold on the
  buyer's side, and MODEL_UNAVAILABLE models cannot."* ⚠️ Writing it is **not** available to a BR
  local seller: `api v2.product.update_model` → `model_status` — *"Only CNSC and KRSC sellers can
  set the model_status."* So a per-variation pause is **read-only** for a BR shop; pausing is
  item-level (`unlist_item`) or destructive (`delete_model`).
- `advance_stock` only for PH/VN/ID/MY.
- `total_available_stock` = *"Stock can be sold currently"*; `total_reserved_stock` = *"Stock
  reserved for promotion"*.
- `guide 221 §2`: `get_item_base_info.has_model` tells you whether this call is needed at all.

---

## 3. Stock

### 3.1 `v2.product.update_stock` contract

`POST /api/v2/product/update_stock`. Definition, verbatim:

> *"Use this API to update one item_id for each call, but still can support updating multiple
> model_ids stock of the same item_id (If you need batch modification, please call multiple times)
> This API will update only "seller_stock". Whenever there is a promotion ongoing or upcoming, the
> total stock must be larger than or equal to real-time "reserved_stock" promotion stock (Please
> check v2.get_item_promotion API for more details). Items that are deleted will not be allowed to
> modify stock."*

Request — `stock_list` *"Length should be between 1 to 50"*:

```json
{
  "item_id": 2000,
  "stock_list": [
    { "model_id": 3456, "seller_stock": [ { "location_id": "SGZ", "stock": 100 } ] },
    { "model_id": 1234, "seller_stock": [ { "stock": 100 } ] }
  ]
}
```
`model_id` — *"0 for no model item"*. `location_id` — *"you can get the location id from
v2.shop.get_warehouse_detail api, **if seller don't have any warehouse, you don't need to upload
this field**"*.

Response — **per-entry**, partial success is normal:

```json
{ "error": "", "message": "", "warning": "", "request_id": "…",
  "response": {
    "success_list": [ { "model_id": 3456, "location_id": "SGZ", "stock": 100 } ],
    "failure_list": [ { "model_id": 1234, "failed_reason": "…" } ] } }
```
`success_list[].location_id`/`stock` — *"This field and the stock field are returned in pairs …
returned if seller stock is used in the request"*.
There is also a top-level error `error_busi_update_stock_failed: Update stock failed, please check
failure_list for detailed reason` — **so a non-empty `error` can coexist with a populated
`failure_list`; do not read success from HTTP status or from `error == ""` alone.**

**Synchronous?** The docs never use the word. But the call returns per-model `success_list` /
`failure_list` in the response body and issues no `task_id`, in explicit contrast with
`batch_update_outlet_stock`, whose Definition is *"Create asynchronous task…"* and which returns a
`task_id`. So: results are returned inline. Whether the write is durably applied at response time
is **UNKNOWN — docs do not say**.

### 3.2 Reserved stock / promotions

- `add_item.seller_stock` and every `seller_stock` field: *"Please notice that stock (including
  Seller Stock and Shopee Stock) should be larger than or equal to real-time reserved stock"*.
- The write **fails** below reserved: `api v2.product.update_stock` errors —
  `error_auth: Total stock must be more than reserved stock.`,
  `error_auth: Stock should be larger than reserved stock.`,
  `error.param: Can not update item with stock less than reserved stock`,
  `error_param: Can not update item with stock less than reserve stock`.
- A promotion can block the write outright:
  `error_promotion_cantnot_update_stock: Cannot change stock when item is under promotion.`,
  `error_cannt_edit_stock_in_promotion: Normal_stock cannot be edited when item is under promotion.`,
  `error_model_update_stock_model_in_promotion: Model stock cannot be editted when item/model is promotion.`
- Holiday mode blocks it: `error_holiday_mode_change_stock: Cannot change stock in holiday mode.`
  (also `error_auth: Please wait for the holiday mode set then to edit item.`)
- `v2.product.get_item_promotion` (`item_id_list`, **1–50 items**) returns per item a
  `promotion[]` of `{promotion_type, promotion_id, model_id, start_time, end_time,
  promotion_price_info[{promotion_price}], promotion_staging ("ongoing"/"upcoming"),
  promotion_stock_info_v2.summary_info.total_reserved_stock}`, plus a `failure_list`.
  `guide 221 §4`: `get_item_base_info.promotion_id` returns **only one** of several promotions —
  *"we suggest you continue to call API v2.product.get_item_promotion to get all"*.
- `promotion_type` enum (`push 5` / `push 6`): `seller_discount`, `product_promotion_<market>`,
  `flash_sale` (contains `in_shop_flash_sale`, `flash_sale`, `brand_sale`), `add_on_deal_main`,
  `add_on_deal_sub`, `bundle_deal`, `group_buy`, `Platform Streaming`, `Seller Streaming`,
  `Campaign` (contains `deep_discount`, `platform_sale`, `low_price_promotion`).

### 3.3 Seller stock vs Shopee stock (FBS)

`guide 223 §5`: *"Sellers can only update seller_stock, cannot update shopee_stock."*
`guide 217` Data Definition, `stock_type`: `1: Shopee Warehouse stock`, `2: Seller stock`.
`stock_info_v2` splits them (`seller_stock[]`, `shopee_stock[]`) plus `summary_info`.
FBS errors on `update_stock`: `error_server / error_auth: The current item belong to the full FBS
(or B2C) shop, so normal stock must be equal to 0`, and
`error_wms_shop_block_upate_stock: Warehouse shop can't update stock.`
`get_model_list.is_fulfillment_by_shopee` and `get_item_base_info.is_fulfillment_by_shopee` flag it
per model/item; `v2.shop.get_shop_info.shop_fulfillment_flag` flags it per shop
(`Pure - FBS Shop`, `Pure - 3PF Shop`, `PFF - FBS Shop`, `PFF - 3PF Shop`, `LFF Hybrid Shop`,
`Others - Unknown`).

### 3.4 `location_id` semantics — multi-warehouse

`v2.shop.get_warehouse_detail` (`warehouse_type` 1 = Pickup, 2 = Return; default 1) returns
*"all warehouse with once call"*:
`{warehouse_id, warehouse_name, warehouse_type, location_id, address_id, region, state, city,
district, town, address, zipcode, state_code, holiday_mode_state}`.
`location_id` is documented as *"Location identifier for stocks. **Different location_ids represent
that your addresses are in different item stocks**"* → **yes, stock is per-warehouse**, keyed by
`location_id` (a short string, e.g. `"IDZ"`), not by `warehouse_id`.

**It is a whitelist feature.** The API's own documented error is
`warehouse.error_not_in_whitelist: Your shop is not in multi-warehouse whitelist.`, and
`guide 211 §5` says the warehouse path is *"currently only used by whitelist users"*.

The structure is **sticky**: `api v2.product.update_stock` →
`error_param: Can not update item with different stock structure. Can only update seller stock with
location id when existing seller stock have location id. Can only update seller stock without
location id when existing seller stock without location id.` Plus
`error_busi: The merchant/shop has multi warehouse, please input location id`,
`error_auth: Lack of location_id, please double check.`,
`error_auth: The location_id input is not matched the shop's location_id(more/wrong).`,
`error_auth: You do not have right to use seller location_id, please only fill seller_stock filed.`,
`error_inner: Invalid stock location ID`.

### 3.5 Rate limit

**UNKNOWN — docs do not say.** `api v2.product.update_stock` reports `rate_limit: [0, 0, 0]`, as do
all 40+ pages in this slice.

### 3.6 Batch APIs — do they apply to a normal BR shop?

| API | What it is | Applies to a normal shop? |
|---|---|---|
| `v2.product.batch_add_item` | *"Create asynchronous task to batch add item"*; `item_list` **1–100**, each entry the full `add_item` body. Returns `{ "task_id": int64 }`. | **Yes** — no outlet/mart field in the request. |
| `v2.product.batch_update_outlet_stock` | *"Create asynchronous task to batch update outlet stock"*; `item_list` 1–100, each entry **requires `outlet_shop_id`** + `item_id` + `stock_list[{model_id?, seller_stock[]}]`. Returns `task_id`. New API 2026-06-12. | **No** — Outlet-shop only. |
| `v2.product.batch_update_outlet_price` | Same shape for `price_list[{model_id?, original_price}]`; *"The value must be greater than 0."* | **No** — Outlet-shop only. |
| `v2.product.get_batch_task_result` | Poll: `{task_type, task_id}` where `task_type` = `1: price; 2: stock; 3: publish outlet; 4: add item`. Returns `publish_status` (`1: ongoing`, `2: finished`) + `success_list[{shop_id, item_id, model_id}]` / `failed_list[{…, failed_reason}]`. | Yes, for whichever task you created. |

"Outlet shop" is a distinct shop type — `v2.shop.get_shop_info` returns `is_mart_shop`,
`is_outlet_shop`, `mart_shop_id`, `outlet_shop_info_list`, `mart_outlet_structure_type`
(`normal_mart_shop`, `warehouse_mart_shop`, `normal_outlet_shop`, `warehouse_outlet_shop`).

**Bottom line for a normal BR shop: there is NO many-item stock or price API.** Stock/price sync is
one `update_stock` / `update_price` call per `item_id`, up to 50 models each. `unlist_item`
(50 items) and the read APIs `get_item_promotion` / `get_item_base_info` /
`get_item_extra_info` / `get_item_violation_info` (50 items each) are the only multi-item calls
in this slice, plus `batch_add_item` (100, async) for creation.

---

## 4. Price

### 4.1 `v2.product.update_price` contract

`POST /api/v2/product/update_price`. `price_list` *"Length should be between 1 to 50"*;
one `item_id` per call (`guide 223 §2`: *"This API only supports updating one item_id in one call"*).

```json
{ "item_id": 2000,
  "price_list": [ { "model_id": 3456, "original_price": 11.11 },
                  { "model_id": 1234, "original_price": 22.22 } ] }
```
No-model item: `{"item_id": 1000, "price_list": [{"original_price": 11.11}]}` (`guide 223 §2.1`).

```json
{ "error": "", "message": "", "warning": "", "request_id": "aaaaaaa",
  "response": {
    "success_list": [ { "model_id": 0, "original_price": 11.11 } ],
    "failure_list": [ { "model_id": 3456, "failed_reason": "fail" } ] } }
```

### 4.2 BR decimals — **two decimal places**

`api v2.product.update_price` → `original_price`:
> *"For SG/MY/BR/MX/PL/ES/AR seller: Sellers can set the price with two decimal place, other
> regions can only set the price as an integer."*

The same sentence appears on `api v2.product.get_model_list` → `price_info`. This is the
authoritative statement; `guide 211 §4`'s inverted wording is a doc bug (§0.4).
Prices are **decimal floats in major units** on the wire (`11.11`, `123.3`, `38.3`) — never centavos.
Currency comes back on the read side as `price_info[].currency` (`get_model_list`,
`get_item_base_info`). **The docs never name BRL explicitly for a BR shop** —
UNKNOWN by citation, though `currency` is returned per item.

`inflated_price_of_*` = *"price with tax"* **only for ID / CO / PL sellers**; for every other
region `inflated_price_of_current_price == current_price` (`guide 223 §1` note 3). So for BR the
inflated fields are noise. `current_price` is the promotion price while a promotion runs, and
equals `original_price` otherwise (`guide 223 §1` note 1).

### 4.3 Price refused while a promotion runs — **yes, refused, not ignored**

`guide 223 §5`: *"The product participates in certain promotion, sellers are not allow to modify the
original price of the product."*
`api v2.product.update_price` errors:
`error_cannt_edit_price_in_promotion: Original_price cannot be edited when item is under promotion.`,
`error_in_item_promotion_item_price_lock: Can't update price when item is under promotion.`,
`error_cannot_update_price_in_promotion: Price cannot be changed when model is under promotion.`
The failure surfaces per-model in `failure_list` or as a top-level `error` — nothing in the docs
suggests a silent no-op.

### 4.4 Floor / ceiling and cross-model ratio

- Absolute band: `get_item_limit.price_limit {min_limit, max_limit}` (`guide 223 §2`). Errors
  `error_price_exceed_min_limitt` / `error_price_exceed_max_limitt` / `error_price_out_of_range`.
- **Cross-variation ratio cap** (`guide 223 §5`, printed in the *stock* section but it is a *price*
  rule):
  *"If a product has variants, the price difference between the variations cannot exceed a certain
  multiple. For example, BR product, the price of the most expensive variations divided by the price
  of the cheapest variations cannot exceed 4."*

  | Region | multiple |
  |---|---|
  | **BR** | **4** |
  | SG/VN/TW/TH/PH/MX | 5 |
  | ID/MY | 7 |
  | CL/CO | 9 |
  | CNSC | 7 |

  This is a **whole-item invariant**, so a single-model price push can be rejected because of a
  *sibling* model's price. Plan price sync per item, not per model.
- Wholesale interactions: `error_busi_price_lower_then_wholesale_price`,
  `error_wholesale_price_less_than_ratio_limit`,
  `error_price_should_be_same_for_wholesales: All model price should be the same when the item has
  been set wholesales.` Threshold from
  `get_item_limit.wholesale_price_threshold_percentage {min_limit, max_limit}`.
- Slash sale: `error_slash_price_not_lowest: In slash sale, price should not be lower or same as
  slash price.`, `error_slash_price_models_diff: In slash sale, the model price should be the same.`
- Channel coupling: `error_invalid_price_for_logistic: Shipping channel cannot be enabled as product
  price exceeds limit.`

### 4.5 `push 25` — `item_price_update_push` (push_code 22)

> *"Send the push when the seller updates the original_price of the item or model."*

```json
{ "data": { "item_id": 1861418518, "model_id": 8791278571,
            "update_field": "original_price", "old_value": 119.99, "new_value": 99.99,
            "update_time": 1660124246 },
  "shop_id": 127449165, "code": 22, "timestamp": 1660124246 }
```
`update_field` is `"original_price"` or `"local_price"` (added 2025-09-08).
It carries **old and new** values — i.e. it is an echo of our own writes as well as of Seller-Centre
edits, **with no actor field**. Retry strategy `300 / 1800 / 10800` s; `push_guarantee: 0`.

---

## 5. Categories, attributes, brands

### 5.1 `v2.product.get_category`

No `category_id` request param — **returns the whole tree for the shop in one call**; optional
`language` (BR: `en` / `pt-br`).
`category_list[] {category_id, parent_category_id, original_category_name, display_category_name,
has_children}`.
`guide 209 §1.2`: `parent_category_id = 0` → level 1; **`has_children = false` → leaf, and only
leaves may be used on an item** (also `guide 211 §2.1`).
`guide 209 §1.1`: the tree is market- and seller-type-dependent — *"it is recommended to obtain it
according to shop_id"*. Categories can be blocked per market
(`add_item` error `error_category_is_block: Category is restricted`).

### 5.2 `v2.product.get_attribute_tree`

Request `category_id_list` (**max 20**, leaf categories only — `guide 209 §2`), optional `language`
(BR: `pt-BR` / `en`).

```
response.list[] = { category_id, warning, attribute_tree[] }
attribute_tree[] = {
  attribute_id, mandatory (bool), name,
  attribute_value_list[] = { value_id, name, value_unit, child_attribute_list[]  // recursive
                             , multi_lang[{language, value}] },
  attribute_info = { input_type, input_validation_type, format_type, date_format_type,
                     attribute_unit_list[], max_value_count, introduction, is_oem,
                     support_search_value },
  multi_lang[] }
```

- **Mandatory**: `mandatory: true` (`guide 209 §2.1` calls it `is_mandatory`; the API field is
  `mandatory`). `add_item` must carry all of them —
  `error_less_required_attribute` / `error_invalid_attribute: Mandatory attribute information required`.
- **`input_type`** (`guide 209 §2.2`): `1 SINGLE_DROP_DOWN`, `2 SINGLE_COMBO_BOX`,
  `3 FREE_TEXT_FILED`, `4 MULTI_DROP_DOWN`, `5 MULTI_COMBO_BOX`. Custom values allowed for 2, 3, 5.
- **`input_validation_type`**: `0 NO_VALIDATE`, `1 INT`, `2 STRING`, `3 FLOAT`, `4 DATE`.
  ⚠️ `guide 217`'s Data Definition lists the *older string* names (`INT_TYPE`, `STRING_TYPE`,
  `ENUM_TYPE`, `FLOAT_TYPE`, `TIMESTAMP_TYPE`, `DATE_TYPE`) and the old `input_type` names
  (`DROP_DOWN`, `TEXT_FILED`, `COMBO_BOX`, `MULTIPLE_SELECT`, `MULTIPLE_SELECT_COMBO_BOX`).
  **The integers in `guide 209` / `get_attribute_tree` are current; `guide 217` is stale.**
- **Units**: `format_type` `1 FORMAT_NORMAL` / `2 FORMAT_QUANTITATIVE_WITH_UNIT`. When 2, the
  allowed units are `attribute_unit_list`, and a custom value must also send `value_unit`
  (`guide 209 §2.4`, `guide 211 §2.2` example 4). In Shopee's own value list the number and the unit
  are **separate fields** (`name` = "5kg" value, `value_unit` = "kg").
- **Multi-value cap**: `max_value_count`.
- **Dates**: send a **Unix timestamp string** in `original_value_name`; reads come back formatted
  as `06/2021` or `31/06/2021` per `date_format_type` (`0 = YEAR_MONTH_DATE (DD/MM/YYYY)`,
  `1 = YEAR_MONTH (MM/YYYY)`) (`guide 209 §2.3`).
- **Parent/child attributes**: `attribute_value_list[].child_attribute_list[]` — *"To upload the
  child attribute, you must also upload the associated parent attribute"* (`guide 209 §2.5`).
- `support_search_value: true` → fetch values via `v2.product.search_attribute_value_list`
  instead of inline.

**Write shape** (`guide 211 §2.2`, its own summary): every attribute value needs a `value_id`; a
custom value is `value_id: 0` + `original_value_name` (**always a string**, whatever the underlying
type) + `value_unit` when `format_type == 2`.

```json
"attribute_list": [
  { "attribute_id": 100036, "attribute_value_list": [ { "value_id": 678 } ] },
  { "attribute_id": 100061, "attribute_value_list": [
      { "value_id": 0, "original_value_name": "12", "value_unit": "g" } ] }
]
```
Errors: `error_value_name_required`, `error_value_id_must_equal_zero`,
`error_invalid_category_attribute: Category and attribute not match.`

### 5.3 Brands

`v2.product.get_brand_list` — request `{offset, page_size (1–100), category_id (leaf), status,
language}`, `status` = `1: normal brand` / `2: pending brand` (`guide 209 §3`).
Response `brand_list[{brand_id, original_brand_name, display_brand_name}]`,
`has_next_page`, `next_offset`, plus **`is_mandatory`** (whether the category forces a brand) and
`input_type: DROP_DOWN`.

**"No Brand" is `brand_id: 0`** — `guide 209 §3`: *"Shopee provides a list of brands, including No
Brand option (brand_id: 0), you can choose this option to upload."* `add_item.brand.brand_id` sample
is `0`; `add_item` error `error_invalid_brand: Brand ID value should be "0".`;
`get_kit_item_info`'s response sample returns `{"brand_id": 0, "original_brand_name": "No brand"}`.
On write, **both** `brand_id` and `original_brand_name` are REQUIRED inside the `brand` object
(errors `Brand name required`, `Brand ID required`).

`v2.product.register_brand` — `{original_brand_name (≤254), category_list (L1 or L2 ids, 1–50),
product_image.image_id_list (≤10), brand_region, app_logo_image_id?, pc_logo_image_id?,
brand_website?, brand_description?, additional_information?, licenses[]?,
brand_registration_website?}` → `{brand_id, original_brand_name}`.
Result arrives asynchronously via **`push 13` `brand_register_result`**:
`result` ∈ `Brand Registration Successfully` | `Brand Registration Reject` |
`Brand combined with an exist brand`.
⚠️ From `push 13`'s own notes: a pending brand **can already be used** on items; on **reject**,
*"the brand name of products that have used this brand in history will be changed to 'No brand'"*;
on **merge**, the item's brand silently becomes the surviving brand (`combined_brand` in the
payload). **A `brand_id` we store can stop existing without any call of ours.**

### 5.4 `v2.product.category_recommend`

`{item_name, product_cover_image?}` (an `image_id` from `media_space.upload_image`) →
`{"category_id": [1000734, 1000382, 100093]}` — a **flat int array**. The docs do not say whether it
is a ranked candidate list or a root→leaf path. **UNKNOWN — docs do not say.**
`add_item` has a matching `ds_cat_rcmd_id` ("category recommendation service id") but never explains
where it comes from — also **UNKNOWN**.

`v2.product.get_recommend_attribute` (`{item_name, cover_image_id?, category_id}`) →
`attribute_list[{attribute_id, attribute_value_list[{value_id}]}]`.
`guide 209 §2.6`: *"Note that this API may not return the required attributes."*

### 5.5 `v2.product.get_weight_recommendation` — BR-only

*"Now only BR shop support to use this api to get recommended weight."* Takes the whole draft
(`item_name`, `cover_image_id`, `category_id`, full `attribute_list`, `brand_id`,
`description_type` + description — all REQUIRED) and returns `normal_weight_range: [0.1, 0.5]` (kg),
*"If there are no recommended results, return empty."*

---

## 6. Size charts — **this decides `tabelaDeMedidas`**

### 6.1 There are TWO different size-chart objects on an item

`api v2.product.add_item` / `api v2.product.update_item` → `size_chart_info`, verbatim:

> - `size_chart` (string) — *"ID of size chart **image**. If you want to remove the image size chart
>   of the item, please pass the "size_chart" empty. You only need to fill out either the image or
>   template. **If both are filled, only the template will be kept.** Notes: Both CB shops and local
>   shops are supported to set "size_chart"."*
> - `size_chart_id` (int64) — *"ID of **template** size chart. If you want to remove the template
>   size chart of the item, please pass the "size_chart_id" as 0. You only need to fill out either
>   the image or template. If both are filled, only the template will be kept. Notes: **Only local
>   shops are supported to set "size_chart_id"**, for CB shops please use "size_chart"."*

A BR domestic seller is a **local shop**, so both are available and `size_chart_id` (the table)
wins over `size_chart` (the image).

Reads: `get_item_base_info` returns **`size_chart` (Url of size chart image)** and
**`size_chart_id` (id of new size chart)** side by side.

### 6.2 Capability probe

`api v2.product.get_item_limit` → `response.size_chart_limit`:
```
{ "size_chart_mandatory": bool,
  "support_image_size_chart": bool,
  "support_template_size_chart": bool }
```
This is the **live** way to ask "does this leaf category take a size chart, and which kind".
`v2.product.support_size_chart` — the API `guide 209 §5` tells you to call — **does not exist**
(§0.2). `v2.global_product.support_size_chart` does exist but its Definition is
*"Only for China mainland sellers and Korean sellers"* and it is merchant-level (`merchant_id`, not
`shop_id`), so it is unusable from a BR shop. It returns only
`{ "support_size_chart": bool }` for a `category_id`.

`guide 209 §5` records the state of the world that produced this mess:
> *"Please note that we are rolling out the size chart of table type, and now only some whitelisted
> sellers can add through the seller center, open api does not support returning the categories that
> support the table size chart and uploading. So whitelisted sellers please ignore the results from
> the v2.product.support_size_chart API."*

That paragraph is what `size_chart_limit` + `get_size_chart_list/detail` superseded.

### 6.3 Reading shop-level templates

`api v2.product.get_size_chart_list ` — **note the trailing space in the module listing**; the doc
API fetches fine with and without it, and both resolve to
`POST /api/v2/product/get_size_chart_list`. Definition: *"Get new size chart list. **Now only
support local shop to use new size chart.**"* Update log: *"2026-07-01: chat拼写错误，改为chart"* —
the name was misspelled `size_chat` until 2026-07-01.

```
request : { "category_id": "100087", "page_size": "10", "cursor": "" }   // page_size Max = 50
response: { "size_chart_list": [ { "size_chart_id": 700024641 } ],
            "total_count": 3, "next_cursor": "" }
```
Cursor-paged, and **scoped to a category** — the list is "which of my shop's templates are valid
for this leaf category", not "all my templates". It returns **ids only, no names**;
`size_chart_name` only comes from the detail call. Note `category_id` and `page_size` are typed
**string** in the request table but the response sample returns `size_chart_id` as a **number**.

`api v2.product.get_size_chart_detail` — `{ "size_chart_id": 700024639 }`. Definition: *"Get new
size chart detail. Now only local shop support to use this api to get new size chart detail."*
Error example: `product.error_param: Size chart id not exist in this shop`.

**The size-chart data model (column-oriented):**

```json
{
  "response": {
    "size_chart_id": 700024639,
    "size_chart_name": "T shirt",
    "size_chart_table": {
      "column_list": [
        {
          "measurement": { "display_name": "test single input number",
                           "input_type": "Input Single Number", "unit": "cm" },
          "measurement_value_list": [ { "value": 1,    "min_value": null, "max_value": null, "option": null },
                                      { "value": 2,    "min_value": null, "max_value": null, "option": null },
                                      { "value": 3,    "min_value": null, "max_value": null, "option": null } ]
        },
        {
          "measurement": { "display_name": "weight", "input_type": "Input Range Number", "unit": "kg" },
          "measurement_value_list": [ { "value": null, "min_value": 12, "max_value": 13, "option": null },
                                      { "value": null, "min_value": 13, "max_value": 14, "option": null },
                                      { "value": null, "min_value": 14, "max_value": 16, "option": null } ]
        },
        {
          "measurement": { "display_name": "regional 001 dropdown",
                           "input_type": "Single Dropdown", "unit": "cm" },
          "measurement_value_list": [ { "value": null, "min_value": null, "max_value": null, "option": "01s" },
                                      { "value": null, "min_value": null, "max_value": null, "option": "01m" },
                                      { "value": null, "min_value": null, "max_value": null, "option": "01l" } ]
        }
      ]
    }
  }
}
```

Shape notes, all from `api v2.product.get_size_chart_detail`'s parameter table:
- A chart is **a list of COLUMNS**, each with a header (`measurement`) and a parallel
  `measurement_value_list`. Verbatim: *"new size chart is a table format which include multiple
  columns. each column has column header (measurement) and multiple values (measurement value) of
  this column."* **Rows are implicit — the i-th entry of every column is one row.** There is no row
  id, no dedicated "size label" field, and no declared row count; the size column is just another
  column (typically the `Single Dropdown` one).
- `input_type` ∈ `"Single Dropdown"` | `"Input Single Number"` | `"Input Range Number"` — verbatim
  *"there are 3 kinds of measurement type"*, given as **human-readable strings with spaces**, not
  enum codes.
- Exactly one of `option` / `value` / (`min_value`,`max_value`) is non-null per cell, keyed by the
  column's `input_type`.
- `unit` is per-column (`cm`, `kg`, …).
- ⚠️ The docs do **not** state that all columns have the same number of values. Nothing guarantees
  a rectangular table; validate it.
- There is **no chart-to-item reverse index** — you cannot ask "which items use chart X".

### 6.4 Can a seller CREATE or UPDATE a shop-level size chart through the API?

**No. Clearly and explicitly: there is no create or update endpoint for a table size chart.**

- Module 89 (Product) contains only `get_size_chart_list ` and `get_size_chart_detail` — **read-only**.
- `v2.product.update_size_chart`, which `guide 221 §7/§14` links to, **does not exist** (§0.2), and
  even as described in that guide it only ever set an **image** (*"add or update the image size
  chart of the product"*), not a table.
- `v2.global_product.update_size_chart` exists but (a) is *"Only for China mainland sellers and
  Korean sellers"*, (b) is merchant-level, and (c) its **entire** request is
  `{ "global_item_id": 3000141126, "size_chart": "c54265d475b85e00ffb2404585e32b6f" }` — an
  **image id**. **It is NOT the table data model**; there is no measurement structure in it at all.
  Its response carries no body beyond `error/message/warning/request_id`.
- `guide 209 §5`: table size charts are added *"through the seller center"* by whitelisted sellers.

**Capability verdict for `tabelaDeMedidas`:** the ERP can **discover** whether a category takes a
chart (`get_item_limit.size_chart_limit`), **list** the shop's existing templates per category,
**read** their full measurement tables, and **attach/detach** one to an item
(`size_chart_info.size_chart_id`, `0` to remove). It **cannot author or edit** one — the template
must already exist, created by a human in Seller Centre. An image-only chart *can* be produced by
the ERP (render → `media_space.upload_image` → `size_chart_info.size_chart`), but a template on the
same item overrides it.

Related error, `api v2.product.add_item`:
`product.error_busi: Upload failed, please upload a more standard size chart image.`

---

## 7. Kits / bundles — **this decides `kitVirtual`**

### 7.1 What a kit item is

`api v2.product.add_kit_item` Definition, verbatim:
> *"Create the kit item by selecting multiple items and setting main component and quantity per kit."*

`api v2.product.get_kit_item_info` Definition: *"Get the kit basic information and kit components."*

A kit item is a **first-class item with its own `item_id`** (`add_kit_item` returns
`response.item_id`), which **carries no category, no attributes and no brand of its own** — those are
**derived from the main component**. From `api v2.product.get_kit_item_info` response params,
verbatim:
- `category_id` — *"The category of this kit item, **sync from the category of the main component**
  of this kit item."*
- `attributes` — *"The attributes of this kit item, **sync from the attributes of the main
  component** of this kit item."*
- `brand_info` — *"The brand of this kit item, **sync from the brand of the main component** of this
  kit item."*
- `sync_setting.auto_sync_dts` — *"Auto sync the pre_order setting **from main component** or not."*

`v2.product.get_item_list` marks them: `item.tag.kit` (bool) — *"Indicate if the item is kit item."*
Same `tag.kit` on `get_item_base_info`. So kit items appear in the normal item list.

### 7.2 Stock — **derived, and there is no stock field anywhere**

`add_kit_item`, `update_kit_item` and `get_kit_item_info` contain **no `stock`, no `seller_stock`, no
`stock_info_v2`** — the string "stock" appears in those three pages exactly once, inside the
boilerplate gloss "SKU (stock keeping unit)". A kit's stock is therefore neither settable nor
readable through the kit APIs.

⚠️ **What the docs never say in words:** they never state *"kit stock is computed as
min(component stock / quantity)"*. That the stock derives from components is the only reading
consistent with (a) the total absence of a stock field, (b) `quantity` per component, and
(c) `component_count_limit_of_single_model`. But **the exact derivation rule is
UNKNOWN — docs do not say**, and it must be confirmed live before any stock-sync design leans on it.
Also unstated: whether ordering a kit decrements component stock, and whether a component's stock
change is echoed anywhere (`push 5` carries only reserved-stock changes).

### 7.3 Shape

`add_kit_item` request:

```json
{
  "sync_setting": { "auto_sync_dts": true },
  "item_setting": {
    "item_name": "item name sample",
    "images":      { "image_id_list": ["br-11134207-7r98o-lzri4neb5vcv18"] },   // 1:1, REQUIRED
    "long_images": { "image_id_list": ["…"] },                                   // 3:4, optional
    "video_upload_id": ["sg_…_000000"],
    "description_type": "extended",
    "description_info": { "extended_description": { "field_list": [ { "field_type": "text", "text": "…" } ] } },
    "logistic_info": [ { "logistic_id": 90003, "enabled": true } ],
    "unlisted": false,
    "item_sku": "item sku sample",
    "weight": 1,
    "dimension": { "package_length": 30, "package_width": 40, "package_height": 50 },
    "pre_order": { "is_pre_order": true, "days_to_ship": 5 },
    "tier_variation_list": [
      { "name": "variation name sample",
        "option_list": [ { "option": "Kit Variation 1", "image": { "image_id": "…" } } ] }
    ],
    "model_list": [
      { "tier_index": [0],
        "model_sku": "model sku sample",
        "original_price": 38.3,
        "component_list": [
          { "component_item_id": 892571466, "component_model_id": 18500721258, "quantity": 2, "main_component": true  },
          { "component_item_id": 885135888, "component_model_id": 9250734451,  "quantity": 3, "main_component": false }
        ] }
    ]
  }
}
```
Response: `{ "response": { "item_id": <int64> } }`.

REQUIRED in `item_setting`: `item_name`, `images`, `description_type`, `logistic_info`, `weight`,
`model_list`, `tier_variation_list` (and inside a model: `tier_index`, `original_price`,
`component_list`). Note there is **no `category_id`** and **no `attribute_list`** — by design (§7.1).
Note also `unlisted` (bool) here, versus `item_status` on a normal item.

`get_kit_item_info` returns `product_info` with `item_id, item_name, category_id, item_status,
item_sku, image/images, long_images, description_info | description, description_type, video_list,
attributes, weight, dimension, brand_info, logistic_info, pre_order_info, sync_setting,
tier_variation_list, model_list[], create_time, update_time`, where each `model_list[]` entry is
`{model_id, model_sku, original_price, tier_index[], component_list[{component_item_id,
component_item_name, component_model_id, component_model_name, component_item_or_model_image,
component_item_or_model_sku, main_component, quantity}]}`.
Its request is `item_id` annotated `limits: [0,50]` — a batch limit on a scalar field; the sample
and the response both handle **one** kit. Doc inconsistency.
⚠️ The parameter table says `images` / `long_images`, but the response **sample** returns the key
`image`. Accept both.

### 7.4 Limits (`api v2.product.get_kit_item_limit`, `add_kit_item`, `update_kit_item`)

- **Variations**: *"Only support one tier variation, and each kit item can have from **1 to 9** kit
  variations."* `model_list` — *"Model info list, model number **at most 9**"*.
  → **A kit CAN have variations, but only 1 tier and at most 9 options.** (Contrast: a normal item
  gets 2 tiers and 50 models.)
- **Components per kit variation**: `get_kit_item_limit.component_count_limit_of_single_model
  {min_limit, max_limit}` — *"Item count min/max limit that each kit variations support"*
  (samples 2 and 10). So **each kit model is composed of ≥2 and ≤10 component item/models**, and
  the real numbers must be read from the API per category.
- A component is addressed as `component_item_id` **+ optional `component_model_id`** → **a kit can
  contain variations of other items**, pinned to one specific model. Whether a component may itself
  be a kit is **UNKNOWN — docs do not say.**
- **Exactly one main component**: *"One kit item can only have one item/model as main component."*
- Price is **per kit model** (`original_price`), set directly — **not** derived from components.
  Whether `update_price` / `update_stock` accept a kit `item_id` is **UNKNOWN — docs do not say**;
  `update_kit_item` is the documented path for kit price.
- `get_kit_item_limit` also returns `price_limit`, `item_name_length_limit` (sample 5–99),
  `item_image_count_limit` (sample 1–10), `description_limit` (its own richer block with
  `description_length_min/max` **and** the extended-description sub-limits),
  `tier_variation_name_length_limit` (sample 1–50), `tier_variation_option_length_limit`
  (sample 1–50), `weight_limit.weight_mandatory`, `dimension_limit.dimension_mandatory`,
  `dts_limit {non_pre_order_days_to_ship, support_pre_order, days_to_ship_limit}`.
  ⚠️ These differ from `get_item_limit`'s (name 99 vs 100, images 10 vs 9, tier option 50 vs 20,
  and `dts_limit` gains a `support_pre_order` flag) — **kits have their OWN limits API and the
  numbers are not the same. Do not reuse `get_item_limit` for kits.**

### 7.5 `update_kit_item` — composition is effectively IMMUTABLE

Definition, verbatim:
> *"Update the kit basic information and kit components, only support **adding** kit variations and
> updating existing kit variation's **image, price, and model_sku**, don't support **deleting**
> existing kit variations and updating **the items, main component and quantity per kit** of existing
> kit variations."*

→ Once a kit model exists, its component list, its main component and its quantities are frozen.
The only compositional edit is **appending** a new kit variation. There is no `delete_kit_item`;
whether `v2.product.delete_item` accepts a kit item is **UNKNOWN — docs do not say**.

### 7.6 `generate_kit_image`

> *"This API generates a single consolidated image by combining the cover images of all selected
> items. It is typically used to create a unified product display image for kits or bundles."*

Request `component_list[{component_item_id, component_model_id?}]` — *"Please send up until 9
components."* Response `{ "kit_image": "<string>" }` — described only as *"generated kit image"*;
whether that is an `image_id` usable in `images.image_id_list` or a URL is
**UNKNOWN — docs do not say**. New API 2025-09-26.

### 7.7 Region support — Brazil

**The docs never state a region list for kit items.** What the pages *do* show: every image id in
the `add_kit_item` / `get_kit_item_info` samples is a **`br-` prefixed Shopee BR asset**
(`br-11134207-7r98o-lzri4neb5vcv18`) served from `https://cf.shopee.com.br/file/…`, and the sample
`logistic_info` is `{"logistic_id": 90003, "logistic_name": "Correios"}` — a Brazilian carrier.
That is strong evidence the feature was documented against a BR shop, **but it is evidence, not a
statement**: *which regions support kit items is* **UNKNOWN — docs do not say**, and must be
confirmed against a real BR shop. The kit APIs carry
`api_permission: ["ERP System","Seller In House System","Product Management","Swam ERP"]` — the same
set as `add_item`, so app permissions are not an extra gate. `add_kit_item` / `get_kit_item_info` /
`update_kit_item` are New API 2024-10-18; `generate_kit_image` 2025-09-26.

### 7.8 Contrast with `bundle_deal`

`bundle_deal` is a **promotion type**, not a product. It appears only in promotion enums:
`guide 217` "Product promotion type" lists `Bundle Deal` alongside Flash Sale, Wholesale, Group Buy,
Add-on Discount…; `push 5`, `push 6` and `push 7` carry `promotion_type: "bundle_deal"`; `push 7`'s
own note says a bundle_deal is a **non-reserved-stock** promotion (*"for non-reserved stock
promotion, reserved_stock field won't return"* — its sample with `bundle_deal` indeed omits it, and
carries `variation_id: 0`).
So: **`bundle_deal` discounts existing items at checkout and locks no stock; a kit item is a
separate saleable SKU with its own `item_id`, its own price and its own listing.** They are not
alternatives to each other, and neither is reachable from the other's APIs.

### 7.9 Verdict for `kitVirtual`

Shopee has a **native kit/bundle SKU** with API create + limited update + read, whose
category/attributes/brand/DTS derive from a designated main component, whose price is set per kit
variation, and whose stock has **no** API surface at all (consistent with derivation from
components; rule unstated). Constraints that will shape the ERP mapping: **1 tier / ≤9 kit
variations**, **2–10 components each** (read the real numbers from `get_kit_item_limit`), **exactly
one main component**, and **components/quantities frozen after creation** — so a kit whose recipe
changes must be recreated, not edited.

---

## 8. Product import

### 8.1 `v2.product.get_item_list` — offset paging

```
request : { "offset": 0, "page_size": 10,                     // page_size limits [1,100], Max=100
            "item_status": ["NORMAL","UNLIST"],               // REQUIRED, repeatable query param
            "update_time_from": 1611311600, "update_time_to": 1611311631 }   // optional, item update time
response: { "item": [ { "item_id": 2500139861, "item_status": "NORMAL",
                        "update_time": 1608128470, "tag": { "kit": true } } ],
            "total_count": 10, "has_next_page": true, "next_offset": 10 }
```
`item_status` is **REQUIRED**; multi-status is expressed by repeating the query key
(*"please upload the url like this: item_status=NORMAL&item_status=BANNED"*), not by a JSON array.
`update_time` is *"the last time that there was a change in value of the item, such as price/stock
change"* (`get_item_base_info`), so it is usable as a delta cursor.

### 8.2 `v2.product.get_item_base_info` — 50 ids per call

```
request : { "item_id_list": [34001, 34002],   // limits [0,50]
            "need_tax_info": true, "need_complaint_policy": true }
```
`need_tax_info` — *"if true will response tax_info"* (the whole BR fiscal block: `ncm`, `cest`,
`csosn`, `origin`, CFOPs, `measure_unit`, `pis`, `cofins`, `icms_cst`, `federal_state_taxes`, …).
`need_complaint_policy` — *"if true will response complaint_policy"* (PL in practice).
Both default off, so the fiscal fields are **absent unless asked for**.

Returns per item: `item_id, category_id, item_name, description, description_type,
extended_description, item_sku, create_time, update_time, attribute_list[] (each with
is_mandatory), price_info[] (absent when the item has models), stock_info_v2,
image{image_id_list, image_url_list, image_ratio}, weight, dimension, logistic_info[], pre_order,
condition, size_chart (URL), size_chart_id, item_status, deboost, has_model,
brand{brand_id, original_brand_name}, gtin_code, promotion_id, promotion_image, video_info[],
wholesale[], tax_info, complaint_policy, compatibility_info, scheduled_publish_time,
authorised_brand_id, ssp_id, is_fulfillment_by_shopee, tag{kit}, purchase_limit_info,
certification_info, medicine_id`.

**`has_model`** is the switch (`guide 221 §2`): false → price/stock are on the item; true → call
`get_model_list` per item.

### 8.3 `v2.product.get_model_list` — one item per call

Request is a single `item_id`. **There is no batch model-list API.** So a catalogue import is
`ceil(N/100)` list calls + `ceil(N/50)` base-info calls + **one `get_model_list` call per
variant-bearing item**.

### 8.4 Paging a 10 000-item catalogue

Per the documented limits: 100 `get_item_list` calls (offset 0…9900, `page_size` 100, driven by
`has_next_page` / `next_offset`), then 200 `get_item_base_info` calls (50 ids each), then up to
10 000 `get_model_list` calls for the items where `has_model == true`. That last leg dominates and
has no documented rate limit (§0.7) — **the throughput ceiling is unknown and must be measured.**
For a delta import, `update_time_from`/`update_time_to` on `get_item_list` collapses the first two
legs.

Related read APIs:
- `v2.product.search_item` — `{page_size (1–100), offset (**string** cursor), item_name?,
  item_sku?, attribute_status? (1 = lacking required attrs, 2 = lacking optional),
  item_status[]?, deboost_only?}` → `{item_id_list[], total_count, next_offset}`. Note it pages by
  **string** cursor while `get_item_list` pages by **int** offset. `guide 221 §1.2`: it also finds
  items lacking required/optional attributes.
- `v2.product.get_item_extra_info` — `item_id_list` (limit 50) → `{sale, views, likes, rating_star,
  comment_count}`; `guide 221 §3`: views are last-30-days, sales are cumulative.

---

## 9. Media

### 9.1 `v2.media_space.upload_image` — the product one

`POST /api/v2/media_space/upload_image`, **`type=Public`**: its common params are only
`partner_id`, `timestamp`, `sign` — **no `shop_id` and no `access_token`**. The signature base is
`partner_id + api path + timestamp + partner_key`.

Request (**multipart/form-data**):
- `image` (file, REQUIRED) — *"image files. **Max 10.0 MB each**. Image format accepted: **JPG,
  JPEG, PNG**. image number should be **less than 9**"* (Definition: *"upload multiple image files
  (less than 9 images)"*).
- `scene` (optional) — `normal` | `desc`. *"normal: we will process the image as a **square**
  image, it is recommended to use when uploading item image; desc: we will **not** process the
  image, … for extend_description"*; default `normal` (`guide 211 §1.1`).
- `ratio` (optional) — *"only applicable to whitelisted sellers. only support **1:1 and 3:4**;
  **1:1 by default**"*.

Response:
```json
{ "response": {
    "image_info": { "image_id": "…",
                    "image_url_list": [ { "image_url_region": "BR",
                                          "image_url": "https://cf.shopee.com.br/file/…" } ] },
    "image_info_list": [ { "id": 0, "error": "", "message": "",
                           "image_info": { "image_id": "…", "image_url_list": [ … ] } } ] } }
```
`image_info_list[]` is the multi-file form, `id` being *"the index of images"*, and it carries a
**per-file `error`/`message`** — partial failure again. `image_info` is the single-file convenience
field.
`guide 211 §1.1`: *"you will get the Shopee image URL accessible in each region and a unique
image_id. We recommend that you link the Shopee image URL based on the shop region. image_id is for
creating products and updating the product image information."*
`v2.media_space.upload_image` does **not** accept a URL — *"we only support image file upload, not
support URL"* (`guide 211 §1.1`), so the ERP must stream bytes.

### 9.2 Are image ids reusable across items?

**UNKNOWN — docs do not say.** No page states reuse or forbids it. What *is* documented and is
suggestive: the endpoint is partner-scoped (no `shop_id`, no `access_token`), the id is called
*"a unique image_id"*, and it is consumed by id everywhere (`image.image_id_list`,
tier-option `image_id`, `size_chart_info.size_chart`, description `image_id`,
`register_brand.product_image`, `category_recommend.product_cover_image`,
`get_weight_recommendation.cover_image_id`, `certification_proofs.image_id`). Do not treat reuse as
guaranteed until tested. Nor is any expiry documented.

### 9.3 Ratio rules

- Product images: `1:1` default; `3:4` **whitelist only**
  (`add_item.image.image_ratio`: *"Allowed ratios: "1:1" (default) "3:4" only applicable to
  whitelisted seller"*; `media_space.upload_image.ratio` says the same).
- `add_item.promotion_images`: *"Currently only allow one promotion image. You could set promotion
  image **only if the product images' ratio is 3:4**."*
- Kit items carry both explicitly: `images` = *"Item images with 1:1 ratio"*, `long_images` =
  *"Item images with 3:4 ratio"* (`add_kit_item`).
- Extended-description images are bounded by
  `get_item_limit.extended_description_limit.description_image_aspect_ratio_min/max`
  (*"aspect_ratio = image width / image height"*) plus `..._width_min` / `..._height_min`.
- `certification_proofs.ratio` (PH/TW) — *"image weight/ image height … can input 0.75 by default"*.

### 9.4 `v2.media.upload_image` is NOT for products

Definition: *"Use this API to upload images and support different business scenarios through
business and scene parameters."* Its only documented values are `business: 2 = Returns` and
`scene: 1 = Return Seller Self Arrange Pickup Proof Image`, ≤3 images, ≤10 MB, JPG/JPEG/PNG. It
returns `image_list[{image_id, image_url}]` (a flat single URL, not per-region).
**Do not use it for product media.**

### 9.5 Video (context)

`guide 211 §1.2`: max **30 MB**, **10–60 s**, **mp4**, ≤1280×1280 px; files over **4 MB must be
split into ≤4 MB parts**. Four steps: `v2.media_space.init_video_upload` (md5 and size of the
**whole** file, even when split) → `upload_video_part` (`part_seq` from 0) →
`complete_video_upload` (`part_seq_list`, `upload_cost`) → `get_video_upload_result`, or subscribe
to **push 11 `video_upload_push`**. Only when status is `SUCCEEDED` may the `video_upload_id` be
used on an item. `add_item.video_upload_id` — *"Only accept one video_upload_id."*
It can be cleared by sending an empty string (`guide 221 §5` note 2).

---

## 10. Pushes

All carry a common envelope `{ data: {...}, shop_id, code, timestamp }`, all have
`push_timeout: 3`, `push_guarantee: 0`, and retry strategy **300 / 1800 / 10800 seconds**.

### push 5 — `reserved_stock_change_push` (code 8)
> *"Get the reserved stock change log"*

`data = { shop_id, item_id, variation_id, changed_values[{name, old, new}], promotion_type,
promotion_id, action, ordersn, update_time }`.
`action` ∈ `place_order` | `cancel_order`. `changed_values[].name` sample `"reserved_stock"`.
```json
{"data":{"shop_id":1274495,"item_id":18614185187,"variation_id":87912785718,
 "changed_values":[{"name":"reserved_stock","old":4951,"new":4950}],
 "promotion_type":"flash_sale","promotion_id":104993304719361,"action":"place_order",
 "ordersn":"220810QXVJM3EX","update_time":1660124246},"shop_id":1274495,"code":8,"timestamp":1660124246}
```
⚠️ It says **`variation_id`, not `model_id`** — legacy naming for the same concept. Same in
`push 6` and `push 7`. Every *API* in this slice says `model_id`.
Note this push reports **reserved** stock, never available/seller stock. **There is no
"stock changed" push for ordinary seller stock** in the Product Push category.

### push 18 — `violation_item_push` (code 16)
> *"Get notified when item status becomes BANNED or SHOPEE_DELETE, or marked as deboost, including
> the violation type, violation reason, suggestion and fix deadline time."*

`data = { item_id, item_name, item_status, deboost, item_status_details[], deboost_details[] }`,
each detail `{violation_type, violation_reason, suggestion, fix_deadline_time, update_time}` and,
for deboost, `suggested_category[{category_id, category_name}]`.
`violation_type` ∈ `Prohibited Listing`, `Counterfeit and IP Infringement`, `Spam`,
`Inappropriate Image`, `Insufficient Information`, `Mall Listing Improvement`,
`Other Listing Improvement`. New Push 2024-01-18. The pull equivalent is
`v2.product.get_item_violation_info` (50 ids, same shape, plus per-id `fail_error`/`fail_message`
for partial failure, and error `error_param: item_status does not match latest violation`).
⚠️ Its sample uses key **`deboosted_details`** in the deboost case while the parameter table says
**`deboost_details`**. Accept both.

### push 25 — `item_price_update_push` (code 22)
See §4.5.

### push 30 — `item_scheduled_publish_failed_push` (code 27)
> *"Get notified when the product fails to publish at scheduled publish time"*
```json
{"data":{"shop_id":220904434,"item_id":885138337,"scheduled_publish_time":1725922200},
 "shop_id":220904434,"code":27,"timestamp":1725922200}
```
It carries **no reason**. Pairs with `add_item`/`update_item`'s `scheduled_publish_time`
(*"Can only set scheduled_publish_time for item with UNLIST status … Can only set the time from
current time +1hour to current time +90days, and the time is only allowed to be accurate to the
minute"*). New Push 2024-09-25.

### Does push 18 replace the older "banned item" push 4?
**There is no push 4.** `shopee-doc.mjs push 4` → `{"code":4,"error":"error_not_exists","msg":"This
push mechanism does not exist."}`, and the Product Push category (1000) in `push-list` is exactly
`5, 11, 13, 18, 25, 30`. So there is nothing for 18 to replace *in the current catalogue*; 18 is
today's only ban/deboost signal, and whether an older push once occupied id 4 is
**UNKNOWN — docs do not say**.

### Also in this slice
- **push 6 `item_promotion_push` (code 7)** — fires *"whenever an item's stock is locked/unlocked by
  promotion"*. `action` ∈ `promo_lock_stock` | `promo_cancelled` | `promo_end`, with
  `reserved_stock`, `start_time`, `end_time`. Its note is the operative stock semantics: *"When the
  item was added in promotion, **the normal stock will deduct the stock set by the promotion
  stock**, At this time, the promotion stock is also reserved_stock … When the promotion ends or
  promo_cancelled, the remaining promotion stock will be **added back** to the normal stock."*
  → **A promotion silently moves numbers under our stock sync.** Any "push our stock" job must
  reconcile against `total_reserved_stock`, not against a local expectation.
- **push 7 `promotion_update_push` (code 9)** — `action` ∈ `added_in_promo` | `removed_from_promo` |
  `promo_time_updated`. *"for reserved stock promotion (flash_sale/product_promotion),
  reserved_stock = reserved stock qty; for non-reserved stock promotion, reserved_stock field won't
  return."* `variation_id: 0` in the sample when the promotion is item-level.
- **push 13 `brand_register_result` (code 13)** — see §5.3. Note: *"Whether it is a brand registered
  by seller centre or open api, you will receive the brand review results"*, and no push is sent at
  submission time — only at resolution.

### Full Product Push category (`shopee-doc.mjs push-list`, category 1000)
`5 reserved_stock_change_push`, `11 video_upload_push`, `13 brand_register_result`,
`18 violation_item_push`, `25 item_price_update_push`, `30 item_scheduled_publish_failed_push`.
Notably **absent: any push for stock changes, item created/updated, or item unlisted.**
FBS sellable stock has its own category (2085) with `36 fbs_sellable_stock` and BR-specific
`38 fbs_br_invoice_error_push`, `39 fbs_br_block_shop_push`, `40 fbs_br_block_sku_push`,
`41 fbs_br_invoice_issued_push`.

---

## 11. Limits — `v2.product.get_item_limit`

`POST /api/v2/product/get_item_limit` (rendered as GET in the code samples), request
`{ "category_id": 400055 }` — **optional**. It is a **Shop-type** API (`shop_id` in the common
params), so the answer is scoped to *this shop* and, when given, *this category*.

Response (sample values in brackets — **they are samples, not constants**):

```
price_limit                          { min_limit [5.5],  max_limit [10000000.0] }
stock_limit                          { min_limit [5],    max_limit [10000000] }
item_name_length_limit               { min_limit [5],    max_limit [100] }
item_description_length_limit        { min_limit [10],   max_limit [2000] }
item_image_count_limit               { min_limit [1],    max_limit [9] }
item_count_limit                     { max_limit [50001] }                      // items per shop
tier_variation_name_length_limit     { min_limit [0],    max_limit [14] }
tier_variation_option_length_limit   { min_limit [0],    max_limit [20] }
wholesale_price_threshold_percentage { min_limit [30],   max_limit [100] }
extended_description_limit           { description_text_length_min/max, description_image_num_min/max,
                                       description_image_width_min, description_image_height_min,
                                       description_image_aspect_ratio_min/max }
dts_limit                            { days_to_ship_limit { min_limit, max_limit },
                                       non_pre_order_days_to_ship }
weight_limit                         { weight_mandatory }
dimension_limit                      { dimension_mandatory }
size_chart_limit                     { size_chart_mandatory, support_image_size_chart,
                                       support_template_size_chart }
gtin_limit                           { gtin_validation_rule }   // NOTE: rendered as a SIBLING of
                                                                // `response`, not inside it
```

**Do these vary by shop? — Yes.** `guide 209 §6`: *"We have certain restrictions on product
information, such as the length of characters that can be filled in the product name, the range of
product price, etc. **We have different restrictions for different markets and different types of
sellers.** You can get the limits we set through v2.product.get_item_limit API."*
And per category: `guide 209 §4` on `dts_limit` — *"If days_to_ship_limit min_limit and max_limit
return a value of **-1**, it means that the category does not support pre-sale … If the category
does not support pre-sales, the non_pre_order_days_to_ship parameter will return the shipping days
set by Shopee for this category."*
→ **Never hard-code any of these; call the API per (shop, leaf category) and cache with a TTL.**

**Not in `get_item_limit`:**
- **Tier/model count** — the 2-tier and 50-model caps come from `guide 219` /
  `init_tier_variation` / `add_model`, **not** from this API. `tier_variation_*_length_limit` bounds
  the *strings*, not the counts.
- **Kit limits** — a separate API, `v2.product.get_kit_item_limit`, with **different numbers**
  (§7.4).
- **Image file size / format** — `guide 211 §1.1` (10 MB, JPG/JPEG/PNG), not this API.
- **The cross-variation price ratio** (BR = 4×) — `guide 223 §5`, not this API.
- `gtin_limit.gtin_validation_rule` ∈ `Mandatory` | `Flexible` | `Optional`; `"00"` declares
  "item without GTIN". BR local sellers get `gtin_code` on models (`get_model_list`:
  *"Only TW seller and BR local seller available"*).
- Logistics channels — `v2.logistics.get_channel_list`; `guide 209 §7`: *"you can only choose the
  channel with **enabled=true and mask_channel_id=0**"*. `fee_type` ∈ `SIZE_SELECTION` (needs
  `size_id`), `SIZE_INPUT` (needs weight + dimension), `FIXED_DEFAULT_PRICE`,
  `CUSTOM_PRICE` (needs `shipping_fee`) — `guide 211 §6`.

---

## 12. Appendix — auto parts (`guide 378`), BR-specific

Not an attribute change; a **parallel structure** `compatibility_info` on `add_item` / `update_item`
(and echoed in `get_item_base_info`), live since 2024-06-24:

```json
"compatibility_info": { "vehicle_info_list": [
  { "brand_id": 5770, "model_id": 5911, "year_id": 5590, "version_id": 5912 },
  { "brand_id": 5508, "model_id": 5509, "year_id": 5516 },   // all versions of that year
  { "brand_id": 5770, "model_id": 5905 }                     // all years, all versions
] }
```
Hierarchy `brand > model > year > version`; omitting a level means "all". `brand_id` and `model_id`
are REQUIRED per entry, `year_id` / `version_id` optional. Sources:
`v2.product.get_all_vehicle_list` (`page_size` ≤ 100, `has_next_page` / `next_offset` paging) and
`v2.product.get_vehicle_list_by_compatibility_detail` (`compatibility_details` ∈
`Brand`/`Model`/`Year`/`Version`, refined by optional `compatibility_brand_id` etc.).
⚠️ These vehicle `brand_id`s are a **different namespace** from product brands (§5.3).

⚠️ Verbatim, and it is the same overwrite-by-omission hazard as §2.6:
> *"ATENÇÃO: Ao usar o v2.product.update_item para adicionar compatibilidade em um item que já possui
> veículos em sua lista, você deverá informar a lista de ids existente atualmente no item + os novos
> ids de compatibilidade. Caso contrário, **a lista de ids existente será sobreposta** pelos novos ids
> informados na chamada do update item."*

---

## 13. Cross-cutting notes for the integration

1. **`update_item` is field-wise merge, list-wise replace.** `guide 221 §5`: *"Fields that are
   uploaded will be updated, and fields that are not uploaded will not be updated"* — but any list
   you *do* send replaces the stored list wholesale (`compatibility_info` proves it explicitly, and
   `update_tier_variation`'s `model_list` behaves the same way). Sending a partial list deletes the
   rest.
2. **`update_item` cannot touch price, stock, models — or logistics.** Its current request table has
   no `logistic_info` (and the update log records *"2026-06-24: deprecate logistics-related fields in
   the response"*), while the **response** still returns `logistic_info`. Changing channel
   enablement after creation has **no documented API** — **UNKNOWN — docs do not say.**
   `guide 221 §5` (2022) also claims `update_item` cannot set the size chart; that is now false
   (§0.3).
3. **Every write validates the whole item.** `guide 221 §5` note 4: *"if you did not update some
   fields but encountered a prompt that these fields are filled in incorrectly, this situation is
   normal because every time you update, we will verify the legitimacy of all the product
   information."* An unrelated stale field can fail an unrelated edit — so a `update_price` that has
   worked for months can start failing because a category gained a mandatory attribute.
4. **`success_list` / `failure_list` is the house style** (`update_stock`, `update_price`,
   `unlist_item`, `get_item_promotion`, `get_batch_task_result`, `media_space.upload_image`'s
   `image_info_list`, `get_item_violation_info`'s per-id `fail_error`). **HTTP 200 + `error: ""`
   does not mean the write landed.** Every one of these must be parsed per entry, and
   `update_stock` explicitly documents `error_busi_update_stock_failed: … please check failure_list
   for detailed reason`, i.e. a non-empty `error` *and* a populated `failure_list` together.
5. **A promotion is a global write lock on the item.** It blocks price (§4.3), stock (§3.2),
   unlisting (§1.5) and deletion (§1.5). Holiday mode blocks stock and edits too. Any sync loop
   must treat "refused because of a promotion" as a normal, retry-later outcome rather than an error
   to escalate.
6. **`item_sku` / `model_sku` are free strings with no uniqueness guarantee** in the docs.
   `item_sku` can be cleared by sending `""` (`guide 221 §5` note 2, which also allows clearing
   `wholesale` and `video_upload_id` the same way). ≤100 chars for `model_sku`.
7. **Deleted items remain readable for 90 days** then vanish permanently (`guide 221 §6`) — *"if
   you need, please save the product information in time."*
8. **`get_item_limit`, `get_kit_item_limit`, `get_attribute_tree`, `get_brand_list`, `get_category`,
   `get_variations`, `get_size_chart_list`/`_detail` are all slow-changing per (shop, category)** —
   natural candidates for the monorepo's `@delfrance/data/admin/cache` read cache with a mandatory
   TTL.
9. **`access_token` expires in 4 hours** and the request `timestamp` expires in **5 minutes**
   (common params on every Shop-type API) — relevant to any long-running import job.
10. **The two open live-test questions** that this survey cannot settle from documentation:
    (a) does `unlist_item` with `unlist: false` actually re-list, given
    `error_set_normal_unlisted_item` (§1.5); and (b) how exactly kit stock derives from component
    stock (§7.2). Both must be confirmed against a real BR shop before design depends on them.
