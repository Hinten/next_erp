# Marketplace stock push

The produto screens' **"Enviar estoque"** action is a registry of channel
providers keyed by `IntegracaoTipo`. It is the port of the legacy
`switch (integracaoTarget.tipo)` in
`.old/lib/produtos/pages/enviarEstoqueDialog.dart:261-336`, which dispatched to
`enviarEstoqueMercadoLivre` / `enviarEstoqueShopee` / `enviarEstoqueLi` /
`enviarEstoqueAmazonListings` / `enviarEstoqueMagalu` and fell through to
_"Tipo de integração não suportado"_.

- `types.ts` — the `StockPushProvider` contract and the `StockPushRow` display
  shape (`quantidade` on top of `../push/types`' `PushRowBase`).
- `registry.ts` — `PROVIDERS`, `resolveStockPushProvider`, and the shared entry
  point `enviarEstoqueParaIntegracao` (which runs the `ativo === false` gate).
- `enviarEstoqueRun.ts` — the thin binding onto `../push/run.ts`.
- `providers/*` — one file per channel.

## The fan-out itself lives one level up

`../push/` owns everything this flow shares with **"Enviar preços"** (#804): the
orchestrator, the progress dialog and the provider-map builder. The legacy had
two dialogs that differed only in the verb in the title and the tick-box above
the run; so does this. Read `../push/README.md` for what is shared and what
each operation deliberately keeps.

`enviarEstoqueRun.test.ts` is where the SHARED orchestrator is pinned — dedup,
the whole-selection dispatch, the per-conta row keys, both cancel checks. It is
not duplicated under `../preco/`.

## Why the ROW unit is the listing, not the produto

A produto can carry several live anúncios on **one** conta — the stock sweep's
link join deliberately has no `limit(1)`, and rendering only the first one once
hid a latched sibling completely (#781). So the legacy dialog's
one-row-per-(produto, integração) shape is deliberately widened here.

## Who owns the wording

**The backend does.** Each channel route returns an operator-facing pt-BR
`mensagem` per listing, and providers pass it through verbatim. The skip
vocabulary (`anuncio-em-erro`, `status-nao-enviavel`, `kit-virtual`, …) belongs
to the sender that emits it; a second copy of that table here would drift from
the rungs it describes. The only strings this layer owns are the ones no channel
can produce: "Integração desativada" and the unsupported-channel notice.

## Adding a channel

Four things. You never touch the registry's gates, the orchestrator, the
progress dialog, the produtos page or the produto ML tab.

0. **A row in `MARKETPLACE_TIPO_CAPS`** (`packages/schemas/src/shared/marketplace.ts`) answering `estoque.suporte` — `'desconhecido'` until somebody reads the provider's documentation, never a guessed `'nao'`. The action is gated on it, so a channel whose row still says `'desconhecido'` reports itself as unresearched no matter what code exists.
1. **A backend route** `POST /api/marketplace/<canal>/enviar-estoque` in
   `apps/<canal>`, returning the same envelope
   `{ listings[], produtosSemEnvio[], pausadoAte }` that
   `apps/mercado-livre/lib/marketplace/estoque/estoqueManual.ts` documents. Nothing in
   that envelope is Mercado-Livre-specific by design (`anuncioId`, not
   `itemId`).
2. **`providers/<canal>.ts`** exporting a `StockPushProvider`:
   - `tipos` — the `IntegracaoTipo` values it claims. Each tipo may be claimed
     by exactly one provider; the registry throws at module load on a conflict.
   - `enviarEstoque(input)` — issue I/O through `input.deps.<canal>` (add the
     client to `StockPushDeps`), forward `input.signal` to `fetch`, and map the
     envelope onto `StockPushRow[]`. Narrow every `catch` to that client's error
     classes and `throw err` for anything else — no generic catch (repo rule 6).
     Never throw for a per-listing failure: return it as a `falha` row.
3. **One row** in the `buildProviderMap([...])` array in `registry.ts`, plus
   `providers/<canal>.test.ts` with an injected fake client, and one line
   flipped in `registry.test.ts`'s exhaustive tipo table.

`resolveStockPushProvider` falls back on its own — any tipo the caps row does
not clear, or that has no exact provider, goes to the `unsupportedChannel`
factory, which claims **no** tipos precisely so registering a real channel never
means editing the placeholder.

## The caps row is what decides, not the provider file (#1430)

`resolveStockPushProvider` asks `MARKETPLACE_TIPO_CAPS` first — via
`suporteEstoqueDoCanal`, which is also what `enviarEstoqueRun.ts`'s
`suportado` and the dialog's pre-run warning read, so the three cannot disagree.
Only then does an exact tipo match serve the request. Everything else gets the
placeholder **carrying the reason**, and the reasons are four different
sentences:

| Caps row says                     | Reason                   | What the operator reads                                     |
| --------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `estoque.suporte: 'nao'`          | `canal-nao-suportado`    | the provider cannot — building a backend will not change it |
| `estoque.suporte: 'desconhecido'` | `canal-nao-pesquisado`   | nobody has read that provider's documentation yet           |
| `'sim'` + `implementado: false`   | `canal-nao-implementado` | the provider can, we have not built the channel             |
| caps say yes, no `PROVIDERS` row  | `canal-sem-provider`     | a wiring gap in this screen                                 |

⚠️ This replaced `PROVIDERS[tipo] !== undefined` — "a provider file exists"
answering "does the channel support it". Same substitution the `/canais` badge
already removed (#815, ADR 0015), and it gave all four situations one sentence,
which ended _"use o aplicativo antigo para este canal"_ — false for three of
them, and expiring at the cutover (there is no dual run, root `CLAUDE.md`
rule 8).

⚠️ `caps/registriesAlinhadas.test.ts` asserts the table and this registry agree
for **every** tipo. If a channel legitimately lands in the middle — backend
shipped, this screen not wired yet — say so there with a named exception; do not
delete the assertion.
