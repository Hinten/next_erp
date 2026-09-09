# `__wire__` — Shopee response bodies, redacted

Three bodies today, for the step-5 order import (#1513). Two provenances, and they
are **not equally strong**:

| file                                  | endpoint            | provenance                                                                                   | verified against the live API?                                                  |
| ------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `get_order_detail.qty2-sg.json`       | `get_order_detail`  | a **real call** against the Singapore SANDBOX shop, quantity 2, `READY_TO_SHIP` (2026-09-09) | ✅ Shopee sent this                                                             |
| `get_order_detail.doc-masked-vn.json` | `get_order_detail`  | the sample printed on the `v2.order.get_order_detail` reference page (a **VN** order)        | ❌ doc only — ⚠️ **unverified for BR**                                          |
| `get_escrow_detail.doc-kit.json`      | `get_escrow_detail` | the sample printed on the `v2.payment.get_escrow_detail` reference page                      | ❌ doc only — and one field is demonstrably a doc artefact, see “kit ids” below |

Pulled with `.master_plans/shopee/shopee-doc.mjs` (`api v2.order.get_order_detail`,
`api v2.payment.get_escrow_detail`), then run through `redactWireBody`
(`../redact.ts`) before being written. `../piiScan.test.ts` re-checks every file
here independently on every run.

## Rules

- **Read them; never rewrite them.** A test that edits a body to make an assertion
  pass has turned the suite's only evidence back into a hand-written fixture. If a
  body looks wrong, the finding is about our code or about Shopee.
- **Never hand-add a file here**, and never paste a body without redacting it
  first: `piiScan.test.ts` fails on any file that is not a redaction fixpoint, but
  a leak is only undone by a rewritten history, not by a red test.
- **These files are Prettier-formatted**, like every other JSON in the repo —
  `pnpm format:check` is a CI gate and this directory is deliberately NOT in
  `.prettierignore` (Mercado Livre's `__wire__` is, because a generator writes it
  and the two would fight over the bytes). Whoever writes a capture/promote script
  for Shopee has to format its output the same way, or add the ignore entry in the
  same commit.
- **A doc sample is not evidence about the live API.** It is better than a
  hand-written fixture and worse than a capture; the table above is the whole
  claim each file makes.

## What the SG sandbox order settles

Everything below is a **wire fact**, not a guess, and each one is asserted somewhere
in the offline suite:

- `model_discounted_price: 15`, `model_quantity_purchased: 2`,
  `estimated_shipping_fee: 1.99`, `total_amount: 31.99` ⇒ **the detail price is PER
  UNIT** (`15 × 2 + 1.99 = 31.99`).
- `product_location_id` is an **array** on the order item and a **string** on the
  package item, **in the same response** — the union at both levels is not
  defensive, it is required.
- The weight key that arrives is `parcel_chargeable_weight_gram`; the parameter
  table's `parcel_chargeable_weight` did not.
- **Shopee zero-fills absent numerics**: `actual_shipping_fee: 0` while the buyer
  paid 1.99, plus `edt_from`, `edt_to`, `pickup_done_time` and
  `order_chargeable_weight_gram` all `0`. A `??` on any of those reads a zero as a
  value; only `> 0` distinguishes them.
- `invoice_data: null`, `payment_info: null`, `buyer_cpf_id: null` on a non-BR
  order — the three-way reading of `invoice_data` is real.
- `order_item_id === item_id` on this payload, so `order_item_id` is not a per-line
  identity to key on.
- `name` and `phone` came back as `"****"` (all stars) while `full_address` and
  `zipcode` were clear in the same object: masking is **per field**, and the
  all-stars spelling is a second shape beside the doc sample's partial `P******n`.

## Redaction

`redactWireBody` scrubs by **path suffix** (`REDACTED_PATH_SUFFIXES` in
`../redact.ts`) and by subtree (`geolocation`). It is type-preserving (a number
redacts to a number) and idempotent, which is what lets `piiScan` use “is this file
already a fixpoint?” as its strongest check.

**Kept deliberately:** `recipient_address.state`, `recipient_address.region`, the
order-level `region`, `order_sn`, `package_number`, `item_id`, `model_id`,
`order_item_id`, `line_item_id`. They are coarse or they are Shopee resource ids,
and every contract assertion keys on them. An `order_sn` names an order, not a
person — and the one here belongs to a disposable sandbox order.

**Redacted:** the recipient's name, phone, street address, town, district, city and
zipcode; `buyer_cpf_id`, `buyer_username`, `buyer_user_name`, `buyer_user_id`;
`payment_info.payment_processor_register` (a CNPJ) and `.transaction_id`;
`message_to_seller`, `note`, `cancel_reason`, `buyer_cancel_reason`;
`invoice_data.access_key`; `image_info.image_url`; anything under `geolocation`.

⚠️ **A value Shopee already masked is kept verbatim** (`"****"`, `P******n`,
`******64`) — it carries nothing and it IS the shape the usable-value predicate has
to refuse. ⚠️ **An empty string is kept too**: Shopee legitimately leaves the coarse
address fields empty by region, and losing that would make “empty” and “masked”
indistinguishable in the corpus, which is the exact confusion these bodies exist to
prevent.

## Repairs to the doc samples, and only these

- `get_order_detail.doc-masked-vn.json` — the page's own sample is **not valid
  JSON**: it opens with a doubled `{` and omits the comma after
  `"logistics_channel_id": 18080`. Both were repaired; **no value was changed**.
- `get_escrow_detail.doc-kit.json` — kept exactly as printed, including
  `"error": " "` and `"message": " "` (a single SPACE). That is the page's
  placeholder, not a protocol variant: `shopeeCall` treats anything but `''` as a
  failure, and this operation carries no `emptyErrorAliases`. The fixture records
  the oddity; it does not license it.

⚠️ **kit ids.** That same sample prints `0.1` for `kit_items.original_product_id`,
`original_model_id` and `total_qty` — the page's filler value for every float,
applied to fields that are ids. `shopeeEscrowKitItemSchema` declares them
`wireInt()`, so **this body deliberately does not parse**, and it fails at exactly
that one path (`wireCorpus.test.ts` pins it). Refusing is the intended behaviour: a
rounded id is an invented id. The consequence to know is that if the LIVE API ever
sends a fractional id there, the escrow read throws `ShopeeSchemaError` and the
importer falls back to detail-only prices for that order.

## The slot that is empty on purpose

`get_escrow_detail.qty2-sg.json` — the SG sandbox order's escrow twin, pending from
Lucas. It is the body that settles two things at once, and nothing else can:

1. **`SHOPEE_ESCROW_DETAIL_TRANSPORT`** — the page declares GET while its only
   request sample is a JSON body; the constant flips the verb and the placement
   together.
2. **The escrow reading of a quantity-2 line** — whether `items[].discounted_price`
   comes back `15` (per unit) or `30` (the subtotal the nine documented fields
   promise). The detail side is settled; the escrow side is not, and the price
   mapping divides by `quantity_purchased` on the strength of that sentence.

Do not invent it. An invented body answers neither question and reads like evidence.
