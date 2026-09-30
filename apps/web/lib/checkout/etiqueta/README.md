# Checkout etiqueta (shipping-label) providers

The checkout screen's "emit / print label" action is a **registry of
carrier providers** keyed by `IntegracaoFrete` tipo. It is the port of the
legacy `emitirOuImprimirFrete` (`.old/lib/despacho/pages/emitirOuImprimirFrete.dart`),
which was one big `switch (tipo)`.

- `types.ts` — the `CheckoutEtiquetaProvider` contract + the injected `ui` /
  `deps` surfaces + the `EtiquetaOutcome` union.
- `intFrete.ts` — `resolverIntFrete`, WHICH freight integration an action
  dispatches on (below); every entry point calls it before the registry.
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
   - `reimpressao` — optional. `'mesmo-documento'` when a reprint hands back
     the SAME document and the carrier itself refuses a second shipment: the
     registry then skips the posted-risk confirm (gate 2 below). Absent means
     `'pode-duplicar'`, today's behaviour.
   - `emitirOuImprimir(input)` — return an `EtiquetaOutcome`. Assume the shared
     gates already ran (see below). Issue all I/O through the injected
     `input.deps.*` clients and `input.db`; every UI effect (confirm, toast,
     open URL, drive the ME buy modal, ask how a Shopee package ships) through
     `input.ui.*`. Never read a module singleton and never write Firestore from
     a print/emit path unless the flow genuinely owns that write.
   - Narrow every `catch` to a specific error class (e.g. the freight client's
     `FreightHttpError` / `FreightNetworkError`, via `freightErrorMessage`) and
     `throw err` for anything else — no generic catch (repo rule). A
     `FreightTimeoutError` (#1094) is a `FreightNetworkError` subclass whose
     message is the copy: put its arm FIRST, and never re-send a buy on it — the
     server may still be running the first one. A UI that offers the buy must
     not leave the button armed either: `EtiquetaComprarModal` shows a yellow
     notice and CLOSES on it, so the only way back is reopening after checking
     the pedido.
   - A provider that needs the `int_frete` DOCUMENT narrows on
     `input.intFrete.fonte === 'doc'` first (the type makes forgetting it a
     compile error).
2. **Add one `registry.ts` entry** — put the provider in the array passed to
   `buildProviderMap`. Done; `PROVIDERS` indexes it by its `tipos`.
3. **A marketplace provider flips its caps in the SAME change**:
   `FREIGHT_TIPO_CAPS[tipo].canFetchLabel` (`@delfrance/schemas`) and the tipo
   leaves `providers/unsupportedMarketplace.ts`. The drift guard in
   `registry.test.ts` reds either half alone — the cap alone shows fetch
   buttons that end in "ainda não suportada"; the provider alone never renders
   its buttons.
4. **Write a unit test** `providers/<tipo>.test.ts` with injected fakes (see
   the existing per-provider tests). Do not hit Firestore or the network.

`resolveEtiquetaProvider` falls back on its own: a tipo with no exact provider
that is `marketplaceOwned` → `unsupportedMarketplace`; anything else → the
generic label. So the fallbacks stay correct even before you register a new
marketplace provider.

## Reachability: the integração a Shopee pedido has none of

`resolverIntFrete` is the one rule behind all three entry points (the checkout
post-save, the "Outros Checkouts" reprint and the `/pedidos` row action). When
the frete block's `externalOptionIntegracao` names a **marketplace-owned** tipo,
that tipo is the dispatch, with or without an `int_frete` document:

- the document is used only when it names the SAME tipo → `fonte: 'doc'`;
- otherwise — no `integracaoFreteOuterRef` (every Shopee pedido), a dangling
  ref, a document of another tipo → `fonte: 'bloco'`, `id: null`, `data: null`.

It WIDENS, never narrows: a block naming a non-marketplace tipo changes
nothing, and no document still means "sem integração". `'bloco'` therefore only
ever reaches a marketplace provider — `resolveEtiquetaProvider` never sends a
marketplace tipo to Melhor Envio or the generic label, and both of those refuse
`'bloco'` anyway ("Integração de frete não encontrada.").

## The marketplace providers

`mercadoLivre` is **implemented** — `providers/mercadoLivre.ts` (port of the
legacy `emitirEtiquetaMercadoLivre`) fetches the marketplace-generated label
through the apps/mercado-livre proxy route (`GET …/etiqueta`, PDF or ZPL2) and
sends it to the print agent. ML's `invoice_pending` reject auto-recovers: the
provider (re)sends the pedido's latest **aprovada** NF-e (`enviar-nfe`, 202 =
enqueued), waits 15s for ML to process it, then retries the fetch exactly once.

`shopee` is **implemented** — `providers/shopee.ts` (#1523, step 15; the port of
the legacy `gerarEtiquetaShippingShopee`). It is a bounded, RESUMABLE loop over
ONE stateless route on `apps/shopee`, `POST /api/marketplace/shopee/etiqueta`,
which re-derives the phase from Shopee on every call:

| answer                        | what the provider does                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| 200 — the file                | prints it (below)                                                                        |
| 202 `aguardar`                | sleeps `tentarEmMs` clamped to [2 s, 15 s]; ONE blue toast per phase                     |
| 202 `escolher-envio`          | `ui.escolherEnvio` (pickup address/slot or dropoff); the answer rides the NEXT call only |
| 202 `baixar-por-pacote`       | one call — and one file — per listed package, with `pacote`                              |
| 409 / 403 / any other failure | `error` with the backend's own sentence; never retried automatically                     |

- **The bounds** (`SHOPEE_ETIQUETA_LIMITES`): 75 s per call (an `AbortSignal`),
  120 s of MACHINE time per click — calls and sleeps; the operator's dialog
  time is excluded — and at most 8 questions. Bounding is safe here because
  the server never ships a package twice (a repeated `ship_order` reads as
  arranged) and a reprint is the same document, so "timeout, then re-click"
  converges. The give-up sentence is chosen from the last 202's `progresso`,
  never parsed from text: every package arranged ⇒ "O envio JÁ ESTÁ
  ORGANIZADO…", otherwise "A Shopee ainda não respondeu…".
- **The print agent** gets only the three types it routes on, as their BARE
  essence (`mimeParaAgente`: `text/plain; charset=utf-8` ⇒ `text/plain`); any
  other type is DOWNLOADED with a yellow notice, because the agent answers 200
  for a type it cannot print and prints nothing. A PDF prints at
  `TAMANHO_DO_PDF_SHOPEE` (`'a4'`, legacy parity, UNVERIFIED until the first
  real BR label); the thermal ZIP and a bare ZPL at `'etq'`. A file in another
  format than the one asked for still prints, with a yellow notice
  (`avisoDeFormato`).
- **`reimpressao: 'mesmo-documento'`**: no posted-risk confirm. Without it the
  confirm would fire on every reprint (`aguardandoPostagem` follows our own
  arrange) and on step 14's `error` stamp.
- **No NF-e logic on the web**: `nfe-pendente` is a terminal 409 whose sentence
  already says what the server did (it re-drives the NF-e when the caller may
  edit pedidos). `frete.externalId` is never read — it is `null` on every split
  Shopee order by design.
- **Deploy `apps/shopee` BEFORE `apps/web`**: the reverse posts to a route that
  does not exist yet.

The remaining marketplace carriers route to `unsupportedMarketplace` (a toast +
an `'unsupported'` outcome). When their fetch flows land (Phase 5/6), each
should reproduce the corresponding legacy call from `emitirOuImprimirFrete.dart`
(`tipoEtiqueta` is the PDF-vs-ZPL2 selection; `zpl2` below is
`tipoEtiqueta == FORMATO_ETIQUETA.zpl2`):

| Tipo (`IntegracaoFrete`) | Legacy call                                                    | Notes                                                |
| ------------------------ | -------------------------------------------------------------- | ---------------------------------------------------- |
| `amz` (Amazon)           | `gerarEtiquetaDBAAmazon(contaUid: pedido.integracao_id, zpl2)` | Amazon DBA label.                                    |
| `magalu`                 | `gerarEtiquetaMagalu(contaUid: pedido.integracao_id, zpl2)`    | Account is the pedido's `integracao_id`.             |
| `lojaIntegrada`          | **target resolution first** (below), then the mapped provider  | LI never emits directly; it maps to another carrier. |

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

`registry.emitirOuImprimirEtiqueta` resolves the provider (pure, no I/O), then
runs `runEtiquetaGates`, so by the time `emitirOuImprimir` is called:

1. **Sem frete skipped** — `frete.modalidade === '9'` (semFrete) short-circuits
   to a silent `skipped`; a provider never sees a no-shipment frete. This gate
   runs for every provider.
2. **Already-posted reprint confirmed** — when
   `frete.estado !== 'checkFinalizado' && isFreteJaPostado(frete.estado)`, the
   operator has confirmed the duplicate-label risk (`ui.confirmRisk`); declining
   short-circuits to `skipped`. ⚠️ SKIPPED for a provider declaring
   `reimpressao: 'mesmo-documento'` (Shopee): its whole rationale is a
   duplicate PAID label, which that provider cannot produce.
3. **Integração resolved** — the caller resolves the freight integration
   through `resolverIntFrete` and passes it as `input.intFrete`
   (`IntFreteResolvido`: `fonte: 'doc'` with the document, or `fonte: 'bloco'`
   with the marketplace tipo alone); a provider never re-reads it, and never
   has to handle a missing integração.
