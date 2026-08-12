# Checkout etiqueta (shipping-label) providers

The checkout screen's "emit / print label" action is a **registry of
carrier providers** keyed by `IntegracaoFrete` tipo. It is the port of the
legacy `emitirOuImprimirFrete` (`.old/lib/despacho/pages/emitirOuImprimirFrete.dart`),
which was one big `switch (tipo)`.

- `types.ts` — the `CheckoutEtiquetaProvider` contract + the injected `ui` /
  `deps` surfaces + the `EtiquetaOutcome` union.
- `gates.ts` — the shared pre-gates every action runs before any provider.
- `registry.ts` — `PROVIDERS`, `resolveEtiquetaProvider`, and the shared entry
  point `emitirOuImprimirEtiqueta`.
- `providers/*` — one file per carrier.

## Adding a provider

Everything is a **provider file + one registry row**. You never touch the
gates, the UI bridge, or the other providers.

1. **Create `providers/<tipo>.ts`** exporting a `CheckoutEtiquetaProvider`:
   - `tipos` — the `IntegracaoFrete` values it claims (a provider may claim
     several; each tipo may be claimed by only one provider — the registry
     throws on a conflict at load time).
   - `emitirOuImprimir(input)` — return an `EtiquetaOutcome`. Assume the shared
     gates already ran (see below). Issue all I/O through the injected
     `input.deps.*` clients and `input.db`; every UI effect (confirm, toast,
     open URL, drive the ME buy modal) through `input.ui.*`. Never read a
     module singleton and never write Firestore from a print/emit path unless
     the flow genuinely owns that write.
   - Narrow every `catch` to a specific error class (e.g. the freight client's
     `FreightHttpError` / `FreightNetworkError`, via `freightErrorMessage`) and
     `throw err` for anything else — no generic catch (repo rule).
2. **Add one `registry.ts` entry** — put the provider in the array passed to
   `buildProviderMap`. Done; `PROVIDERS` indexes it by its `tipos`.
3. **Write a unit test** `providers/<tipo>.test.ts` with injected fakes (see
   the existing per-provider tests). Do not hit Firestore or the network.

`resolveEtiquetaProvider` falls back on its own: a tipo with no exact provider
that is `marketplaceOwned` → `unsupportedMarketplace`; anything else → the
generic label. So the fallbacks stay correct even before you register a new
marketplace provider.

## Legacy behavior to port for the future marketplace providers

`mercadoLivre` is **implemented** — `providers/mercadoLivre.ts` (port of the
legacy `emitirEtiquetaMercadoLivre`) fetches the marketplace-generated label
through the apps/mercado-livre proxy route (`GET …/etiqueta`, PDF or ZPL2) and
sends it to the print agent. ML's `invoice_pending` reject auto-recovers: the
provider (re)sends the pedido's latest **aprovada** NF-e (`enviar-nfe`, 202 =
enqueued), waits 15s for ML to process it, then retries the fetch exactly once.

The remaining marketplace carriers route to `unsupportedMarketplace` (a toast +
an `'unsupported'` outcome). When their fetch flows land (Phase 5/6), each
should reproduce the corresponding legacy call from `emitirOuImprimirFrete.dart`
(`tipoEtiqueta` is the PDF-vs-ZPL2 selection; `zpl2` below is
`tipoEtiqueta == FORMATO_ETIQUETA.zpl2`):

| Tipo (`IntegracaoFrete`) | Legacy call                                                         | Notes                                                |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------- |
| `shopee`                 | `gerarEtiquetaShippingShopee(contaUid: pedido.integracao_id, zpl2)` | Account is the pedido's `integracao_id`.             |
| `amz` (Amazon)           | `gerarEtiquetaDBAAmazon(contaUid: pedido.integracao_id, zpl2)`      | Amazon DBA label.                                    |
| `magalu`                 | `gerarEtiquetaMagalu(contaUid: pedido.integracao_id, zpl2)`         | Account is the pedido's `integracao_id`.             |
| `lojaIntegrada`          | **target resolution first** (below), then the mapped provider       | LI never emits directly; it maps to another carrier. |

### Loja Integrada target resolution (legacy 184-224)

`lojaIntegrada` resolves a **target** carrier before emitting:

1. If `freteInicial.integracaoTargetOuterRef` is set → read it; `tipo` = the
   target integration's tipo, and its doc id is the target account.
2. Else map `externalOptionData['id'].split('---')[0]` through
   `integracaoFrete.mapa`, matching on
   `element.idOriginal.split('---')[0]`. The matched `MapaDeIntegracoes` gives
   `targetTipoIntegracao` + `integracaoUid`; when the target is
   `melhorEnvios`, also `melhorEnviosServiceId = mapeamento.targetData['id']`.
3. No mapping found → abort with "Este frete não possui mapeamento com
   transportadora."

The resolved target tipo is then dispatched exactly like a first-class carrier
(a mapped `melhorEnvios` target runs the Melhor Envio buy/print, etc.).

## What the shared gates guarantee (providers may assume these already ran)

`registry.emitirOuImprimirEtiqueta` runs `runEtiquetaGates` before resolving a
provider, so by the time `emitirOuImprimir` is called:

1. **Sem frete skipped** — `frete.modalidade === '9'` (semFrete) short-circuits
   to a silent `skipped`; a provider never sees a no-shipment frete.
2. **Already-posted reprint confirmed** — when
   `frete.estado !== 'checkFinalizado' && isFreteJaPostado(frete.estado)`, the
   operator has confirmed the duplicate-label risk (`ui.confirmRisk`); declining
   short-circuits to `skipped`.
3. **Integração resolved** — the caller resolves the freight integration and
   passes it as `input.intFrete` (`{ id, tipo, data }`); a provider never
   re-reads it, and never has to handle a missing integração.
