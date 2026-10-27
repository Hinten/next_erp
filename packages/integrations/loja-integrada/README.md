# @delfrance/integrations-loja-integrada

Platform-neutral Loja Integrada REST v1 library: **fetch-only**, no Firestore, no
Admin SDK, no `process.env`. The **read client is GET-only by construction**; a
separate **write client** is the package's only writer. The stateful half (the
credential store, the connect route, the sweeps and the write engine) lives in
`apps/loja-integrada`.

What ships here:

| Module              | Holds                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.ts`            | `URL_BASE_LI`, `CAMINHO_VALIDACAO` and `validarPersonalToken`, the validating GET                                                                                                                 |
| `client.ts`         | The shared request core (package-internal) and the GET-only read client, `criarClienteLeituraLi`: the strict token check, no redirect following, a `PUT` held to the write routes                 |
| `escrita.ts`        | The write client, `criarClienteEscritaLi`: the pre-write `GET` (with the scrubbed body text for a restore snapshot) and one `PUT`; a 2xx resolves, an unreadable echo is reported, 202 is pending |
| `paginacao.ts`      | `paginarLi`, Tastypie paging rebuilt from `meta.next` (only `offset` and the caller's own keys travel), with caller cancellation                                                                  |
| `pedidos.ts`        | The order import's reads: `buscarPedidoLi`, `listarHistoricoSituacaoLi` (every page) and `buscarProdutoPorIdExternoLi`                                                                            |
| `pedidosEscrita.ts` | The status write-back's two writes: `atualizarObjetoEnvioLi` (the tracking code) and `alterarSituacaoPedidoLi` (only the three write-back codigos)                                                |
| `pedidoTipos.ts`    | The order detail, situação, situação-history row and produto-identity response schemas, written against captures; the two write echoes, every field optional                                      |
| `prazos.ts`         | `PRAZO_LI_MS`, the per-call deadline keyed on the operation class (`leitura`, `escrita`)                                                                                                          |
| `types.ts`          | The `{ meta, objects }` paging envelope and the categoria row schema                                                                                                                              |
| `errors.ts`         | The typed errors (each message names the verb and the path), the 429 scope (read from the body) and `Retry-After` (from the header)                                                               |

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
- **No write method on the read client, and no body on any read.** Every request
  `criarClienteLeituraLi` makes is a `GET` by construction. The write client
  (`escrita.ts`) is a separate factory, with method names used nowhere else. Every
  `PUT` it can send is held to the package-internal write routes
  (`rotasEscrita.ts`): exactly two paths, each with one strict body, refused before
  anything is sent otherwise. So no write can carry a situação outside the three
  write-back codigos, an empty or non-visible-ASCII tracking code (no write can
  clear one), a stray key or the token. Its two operations (`pedidosEscrita.ts`)
  build those calls. The manifest's `exports` map publishes the root alone, so the
  request core is reachable only through the two clients.
- **Called by the app's write engine only.** `apps/loja-integrada`'s
  `core/escrita.ts` (master-plan step 7) is the only module there that names a
  write operation or a write-client method, and its write context the only one
  that builds the write client — a name-keyed guard (`estrutura.test.ts` there)
  refuses any other, and any import of a package subpath. Every write runs behind
  the write valves and the read switch, all off until the window. Nothing writes
  to the provider before the cutover.
- **No decision about a write.** Whether one is due, safe or already reflected is
  the app's, from a fresh read made just before it. A write cut by its deadline
  may have landed; the caller re-reads before deciding anything.
- **No token store, no refresh, no OAuth.** The Personal Token is supplied by the
  caller on every call.
- **No retry, backoff or rate limiter.** The rate-limit error carries its scope and
  `Retry-After`; durable retry belongs to the app.
- **No logging.** `onChamada` is the observation hook; the app decides what is kept.
  `validarPersonalToken` forwards an optional `onChamada` to its client too, so the
  validating GET is observable like any other call (its event carries
  `refCredencial: 'candidato'`; a malformed token sends nothing and is not
  observed). An observer must never throw: the client rethrows its error in place
  of the outcome, which for a write rejects a write that landed. The app's observer (`apps/loja-integrada`, `core/log.ts`) is the
  only consumer, and it redacts the event before anything is written; its totality
  on every write outcome is pinned there (`log.test.ts`).
- **No body excerpt on any error.** Response text never rides an exception.
- **No `process.env`.** Every value is a parameter.
- **No resource schema far ahead of its consumer.** Beyond the paging envelope and
  categoria, only the order import's shapes and reads ship (`pedidoTipos.ts`,
  `pedidos.ts`), consumed by `apps/loja-integrada`'s order import (master-plan
  step 5), and the status write-back's two writes and their echoes
  (`pedidosEscrita.ts`), consumed by its write engine (master-plan step 7); every
  other resource arrives with its first consumer, written against captured
  responses. The write echoes are the one exception to "against captures": no
  write is made before the cutover, so they follow the public document and keep
  every field optional.
- **No decision about an order.** `pedidos.ts` reads and parses; mapping a
  situação, a payment or a line is the app's (`apps/loja-integrada`), through the
  shared situação table in `@delfrance/schemas`.
- **No `build` script**, deliberately: `ci.yml`'s seven-job split relies on no
  `packages/*` workspace defining one.
