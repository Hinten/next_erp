---
title: Plugin authoring
description: How to add a new domain plugin (tax, invoice, payment, marketplace, freight) to Delfrance.
---

Brazilian-specific features (NFe, Mercado Pago, marketplaces) ship as **opt-in plugins** in Delfrance. The core is locale-agnostic — anything tax, invoice, payment, marketplace, or freight related is authored against a contract in `@delfrance/core/plugins` and registered into a `PluginRegistry` at app boot. This guide shows how to add a new one.

## Plugin contracts

`@delfrance/core/plugins` exports five interfaces, each with a small surface:

```ts
interface TaxProvider       { id; calculate(input)            }
interface InvoiceProvider   { id; issue(orderId)              }
interface PaymentGateway    { id; createCharge; refund; webhook }
interface MarketplaceChannel{ id; syncProducts; pullOrders;
                              pushTracking; oauthFlow         }
interface FreightProvider   { id; quote; purchase; track      }
```

Implementations live under `packages/integrations/<channel>/`. The host app (`apps/web` or `apps/integrations`) imports them and calls `registry.registerXxx(impl)` at boot.

## Public surface for third-party plugins

Plugin authors publishing to npm should depend on `@delfrance/plugin-sdk`, **not** on `@delfrance/core/plugins` directly. The SDK re-exports the contracts and provides:

```ts
defineIntegration({
  manifest: {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '0.1.0',
    kinds: ['tax'],          // 'tax' | 'invoice' | 'payment' | 'marketplace' | 'freight'
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

## Where to register at runtime

In `apps/web`, plugin registration lives at `lib/plugins/`. Each app boot reads a `delfrance.config.ts` (TODO: not yet implemented; a follow-up doc explains the format) and seeds the registry. Registration order matters only when two plugins claim the same `id`.

## Testing your plugin

- Unit tests: Vitest. Keep contract tests deterministic — no network in unit tests.
- Integration tests: against a real upstream (or `nock` fixtures for marketplace plugins). Mark these as `*.contract.test.ts` so they can be skipped when offline.
- The `@delfrance/example` demo is a quick smoke test you can adapt before publishing.

## Naming

- Package name: `@delfrance/integrations-<channel>` (e.g. `@delfrance/integrations-mercado-pago`).
- Plugin id: kebab-case channel name (`'mercado-pago'`, `'mercado-livre'`, `'amazon-sp-api'`). Match the conventions in `pluginIdForTipo()` in `@delfrance/schemas`.
- Errors: throw a named error class (`MyChannelNotConfiguredError`) instead of plain `Error`, so consumers can pattern-match.

## Status of in-tree plugins

| Plugin | Status |
|---|---|
| `nfe` | Scaffold (depends on Phase 0 spikes 0004–0008) |
| `mercado-pago` | Scaffold (will wrap `mercadopago` SDK) |
| `mercado-livre` | Scaffold (OAuth start URL works; rest pending) |
| `shopee` | Scaffold |
| `amazon-sp-api` | Scaffold (will wrap `amazon-sp-api` npm) |
| `magalu`, `loja-integrada`, `facebook` | Scaffold |
| `freight-br` | Scaffold (Melhor Envio + Correios + motoboy + retirar-loja) |
| `whatsapp-cloud-api` | Typed client + webhook envelope schemas (real impl) |
