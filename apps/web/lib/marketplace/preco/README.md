# Marketplace price push

The produto screens' **"Enviar preços"** action (#804) is a registry of channel
providers keyed by `IntegracaoTipo`. It is the port of the legacy chain of
per-channel `if` arms inside `EnviarPrecoDialog`
(`.old/lib/produtos/pages/produtoTableView.dart:531-1000`), which dispatched one
produto's price to Mercado Livre / Shopee / Loja Integrada / Amazon / Magalu in
turn and fell through silently for anything else.

- `types.ts` — the `PricePushProvider` contract and the `PricePushRow` display
  shape (`preco` + `precoAnterior` on top of `../push/types`' `PushRowBase`).
- `registry.ts` — `PROVIDERS`, `resolvePricePushProvider`, and the shared entry
  point `enviarPrecoParaIntegracao` (which runs the `ativo === false` gate).
- `enviarPrecoRun.ts` — the thin binding onto `../push/run.ts`.
- `providers/*` — one file per channel.

## Why this is not the account-wide job

`POST /api/marketplace/mercado-livre/atualizar-precos` prices a whole conta, and
its discovery query drops three classes of produto server-side with no skip row
(#804 S7). This flow reads the selected produtos by KEY instead, so an
unpublished produto with a live listing, a produto whose `integracoesComProduto`
denorm drifted, and a variation child all reach the report as explicit rows.

**`baixarPreco` defaults ON here**, unlike the account-wide job and unlike the
stock push's own checkbox. Hand-picking produtos IS the explicit intent, and the
legacy per-produto action passed `baixarPreco: true` unconditionally
(`produtoTableView.dart:607`). It is still re-armed to that default on every
open — a run where the operator unticked it never leaks into the next one.

## Who owns the wording

**The backend does.** Each channel route returns an operator-facing pt-BR
`mensagem` per listing, and providers pass it through verbatim. The skip
vocabulary (`PRECO_ANTIGO_MAIOR`, `PRECO_NAO_MODIFICAVEL`, `NAO_PUBLICADO`, …)
belongs to the sender that emits it; a second copy of that table here would
drift from the gates it describes. The only strings this layer owns are the ones
no channel can produce: "Integração desativada" and the unsupported-channel
notice.

## Adding a channel

Three things. You never touch the registry's gates, the orchestrator, the
progress dialog or the produtos page.

1. **A backend route** `POST /api/marketplace/<canal>/enviar-precos` in
   `apps/<canal>`, returning the same envelope
   `{ listings[], produtosSemEnvio[], pausadoAte }` that
   `apps/mercado-livre/lib/marketplace/preco/precoManual.ts` documents. Nothing in
   that envelope is Mercado-Livre-specific by design (`anuncioId`, not `itemId`).
2. **`providers/<canal>.ts`** exporting a `PricePushProvider`:
   - `tipos` — the `IntegracaoTipo` values it claims. Each tipo may be claimed
     by exactly one provider; the registry throws at module load on a conflict.
   - `enviarPreco(input)` — issue I/O through `input.deps.<canal>` (add the
     client to `PushDeps`), forward `input.signal` to `fetch`, and map the
     envelope onto `PricePushRow[]`. Narrow every `catch` to that client's error
     classes and `throw err` for anything else — no generic catch (repo rule 6).
     Never throw for a per-listing failure: return it as a `falha` row.
3. **One row** in the `buildProviderMap([...])` array in `registry.ts`, plus
   `providers/<canal>.test.ts` with an injected fake client, and one line
   flipped in `registry.test.ts`'s exhaustive tipo table.

Once a channel is registered here, the produtos table's one click sends that
produto's price to it alongside every other registered channel — which is what
the legacy did and what #804 asks to restore.
