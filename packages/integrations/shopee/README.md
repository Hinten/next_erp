# @delfrance/integrations-shopee

Platform-neutral Shopee Open Platform library: **fetch-only**, no Firestore, no
Admin SDK, no `process.env`. The stateful half — the token store, the OAuth state
attempts, the push receiver, the sweeps — lives in `apps/shopee`.

What ships here:

| Module                | Holds                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `sign.ts`             | The three HMAC-SHA256 base strings (public / shop / merchant) and the signed query builder |
| `hosts.ts`            | The production and sandbox API + consent hosts, and the env-override resolver              |
| `oauth.ts`            | The consent URL (Format A), `exchangeCode`, `refreshAccessToken`, `expiresAtFrom`          |
| `api.ts`              | Two typed clients — partner-scoped (public-signed) and shop-scoped                         |
| `types.ts`            | The `{ error, message, warning, request_id }` envelope and one Zod schema per operation    |
| `errors.ts`           | The typed error hierarchy and the classification of Shopee's `error` code strings          |
| `logistica.ts`        | The label and package-search ops' paths, request shapes, guards, wire constants (15/15b)   |
| `arquivo.ts`          | The downloaded-file shape and the byte sniff of a shipping label (step 15)                 |
| `devolucoes.ts`       | The returns ops' paths, request shapes, guards, wire constants, solution reader (17)       |
| `tabelasDeMedidas.ts` | Size-chart reads: paths, shapes, guards, constants, page reader; attach union + guard (18) |

## Label operations (step 15)

Seven `v2.logistics.*` operations on the SHOP client arrange a shipment and
fetch its label: `getShippingParameter`, `shipOrder` and `getTrackingNumber`;
the batch pages `getShippingDocumentParameter`, `createShippingDocument` and
`getShippingDocumentResult` (1…50 packages each); and
`downloadShippingDocument`, which answers BYTES. Their guards run BEFORE the
access token is asked for and throw `ShopeeConfigError` naming the field, the
position and a length — never a value.

- ⚠️ **`shipOrder` is NOT idempotent and is never retried here.** A transport
  failure after it is an UNKNOWN outcome; the caller re-reads the package
  before anything is sent again.
- **`package_number` is omitted when absent, never `""`**, on every operation.
  This package sends it whenever it is given: sending it only on a SPLIT
  order's `ship_order` is the app's rule (`SHOPEE_SHIP_ORDER_PACOTE`), because
  Shopee refuses it in both directions and only the app knows how many
  packages the order has.
- **A dropoff with nothing to fill is sent as `"dropoff": {}`** — never `null`,
  never absent, as the page requires (`SHOPEE_SHIP_ORDER_DROPOFF_VAZIO`, probe
  P3; `'nulos-explicitos'` is the legacy body, never measured). Undefined
  sub-fields are dropped.
- **The bytes mode, `shopeeCallArquivo`** (`call.ts`), shares the request half
  with `shopeeCall` and reads `arrayBuffer()`, never `text()`. The FIRST
  significant byte decides, never the status or the content type: a body that
  starts with `{` or `[` (after an optional BOM and JSON whitespace) takes the
  envelope verdict, and a SUCCESS envelope is a failure too — it is never a
  label. An empty 2xx is `ShopeeArquivoVazioError`. It logs the path, status,
  length and content type of a refused body, never a byte. What format the
  bytes are is `classificarArquivoDeEnvio`'s answer (`pdf` / `zip` / `zpl`,
  each with an exact, parameter-free content type, or `desconhecido`, which the
  caller refuses).
- **`avisoEmLista`.** The three batch pages send `warning` as an ARRAY of rows,
  while the envelope's `warning` is a string. The flag lets the envelope read
  an array as a COUNT sentence (`"<n> aviso(s) por pedido/pacote"`), only after
  the strict read failed, so `onWarning` and `ShopeeApiError.warning` stay
  `string | null` and never carry a row (an `order_sn`). The operation schema
  still reads the rows.
- **`ShopeeLoteLogistico<Row>`** is what the three batch pages answer, the same
  projection for a success and for a `common.batch_api_all_failed` that
  carried at least one READABLE row (`todasFalharam: true`) — that one code,
  one module segment stripped, is the only failure read as a value; everything
  else rethrows. The verdict is per row (`falhaDaLinha`: a non-empty
  `fail_error`, code verbatim). Rows arrive in Shopee's order: reconcile them
  by `(order_sn, package_number)`, never by position, and a FAILED row carries
  no `package_number` at all.

## Package search (step 15b)

One more operation on the SHOP client, `searchPackageList` — ONE page of the
packages a shop has not shipped yet (`v2.order.search_package_list`, a POST
with the filters in a JSON body). It is an order-module path serving the
arrange flow, so its path, filter enums (`SHOPEE_PACKAGE_STATUS_FILTRO`,
`SHOPEE_FULFILLMENT_TYPE_FILTRO`, `SHOPEE_ORDER_TYPE_FILTRO`,
`SHOPEE_PACKAGE_SORT`), request shape and guard live in `logistica.ts`; it
lists and never arranges.

- **The three filters Shopee defaults are always SENT** (`package_status`,
  `fulfillment_type`, `invoice_pending` — `false` included): what
  `invoice_pending: false` filters is register 222, readable only if we know
  exactly what went out.
- **It does NOT auto-page.** Terminate on `pagination.more === false`, never on a
  row count and never on the cursor (`next_cursor` is `""` when `more` is
  false). The `cursor` key is ABSENT on page 1; `''` is refused, and a cursor is
  sent back verbatim.
- **An empty channel list is refused** — it may read as "no channel filter";
  omit the key instead. The guard runs before the access token is asked for and
  names the field, a position or a type, never a value.
- **A row is a pointer, not a verdict**: it carries no `fulfillment_status` and
  no `invoice_pending`, and ToProcess mixes LOGISTICS_READY with
  LOGISTICS_PICKUP_RETRY. Confirm with `getPackageDetail` before `shipOrder`.

## Returns (step 17)

Six `v2.returns.*` operations on the SHOP client: three reads —
`getReturnList` (ONE page), `getReturnDetail` and
`getReturnAvailableSolutions` — and the three seller actions the ERP drives —
`confirmReturn`, `offerReturn` and `acceptReturnOffer`. Their paths, request
shapes, guards and wire constants live in `devolucoes.ts`; their response
schemas in `types.ts`.

- **All six return the WHOLE parsed envelope, the reads included.** Every
  returns page samples a NON-empty `error` on success (`" "` on four, `"-"` on
  `get_return_list` and `get_return_detail`), so each of the six call sites
  carries `SHOPEE_RETURNS_ERROR_ALIASES` (`[' ', '-']`). The match is EXACT —
  `'  '`, `'\t'` and `' -'` stay failures — and per call site, never global:
  `' '` is still a failure on every other operation. A body with an alias and
  no `response` is a `ShopeeSchemaError`, never a success. The caller logs the
  observed `error` VALUE until a BR shop settles which one Shopee sends
  (register 231).
- **Buyer data never leaves the package.** The returns response schemas STRIP
  unknown keys — the one exception to "every object is `.passthrough()`" — and
  declare only what the app reads, so the buyer's name, email, pickup address,
  photos, videos, free text and the reverse tracking number do not exist past
  the parse. A field the app needs later is a one-line schema addition.
- **`return_sn` travels verbatim**: blank refused, nothing trimmed, and never a
  digits-only check — the pages' own samples are alphanumeric. Every guard runs
  BEFORE the access token is asked for and names the field, never a value.
- **`getReturnList` does not auto-page**: terminate on `more === false`.
  `page_no` is sent verbatim (page index vs entry offset is register 235); each
  time window is both bounds or neither and at most 15 days — one second past
  is refused, never truncated. No status filter is exposed.
- **`offerReturn` never picks an amount.** An absent amount sends NO key (never
  `null`, never `0`); a present one with more than two decimals is refused,
  never rounded. The min/max are per return (`getReturnAvailableSolutions`) and
  are the app's check.
- **The actions move money and are NOT idempotent** — nothing here retries,
  and nothing here decides whether an action is allowed. The dispute half
  (`dispute`, `cancel_dispute`, `upload_proof`, `convert_image`, `query_proof`,
  `get_return_dispute_reason`) is deliberately not built: both dispute writes
  REQUIRE an operator email whose source is undecided.

## Size charts (step 18)

Two `v2.product.*` READS on the SHOP client: `getSizeChartList` — ONE page of
a category's TEMPLATE size-chart ids (ids only, no names) — and
`getSizeChartDetail` — one template's column-oriented table and its name. Their
paths, request shapes, guards and wire constants live in
`tabelasDeMedidas.ts`, beside `lerPaginaDeTabelasDeMedidas`, the one reader of
a list page; their response schemas in `types.ts`. Templates are authored in
Seller Centre — there is no authoring API. The attach (`size_chart_info` on
`add_item` / `update_item`) is not one of these reads, but its write half lives
in the same module (last bullet).

- **Both are `GET` with a query string** (the pages' `method: 2`; the issue's
  POST body was a doc-reader misreading), send **no `language`** (the Product
  pages have none), unwrap `response`, and carry no trailing space in the path
  (the list page's module listing name has one; the wire path does not).
- **The continuation is THREE-valued**: `fim` (`next_cursor === ''`),
  `seguinte` (the cursor, VERBATIM — never trimmed) and `sem-cursor`
  (`next_cursor` absent or `null` — not a proof of exhaustion, register 249).
  `total_count` is never a terminator. **It does NOT auto-page**: `cursor` is
  ABSENT on page 1, `''` is refused, and the caller loops. A JSON-number cursor
  reads as its digits; an unsafe one fails the page rather than being rounded.
- **`0` is refused for every id** — `size_chart_id: 0` is the add/update
  DETACH sentinel. The list row reads `"700024641"` ≡ `700024641`; `0`,
  negatives, fractions, unsafe integers and non-numeric strings make THAT row a
  `null` (counted as `linhasIlegiveis`), never the page. The row reader and the
  detail guard refuse the same values, so a listed id can always be detailed.
  Every guard runs BEFORE the access token is asked for and names the field,
  never a value.
- **The detail is tolerant per column and per cell** with `null` sentinels that
  keep their position; `input_type` is a RAW string (three documented
  spellings, a fourth must not cost the chart). The projection into rows and
  problems is `projetarTabelaShopee` in `@delfrance/schemas`, never here.
- **A stale id and a refused category share ONE code**:
  `ShopeeApiError { code: 'product.error_param', kind: 'other' }` with
  `providerMessage` "Size chart id not exist in this shop" (detail) or
  "Category id is invalid" (list). Tell them apart by the sentence, never by
  the code alone and never by `.message`; the classifier is the app's.
- **The attach is a one-key union**, `ShopeeSizeChartInfoRequest` =
  `{ size_chart_id }` (a template) | `{ size_chart }` (an `upload_image` id),
  each arm `?: never` on the other key, so "both" and "neither" do not compile.
  `assertSizeChartInfoRequest` enforces the same at runtime — counted over
  DEFINED values, `size_chart_id` a positive safe integer, `size_chart` a
  non-blank string — and `assertAddItemParams` / `assertUpdateItemParams` call it
  before the token. It refuses both DETACH sentinels (`0`, `''`): nothing in this
  package ever sends a detach, so a caller with no match OMITS the key.

## What it deliberately is not

- **No Firestore / Admin SDK / `@delfrance/data`.** ADR 0015: a channel package is a
  library, not a plugin, and the ERP orchestration lives in its app.
- **No token store, no refresh scheduling, no lease.** `refreshAccessToken` is a pure
  wire call; persisting and serialising the rotation is step 2 of the master plan.
- **No proxy and no `undici`.** `fetch` is injected, so `apps/shopee` can compose a
  static-egress fetch when the IP whitelist lands (P2 of the master plan).
- **No retry or backoff.** `ShopeeRateLimitError` carries `kind` (`'burst'` vs
  `'daily'`) and `retryAfterSeconds`; durable retry is the Cloud Tasks pipeline.
- **No push/webhook verification.** That signature is a _different_ base string (with
  a `|` separator) and belongs with the receiver.
- **No merchant flows** beyond `merchantBaseString` existing.
- **No `build` script**, deliberately: `ci.yml`'s seven-job split relies on no
  `packages/*` workspace defining one.

## Reading the docs

Shopee's own reference is readable without a login; see the master plan
`.master_plans/shopee/shopee-marketplace-integration.md` and its `shopee-doc.mjs`
helper. Every doc contradiction this package had to take a side on is written down
as a ⚠️ comment next to the seam it affects.
