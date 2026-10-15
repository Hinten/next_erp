# `__wire__` — Shopee response bodies, redacted

Forty-six bodies today: five for the step-5 order import (#1513), four for step
15b's package search (#1744), six for step 17's returns (#1525), four for
step 18's size charts (#1526) and twenty-seven for step 19's native kits
(#1527) — nine reads and eighteen writes. Two provenances, and they are **not
equally strong**:

| file                                               | endpoint                  | provenance                                                                                   | verified against the live API?                                                   |
| -------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `get_order_detail.qty2-sg.json`                    | `get_order_detail`        | a **real call** against the Singapore SANDBOX shop, quantity 2, `READY_TO_SHIP` (2026-09-09) | ✅ Shopee sent this                                                              |
| `get_escrow_detail.qty2-sg.json`                   | `get_escrow_detail`       | the **escrow twin of that same order**, SG sandbox (2026-09-10)                              | ✅ Shopee sent this                                                              |
| `get_order_detail.qty2-sg-processed.json`          | `get_order_detail`        | the **same order re-read after arrange-shipment**, `PROCESSED`, SG sandbox (2026-09-10)      | ✅ Shopee sent this                                                              |
| `search_package_list.sg-canais-da-loja.json`       | `search_package_list`     | the SG shop's own two channels, `invoice_pending: false` — one row (2026-10-01)              | ✅ Shopee sent this — ⚠️ ids are fixture ids, see below                          |
| `search_package_list.sg-invoice-pending-true.json` | `search_package_list`     | the same call with `invoice_pending: true` — zero rows (2026-10-01)                          | ✅ Shopee sent this                                                              |
| `search_package_list.sg-canais-turbo.json`         | `search_package_list`     | `[90011, 90012, 90026]`, channels the SG shop lacks — zero rows (2026-10-01)                 | ✅ Shopee sent this                                                              |
| `get_item_list.sg-com-kit.json`                    | `get_item_list`           | kit probe #1 (SG sandbox, 2026-10-06): the kit and its two components, `tag.kit` per row     | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `get_item_list.sg-seller-delete.json`              | `get_item_list`           | kit probe #1: the shop's deleted listings, the deleted kit first, all `SELLER_DELETE`        | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `get_item_base_info.sg-kit.json`                   | `get_item_base_info`      | kit probe #1: the kit right after `add_kit_item` — `has_model`, `tag.kit`, no stock          | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `get_kit_item_info.sg-pos-criacao.json`            | `get_kit_item_info`       | kit probe #1: the kit right after `add_kit_item` — one model, B's HIDDEN model id            | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `get_model_list.sg-kit.json`                       | `get_model_list`          | kit probe #1: the kit's one model — the only place a kit's stock can be read                 | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `get_model_list.sg-item-sem-variacao.json`         | `get_model_list`          | kit probe #1: component B (no variations) — `model: []`, the hidden id absent                | ✅ Shopee sent this                                                              |
| `get_kit_item_info.sg-apagado.json`                | `get_kit_item_info`       | kit probe #1: the same kit after `delete_item` — it still reads, `SELLER_DELETE`             | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `get_kit_item_info.sg-nao-kit.json`                | `get_kit_item_info`       | kit probe #1: a NON-kit `item_id` — `"error": "."`, "product is not found"                   | ✅ Shopee sent this                                                              |
| `get_kit_item_limit.sg-http404.json`               | `get_kit_item_limit`      | kit probe #1: a path the sandbox host does not route — HTTP 404, the bare body               | ✅ Shopee sent this — ⚠️ the 404 STATUS is not in the file                       |
| `add_kit_item.sg.json`                             | `add_kit_item`            | kit probe #1: the create that took — the identical retry of the transient refusal            | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `add_kit_item.sg-too-many-connections.json`        | `add_kit_item`            | kit probe #1: the first create — `product.error_busi`, "Too many connections"                | ✅ Shopee sent this                                                              |
| `add_kit_item.sg-corpo-vazio.json`                 | `add_kit_item`            | kit probe #1: an empty body — "virtual sku setting is empty"                                 | ✅ Shopee sent this                                                              |
| `add_kit_item.sg-dois-principais.json`             | `add_kit_item`            | kit probe #2 (SG sandbox, 2026-10-07): a main component on BOTH models                       | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `update_kit_item.sg-sem-item-id.json`              | `update_kit_item`         | kit probe #1: no `item_id` — `"error": "."`, "product is not found"                          | ✅ Shopee sent this                                                              |
| `update_kit_item.sg-parcial.json`                  | `update_kit_item`         | kit probe #2: ONE model and no tier list — the bare 200 (the other model was KEPT)           | ✅ Shopee sent this                                                              |
| `update_kit_item.sg-anexar.json`                   | `update_kit_item`         | kit probe #2: `model_id: 0` + the whole tier list — the bare 200 (it was appended)           | ✅ Shopee sent this                                                              |
| `update_kit_item.sg-quantidade-ignorada.json`      | `update_kit_item`         | kit probe #2: a QUANTITY change — the same bare 200, and the change was IGNORED              | ✅ Shopee sent this                                                              |
| `get_kit_item_info.sg-quantidade-ignorada.json`    | `get_kit_item_info`       | kit probe #2: the family kit read back after that — three models, quantities unchanged       | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `generate_kit_image.sg-toggle-fechado.json`        | `generate_kit_image`      | kit probe #1: valid ids — `product.error_server`, "generate kit image toggle closed"         | ✅ Shopee sent this                                                              |
| `generate_kit_image.sg-chaves-do-doc.json`         | `generate_kit_image`      | kit probe #1: the page's own component keys — "ItemId is required"                           | ✅ Shopee sent this                                                              |
| `generate_kit_image.sg-sem-model-id.json`          | `generate_kit_image`      | kit probe #1: a component without `model_id` — "ModelId is required"                         | ✅ Shopee sent this                                                              |
| `generate_kit_image.sg-um-componente.json`         | `generate_kit_image`      | kit probe #1: ONE component — "between 2 and 9 items"                                        | ✅ Shopee sent this                                                              |
| `update_stock.sg-kit.json`                         | `update_stock`            | kit probe #1: stock sent to a kit — refused, with `failure_list` and a `debug_message`       | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `delete_item.sg-kit.json`                          | `delete_item`             | kit probe #1: the kit deleted — `response: {}`                                               | ✅ Shopee sent this                                                              |
| `get_item_base_info.sg-kit-apagado.json`           | `get_item_base_info`      | kit probe #1: the delete's read-back — `SELLER_DELETE`, still `tag.kit: true`                | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `update_price.sg-kit.json`                         | `update_price`            | kit probe #2: one kit model's price — accepted, in `success_list`                            | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `unlist_item.sg-kit.json`                          | `unlist_item`             | kit probe #2: the family kit unlisted — accepted                                             | ✅ Shopee sent this — ⚠️ ids reassigned by role, see “Native kits”               |
| `get_order_detail.doc-masked-vn.json`              | `get_order_detail`        | the sample printed on the `v2.order.get_order_detail` reference page (a **VN** order)        | ❌ doc only — ⚠️ **unverified for BR**                                           |
| `get_escrow_detail.doc-kit.json`                   | `get_escrow_detail`       | the sample printed on the `v2.payment.get_escrow_detail` reference page                      | ❌ doc only — and one field is demonstrably a doc artefact, see “kit ids” below  |
| `search_package_list.doc.json`                     | `search_package_list`     | the sample printed on the `v2.order.search_package_list` reference page (a **VN** channel)   | ❌ doc only — a VN channel id, unverified for BR; its `sort` echo is wrong       |
| `get_return_detail.doc.json`                       | `get_return_detail`       | the sample printed on the `v2.returns.get_return_detail` reference page (an **SG** return)   | ❌ doc only — ⚠️ **unverified for BR**; three spellings contradict its own table |
| `get_return_list.doc.json`                         | `get_return_list`         | the sample printed on the `v2.returns.get_return_list` reference page                        | ❌ doc only — unverified for BR                                                  |
| `get_available_solutions.doc.json`                 | `get_available_solutions` | the sample printed on the `v2.returns.get_available_solutions` reference page                | ❌ doc only — unverified for BR                                                  |
| `confirm.doc.json`                                 | `confirm`                 | the sample printed on the `v2.returns.confirm` reference page                                | ❌ doc only — unverified for BR                                                  |
| `offer.doc.json`                                   | `offer`                   | the sample printed on the `v2.returns.offer` reference page                                  | ❌ doc only — unverified for BR                                                  |
| `accept_offer.doc.json`                            | `accept_offer`            | the sample printed on the `v2.returns.accept_offer` reference page                           | ❌ doc only — unverified for BR                                                  |
| `get_size_chart_list.doc.json`                     | `get_size_chart_list`     | the response sample printed on the `v2.product.get_size_chart_list` reference page           | ❌ doc only — unverified for BR; ids typed `string` by its own table             |
| `get_size_chart_list.doc-categoria-invalida.json`  | `get_size_chart_list`     | the ERROR example printed on that same page — `Category id is invalid`                       | ❌ doc only — unverified for BR                                                  |
| `get_size_chart_detail.doc.json`                   | `get_size_chart_detail`   | the response sample printed on the `v2.product.get_size_chart_detail` reference page         | ❌ doc only — unverified for BR; a different chart from the list's ids           |
| `get_size_chart_detail.doc-id-inexistente.json`    | `get_size_chart_detail`   | the ERROR example printed on that same page — `Size chart id not exist in this shop`         | ❌ doc only — unverified for BR                                                  |

The thirteen doc samples were pulled with `.master_plans/shopee/shopee-doc.mjs`
(`api v2.order.get_order_detail`, `api v2.payment.get_escrow_detail`,
`api v2.order.search_package_list`, `api v2.returns.<op>` for the six returns
pages, and `api v2.product.get_size_chart_list` /
`api v2.product.get_size_chart_detail` for the four size-chart bodies); the first
three sandbox bodies were pasted
from the Shopee console's own test tool, and the three `search_package_list` ones
were written by a read-only probe script (see below). The twenty-seven kit
bodies are the two step-19 kit probes' own captures, promoted with their ids
reassigned by role (see **The native-kit bodies**). The nineteen bodies before
step 19 all went through
`redactWireBody` (`../redact.ts`) before being committed — for the four
`search_package_list` bodies, the four one-id returns bodies and the four
size-chart bodies it changed nothing, since no key on those pages is denylisted
— with `request_id` dropped from every body but the first two doc samples, which
kept the page's own placeholder. `../piiScan.test.ts` re-checks every file here
independently on every run.

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
On a **return** (step 17): everything under `user`, `return_pickup_address` and
`buyer_videos`; `image[]`, `item[].images[]`, `text_reason`,
`dispute_text_reason` (string AND `string[]`), `negotiation.latest_offer_creator`,
`virtual_contact_number`, `package_query_number`, and the REVERSE leg's
`tracking_number` (`response.tracking_number`, `return[].tracking_number`).

⚠️ **A value Shopee already masked is kept verbatim** (`"****"`, `P******n`,
`******64`) — it carries nothing and it IS the shape the usable-value predicate has
to refuse. ⚠️ **An empty string is kept too**: Shopee legitimately leaves the coarse
address fields empty by region, and losing that would make “empty” and “masked”
indistinguishable in the corpus, which is the exact confusion these bodies exist to
prevent.

⚠️ **Except under a return's buyer blocks** (`REDACTED_SUBTREES_SEM_EXCECAO`:
`user`, `return_pickup_address`, `buyer_videos`), where a masked value is replaced
too. Both returns samples print a masked `user.email` (stars, two letters, a
domain), which `piiScan`'s e-mail pattern reads as a leak, and no ERP code reads
those blocks at all — the package's returns schemas STRIP them — so the masked
value there is evidence of nothing. The empty exit still holds under them.

## Repairs to the doc samples, and only these

- `get_order_detail.doc-masked-vn.json` — the page's own sample is **not valid
  JSON**: it opens with a doubled `{` and omits the comma after
  `"logistics_channel_id": 18080`. Both were repaired; **no value was changed**.
- `get_escrow_detail.doc-kit.json` — kept exactly as printed, including
  `"error": " "` and `"message": " "` (a single SPACE). That is the page's
  placeholder, not a protocol variant: `shopeeCall` treats anything but `''` as a
  failure, and this operation carries no `emptyErrorAliases`. The fixture records
  the oddity; it does not license it.
- `search_package_list.doc.json` — valid JSON as printed; only `request_id` was
  dropped. Its `sort` echo `{sort_type, is_asc}` is kept VERBATIM although the
  wire disagrees (see below): it is what the page prints.

⚠️ **kit ids.** That same sample prints `0.1` for `kit_items.original_product_id`,
`original_model_id` and `total_qty` — the page's filler value for every float,
applied to fields that are ids. `shopeeEscrowKitItemSchema` declares them
`wireInt()`, so **this body deliberately does not parse**, and it fails at exactly
that one path (`wireCorpus.test.ts` pins it). Refusing is the intended behaviour: a
rounded id is an invented id. The consequence to know is that if the LIVE API ever
sends a fractional id there, the escrow read throws `ShopeeSchemaError` and the
importer falls back to detail-only prices for that order.

## What the escrow twin settled (2026-09-10)

`get_escrow_detail.qty2-sg.json` was the slot this file used to name as empty. It
arrived, and it closed the two questions nothing else could:

1. **`SHOPEE_ESCROW_DETAIL_TRANSPORT` = `'get-query'`.** The console's test tool
   sent a **GET** with `order_sn` in the QUERY STRING and an empty body, and Shopee
   answered. The page's `method: 2` was right and its JSON request sample was
   misleading. The constant stays as the named seam.
2. **The escrow's per-item money is a LINE TOTAL.** `discounted_price: 30`,
   `original_price: 30`, `selling_price: 30` beside `quantity_purchased: 2`, while
   the SAME order's detail says `model_discounted_price: 15`. So the page's
   "subtotal if quantity exceeds 1" sentence holds, `precoUnitario`'s escrow-first
   `discounted_price ÷ quantity_purchased` is right, and the pair
   (**detail per unit, escrow per line**) is now a wire fact rather than an
   inference. Quantity 1 could not have distinguished either reading.

Three more facts from that body, each asserted in `wireCorpus.test.ts`:

- `order_income.buyer_total_amount: 31.99` = `buyer_paid_shipping_fee: 1.99` +
  `order_discounted_price: 30` — the first rung of `valorCobradoDoPedido`, and it
  agrees with the detail's `total_amount`.
- The escrow line on a **non-BR** order carries **no `is_kit` and no `kit_items`
  key at all** — absent, not `null`. The schema's `.nullable().default(null)` is
  what answers `null`, and `ehKitShopee` reads that as "unknown", never "not a kit".
- Zero-fill again (`order_chargeable_weight: 0`), plus the settlement columns step 6
  will read: `escrow_amount: 30.7`, `commission_fee: 0.65`,
  `credit_card_transaction_fee: 0.64`, `seller_transaction_fee: 0.64`.

## What the PROCESSED re-read settled

`get_order_detail.qty2-sg-processed.json` is the same order after
arrange-shipment. One order at two points in its lifecycle is the only body that
can separate what MOVES from what does not:

- **Moves**: `order_status` `READY_TO_SHIP` → `PROCESSED`, the package's
  `logistics_status` → `LOGISTICS_REQUEST_CREATED`, `update_time`
  `1788973354` → `1789042568`. Both statuses map to `pago`, so this delivery moves
  the watermark and not the estado.
- **Arrives**: `note: ""` and `note_update_time: 0` — the two tokens added to
  `SHOPEE_ORDER_DETAIL_OPTIONAL_FIELDS` after the first capture. An unnamed
  optional field comes back ABSENT (they are missing from the 2026-09-09 body
  entirely), which is why leaving them out would blank `observacoesInternas`.
- **Does not move**: the recipient is STILL `"****"` in `PROCESSED`. There is no
  whitelist on the sandbox, so "masked" and "not permitted to unmask" remain
  indistinguishable — settle-live register item 5 stands. `actual_shipping_fee` is
  still `0` (the real freight is known only after pickup) and `pickup_done_time`
  is still `0`.

## What the package search settled (step 15b, 2026-10-01)

The three `search_package_list.sg-*.json` bodies are one read-only probe against
the SG sandbox shop, sending step 15b's EXACT body (`package_status: 2`,
`fulfillment_type: 2`, `invoice_pending`, the channel list, `page_size: 100`,
ShipByDate ascending; page 1 with NO `cursor` key, which Shopee accepted). Each
fact below is asserted in `wireCorpus.test.ts`:

- **The empty answer's shape (register 223).** `packages_list: []` — an array,
  never `null` or absent — WITH `pagination {total_count: 0, more: false,
next_cursor: ""}`. The schema still tolerates both absent; the wire sends
  neither.
- **The channel filter is server-side (register 224, on SG).** Asked for
  `[90011, 90012, 90026]`, channels the shop lacks, Shopee left out the shop's own
  ready package.
- **`invoice_pending: true` filters**: the same shop's non-pending package is
  excluded. ⚠️ What `false` means — "not pending" or "no filter" — is still
  register 222, BR only: with no pending package on SG the two readings answer the
  same. The sweep's `nfePendenteNaBusca` counter is the instrument.
- **The row keys are exactly the page's six**: `order_sn`, `package_number`,
  `logistics_channel_id`, `product_location_id` (a string, as the page says),
  `sorting_group`, `is_shipment_arranged`. Four are declared; the other two ride
  `.passthrough()`.
- ⚠️ **The response `sort` echoes `{sort_type, ascending}`** — the REQUEST's key —
  where the page's response table and sample print `is_asc`. Nothing declares
  `response.sort`, so neither spelling is read.
- **The envelope key is `message`**, in the page's sample and on the wire; the
  response table's `mesage` appears in no body.
- `next_cursor` is `""` when `more` is `false`: the loop terminates on `more`,
  never on the cursor.

⚠️ **The ids in these three bodies are FIXTURE ids, not the wire's.** The probe
overwrote every `order_sn` with `260910KJBHUJDM` and every `package_number` with
`OFG000000000001` before writing (and its digit sweep had turned the latter into
`OFG1000001` in `sg-canais-da-loja`, repaired by hand to the fixture id — the only
edit made to any of the three). So the one row is the step-14 `READY_TO_SHIP`
order, NOT the quantity-2 order the `get_order_detail` bodies carry under the same
`order_sn`: that one has been `PROCESSED` since 2026-09-10 and cannot be ToProcess.
Never join two bodies here on an id.

## The returns doc samples (step 17, #1525)

The SG sandbox has **no Returns module** (`guide 644`), so nothing here was sent
by Shopee: the six `*.doc.json` returns bodies are the pages' own samples, pulled
2026-10-02, and every claim they make is ❌ unverified for BR until the
settle-live register (231–247) is read off a BR shop. What was done to them, and
only this:

- **Ids swapped for FIXTURE ids, every one** — never the page's. `order_sn` →
  `260910KJBHUJDM`; every `item_id` → `2500139861`; every `model_id` /
  `variation_id` → `2000458802` (the list's `model_id: 0`, Shopee's "no model", is
  kept — it is not an id); `return_sn` → `260910ABCDE0001` in the detail
  (ALPHANUMERIC, like the page's own sample: a digits-only guard must meet one),
  `2609100000000001` in the list row and `confirm` (the page uses one id for
  both), `2609100000000002` in `get_available_solutions`, `offer` and
  `accept_offer`. As above: **never join two bodies on an id.** The detail's
  `activity_id: 123456789` is the page's own placeholder and stays.
- `request_id` dropped, `redactWireBody` applied (the buyer blocks — see
  **Redaction**), Prettier-formatted. Valid JSON as printed; no other value was
  changed. The float literals `15.0` / `10.0` / `5.0` of `get_available_solutions`
  stay as printed (`JSON.parse` reads them as integers either way).

What they carry, each asserted in `wireCorpus.test.ts`:

- ⚠️ **No success sample has `"error": ""`**: `"-"` on the two reads, one SPACE on
  `get_available_solutions` and the three writes, `message` mirroring it. That is
  what `SHOPEE_RETURNS_ERROR_ALIASES` tolerates PER CALL SITE (never a trim), and
  these bodies are its evidence: served through a fake `fetch`, each of the six
  client operations resolves only because it carries the alias. Which value the
  live wire sends is register 231.
- The detail contradicts its own table three times: `reverse_logistic_status`
  without the `s` (register 241 — the package copies it over only when the table's
  spelling is absent), `dispute_reason: 2` as a NUMBER (`string[]` in the table)
  and `dispute_text_reason` as a STRING (`string[]` in the table and in the list
  sample). Plus `seller_compensation_status: "PENDING_REQUEST"` UNprefixed on both
  pages (register 240) and `activity[].original_price` quoted.
- The list row carries the three sub-statuses FLAT, `dispute_reason: ["UNKNOWN"]`
  and `refund_amount: 1409` (an integer on a float field), under `more: true`.
- Every buyer key on these pages (`user`, the pickup address, `image`,
  `buyer_videos`, `text_reason`, `dispute_text_reason`, the reverse
  `tracking_number`, `latest_offer_creator`) is present in the file — redacted —
  and absent from the package's parse: the returns schemas STRIP (#1525 R-11),
  and a key walk over the parse pins it against this corpus.

## The size-chart doc samples (step 18, #1526)

Nothing here was sent by Shopee either. The four `get_size_chart_*` bodies are
the two `v2.product` pages' own samples, pulled 2026-10-05: each page's
**response** sample and its printed **error example**. ⚠️ The SG sandbox may
have no size-chart templates at all — `guide 644` lists no template authoring in
the sandbox Seller Centre, and the repo's sandbox shop is SG — so whether the
list even answers there is register 260, and every claim below is ❌ unverified
for BR until register 248–258 is read off a BR shop. What was done to them, and
only this:

- `request_id` dropped, Prettier-formatted. Valid JSON as printed; **no other
  value was changed** — not even the ids, which are Shopee's own published
  sample ids (doc placeholders, not a real shop's charts). `redactWireBody`
  changes nothing: a chart is seller-authored measurement data with no buyer,
  address or document in it, and `display_name` / `size_chart_name` do not
  collide with the `recipient_address.name` suffix.
- The detail body is the PAGE's sample (`testtestt`), not survey-c §6.3's block,
  which mixes the parameter table's samples (`T shirt`, `weight`) into it.
- ⚠️ **The two error examples are the corpus's first error-only bodies.** They
  carry no `response`, so neither operation schema accepts them: they are read
  with `lerFixture` alone, and served through a fake `fetch` they reject as
  `ShopeeApiError`.

What they carry, each asserted in `wireCorpus.test.ts`:

- **Every success sample has `"error": ""`** — unlike the returns pages, no alias
  is needed.
- The list's `size_chart_id`s and `total_count` are JSON **numbers**, while the
  page's own response table types both `string` (register 248: which one the BR
  wire sends). The drained page answers `next_cursor: ""` — whether a last page
  can instead omit it, or send `null`, is register 249.
- **The two pages print DIFFERENT charts.** The detail's `size_chart_id` echo is
  `700024639`, none of the list's `700024641` / `700024613` / `700024605`. Never
  join two bodies here on an id: a list id fed to this detail is a REQUESTED id
  that its echo contradicts, which the projector reports as `id-divergente`.
- The detail is column-oriented, 3 columns × 3 cells — one column per documented
  `input_type` spelling (`Input Single Number`, `Input Range Number`,
  `Single Dropdown`, human strings WITH spaces) — and every cell carries **all
  four** value keys, `null` except the one its column's type names. One sample
  obeying that is not a guarantee: zero-filled siblings are what this wire does
  elsewhere (register 254). ⚠️ `unit: "cm"` sits on the **dropdown** column too,
  so a renderer that appends the unit to every cell would print `01s cm`.
- ⚠️ **One code, two sentences.** Both error examples answer
  `product.error_param`: `Size chart id not exist in this shop` (a stale pick)
  and `Category id is invalid` (a category the list refuses). Only the sentence
  tells them apart, which is why the classifier reads `providerMessage` and never
  the code alone (register 258).

## The native-kit bodies (step 19, #1527)

Every one of the twenty-seven was SENT by Shopee — the SG sandbox shop, answering
the two kit probes of #1527: probe #1 (2026-10-06, one kit `SONDA-KIT` with one
model) and probe #2 (2026-10-07, the family kit `SONDA-KIT2`, two models and then
a third appended). ⚠️ **The sandbox shop is SG**: none of this says a BR shop
serves kits at all (register 272).

### What was done to them, and only this

The probes' own masking flattened every run of seven or more digits to `1000001`
(ids, timestamps, the digits inside an image id, Shopee's internal error codes)
and replaced every image URL with `https://example.invalid/file/redacted` before
anything was written. A flattened id is unjoinable and ambiguous, so the
promotion put back, and only this:

- **Ids, BY ROLE** — the table below. The capture FILE names carry the roles
  (`item1` = component A, the 2-tier item; `c2` = component B, the plain item);
  the values are this corpus's own fixture ids, never Shopee's.
- **The image id** → Shopee's published doc sample
  `br-11134207-7r98o-lzri4neb5vcv18`, on every row: it was ONE image everywhere
  (component A's photo, which the probes reused for component B and both kits).
- **The category** → Shopee's doc sample `107290`, replacing the sandbox's SG
  category.
- **`create_time` / `update_time`** → ONE fixture clock per probe day:
  `1791244800` (2026-10-06T00:00:00Z) for probe #1, `1791331200`
  (2026-10-07T00:00:00Z) for probe #2. The real stamps are lost, so no test may
  read an order or an age from them.
- **Component A's `component_item_or_model_sku`** (a numeric SKU the masking
  flattened) → `KIT-COMP-A-M1` / `-M2` / `-M3`, one per model of A. The
  `SONDA-*` SKUs are the probes' own markers and stay verbatim.
- **Shopee's internal error codes inside a `message`** (`code: …`,
  `Spex error code …`) → `REDACTED`: they identify nothing this ERP models and
  no role fits them. `Error 1040` (MySQL's own code) was never masked.
- `update_stock.sg-kit`'s sandbox-only `debug_message` names the kit by its role
  id. ⚠️ `add_kit_item.sg-dois-principais` names ONE `itemId:ModelId` pair;
  the probe flagged component A as main on both kit models, and which of A's two
  models Shopee named is NOT recoverable — the corpus writes A with its model on
  the SECOND kit model. Nothing may assert on that pair.
- **Row order** of `get_item_list.sg-com-kit` (kit, A, B) is the order the probe's
  paired `get_item_base_info` read of those same ids answered.

No body carried a `request_id`; `debug_message` stays wherever Shopee sent it. All
twenty-seven are Prettier-formatted, and `redactWireBody` changes nothing on them
(no denylisted key on these pages). ⚠️ **`image.image_url_list` is NOT on that
denylist**: here the probes' own URL replacement kept the real URLs out, and a
real BR kit capture needs the path added to `../redact.ts` before it is promoted.

| role                                                                 | fixture id                  |
| -------------------------------------------------------------------- | --------------------------- |
| the kit `item_id` — BOTH probes' kit (two different kits, see below) | `2500139870`                |
| the kit's first model (`tier_index: [0]`)                            | `2000458820`                |
| component A — the 2-tier item / its model `White,02`                 | `2500139871` / `2000458821` |
| component B — the plain item, no variations                          | `2500139872`                |
| **B's hidden default model id** — in NO `get_model_list` body        | `2000458829`                |
| six unrelated listings the sandbox shop deleted in earlier probes    | `2500139881`–`2500139886`   |
| the kit's second model (`tier_index: [1]`, probe #2)                 | `2000458823`                |
| the APPENDED kit model (`tier_index: [2]`, probe #2)                 | `2000458822`                |
| component A's models `White,04` / `White,08` (probe #2)              | `2000458824` / `2000458825` |

⚠️ **Joins hold WITHIN ONE probe only.** Probe #1's kit and probe #2's kit are
two different kits that both carry the kit role `2500139870` (probe #2's bodies:
`add_kit_item.sg-dois-principais`, `update_kit_item.sg-parcial` / `-anexar` /
`-quantidade-ignorada`, `get_kit_item_info.sg-quantidade-ignorada`,
`update_price.sg-kit` and `unlist_item.sg-kit`). And never join a kit body with
the order, returns or size-chart sets. The six unrelated ids have no role.

**Not committed:** probe #1's stock sequence (`estoque/*`: no ERP code reads kit
stock, and the measurement lives in #1527 as prose), the `add_item` capture whose
`warning` belongs to step 18's register, and the duplicate reads. ⚠️ **No
synthetic body enters this directory:** the fail-closed `tag: null` list row is
derived INSIDE `kits/localizarKitPorSku.test.ts` from `get_item_list.sg-com-kit`
by a named transform, labelled synthetic there.

### What the reads settle

Each one is asserted in `wireCorpus.test.ts`:

- `get_kit_item_info` answers under `response.product_info`, with `image` (not the
  table's `images`) and a SINGULAR `long_image` that carries only
  `image_ratio: "3:4"`; `description_type: "normal"` with `description`;
  `sync_setting.auto_sync_dts`; a scalar `category_id`; and exactly ONE
  `main_component: true` in the kit.
- **The hidden model id.** Component B has no variations and was sent with no
  `component_model_id`, yet it reads back a NON-ZERO one, with `''` name and SKU —
  while B's own `get_model_list` answers `model: []`. The id exists only inside
  the kit.
- A kit's stock is readable ONLY on `get_model_list(kit)`: `stock_info_v2` with
  `total_available_stock: 1` (A had 2 at quantity 2, B had 6 at quantity 1). Its
  `get_item_base_info` carries `has_model: true`, `tag.kit: true` and no
  `stock_info_v2`.
- `tag.kit` rides the `get_item_list` ROW — `true` on the kit, `false` on both
  components — which is the duplicate-SKU scan's filter.
- A DELETED kit still reads: `get_kit_item_info` answers 200 with
  `item_status: "SELLER_DELETE"` (its channels `enabled: false`), and a list of
  the deleted statuses carries it with `tag.kit: true`.
- A NON-kit `item_id` answers `"error": "."` (literally a dot) with "product is
  not found".
- `get_kit_item_limit` is not routed by the sandbox host: HTTP **404** and the
  bare `{"error": "error_not_found"}` — no `message`, no `request_id`. ⚠️ The 404
  is NOT in the file (a capture is the body); the test serves it with 404, the
  file name says so, and the same body at 200 must stay the base `ShopeeApiError`,
  never `ShopeeOperacaoNaoServidaError`.

### What the writes settle

Each one is asserted in `wireCorpus.test.ts`:

- `add_kit_item` succeeds with `{item_id}` under `response`. Its first attempt
  failed with `product.error_busi` "… Error 1040: Too many connections …", a
  Shopee-side transient that an identical retry cured — and that is the SAME code
  as `update_stock`'s permanent refusal of a kit, so only the sentence tells them
  apart.
- **ONE main per KIT** (P2-a): a main component on both models is
  `product.error_busi` "… mupltiple main sku …" (Shopee's spelling, byte-exact).
  An empty body is `product.error_param` "virtual sku setting is empty".
- ⚠️ **`update_kit_item`'s 200 says NOTHING about what was applied.** The partial
  update, the append and the quantity change all answered the SAME bare envelope
  (`error`, `message`, `warning`, all `""`, no `response`), and the three files
  are byte-identical on purpose. Only the read-back says what happened, and for
  the quantity change it says the change was SILENTLY IGNORED: every component
  quantity of `get_kit_item_info.sg-quantidade-ignorada` is still `1`. Every kit
  write is verified by read-back. Without `item_id` the update answers the dot
  error (`… VskuId: value must be greater than 0`).
- That read-back is the family kit: ONE tier `Kit` with three options, three
  models at `tier_index` `[0]`, `[1]`, `[2]` (the third appended), ONE main in the
  whole kit (on model 0), each model its OWN model of A, and B's hidden id on all
  three.
- `generate_kit_image` never produced an image: the toggle is closed
  (`product.error_server` "… generate kit image toggle closed." — a shop setting
  under a transient-looking code), the page's own `component_item_id` keys are
  refused ("ItemId is required"), a component with no `model_id` is refused
  ("ModelId is required"), and so is a single component ("between 2 and 9
  items").
- `update_stock` on a kit is refused: `product.error_busi` "Invalid product
  setting. Please verify." WITH a `failure_list` row for the kit model.
- `delete_item` on a kit answers `response: {}`, and the read-back is
  `SELLER_DELETE` with `tag.kit: true` still set.
- `update_price` on a kit model is accepted (P2-d), and so is `unlist_item` on a
  kit (P2-e).
