# @delfrance/integrations-loja-integrada

Platform-neutral Loja Integrada REST v1 library: **fetch-only**, no Firestore, no
Admin SDK, no `process.env`. The **read client is GET-only by construction**; a
separate **write client** is the package's only writer. The stateful half (the
credential store, the connect route, the sweeps and the write engine) lives in
`apps/loja-integrada`.

What ships here:

| Module              | Holds                                                                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.ts`            | `URL_BASE_LI`, `CAMINHO_VALIDACAO` and `validarPersonalToken`, the validating GET                                                                                                                                                                                                                                     |
| `client.ts`         | The shared request core (package-internal) and the GET-only read client, `criarClienteLeituraLi`: the strict token check, no redirect following, a `PUT` held to the write routes                                                                                                                                     |
| `escrita.ts`        | The write client, `criarClienteEscritaLi`: the pre-write `GET` (with the scrubbed body text for a restore snapshot) and one `PUT`; a 2xx resolves, an unreadable echo is reported, 202 is pending                                                                                                                     |
| `paginacao.ts`      | `paginarLi`, Tastypie paging rebuilt from `meta.next` (only `offset` and the caller's own keys travel), with caller cancellation; its rules live in `proximaPaginaLi`                                                                                                                                                 |
| `pedidos.ts`        | The order import's reads: `buscarPedidoLi`, `listarHistoricoSituacaoLi` (every page) and `buscarProdutoPorIdExternoLi`                                                                                                                                                                                                |
| `catalogo.ts`       | The four catalogue reads: `listarCategoriasLi`, `listarMarcasLi`, `listarGradesLi` (every page, the caller's `limite` and `maxPaginas` both required) and `buscarGradeLi` (one grade's options)                                                                                                                       |
| `produtos.ts`       | The product import's reads: `lerPaginaLi` (one page of any list, its next offset validated), `lerPaginaProdutosLi` (live or trash) and `buscarProdutoLi`, both projected: no price or stock                                                                                                                           |
| `cdn.ts`            | The photo reader, `criarLeitorCdnLi`: the pinned CDN host, no credential, no redirect, `PRAZO_CDN_LI_MS`, a byte cap, the type from the bytes; original or `800x800`                                                                                                                                                  |
| `pedidosEscrita.ts` | The status write-back's two writes: `atualizarObjetoEnvioLi` (the tracking code) and `alterarSituacaoPedidoLi` (only the three write-back codigos)                                                                                                                                                                    |
| `estoque.ts`        | The stock sync's reads: `lerPaginaEstoqueLi` (one page of the stock list, through `lerPaginaLi`), `buscarEstoqueProdutoLi` (one product's stock, by the produto id) and `produtoIdDoEstoqueLi` (the produto a row names)                                                                                              |
| `estoqueEscrita.ts` | The stock write, `atualizarEstoqueProdutoLi`: managed stock at a non-negative integer quantity, the two situações fixed (`ESTOQUE_FIXO_ESCRITA_LI`), every number sent unquoted                                                                                                                                       |
| `preco.ts`          | The price sync's read: `lerPrecosPorIdLi` (one `set/` call of at most `MAX_IDS_SET_PRECO_LI` product ids), `classificarSetPrecoLi` (every asked id's result, matched by the produto a row names) and `produtoIdDoPrecoLi`                                                                                             |
| `precoEscrita.ts`   | The price write: `corpoPrecoProdutoLi` (a full body from integer centavos and the configured clear, the store's custo echoed or omitted) and `atualizarPrecoProdutoLi`, every number sent unquoted                                                                                                                    |
| `pedidoTipos.ts`    | The order detail, situação, situação-history row and produto-identity response schemas, written against captures; the two write echoes, every field optional                                                                                                                                                          |
| `prazos.ts`         | `PRAZO_LI_MS`, the per-call deadline keyed on the operation class (`leitura`, `escrita`)                                                                                                                                                                                                                              |
| `types.ts`          | The `{ meta, objects }` paging envelope, the pedido search row, the catalogue rows (categoria, marca, grade, a grade's options), the produto row, detail and image, the stock row, detail and write echo, and the price row, the by-id envelope, the produto detail a price write decides on and the price write echo |
| `errors.ts`         | The typed errors (each message names the verb and the path), the 429 scope (read from the body) and `Retry-After` (from the header)                                                                                                                                                                                   |

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
  (`rotasEscrita.ts`): exactly four paths, each with one strict body, refused
  before anything is sent otherwise. So no write can carry a situação outside the
  three write-back codigos, an empty or non-visible-ASCII tracking code (no write
  can clear one), stock other than managed stock at a non-negative integer
  quantity with the two fixed situações, a price that is not above 0 with at most
  two decimal places, a price write without `sob_consulta`, a quoted number, a
  stray key or the token. A body is the route schema's OUTPUT, serialised once:
  JSON scalars only, a number sent as a JSON number. Its four operations
  (`pedidosEscrita.ts`, `estoqueEscrita.ts`, `precoEscrita.ts`) build those
  calls. The manifest's `exports` map publishes
  the root alone, so the request core is reachable only through the two clients.
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
- **No resource schema far ahead of its consumer.** Beyond the paging envelope,
  only the order import's shapes and reads ship (`pedidoTipos.ts`, `pedidos.ts`),
  consumed by `apps/loja-integrada`'s order import (master-plan step 5), the status
  write-back's two writes and their echoes (`pedidosEscrita.ts`), consumed by its
  write engine (master-plan step 7), and the catalogue rows and reads
  (`types.ts`, `catalogo.ts`), consumed by its catalogue routes (master-plan
  step 10) and written against the owner's catalogue capture C9, and the produto
  reads (`types.ts`, `produtos.ts`), for the product import (master-plan step 9),
  written against the public document's examples and checked against the shapes of
  the owner's produto capture C10, the stock rows, reads and write (`types.ts`,
  `estoque.ts`, `estoqueEscrita.ts`), for the stock sync (master-plan step 12),
  and the price row, the by-id read, the deciding detail schema and the price
  write (`types.ts`, `preco.ts`, `precoEscrita.ts`), for the price sync
  (master-plan step 13); every other resource arrives with its first consumer,
  written against captured responses.
  The write echoes are the exception to "against captures": no write is made
  before the cutover, so they follow the public document and keep every field
  optional. The stock wire was written against the public document and is
  pinned against the owner's read-only stock captures (both path forms answer
  the same for GET; the stock PUT's path form stays unproven, like every write).
  The price wire was written against the public document and the facts the
  owner's read-only price capture (2026-11-24, both stores) measured; its
  sanitized pages are replayed through these reads in a later change.
- **No stock decision.** `estoque.ts` and `estoqueEscrita.ts` read, parse and
  send: which quantity is due, whether a row is already reflected, which ERP
  product a row belongs to and what a missing row means are the app's. The
  produto a row names is read by `@delfrance/schemas`' resource-URI reader
  (`idDoRecursoLi`), the one the product import reads `filhos` and `pai` with,
  never by a copy. The stock list is read one page at a time through
  `lerPaginaLi`, at most `MAX_LIMITE_PAGINA_ESTOQUE_LI` rows a page (the largest
  page measured honoured: 100 in full; 200 is a 400, and 101–199 were not
  probed; it lives in
  `@delfrance/schemas` and is re-exported, because the
  reconcile cursor's stored page size is held to the same binding), with exactly
  `limit` and
  `offset` and no filter (the list has none). Each row is read on its own: a row
  the schema refuses is reported in `ilegiveis` (its position, the produto it
  names, the field paths) and never costs the rows beside it; only a malformed
  envelope refuses the page. The detail, which a write decides on, is read whole
  and strict. The stock write is strict too, so a rollback can only re-send a
  non-negative quantity under the fixed situações: a prior negative, unmanaged
  or other-lead-time row cannot be put back exactly.
- **No price decision.** `preco.ts` and `precoEscrita.ts` read, parse, classify
  and send: which price is due, whether the store already shows it, whether a
  write may lower it and what an unanswered id means are the app's (through the
  price fold of `@delfrance/schemas`, `precoErpLojaIntegrada.ts`).
  - **By id only.** The store's prices are read with `set/`, at most
    `MAX_IDS_SET_PRECO_LI` (100) product ids a call, re-exported from
    `@delfrance/schemas` and never copied. Each row is matched to the id asked
    for by the produto it names (the shared `idDoRecursoLi`), never by its own
    `id` or its place. An id the answer lists in `not_found` is "not found";
    an id the answer neither returns nor lists, an unreadable row, an id
    answered twice and a row naming an id not asked are each reported apart and
    never read as "no row". An answer that accounts for none of the asked ids
    is `LiSchemaError`.
  - **No list reader and no single-resource reader.** The price list's offset
    walk served some rows twice and never served as many others, with every
    envelope check clean (the owner's read-only price capture), so nothing reads
    it. A price write decides on the produto detail
    (`liProdutoComPrecoDetalheSchema`, through the write client's deciding read),
    whose prices the same capture found equal to the price resource's, so nothing
    would consume a single-resource reader.
  - **Readability is judged by the fold, nowhere else.** A row's `cheio` and
    `promocional` are judged by `valorPrecoLi` at the wire (an unreadable one
    makes the row unreadable), and the deciding detail's four `preco_*` leaves are
    carried raw (an unreadable one is the send's decision to skip). The wire has
    no decimal grammar of its own. The store's resource custo is opaque: no
    decision reads it.
  - **The clear.** A write clears a promotion in the configured shape
    (`FORMA_PROMO_LIMPA_LI`: `null` by default, `0`, or the full price). The route
    accepts all three, because a route is looked up by its path alone; only the
    body builder holds a write to the configured one.
  - **A full write.** `cheio`, `promocional` and `sob_consulta` always, the
    store's own custo when it holds one (a `null` custo omits the key), never the
    ERP custo. The two-decimal rule binds `cheio` and `promocional` only.
- **No catalogue decision.** `catalogo.ts` reads and parses: whether a category's
  parent URI names a parent, whether an option belongs to the grade asked for,
  and what a 403 or a 404 on a catalogue read means are the app's. Every URI is
  carried verbatim and every id comes from `id`. The leaves the app judges (a
  category's `categoria_pai`, an option's `grade`, a brand's `ativo`) are read as
  `z.unknown()` and carried raw whatever their type, so one odd row never refuses
  a whole list or grade. `id_externo` is never sent (on
  these GETs it would make the path id the store's external id) and never read,
  and there is no `/set/` read: a consumer reads a whole list once. A list longer
  than the caller's `maxPaginas` throws `LiPaginacaoError('limite-de-paginas')`;
  it is never returned truncated.
- **No product decision, and no price or stock.** `produtos.ts` reads and parses:
  which family a row belongs to, whether a child is orphaned and what a 404 on a
  detail means are the app's. The produto schemas are passthrough like every other,
  so both produto reads return an explicit projection: price and stock
  (`preco_*`, `estoque_*`), `seo`, `tags`, `url` and an image's absolute URLs
  never leave the package. The produto list is read one page at a time at most 100
  rows a page (the API answers 400 from 200 up), with `removido` sent on every page;
  the detail is the plain GET (no `descricao_completa` flag: it changed nothing).
  Neither sends `id_externo`, `sku`, `ativo` or a date filter. The price sync reads
  the same detail path for its own reasons, through `liProdutoComPrecoDetalheSchema`
  and the write client's deciding read only: the import's reads stay price-free.
- **No credential on the CDN, and no URL from a body.** `cdn.ts` reads a photo from
  the pinned CDN host (`URL_BASE_CDN_LI`) by its `caminho` alone, never from a
  body's absolute URL, with no header at all, so the Personal Token never leaves
  the API host. A refused picture (a malformed `caminho`, a 3xx, a 404 or another
  status, over the byte cap, not a JPEG, PNG, WebP or GIF by its bytes) is a typed
  outcome the importer reports per photo; over the cap is its own outcome, the
  cue to ask for the `800x800` form instead. A CDN 401, 403 or 429 is never the
  API's auth or throttle error. The deadline and a dropped connection throw the
  same transport errors as any read.
- **No decision about an order.** `pedidos.ts` reads and parses; mapping a
  situação, a payment or a line is the app's (`apps/loja-integrada`), through the
  shared situação table in `@delfrance/schemas`.
- **No `build` script**, deliberately: `ci.yml`'s seven-job split relies on no
  `packages/*` workspace defining one.
