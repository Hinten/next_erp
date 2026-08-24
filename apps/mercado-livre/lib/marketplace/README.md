# lib/marketplace — the Mercado Livre channel backend

Grouped by theme. Each folder has its own `README.md` describing what it
owns and calling out the traps; start there rather than in this file.

There is deliberately **no barrel `index.ts`** anywhere here — importers reach
concrete files (`@/lib/marketplace/pedidos/orderImport`). Barrels would hide the
cross-theme edges this layout exists to expose. Same convention as
`apps/web/lib/marketplace/{estoque,preco,push}/`.

| Folder                           | What lives there                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`core/`](core/)                 | Shared runtime — channel context, token store, HTTP responder, link refs. The sink every theme may import. |
| [`conta/`](conta/)               | OAuth connect, PKCE state, ML test-user bootstrap.                                                         |
| [`notificacoes/`](notificacoes/) | Inbound webhook ingestion, the Cloud Tasks queue, and the two backstop sweeps.                             |
| [`pedidos/`](pedidos/)           | The order → pedido import pipeline. Largest theme.                                                         |
| [`claims/`](claims/)             | Claims and mediations → Incidente + Conversa.                                                              |
| [`chat/`](chat/)                 | Perguntas, post-sale mensagens, and the outbound send path.                                                |
| [`importacao/`](importacao/)     | Product import, ML → ERP.                                                                                  |
| [`mass-import/`](mass-import/)   | The resumable "importar todos os anúncios" job.                                                            |
| [`anuncios/`](anuncios/)         | Publishing and listing lifecycle, ERP → ML.                                                                |
| [`estoque/`](estoque/)           | Stock sync — sweeps, per-listing sends, the plan core.                                                     |
| [`preco/`](preco/)               | Price sync — the bulk job and the manual push.                                                             |
| [`size-charts/`](size-charts/)   | Grades de tamanho: selection at publish, CRUD sync.                                                        |
| [`categorias/`](categorias/)     | Category tree and catalog metadata reads.                                                                  |
| [`nfe/`](nfe/)                   | Uploading an approved NF-e to ML.                                                                          |
| [`frete/`](frete/)               | `int_frete` ⇆ ML conta sync.                                                                               |

## Reading order for a newcomer

1. `core/mercadoLivre.ts` — how any request gets an authenticated channel.
2. `notificacoes/notificacao.ts` — the topic dispatcher; it names every inbound
   flow in one place and is the fastest map of what this channel does.
3. Whichever theme the dispatcher pointed you at.

## Cross-theme edges worth knowing

- **`notificacoes/notificacao.ts` depends on nearly everything.** It is the
  topic dispatcher, so it reaches into `pedidos/`, `claims/`, `chat/`,
  `importacao/` and `anuncios/`. _That_ fan-out is one-directional and intended.
- ⚠️ **But `notificacoes/` as a folder is also an inbound sink**, via two
  modules that have nothing to do with dispatch:
  - `mlTasks.ts` — imported by `estoque/` (×4), `preco/` and `nfe/`. This is
    precisely why a `tasks/` folder cannot exist, and it is the edge that would
    have to move first if `notificacoes/` were ever split.
  - `notificacaoFrescor.ts` — imported by `chat/orderMessageImport.ts` and
    `chat/questionImport.ts`.

  Combined with the dispatcher's own `notificacao.ts → chat/` edge, that makes
  **`chat/ ⇄ notificacoes/`** a real cycle, not a one-way fan-out.

- **`chat/ ⇄ claims/` is genuinely bidirectional** — `chat/` imports `claimIds`
  and `claimActionability`, `claims/` imports `mensagemProvisoria`. A property
  of today's code, not of this layout.
- **`anuncios/ ⇄ estoque/ ⇄ preco/`** all meet at `estoque/bulkEstoquePlan.ts`
  and `core/publishFalhas.ts`. If those edges start to chafe, hoisting
  `bulkEstoquePlan.ts` into `core/` is the obvious next move.
- **`importacao/ → anuncios/moderacoes.ts`** (#1087). One-directional. The
  importer is the third writer of the link doc's `moderacoes`, beside the `items`
  sync and `reverificarAnuncio`, and it deliberately shares their module rather
  than restating the `-ITM` reference and the 404-is-data narrow — the places
  those could drift. `moderacoes.ts` lives in `anuncios/` because listing
  lifecycle is its subject; the import merely reads it. ⚠️ The **gate** (_when_ to
  ask) is no longer part of this edge: `precisaConsultarModeracao` moved to
  `@delfrance/schemas` in #1239 so `apps/web` could reach it, and all three
  writers import it from there.

## Paths that are load-bearing outside this folder

Moving or renaming a file here is never only a rename — these bind by path:

- `tools/deploy-env/preflight.mjs` reads `estoque/bulkEstoquePlan.ts` **from
  disk** (`preflight.test.js`); a stale path fails with ENOENT.
- `packages/config-eslint/rules/firestore-transaction-inventory.test.js` and
  `reserva-arithmetic-inventory.test.js` key their inventories on
  repo-relative paths and red CI on an unlisted or stale entry.
- `notificacoes/coldStartPolicy.test.ts` and
  `estoque/stockSendMaxAttempts.test.ts` read fixtures via `__dirname` and are
  depth-sensitive.
