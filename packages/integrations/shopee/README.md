# @delfrance/integrations-shopee

Platform-neutral Shopee Open Platform library: **fetch-only**, no Firestore, no
Admin SDK, no `process.env`. The stateful half — the token store, the OAuth state
attempts, the push receiver, the sweeps — lives in `apps/shopee`.

What ships here:

| Module         | Holds                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------ |
| `sign.ts`      | The three HMAC-SHA256 base strings (public / shop / merchant) and the signed query builder |
| `hosts.ts`     | The production and sandbox API + consent hosts, and the env-override resolver              |
| `oauth.ts`     | The consent URL (Format A), `exchangeCode`, `refreshAccessToken`, `expiresAtFrom`          |
| `api.ts`       | Two typed clients — partner-scoped (public-signed) and shop-scoped                         |
| `types.ts`     | The `{ error, message, warning, request_id }` envelope and one Zod schema per operation    |
| `errors.ts`    | The typed error hierarchy and the classification of Shopee's `error` code strings          |
| `logistica.ts` | The label operations' paths, request shapes, guards and wire constants (step 15)           |
| `arquivo.ts`   | The downloaded-file shape and the byte sniff of a shipping label (step 15)                 |

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
