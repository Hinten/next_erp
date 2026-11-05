# @delfrance/integrations-amazon-sp-api

Platform-neutral Amazon Selling Partner API library: **fetch-only**, no Firestore,
no Admin SDK, no `process.env`, no logging. The stateful half (the OAuth routes,
the credential store, the access-token cache, the sweeps) lives in `apps/amazon`.

What ships here:

| Module                  | Holds                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `lwa.ts`                | `URL_TOKEN_LWA`, `trocarRefreshToken`, `trocarCodigoAutorizacao` and `credencialLwaValida`             |
| `consentimento.ts`      | `URL_CONSENTIMENTO_BR`, `montarUrlConsentimento` (a consent URL, never sent), `applicationIdValido`    |
| `client.ts`             | `URL_BASE_SP_API`, `MARKETPLACE_ID_BR`, `criarClienteSpApi` (`get`, no body); the shared request core  |
| `escrita.ts`            | `criarClienteEscritaSpApi`: the ONE write client, `post` only (a JSON body, `escrita` deadline)        |
| `pedidos.ts`            | `searchOrders` (`buscarPedidosAtualizados`) and `getOrder` (`buscarPedido`): the two Orders reads      |
| `entrega.ts`            | Delivery: `consultarStatusNotaFiscal`, `enviarNotaFiscal`, the PascalCase status constants             |
| `tokens.ts`             | Tokens: `criarTokenRestrito`, the Restricted Data Token for the ONE resource (the Easy Ship bulk)      |
| `easyShip.ts`           | Easy Ship: `agendarPacotesEasyShip` (one order, no `packageDetails`, `labelFormat` always `ZPL`)       |
| `documentosEasyShip.ts` | The label zip: `baixarDocumentosEasyShip` (header-free GET) and `extrairEtiquetaZplEasyShip`           |
| `prazos.ts`             | `PRAZO_AMAZON_MS`, the per-call deadline keyed on the operation class                                  |
| `types.ts`              | The LWA token response and error body, the SP-API `errors[]` envelope, the Orders v2026 order          |
| `errors.ts`             | The typed errors, `lerLimiteTaxa` (`x-amzn-RateLimit-Limit`) and `lerCodigoErroLwa`                    |
| `transporte.ts`         | Internal (not re-exported): the one deadline-and-catch sequence both callers share; the order-id check |

## Operations

Every SP-API operation this package can call, with the model's default usage plan
(`x-amzn-RateLimit-Limit` reports the one actually applied, when Amazon sends it):

| Operation                           | Helper                      | Path                                     | Query sent                                                                                               | Rate (rps) | Burst |
| ----------------------------------- | --------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- | ----- |
| `searchOrders`                      | `buscarPedidosAtualizados`  | `/orders/2026-01-01/orders`              | `lastUpdatedAfter`, `marketplaceIds`, `maxResultsPerPage`, `paginationToken`?                            | 0.0056     | 20    |
| `getOrder`                          | `buscarPedido`              | `/orders/2026-01-01/orders/{orderId}`    | `includedData` only: `DADOS_INCLUIDOS_GET_ORDER` joined with `,`                                         | 0.5        | 30    |
| `getInvoiceStatus`                  | `consultarStatusNotaFiscal` | `/delivery/2022-07-01/invoice/status`    | `orderId`, `marketplaceId`, `invoiceType=Outbound`, `programType=EasyShip`                               | 1.133      | 25    |
| `submitInvoice` (POST)              | `enviarNotaFiscal`          | `/delivery/2022-07-01/invoice`           | `orderId` only; body: `invoiceContent`, `contentMD5Value`, `invoiceType`, `programType`, `marketplaceId` | 1.133      | 25    |
| `createRestrictedDataToken` (POST)  | `criarTokenRestrito`        | `/tokens/2021-03-01/restrictedDataToken` | none; body: `restrictedResources` (`POST` + the bulk path), no `dataElements`, no `targetApplication`    | 1          | 10    |
| `createScheduledPackageBulk` (POST) | `agendarPacotesEasyShip`    | `/easyShip/2022-03-23/packages/bulk`     | none; body: `marketplaceId`, `orderScheduleDetailsList` (one `amazonOrderId`), `labelFormat: 'ZPL'`      | 1          | 5     |

- Each helper builds its query (and each write its body) from NAMED keys, never a spread of
  the caller's object. `getInvoiceStatus` never sends `shipmentId` or `invoiceId`.
- The Delivery helpers check SHAPE before anything is read or sent (`AmazonConfigError`): the
  order id's 3-7-7 grammar (`pedido`), `contentMD5Value` as the base64 of a 16-byte digest — a
  hex digest is refused (`md5`) — and `invoiceContent` as standard base64 (`base64`). Computing
  them is the app's job; this package holds no crypto.
- The Delivery responses are tolerant: every field nullish, every status an OPEN string (the
  API answers PascalCase, `Accepted`; the order's own `invoiceStatus` is UPPER_SNAKE, and the
  two are never compared). `submitInvoice` takes an empty 2xx, `{}` and `{ errors: [] }` alike
  as accepted for processing.
- `createScheduledPackageBulk` is RESTRICTED: the app calls it through a write client whose
  access token is the Restricted Data Token `criarTokenRestrito` minted (with the LWA token)
  for exactly that resource. Its answer is tolerant (an empty 2xx and `{}` parse; every field
  nullish; `packageStatus`, units and `handoverMethod` are open strings), and only what is read
  is declared: the scheduled packages' ids, status, tracking id and handover method, each
  rejection's order id and `error.code`, and `printableDocumentsUrl`.
- `printableDocumentsUrl` is a pre-signed, short-lived link to a zip holding the buyer's label.
  This package never stores it or puts it in an error: `baixarDocumentosEasyShip` downloads it
  at once (below). Like every SP-API 2xx body, the answer that carries it reaches the observer
  event's `corpo`; the app's logger denies that leaf, and that is what keeps it out of a log line.
- `getOrder` requests eight datasets: `BUYER`, `RECIPIENT`, `TAX`, `PAYMENT`, `PROCEEDS`,
  `FULFILLMENT`, `PACKAGES`, `CANCELLATION`. `FULFILLMENT_ORDERS`, `EXPENSE` and
  `PROMOTION` stay out until a step reads them.
- The order schema (`pedidoWireAmazonSchema`, `types.ts`) is strict only where a key is
  built from it (`orderId`, `lastUpdatedTime`, each line's `orderItemId`): every other
  leaf is nullish, every enum-like string is open, `orderItems` and a line's quantity,
  product and price may be absent (a cancelled order), and money amounts stay unread
  (`unknown`) for the app's one money reader.

## The Easy Ship label document

`documentosEasyShip.ts` is the package's one request that is NOT an SP-API call: a `GET` of
the pre-signed object behind `printableDocumentsUrl`. It goes through neither client: no
credential, no observer event, no `onChamada`.

- **The URL** must be `https:`, with no userinfo and no port, on a host ending in
  `.amazonaws.com`; anything else is refused before anything is fetched. The model's own
  example (`https://www.amazon.com/documents.zip`) is refused by that rule.
- **The request** carries NO `headers` object at all and `redirect: 'error'`, under its own
  deadline class (`PRAZO_AMAZON_MS.documento`, 20 s). `fetch` is a REQUIRED option, never the
  global one.
- **The body** is read with a running count and cancelled past 5 MiB, and must start with a
  zip signature (an S3 XML error page is not one).
- **The extraction** keeps EXACTLY ONE entry named `*.zpl` / `*.zpl2` (any case) among at most
  64, at most 1 MiB declared (compressed and original), stored or deflate. fflate verifies
  nothing, so the inflated bytes are checked against the zip's own central-directory record
  (joined by position): the declared original size and the CRC-32. The content must hold `^XA`
  and must not start with `%PDF-`, `PK` or `<`. The label comes back verbatim; a zip or a PDF
  never does.

Every refusal is an `AmazonDocumentoEasyShipError` with a closed `motivo`, whose message never
carries the URL, a byte of the document or an entry name.

## The credential rule

- The **access token** travels in `x-amz-access-token` and nowhere else. There is
  no SigV4 and no `Authorization` header; `x-amz-date` is sent as a plain timestamp, never a
  signature. A write body that contains the access token, or that is not text and so cannot
  be checked, is refused (`token-no-corpo`) before anything is sent.
- The **client secret, refresh token and authorization code** travel only in the
  form body of the LWA token POST.
- None of them ever appears in a URL, an error, an error's `cause` or an observer
  event. A path or query carrying the access token, or a `user-agent` or `ref`
  carrying any secret, is refused before anything is sent.
- **No LWA body is ever handed to the observer** (`corpo: null`): a 200 is the token
  pair, and an error carries an `error_description`. Only the `error` code is read,
  through a closed set (`codigoLwa`). An SP-API body reaches the observer with the
  access token scrubbed, and never reaches an error.
- The **Restricted Data Token** is a credential too, and gets no structural `corpo: null`:
  `createRestrictedDataToken` is an ordinary SP-API write, so the minted token reaches the
  caller AND the observer event's `corpo` (the scrub removes only the LWA access token of
  that request). It is never cached here and never in an error; the app's logger classifies
  that path as a secret one and excerpts nothing of it, which is the only thing keeping the
  token out of a log line (`tokens.test.ts` pins that the event carries it).
- Every secret must be visible ASCII and is **never trimmed**: a token with a line
  break is a paste accident, refused rather than repaired. `credencialLwaValida`
  is that exact rule for the client id, client secret, refresh token and code,
  exported so the app can refuse a value before it spends something irreversible
  (a consent, a single-use state) on a value the exchange would refuse anyway.
- `ref` is an **opaque, non-secret label** for the credential. The package never
  computes or interprets it; it echoes it so the app can tell which credential a
  refusal belonged to. The error that refuses the token or the `ref` itself never
  carries it.
- The **`user-agent` is mandatory and the caller's**: Amazon requires one on every
  request, at most 500 characters; this package also requires printable ASCII with
  no space at either end. There is no default — the app names itself — and since
  this repository is public, never a store or brand name.

## Consent URL

`montarUrlConsentimento({ applicationId, state, redirectUri })` builds the website
authorization workflow's consent URL on `URL_CONSENTIMENTO_BR` (Seller Central, BR).
It is pure: it builds a string and sends nothing. It writes exactly four
parameters, explicitly and in this order:

1. `application_id` — the app's Solution Provider Portal id (not a secret);
2. `state` — the caller's signed, single-use value, opaque here;
3. `version=beta` — a constant: the app is in Draft (master plan D10);
4. `redirect_uri` — always explicit. On an app with more than one registered URI,
   an omitted `redirect_uri` sends the code to the FIRST registered one, which on a
   reused app is not ours. The code exchange (`trocarCodigoAutorizacao`) must then
   repeat the identical string — both go through the same `redirectUriValido`
   check (absolute `https:`, no fragment, no userinfo).

`[live-proven, legacy]` — the direct consent → redirect path, with no log-in URI
leg, is what the legacy integration used live. That Amazon honours an explicit
`redirect_uri` on the reused app is confirmed only in the migration window (D11).

An unusable value is refused with `AmazonConfigError` — `'application-id'` (empty,
over 200 characters or outside visible ASCII), `'state'` (empty or outside visible
ASCII) or `'redirect-uri'` — whose message never echoes the value.

`applicationIdValido` is the predicate `montarUrlConsentimento` refuses the
`application_id` with. It is exported so the app's push receiver refuses exactly the
same configured application ids (`AMAZON_APPLICATION_ID`) as the OAuth start.

## Errors

The non-2xx rows are checked top to bottom: 5xx, then 429, then auth, then 404, and
anything left is the catch-all.

| Response                                                                                                       | Error                                                                       |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 5xx (whatever the body says)                                                                                   | `AmazonHttpError`, `transitorio: true`                                      |
| 429                                                                                                            | `AmazonThrottleError` (`limiteTaxa` when sent)                              |
| SP-API 401 / 403                                                                                               | `AmazonAuthError` (`destino: 'sp-api'`)                                     |
| LWA 401 / 403, or a 4xx `invalid_grant` / `invalid_client` / `unauthorized_client`                             | `AmazonAuthError` (`destino: 'lwa'`, `codigoLwa`)                           |
| 404                                                                                                            | `AmazonNotFoundError`                                                       |
| Any other non-2xx (3xx, 400, 409, 413, 415, 422, …; any other LWA code, e.g. `invalid_request`)                | `AmazonHttpError`, `transitorio: false`                                     |
| 2xx that is empty, not JSON or the wrong shape (an empty `submitInvoice` 2xx is accepted instead)              | `AmazonSchemaError` (field paths only)                                      |
| A `submitInvoice` 2xx whose `errors` list is NOT empty                                                         | NOT an error class: `enviarNotaFiscal` returns `{ tipo: 'erros', codigos }` |
| DNS / TLS / reset / body dropped mid-stream                                                                    | `AmazonNetworkError`                                                        |
| The per-call deadline                                                                                          | `AmazonTimeoutError` (an `AmazonNetworkError`)                              |
| Our own input (token, ref, path, user-agent, LWA credentials, redirect URI, application id, state)             | `AmazonConfigError` — nothing was sent                                      |
| A write body holding the token or not text; a Delivery or Easy Ship order id, MD5 or base64 of the wrong shape | `AmazonConfigError` — nothing was sent                                      |
| The Easy Ship label document: its URL, download or zip (`documentosEasyShip.ts`)                               | `AmazonDocumentoEasyShipError` (`motivo`; `status` for an HTTP answer)      |

`AmazonAuthError` is the INPUT to the app's parking decision, not the decision: an
SP-API 403 also means "expired access token" (a refresh fixes it) or "missing role",
an LWA `invalid_client` refuses the app's own secret, and an `invalid_grant` from the
code exchange means the five-minute code expired or was spent. The SP-API body's
`errors[].code` rides the observer event (`codigosErro`) and, as a frozen NON-ENUMERABLE
`codigosErro` property, the HTTP error: readable by a caller that must tell two answers of one
status apart (`EntityNotFound` on a 400), never in a message or in any serialization of the
error. A 413's body is a bare array, so its codes are `[]`.

On the write client, a 2xx failing its schema, a 5xx, a timeout or a dropped connection MAY HAVE
LANDED: the caller never repeats it in the same attempt, it re-reads the provider's state.

## What it deliberately is not

- **No Firestore / Admin SDK / `@delfrance/data`.** ADR 0015: a channel package is a
  library, not a plugin, and the ERP orchestration lives in its app.
- **No SigV4.** SP-API has not required AWS signing since 2023-10-02.
- **Exactly one write client, `escrita.ts`, used only by the app's write engine.** The read
  client's `get` takes no body by construction; the SP-API writes are `submitInvoice`
  (`entrega.ts`), `createRestrictedDataToken` (`tokens.ts`) and `createScheduledPackageBulk`
  (`easyShip.ts`), and the other POST is the LWA token exchange. The request body never reaches
  the observer event.
- **One non-SP-API GET**: the Easy Ship document download (`documentosEasyShip.ts`),
  header-free, with no credential and no observer event.
- **No OAuth route, no credential store, no token cache.** The access token is
  supplied by the caller on every call.
- **No `client_credentials` (grantless) grant yet.** No pre-cutover step calls a
  grantless operation from code (`createDestination` / `createSubscription` are a
  manual action, master plan §4.26); the first planned consumer is P2's secret
  rotation, and it arrives with that step.
- **No retry, backoff or rate limiter.** A cut authorization-code exchange may have
  spent the single-use code, so it must never be retried blindly.
- **No logging.** `onChamada` is the observation hook; the step-2b logger attaches
  there and decides what is kept. An observer must never throw.
- **No body excerpt on any error.** Response text never rides an exception.
- **No `process.env`.** Every value is a parameter.
- **No resource schema before its consumer.** Each operation's arrives with the step
  that first reads it (`searchOrders`' page schema with step 4, `getOrder`'s order with
  step 5). Within step 5, the order schema and `buscarPedido` land in PR 5-a, ahead of
  their one consumer, the importer (PR 5-d of the same stack); nothing calls
  `buscarPedido` until then. Step 14 does the same: the write client and the Delivery helpers
  land in PR 14-a, and nothing calls them until the app's NF-e task (PR 14-c). So does step 15:
  the RDT, bulk and document helpers land in PR 15-a, ahead of the app code that calls them.
- **No call to Amazon from the tests** (D11). Every test injects its own `fetch`, and
  `test/_setup/semRede.ts` makes an un-injected one throw.
- **No `build` script**, deliberately: `ci.yml`'s seven-job split relies on no
  `packages/*` workspace defining one.
