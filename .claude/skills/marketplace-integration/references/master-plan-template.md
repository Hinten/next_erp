# Master plan template — a new marketplace channel

Generate the plan from the channel's `MARKETPLACE_TIPO_CAPS` row (Phase 1), not from
this list. A capability the row marks `'nao'` **drops its step, with a line saying
so**; a `'desconhecido'` means Phase 0 is not finished and the plan is not ready.

Order is dependency order, learned from the Mercado Livre port. Steps 1-4 are
prerequisites — nothing downstream works without them.

## The steps

| # | Step | Gate (caps field) | Trigger | Firestore | Shared seam |
| --- | --- | --- | --- | --- | --- |
| 1 | Channel app scaffold + OAuth connect | `auth`, `pkce` | HTTP | `integracao`, `integracao/{id}/credenciais` | `@delfrance/data/admin/oauth-state` |
| 2 | Account context + credential store + read cache | always | — | `integracao` | `@delfrance/data/admin/cache` |
| 3 | Inbound: receiver + queue, or the poller | `notificacoes`, `assinaWebhook` | HTTP → Cloud Task, or `onSchedule` | `notificacoes<Canal>` | `defineNotificationPipeline` |
| 4 | Delivery backstop (missed-feed replay and/or forward backfill) | `notificacoes` | `onSchedule` | a per-conta cursor doc | — |
| 5 | Order → pedido import | `importarPedido`, `consolidaPacote`, `dadosFiscaisSeparados` | Cloud Task | `pedidos` + subcollections, `clientes` | `findOrCreateCliente` |
| 6 | Payment → pagamento | `importarPagamento` | Cloud Task | `pedidos/{id}/pagamentos` | `@delfrance/core/wire` |
| 7 | Shipment → `freteInicial` + conference | `rastreio` | Cloud Task | `pedidos.freteInicial` | — |
| 8 | Stuck-reservation release | `importarPedido` | `onSchedule` | `pedidos` | — |
| 9 | Product import (+ the resumable mass-import job) | `importarAnuncio` | HTTP + Cloud Task | `produtos` + link subcollection, `categorias`, `arquivos` | `@delfrance/storage/admin` |
| 10 | Categories / attributes / taxonomy | `categoriasEAtributos` | HTTP (cached) | — | `@delfrance/data/admin/cache` |
| 11 | Publish / listing lifecycle (+ pause / reactivate) | `publicarAnuncio`, `variacoes`, `pausarAnuncio` | HTTP + Cloud Task | link subcollection, `produtos.integracoesComProduto` | — |
| 12 | **Stock sync** — the cost centre | `estoque.*` | `onSchedule` ×N + Cloud Task + HTTP | `produtos`, `estoques`, a sync-state doc | `firestore-pipelines` |
| 13 | Price sync | `enviarPreco` | Cloud Task + HTTP | a job doc + link subcollection | — |
| 14 | NF-e upload | `enviarNfe` | Firestore trigger → Cloud Task | `pedidos.freteInicial` (failure only) | — |
| 15 | Labels | `etiqueta` | HTTP | — | `freight-integrations` |
| 16 | Chat: questions + post-sale + outbound | `perguntas`, `mensagensPosVenda` | Cloud Task + HTTP | `chat`, `chat/{id}/mensagem` | `conversaOrigem` |
| 17 | Claims / returns / mediations | `reclamacoes` | Cloud Task + HTTP | `pedidos/{id}/incidentes`, `chat` | — |
| 18 | Tabela de medidas | `tabelaDeMedidas` | HTTP | `tabMedi` | — |
| 19 | **Kits virtuais** | `kitVirtual` | publish + stock | `produtos.ehKitVirtual` | — |
| 20 | `int_frete` sync (marketplace-owned freight) | `etiqueta !== 'nenhuma'` | Firestore trigger | `int_frete` | `freight-integrations` |
| 21 | `apps/web`: conta screen, row actions, inbox origin | derived | — | — | the four provider registries + the caps row |

⚠️ **Step 19 is the one Mercado Livre does not have.** If it survives the caps filter
you are writing code with no reference implementation — plan it from the provider's
documentation alone, and say so in the issue.

⚠️ **Step 12 is where the money goes.** Read the stock chapter in `SKILL.md` before
planning it, and record the measured scan cost in the issue.

## Issue shape

One tracker plus one issue per step. Each issue states:

- **Why the timing is load-bearing** — what breaks if it lands before its
  prerequisite, or after a step that depends on it.
- **The caps row fields it consumes**, and the documentation page that answered them
  (Phase 0 citations).
- **The exact wire operations** — verb, path, the response shape you validated.
- **The Firestore reads and writes**, plus any composite index the step needs.
- **The shared seam it reuses**, or an explicit argument for why none fits.
- **How you will verify it** end to end.
- **What it deliberately does NOT do**, with the number if it is a cost decision.

Labels: the channel label + a `task:` label. ⚠️ Ask before opening any issue — the
tracker is curated (root `CLAUDE.md`).

## Definition of ready for the whole plan

- [ ] The caps row exists and contains **no `'desconhecido'`**.
- [ ] Every `'sim'` cites the provider documentation page that established it.
- [ ] Every dropped step is listed with the `'nao'` that dropped it.
- [ ] `estoque.protocolo` is decided, and if it is `'feed-assincrono'` the plan
      contains a submission-record + poll step that no channel here has written.
- [ ] `assinaWebhook` is decided, and if `'sim'` the receiver plan **fails closed**.
- [ ] Legacy checked: does `.old/` show this channel writing collections the migrated
      corpus still carries? (Shopee: `pedshopee`, `prodshopee`/`variashopee`,
      `pushshopee`, `brandshopee`, `tabelasMedidasShopee`. Amazon: `prodAmazon`.
      Magalu: `produtoMagalu2`, `tokenMagalu`. Loja Integrada:
      `produtolojaintegrada`.) A corpus that exists constrains the wire shape; one
      that does not, does not — **do not invent a mirror by analogy with `orderML`.**
