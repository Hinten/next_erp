---
name: freight-integrations
description: >-
  Domain reference for freight (frete) in this monorepo — the Melhor Envio
  OAuth → quote → buy-label → print → track → webhook flow, the `int_frete`
  config collection and its per-tipo bodies (retiradaNaLoja / motoboy / fob /
  melhorEnvios / marketplaces), the `freteInicial` block on a pedido, the Frete
  tab in the pedido form, and the `/pedidos` etiqueta row action. Use when
  implementing, debugging or reviewing freight: Melhor Envio, melhorEnvios,
  etiqueta, label, frete, cotação / quote, carrinho / cart, checkout, Jadlog,
  Correios, declaração de conteúdo / DC-e, agency / agência, OAuth token
  refresh, the freight HTTP client, the ME order-status webhook, or adding a
  new freight tipo. Triggers on work in `apps/melhor-envio` or
  `packages/integrations/freight-br`, and on terms like intFrete, freteInicial,
  externalOptionId, externalOptionIntegracao, externalOptionData,
  comprarEtiqueta, addToCart, ensureCartAgency, calculate,
  loadMelhorEnvioContext, tokenMelEnv, printLabelId, codRastreio,
  FREIGHT_TIPO_CAPS, marketplaceOwned, labelMode, and adding a new freight
  provider / integradora (marketplace freight, emit vs fetch labels).
---

# Freight integrations

The freight domain ports the legacy Flutter ERP's despacho/frete flow with
**byte-compatible Firestore wire shapes** (the Flutter app still runs on the
same backend, so a field rename or shape drift corrupts live data). The only
**live** provider today is **Melhor Envio** (ME) — a shipping aggregator with an
OAuth API for quoting, buying and printing labels across many carriers (Correios,
Jadlog, …). The architecture is built so other providers (marketplace freight,
another aggregator) slot in by **category** — see *Provider categories* below.

## Where it lives (architecture map)

| Layer | Path | Holds |
| --- | --- | --- |
| **ME core** (platform-neutral) | `packages/integrations/freight-br` (`@delfrance/integrations-freight-br`) | OAuth, token lifecycle, the `MelhorEnvioApi` client, `calculate`/`cart`/`comprarEtiqueta` pipeline. **Deps: only `zod`** — no firebase, no Next. Tests mock `fetch`. |
| ↳ browser-safe client | `freight-br/src/http-client` (subpath `…/http-client`) | The typed `FreightHttpClient` `apps/web` calls (`.conta()`/`.comprar()`/`.imprimir()`/`.rastrear()`/`.calculate()`) + pure builders (`buildCartItem`, `buildCalculatePayload`). |
| **ME app** (API-only) | `apps/melhor-envio` (`@delfrance/melhor-envio-app`, `:3005`) | Thin route handlers under `app/api/freight/melhor-envio/{oauth/start,calculate,conta,comprar,imprimir,rastrear}`, the OAuth `callback`, the `webhooks/melhor-envio` receiver, and `lib/freight/*` (`loadMelhorEnvioContext`, the Firestore token store, signed-state HMAC, error→HTTP mapper). Has its **own** `CLAUDE.md`. |
| **Web UI** (client-first) | `apps/web/app/(app)/pedidos/_components` + `…/logistica` | Frete tab (`tabs/FreteTab.tsx` + `tabs/frete/*`), the `/pedidos` etiqueta row action (`EtiquetaRowAction` → `EtiquetaComprarModal`), the object-view print/track panel (`EtiquetaMelhorEnvioPanel`), the `/logistica` `int_frete` CRUD. `useFreightClient()` targets the ME app via `NEXT_PUBLIC_MELHOR_ENVIO_URL`. |
| **Schemas** | `packages/schemas/src/{integracao,frete}.ts` | `intFreteSchema` (the config doc, discriminated by `tipo`), `freteDoPedidoSchema` (`freteInicial`), `volumeSchema`, `PERM.frete`, and **`FREIGHT_TIPO_CAPS`** (the per-tipo capability table). Source of truth → `firestore.rules`. |

Freight **bypasses** the `core/plugins` `FreightProvider` registry (now
`@deprecated`): that 3-method contract can't express OAuth, cart→checkout→generate,
agency resolution, per-tipo UI, or the fetch / read-only category. The real
provider-neutral surface emerged bottom-up — `FreightHttpClient` +
`FREIGHT_TIPO_CAPS` (see *Provider categories*).

## Provider categories

Every freight `tipo` is one of three categories. The per-tipo flags live in **one
table** — `FREIGHT_TIPO_CAPS` in `packages/schemas/src/frete.ts`
(`Record<IntegracaoFrete, FreightTipoCapabilities>`) — the single source of truth
the etiqueta dispatch (`etiquetaRowState`) and the Frete tab read. Adding a `tipo`
without a caps row is a **compile error**.

| Category (`labelMode`) | Who makes the label | Status / tracking | Frete tab | Examples |
| --- | --- | --- | --- | --- |
| **emit** | the app buys + generates it (OAuth → quote → cart → checkout → generate → print) | a freight **webhook** (`webhooks/melhor-envio`) | editable | `melhorEnvios` |
| **fetch** | the **marketplace** generated it; the app fetches + prints | the marketplace **order-sync** (its own webhook), NOT a freight webhook | **read-only** (`marketplaceOwned`); `lojaIntegrada` remaps via `int_frete.mapa` to a target carrier | `mercadoLivre` / `shopee` / `amz` / `magalu` / `lojaIntegrada` — Phase 5/6, stubs today |
| **generic / none** | no carrier API — a generic PDF (`generic`) or nothing (`none`) | none (manual) | editable | `motoboy` / `outros`; `retiradaNaLoja` / `fob` |

⚠️ **`labelMode` is descriptive; the `can*` flags drive behavior.** Every `can*`
is false for every non-ME tipo today, so the row action resolves to `unsupported`
— byte-identical to the old `tipo !== 'melhorEnvios'` reject. Don't flip a
marketplace `canPrint` true until its fetch flow + client route exist, or a
marketplace pedido carrying a `printLabelId` would route "Imprimir" to the ME
backend.

### The provider-neutral surface (what every category writes through)

- `freteInicial.externalOption*` — `externalOptionId` (string), `externalOptionIntegracao` (the **tipo** enum), `externalOptionData` (opaque `Record<string,unknown>` — any provider's quote/option blob).
- `freteInicial.printLabelId` / `codRastreio` — label id + tracking code; the webhook finds a pedido by `printLabelId`.
- `freteInicial.estado` — `EstadoFrete` (27 states); `isFreteJaPostado` / `ESTADOS_FRETE_NAO_POSTADO` gate the re-emit/reprint risk confirm.
- `int_frete.mapa` — the marketplace shipping-option → target `int_frete` + `targetTipoIntegracao` routing table (the fetch category's remap).
- `FreightHttpClient` (6 methods) — already provider-neutral; only the route paths are ME-specific today.

### Status-update pattern (estado + tracking)

The ME webhook (`apps/melhor-envio/app/api/webhooks/melhor-envio/route.ts`) is the
template every provider follows: **find** the pedido by its label/tracking key →
**map** the provider status to `EstadoFrete` (`meStatusToEstadoFrete`) → **guard**
terminal states (`entregue`/`cancelado` never regress; a late, out-of-order event
can't downgrade) → **idempotent patch** of `freteInicial.estado`/`codRastreio`. A
new provider supplies only its signature verification + status map; the
find/guard/patch core is reusable — extract `applyFreightStatusUpdate` to
`@delfrance/data/admin` when a 2nd caller (webhook OR order-sync poll) appears.

## The flow (happy path)

```
1. CONNECT   OAuth: /oauth/start → ME consent → callback exchanges code →
                token persisted in int_frete/{id}/tokenMelEnv (single-token)
2. QUOTE     POST /me/shipment/calculate → list of carrier options
                (each quotable OR errored). User picks one → externalOption* cache
3. BUY       POST /me/cart (addToCart) → checkout → generate. Idempotent pipeline
                in comprarEtiqueta.ts: getOrder → resume if already paid_at
4. PRINT     POST /me/shipment/print → { url } printable label
5. TRACK     POST /me/shipment/tracking → status keyed by order id
6. WEBHOOK   ME posts order-status changes → webhooks/melhor-envio (HMAC) →
                maps to estadoFrete; terminal states never regress
```

The buy is driven from the **`/pedidos` row action** (`EtiquetaRowAction`), not
the object view — `EtiquetaMelhorEnvioPanel` only prints/tracks an already-bought
label. The comprar route is **server-authoritative**: it reads the persisted
`freteInicial.printLabelId` from the fresh pedido doc and prefers it over the
client value, so a double-click or stale client re-buy **resumes/reprints** the
same label instead of double-spending.

## Critical wire-compat facts (the traps)

- **`externalOptionIntegracao` is the integração `tipo` enum** (`'melhorEnvios'`,
  …) — **not** a doc id. Writing the doc id there fails Zod silently on save
  (was #218). Set it from `integracao.tipo`.
- **`externalOptionId`** = the chosen ME service id as a **string** (`"3"`).
  `externalOptionData` caches the option object (`{id,name,company,…}`,
  optionally `agency`). For motoboy it's an optionString
  `"${cepInicial} - ${cepFinal} - ${custo} - ${valor} - ${prazo}"`.
- **`tokenMelEnv` is single-token** — a refresh deletes the old token doc and
  writes the new one in one tx (Flutter parity). 30-day access / 45-day refresh,
  60s skew; `getOrRefreshAccessToken` handles it transparently.
- **`int_frete`**: `dataCadastro` is a **required ms-epoch**; `prazoExtra`
  non-nullable default 0; ME `client_id`/`client_secret` are **nullable on the
  doc for read-compat** but the live app reads the app-wide creds from **env**
  (one registered ME app, many connected accounts) — never per-doc.
- **Volume keeps the Flutter shape**
  (`quantidade/especie/marca/numero/pesoBruto/pesoLiquido/dimensoes/lacres`); it's
  remapped to XSD names only at the NF-e boundary.
- **Totals**: `valorCobrado = subtotal − desconto + valorFreteInicial`;
  `custoFreteInicial = custoFinal ?? custoCalculado` (custoCalculado first!);
  modalidade `'9'` (sem frete) → `valorFreteInicial = null`.
- **ME status map** (webhook): `delivered→entregue`, `posted|received→postado`,
  `canceled|cancelled→cancelado`, `suspended|paused→suspenso`,
  `undelivered→falhaNaEntrega`, `released`→**no-op**; terminal
  (`entregue`/`cancelado`) never regress.

## ⭐ The opaque cart 500 — drop-off carriers need an `agency`

The single biggest gotcha. **Jadlog** (and other drop-off carriers, ME services
3/4) **require an `agency`** (a drop-off agency id near the sender) on the cart
insert. Without it ME returns an **opaque HTTP 500** with *no* validation hint —
not a 422. This is auto-resolved server-side in `freight-br/src/melhor-envio/agency.ts`:
`addToCart` calls `ensureCartAgency`, which (when the caller hasn't set an agency)
looks up the service's company via `listServices`, finds the nearest agency via
`listAgencies({company, country, state, city})`, and picks the first. **Correios**
(services 1/2) is NOT agency-based — it instead needs a real NF-e key or a
**DC-e** (declaração de conteúdo eletrônica, a 2026-04 ME change) for
`non_commercial` shipments (DC-e generation is a deferred follow-up). When
debugging a cart 500, reach for `tools/test-fixtures/src/debug-me-cart.ts`
(`debug:me-cart`) — it bisects the cart payload field-by-field against the live
sandbox.

## NF-e key on the label (#209)

When the pedido has an authorized NF-e (modelo 55), its 44-digit **chave** is
sent as `invoice.key` on the cart item and flips `non_commercial` **off** — most
carriers reject a commercial shipment without it. Absent → `non_commercial: true`
(declaração de conteúdo). The chave is resolved by
`etiquetaActions.ts:resolveNfeChave()` (reads `pedidos/{id}/nfev4`, latest
aprovada/EPEC chave) and passed as `invoiceKey` into the **pure**
`buildPedidoCartPayload` (`melhorEnvioCart.ts`) — the mapper does no Firestore
reads; `buildCartItem` tolerates a blank/null key.

## Add a new freight provider

1. **Enum + caps (compiler-gated).** Add the `tipo` to `integracoesFreteSchema` +
   a label in `INTEGRACAO_FRETE_LABELS`, and a **`FREIGHT_TIPO_CAPS` row** — TS
   won't compile without it. Pick the flags by category (emit / fetch / generic /
   none); set `marketplaceOwned` for a marketplace-owned block, and `channel` only
   if it has a server route.
2. **`int_frete` body.** Add tipo-specific fields to `intFreteSchema`
   (`packages/schemas/src/intFrete.ts`) — one passthrough object; add defaulted
   extras. Register in `registry.ts` only for a new domain. Any `*Meta` perm /
   path change → `pnpm --filter @delfrance/rules-gen gen:rules` + commit (rule 1).
3. **Config CRUD.** Extend the `/logistica` editors (see the `schema-driven-crud`
   skill).
4. **Frete tab body.** Add `tabs/frete/<Tipo>Fields.tsx` + a `case` in
   `FreteTab.renderTipoFields()` (the switch stays until ≥2 providers with
   converged Fields props). `marketplaceOwned: true` auto-locks the header via the
   caps read — no separate list to edit.
5. **Etiqueta dispatch — automatic from caps.** `etiquetaRowState` routes off
   the caps (via **`freightCapsFor(tipo)`** — the tolerant accessor; index
   `FREIGHT_TIPO_CAPS` directly only with a parsed `tipo`, since UI `tipo` comes
   unparsed from Firestore and an unknown value must degrade to "unsupported",
   not crash). Set `canQuote` / `canBuy` / `canPrint` and the `/pedidos` row
   action lights up (quote-first / comprar / imprimir). Add a branch in
   `EtiquetaRowAction.tsx` only for a genuinely NEW action kind (e.g. a
   fetch-label download).
6. **Client route (emit / routed providers only).** If the provider needs server
   compute (OAuth / secret / API), give it `channel: '<slug>'` in caps, add
   `/api/freight/<slug>/*` handlers (its own app like `apps/melhor-envio`, or a
   segment in a shared freight app — decide per provider), and thread `channel`
   into `createFreightHttpClient` (a ~15-line change; the `FreightHttpClient`
   interface is already neutral, so do it WITH this provider). Fetch / generic
   providers skip this.
7. **Status updates.** Copy `meStatusToEstadoFrete` + the find/guard/patch block
   from the ME webhook; parameterize the status map + lookup key. **If this is the
   2nd status caller**, extract `applyFreightStatusUpdate` to
   `@delfrance/data/admin` and route both through it. Marketplace (fetch) status
   arrives via the marketplace order-sync, not a freight webhook.

## Melhor Envio specifics

- **Sandbox vs prod**: `melhorEnvioBaseUrl(sandbox)` →
  `sandbox.melhorenvio.com.br` vs `www.melhorenvio.com.br`. Default is **sandbox
  unless `MELHOR_ENVIO_SANDBOX=false`** (prod must opt out). All dev/test runs on
  sandbox.
- **`User-Agent` is required** by ME on every request (app name + contact email)
  — the legacy omitted it on GETs; the port always sends it.
- **Tokens are Laravel Passport JWTs** with a `scopes` array; the registered
  sandbox app must grant cart-write scopes (it does — verified, all 14 scopes).
- **Quote responses are per-service**: an option is either quotable (`price` +
  `company`) or carries an `error` string (carrier can't quote the route) —
  `isErroredOption(o)` distinguishes them; never assume `price`/`company` exist.
- **Checkout spends real wallet balance** even in sandbox semantics — the buy
  modal shows the account **saldo** + a low-balance warning before confirming.

## Testing & fixtures

- **Offline unit** (`packages/integrations/freight-br/test`, `apps/melhor-envio`):
  `vitest run`, `fetch` mocked. No creds. This is what `ci-freight.yml`'s
  offline job runs (it `--exclude '**/*.sandbox.test.ts'`).
- **Live sandbox** (`*.sandbox.test.ts`, e.g.
  `freight-br/test/melhor-envio/calculate.sandbox.test.ts`): hits the real ME
  sandbox with a connected account token from `MELHOR_ENVIO_SANDBOX_TOKEN`.
  **Read-only** (`/me`, `/me/balance`, `calculate`) — no cart/checkout, no spend.
  `describe.skip`s locally without the token; THROWS in CI so a missing secret
  fails loud. Refresh the token (~30-day expiry) and update the secret when it
  401s.
- **Manual UI loop** (staging Firestore): `pnpm --filter @delfrance/test-fixtures
  seed:frete-me` (Jadlog quote on `dev-frete-me-01`) → `/pedidos` → Comprar
  etiqueta → buy → `reset:frete-me` re-arms the pedido for another buy.
  `debug:me-cart` is the low-level cart-500 bisector.

## CI — `ci-freight.yml`

Mirrors `ci-nfe.yml`, path-filtered to `apps/melhor-envio/**` +
`packages/integrations/freight-br/**` + `schemas/src/{frete,integracao}.ts`:

- **`freight-build-test`** (always): lint + typecheck + offline unit
  (`--exclude '**/*.sandbox.test.ts'`) + `next build`, filtered to the two
  freight packages.
- **`freight-live`** (opt-in): gated by `vars.FREIGHT_CI_LIVE_ENABLED == 'true'
  || workflow_dispatch` — **off by default** so an expired sandbox token never
  reds a PR. Verifies the `MELHOR_ENVIO_SANDBOX_TOKEN` secret (loud fail if
  missing), then runs the sandbox suite by name. **No ngrok** — the OAuth
  callback round-trip can't run in CI, so the token is supplied directly.
- **`report-failure`**: comments the Actions run link on a failing PR.

To enable the live lane: set repo var `FREIGHT_CI_LIVE_ENABLED=true` + secret
`MELHOR_ENVIO_SANDBOX_TOKEN` (+ optional var `MELHOR_ENVIO_USER_AGENT`).

## Reference

**Env vars** (root `.env.local` in dev; Cloud Secret Manager in prod):
`MELHOR_ENVIO_CLIENT_ID`, `MELHOR_ENVIO_CLIENT_SECRET`,
`MELHOR_ENVIO_STATE_SECRET` (OAuth state HMAC), `MELHOR_ENVIO_SANDBOX`,
`MELHOR_ENVIO_USER_AGENT`, `MELHOR_ENVIO_PUBLIC_URL` (callback origin),
`NEXT_PUBLIC_MELHOR_ENVIO_URL` (apps/web → ME app).

**ME endpoints** (all under `/api/v2`): `POST /me/shipment/calculate`,
`GET /me`, `GET /me/balance`, `GET /me/shipment/services`,
`GET /me/shipment/agencies`, `POST /me/cart`, `GET /me/orders/{id}`,
`POST /me/shipment/{checkout,generate,print,tracking}`.

**Key files**: `freight-br/src/melhor-envio/{oauth,api,calculate,cart,agency,comprarEtiqueta,types}.ts`;
`apps/melhor-envio/lib/freight/{melhorEnvio,tokenStore,state,respond}.ts`;
`apps/web/app/(app)/pedidos/_components/{EtiquetaRowAction,EtiquetaComprarModal,etiquetaActions}.tsx`
+ `tabs/frete/{FreteTab,MelhorEnvioFields,EtiquetaMelhorEnvioPanel,melhorEnvioCart}.tsx`.
