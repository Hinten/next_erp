# `__wire__` — Shopee response bodies, redacted

Nineteen bodies today: five for the step-5 order import (#1513), four for step
15b's package search (#1744), six for step 17's returns (#1525) and four for
step 18's size charts (#1526). Two provenances, and they are **not equally
strong**:

| file                                               | endpoint                  | provenance                                                                                   | verified against the live API?                                                   |
| -------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `get_order_detail.qty2-sg.json`                    | `get_order_detail`        | a **real call** against the Singapore SANDBOX shop, quantity 2, `READY_TO_SHIP` (2026-09-09) | ✅ Shopee sent this                                                              |
| `get_escrow_detail.qty2-sg.json`                   | `get_escrow_detail`       | the **escrow twin of that same order**, SG sandbox (2026-09-10)                              | ✅ Shopee sent this                                                              |
| `get_order_detail.qty2-sg-processed.json`          | `get_order_detail`        | the **same order re-read after arrange-shipment**, `PROCESSED`, SG sandbox (2026-09-10)      | ✅ Shopee sent this                                                              |
| `search_package_list.sg-canais-da-loja.json`       | `search_package_list`     | the SG shop's own two channels, `invoice_pending: false` — one row (2026-10-01)              | ✅ Shopee sent this — ⚠️ ids are fixture ids, see below                          |
| `search_package_list.sg-invoice-pending-true.json` | `search_package_list`     | the same call with `invoice_pending: true` — zero rows (2026-10-01)                          | ✅ Shopee sent this                                                              |
| `search_package_list.sg-canais-turbo.json`         | `search_package_list`     | `[90011, 90012, 90026]`, channels the SG shop lacks — zero rows (2026-10-01)                 | ✅ Shopee sent this                                                              |
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
were written by a read-only probe script (see below). All nineteen went through
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
