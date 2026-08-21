---
title: Plugin authoring
description: How to add a new domain plugin (tax, invoice, payment, marketplace) to Delfrance.
---

Brazilian-specific features (NFe, Mercado Pago, marketplaces) ship as **opt-in plugins** in Delfrance. The core is locale-agnostic — anything tax, invoice, payment, or marketplace related is authored against a contract in `@delfrance/core/plugins`. This guide shows how to add a new one. (Freight is the exception: it's integrated **directly** via `@delfrance/integrations-freight-br` + the `FREIGHT_TIPO_CAPS` table in `@delfrance/schemas`, not against a plugin contract — see the `freight-integrations` skill.)

:::caution[Read "How in-tree channels are actually wired" first]
The `PluginRegistry` described here is the contract for **third-party** plugins. No in-tree channel uses it: they are resolved per request from a Firestore `integracao` document, not looked up by plugin id at boot. See the section below before assuming the registry path.
:::

## Plugin contracts

`@delfrance/core/plugins` exports four interfaces:

```ts
interface TaxProvider       { id; calculate(input)            }
interface InvoiceProvider   { id; issue(orderId)              }
interface PaymentGateway    { id; createCharge; refund; webhook }
interface MarketplaceChannel{ id; syncProducts; pullOrders;
                              pushTracking; oauthFlow;
                              /* + ~15 OPTIONAL members */    }
```

The first three really are that small. `MarketplaceChannel` is not: those five are only the **required** core, and the interface carries roughly fifteen optional capabilities on top — `pushPrice` / `pushAllPrices`, `pushStock`, `exportProduct` / `bindListing` / `syncProduct`, `importProducts`, `importOrders`, the order-enrichment group, `fetchLabel`, the incident group. The rule, from the interface's own docblock:

> The core members (`id`, `syncProducts`, `pullOrders`, `pushTracking`, `oauthFlow`) are REQUIRED; every other capability is OPTIONAL — a channel implements only what its API supports and callers feature-detect (`typeof channel.pushPrice === 'function'`).

Read `packages/core/src/plugins/index.ts` for the current list rather than this page. ⚠️ The contract is **under revision**: the Mercado Livre port was the first real implementation and surfaced seven amendments it needs before a second channel is built against it — see [#815](https://github.com/Hinten/next_erp/issues/815). Don't design a new channel around the shape as it stands today without reading that issue.

Implementations live under `packages/integrations/<channel>/`.

## Public surface for third-party plugins

Plugin authors publishing to npm should depend on `@delfrance/plugin-sdk`, **not** on `@delfrance/core/plugins` directly. The SDK re-exports the contracts and provides:

```ts
defineIntegration({
  manifest: {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '0.1.0',
    kinds: ['tax'],          // 'tax' | 'invoice' | 'payment' | 'marketplace'
  },
  register({ register }) {
    register(myImplementation);
  },
});
```

This indirection lets us evolve the internal `core/plugins` API without breaking external plugins.

## Worked example

See `apps/example/src/customPlugin.ts` and `apps/example/src/index.ts` for a runnable demo. Run it with:

```bash
pnpm --filter @delfrance/example demo
```

The example registers a flat-rate `TaxProvider` and exercises every public surface (schemas, money, plugin registry, permissions) without depending on Firebase.

## How in-tree channels are actually wired

`PluginRegistry` is real (`packages/core/src/plugins/index.ts`) and so is the `defineIntegration` path above — but **nothing in the repo registers a marketplace at boot**. There is no `delfrance.config.ts`, and no boot step that seeds a marketplace registry. Only two registry instances exist at all: `apps/web/lib/plugins/paymentRegistry.ts`, which is deliberately empty and serves payments only, and the one `apps/example` builds to demo a `TaxProvider`. Neither is a marketplace, and `registerMarketplace` is called nowhere outside its own unit test.

In-tree channels are wired the other way round: **one App Hosting backend per channel**, and the channel object is constructed **per request** from the Firestore `integracao` document that the request names. Mercado Livre is the worked example — every ML route calls:

```ts
// apps/mercado-livre/lib/marketplace/core/mercadoLivre.ts
const channel = createMercadoLivreChannel(mercadoLivreConfig());
```

inside `loadMercadoLivreContext(db, integracaoId)`, which reads the `integracao` doc, rejects it unless `tipo === INTEGRACAO_TIPO.mercadoLivre`, resolves the account's OAuth token (or refreshes it), and hands back a `ChannelContext` bound to that one account. **The routing key is the Firestore document, not a plugin id.**

That is not an accident of implementation — it falls out of the architecture. A channel needs per-account credentials, Firestore, and its own deploy/scale/failure isolation, none of which a process-global id→implementation map provides. Which is also why several `MarketplaceChannel` members on the ML channel object throw `MercadoLivreNotConfiguredError`: they need Firestore, so the working implementation lives in `apps/mercado-livre` and the contract member stays a stub.

So: the registry contract is the **public** surface, for plugins published to npm by someone who is not us. If you are adding a channel to this repo, follow `apps/mercado-livre` — a new app, `packages/integrations/<channel>` for the platform-neutral half, and a context loader.

## Testing your plugin

- Unit tests: Vitest. Keep contract tests deterministic — no network in unit tests.
- Integration tests: against a real upstream (or `nock` fixtures for marketplace plugins). Mark these as `*.contract.test.ts` so they can be skipped when offline.
- The `@delfrance/example` demo is a quick smoke test you can adapt before publishing.

## Naming

- Package name: `@delfrance/integrations-<channel>` (e.g. `@delfrance/integrations-mercado-pago`).
- Plugin id: kebab-case channel name (`'mercado-pago'`, `'mercado-livre'`, `'amazon-sp-api'`). Match the conventions in `pluginIdForTipo()` in `@delfrance/schemas`.
- Errors: throw a named error class (`MyChannelNotConfiguredError`) instead of plain `Error`, so consumers can pattern-match.

## Status of in-tree plugins

Only five of the ten are implemented; the other five throw `NotImplemented` from a single-file scaffold. **Note the pattern in the "Built" column**: every implemented one is a library paired with an app, because that is where the Firestore-bound half lives.

| Plugin | Status |
|---|---|
| `nfe` | **Built** — NF-e 4.00 generation, signing, SEFAZ transmission, DANFE. Paired with `apps/nfe`; XSD→TS types are generated (ADR 0004) |
| `mercado-livre` | **Built** — the channel is code-complete (OAuth, import, orders, payments, shipments, stock, price, labels, claims). Paired with `apps/mercado-livre`, which holds everything Firestore-bound |
| `mercado-pago` | **Built** — paired with `apps/mercado-pago` |
| `whatsapp-cloud-api` | **Built** — typed client + webhook envelope schemas, paired with `apps/whatsapp` |
| `freight-br` | **Built** — Melhor Envio (OAuth + quote + buy/print/track). Direct integration, **not** a plugin-contract channel (see the `freight-integrations` skill) |
| `shopee`, `amazon-sp-api`, `magalu`, `loja-integrada`, `facebook` | Scaffold — every contract member throws `NotImplemented` |
