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

Three things. You never touch the registry's gates, the orchestrator, the
progress dialog, the produtos page or the produto ML tab.

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

`resolveStockPushProvider` falls back on its own — any tipo without an exact
provider goes to `unsupportedChannel`, which claims **no** tipos precisely so
registering a real channel never means editing the placeholder.
