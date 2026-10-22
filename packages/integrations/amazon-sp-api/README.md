# @delfrance/integrations-amazon-sp-api

Platform-neutral Amazon Selling Partner API library: **fetch-only**, no Firestore,
no Admin SDK, no `process.env`, no logging. The stateful half (the OAuth routes,
the credential store, the access-token cache, the sweeps) lives in `apps/amazon`.

What ships here:

| Module             | Holds                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `lwa.ts`           | `URL_TOKEN_LWA`, `trocarRefreshToken`, `trocarCodigoAutorizacao` and `credencialLwaValida`          |
| `consentimento.ts` | `URL_CONSENTIMENTO_BR`, `montarUrlConsentimento` (a consent URL, never sent), `applicationIdValido` |
| `client.ts`        | `URL_BASE_SP_API`, `MARKETPLACE_ID_BR`, `criarClienteSpApi`: GET-only, redirects never followed     |
| `pedidos.ts`       | `buscarPedidosAtualizados`, `respostaSearchOrdersSchema`: `searchOrders`, the poll's one list read  |
| `prazos.ts`        | `PRAZO_AMAZON_MS`, the per-call deadline keyed on the operation class                               |
| `types.ts`         | The LWA token response, the LWA error body and the SP-API `errors[]` envelope — nothing else        |
| `errors.ts`        | The typed errors, `lerLimiteTaxa` (`x-amzn-RateLimit-Limit`) and `lerCodigoErroLwa`                 |
| `transporte.ts`    | Internal (not re-exported): the one deadline-and-catch sequence both callers share                  |

## The credential rule

- The **access token** travels in `x-amz-access-token` and nowhere else. There is
  no SigV4, no `Authorization` and no `x-amz-date`.
- The **client secret, refresh token and authorization code** travel only in the
  form body of the LWA token POST.
- None of them ever appears in a URL, an error, an error's `cause` or an observer
  event. A path or query carrying the access token, or a `user-agent` or `ref`
  carrying any secret, is refused before anything is sent.
- **No LWA body is ever handed to the observer** (`corpo: null`): a 200 is the token
  pair, and an error carries an `error_description`. Only the `error` code is read,
  through a closed set (`codigoLwa`). An SP-API body reaches the observer with the
  access token scrubbed, and never reaches an error.
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

| Response                                                                                           | Error                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 5xx (whatever the body says)                                                                       | `AmazonHttpError`, `transitorio: true`            |
| 429                                                                                                | `AmazonThrottleError` (`limiteTaxa` when sent)    |
| SP-API 401 / 403                                                                                   | `AmazonAuthError` (`destino: 'sp-api'`)           |
| LWA 401 / 403, or a 4xx `invalid_grant` / `invalid_client` / `unauthorized_client`                 | `AmazonAuthError` (`destino: 'lwa'`, `codigoLwa`) |
| 404                                                                                                | `AmazonNotFoundError`                             |
| Any other non-2xx (3xx, 400, 409, 413, 415, 422, …; any other LWA code, e.g. `invalid_request`)    | `AmazonHttpError`, `transitorio: false`           |
| 2xx that is empty, not JSON or the wrong shape                                                     | `AmazonSchemaError` (field paths only)            |
| DNS / TLS / reset / body dropped mid-stream                                                        | `AmazonNetworkError`                              |
| The per-call deadline                                                                              | `AmazonTimeoutError` (an `AmazonNetworkError`)    |
| Our own input (token, ref, path, user-agent, LWA credentials, redirect URI, application id, state) | `AmazonConfigError` — nothing was sent            |

`AmazonAuthError` is the INPUT to the app's parking decision, not the decision: an
SP-API 403 also means "expired access token" (a refresh fixes it) or "missing role",
an LWA `invalid_client` refuses the app's own secret, and an `invalid_grant` from the
code exchange means the five-minute code expired or was spent. The SP-API body's
`errors[].code` rides the observer event (`codigosErro`), never the error.

## What it deliberately is not

- **No Firestore / Admin SDK / `@delfrance/data`.** ADR 0015: a channel package is a
  library, not a plugin, and the ERP orchestration lives in its app.
- **No SigV4.** SP-API has not required AWS signing since 2023-10-02.
- **No SP-API write method and no request body.** Every SP-API request is a `GET` by
  construction; the only POST is the LWA token exchange.
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
  that first reads it (`searchOrders`' page schema with step 4).
- **No call to Amazon from the tests** (D11). Every test injects its own `fetch`, and
  `test/_setup/semRede.ts` makes an un-injected one throw.
- **No `build` script**, deliberately: `ci.yml`'s seven-job split relies on no
  `packages/*` workspace defining one.
