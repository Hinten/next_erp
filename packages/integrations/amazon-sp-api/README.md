# @delfrance/integrations-amazon-sp-api

Platform-neutral Amazon Selling Partner API library: **fetch-only**, no Firestore,
no Admin SDK, no `process.env`, no logging. The stateful half (the OAuth routes,
the credential store, the access-token cache, the sweeps) will live in `apps/amazon`:
step 1 PR b adds the app, and the OAuth routes, credential store and token cache
arrive in step 2.

What ships here:

| Module          | Holds                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `lwa.ts`        | `URL_TOKEN_LWA`, `trocarRefreshToken` and `trocarCodigoAutorizacao`, the two LWA exchanges      |
| `client.ts`     | `URL_BASE_SP_API`, `MARKETPLACE_ID_BR`, `criarClienteSpApi`: GET-only, redirects never followed |
| `prazos.ts`     | `PRAZO_AMAZON_MS`, the per-call deadline keyed on the operation class                           |
| `types.ts`      | The LWA token response, the LWA error body and the SP-API `errors[]` envelope — nothing else    |
| `errors.ts`     | The typed errors, `lerLimiteTaxa` (`x-amzn-RateLimit-Limit`) and `lerCodigoErroLwa`             |
| `transporte.ts` | Internal (not re-exported): the one deadline-and-catch sequence both callers share              |

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
  break is a paste accident, refused rather than repaired.
- `ref` is an **opaque, non-secret label** for the credential. The package never
  computes or interprets it; it echoes it so the app can tell which credential a
  refusal belonged to. The error that refuses the token or the `ref` itself never
  carries it.
- The **`user-agent` is mandatory and the caller's**: Amazon requires one on every
  request, at most 500 characters; this package also requires printable ASCII with
  no space at either end. There is no default — the app names itself — and since
  this repository is public, never a store or brand name.

## Errors

The non-2xx rows are checked top to bottom: 5xx, then 429, then auth, then 404, and
anything left is the catch-all.

| Response                                                                                        | Error                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 5xx (whatever the body says)                                                                    | `AmazonHttpError`, `transitorio: true`            |
| 429                                                                                             | `AmazonThrottleError` (`limiteTaxa` when sent)    |
| SP-API 401 / 403                                                                                | `AmazonAuthError` (`destino: 'sp-api'`)           |
| LWA 401 / 403, or a 4xx `invalid_grant` / `invalid_client` / `unauthorized_client`              | `AmazonAuthError` (`destino: 'lwa'`, `codigoLwa`) |
| 404                                                                                             | `AmazonNotFoundError`                             |
| Any other non-2xx (3xx, 400, 409, 413, 415, 422, …; any other LWA code, e.g. `invalid_request`) | `AmazonHttpError`, `transitorio: false`           |
| 2xx that is empty, not JSON or the wrong shape                                                  | `AmazonSchemaError` (field paths only)            |
| DNS / TLS / reset / body dropped mid-stream                                                     | `AmazonNetworkError`                              |
| The per-call deadline                                                                           | `AmazonTimeoutError` (an `AmazonNetworkError`)    |
| Our own input (token, ref, path, user-agent, LWA credentials, redirect URI)                     | `AmazonConfigError` — nothing was sent            |

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
- **No resource schemas.** Each operation's (Orders, Sellers, Listings, …) arrives
  with its first consumer.
- **No call to Amazon from the tests** (D11). Every test injects its own `fetch`, and
  `test/_setup/semRede.ts` makes an un-injected one throw.
- **No `build` script**, deliberately: `ci.yml`'s seven-job split relies on no
  `packages/*` workspace defining one.
