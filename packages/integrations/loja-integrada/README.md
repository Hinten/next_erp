# @delfrance/integrations-loja-integrada

Platform-neutral Loja Integrada REST v1 library: **fetch-only and GET-only**, no
Firestore, no Admin SDK, no `process.env`. The stateful half (the credential
store, the connect route, the sweeps) lives in `apps/loja-integrada`.

What ships here:

| Module         | Holds                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `api.ts`       | `URL_BASE_LI`, `CAMINHO_VALIDACAO` and `validarPersonalToken`, the validating GET              |
| `client.ts`    | The GET-only transport: `criarClienteLeituraLi`, the strict token check, no redirect following |
| `paginacao.ts` | `paginarLi`, Tastypie paging rebuilt from `meta.next`, with caller cancellation                |
| `prazos.ts`    | `PRAZO_LI_MS`, the per-call deadline keyed on the operation class                              |
| `types.ts`     | The `{ meta, objects }` paging envelope and the categoria row schema                           |
| `errors.ts`    | The typed errors, the 429 scope (read from the body) and `Retry-After` (from the header)       |

## The token rule

The credential is a Personal Token sent as `Authorization: Basic <token>`, the
token **raw** after `Basic ` (not base64-encoded by us).

- Visible ASCII only. A token with whitespace, a control character or anything
  outside that range is refused before any request is made.
- **Never trimmed, never stored, never logged.** `obterCredencial` is called on
  every request and its result is not kept.
- Never in a URL, a query string, an error message or a log line. A path or query
  that carries it is refused before any request is made.
- `ref` is an **opaque, non-secret label** for the credential (for example a
  fingerprint the app computes). The package never computes or interprets it; it
  only echoes it, so the app can tell which credential a 401 belonged to. The
  error that refuses the token or the `ref` itself never carries it.

## What it deliberately is not

- **No Firestore / Admin SDK / `@delfrance/data`.** ADR 0015: a channel package is a
  library, not a plugin, and the ERP orchestration lives in its app.
- **No write method and no request body.** Every request is a `GET` by
  construction. No write to the provider exists before the cutover.
- **No token store, no refresh, no OAuth.** The Personal Token is supplied by the
  caller on every call.
- **No retry, backoff or rate limiter.** The rate-limit error carries its scope and
  `Retry-After`; durable retry belongs to the app.
- **No logging.** `onChamada` is the observation hook; the app decides what is kept.
- **No body excerpt on any error.** Response text never rides an exception.
- **No `process.env`.** Every value is a parameter.
- **No resource schemas beyond the paging envelope and categoria.** The rest arrive
  with their first consumer, written against captured responses.
- **No `build` script**, deliberately: `ci.yml`'s seven-job split relies on no
  `packages/*` workspace defining one.
