---
title: Plugin authoring
description: How to add a tax or invoice plugin to Delfrance — and why sales channels, payments and freight are not plugins.
---

NFe ships as an **opt-in plugin** in Delfrance. The core is locale-agnostic — tax and
invoice concerns are authored against a contract in `@delfrance/core/plugins`. This
guide shows how to add one.

:::danger[Sales channels, payments and freight are NOT plugins.]
If you are adding a marketplace (Shopee, Magalu, Amazon, Loja Integrada), a payment
provider, or a freight provider, **stop reading this page.**

- **Marketplaces** → [ADR 0015](/adr/0015-no-marketplace-mega-contract/) and the
  `marketplace-integration` skill. A channel is one App Hosting backend
  (`apps/<channel>`) resolved per request from its `integracao` document, declared by
  a row in `MARKETPLACE_TIPO_CAPS` (`@delfrance/schemas`).
- **Payments** → mirror `apps/mercado-pago`. The step-by-step procedure lives on
  `tipoIntegracaoPgtoSchema` in `@delfrance/schemas`, beside the enum you widen.
- **Freight** → the `freight-integrations` skill. Integrated directly via
  `@delfrance/integrations-freight-br` + the `FREIGHT_TIPO_CAPS` table.

All three used to have a plugin contract here, and all three had it **deleted** —
`FreightProvider` in #262, `MarketplaceChannel` in #815, `PaymentGateway` in #1429 —
for the same reason: a registry interface in `packages/core` can only describe
fetch-and-return operations, while the real work needs Firestore, Storage and a token
refresher. This page previously told marketplace authors to implement four members
that every implementation threw from, and to register them into a registry nothing
read. It no longer does.
:::

## Plugin contracts

`@delfrance/core/plugins` exports two interfaces, and they really are this small:

```ts
interface TaxProvider     { id; calculate(input) }
interface InvoiceProvider { id; issue(orderId) }
```

⚠️ A `PaymentGateway` sat here until #1429 and was **deleted**, for the reason in
the box above: all three of its members threw, the registry that would have held it
was permanently empty, and the working Mercado Pago integration lives in
`apps/mercado-pago`. Its `webhook` had already shipped there on the shared
notification pipeline; its `createCharge` mis-described the real operation (a
Checkout Pro *preference*, which returns a link and an expiry, not a charge id and a
status); its `refund` had no precedent in this repo or the legacy one.

Read `packages/core/src/plugins/index.ts` for the current shape rather than this page.

## Public surface for third-party plugins

Plugin authors publishing to npm should depend on `@delfrance/plugin-sdk`, **not** on
`@delfrance/core/plugins` directly. The SDK re-exports the contracts and provides:

```ts
defineIntegration({
  manifest: {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '0.1.0',
    kinds: ['tax'], // 'tax' | 'invoice'
  },
  register({ register }) {
    register(myImplementation);
  },
});
```

This indirection lets us evolve the internal `core/plugins` API without breaking
external plugins.

## How in-tree integrations are actually wired

`PluginRegistry` is real, and so is the `defineIntegration` path above — but it is the
contract for **third-party** plugins published by someone who is not us. **Nothing
in-tree registers anything at boot.** There is no `delfrance.config.ts` and no boot
step that seeds a registry. Exactly **one** instance exists in the whole repo: the one
`apps/example` builds to demo a `TaxProvider`. (There was a second — a permanently
empty payments registry under `apps/web/lib/plugins/` — deleted with the payment
contract in #1429.)

In-tree integrations are wired the other way round: **one App Hosting backend per
channel**, with the account resolved **per request** from the Firestore `integracao`
(or `int_frete`, or `metodo_pgto`) document the request names. Mercado Livre is the
worked example — every ML route starts at
`loadMercadoLivreContext(db, integracaoId)`, which reads the document, rejects it
unless `tipo === INTEGRACAO_TIPO.mercadoLivre`, resolves the account's OAuth token
(or refreshes it), and hands back a `ChannelContext` bound to that one account.
**The routing key is the Firestore document, not a plugin id.**

That is not an accident of implementation. An integration needs per-account
credentials, Firestore access, and its own deploy/scale/failure isolation — none of
which a process-global id→implementation map provides.

## Worked example

See `apps/example/src/customPlugin.ts` and `apps/example/src/index.ts` for a runnable
demo:

```bash
pnpm --filter @delfrance/example demo
```

It registers a flat-rate `TaxProvider` and exercises the public surface (schemas,
money, plugin registry, permissions) without depending on Firebase.

## Testing your plugin

- Unit tests: Vitest. Keep contract tests deterministic — no network in unit tests.
- Integration tests: against a real upstream, or recorded fixtures. Mark these
  `*.contract.test.ts` so they can be skipped when offline.
- The `@delfrance/example` demo is a quick smoke test you can adapt before publishing.

## Naming

- Package name: `@delfrance/integrations-<channel>` (e.g.
  `@delfrance/integrations-mercado-pago`).
- Plugin id: kebab-case channel name (`'mercado-pago'`, `'nfe'`).
- Errors: throw a named error class (`MyChannelNotConfiguredError`) instead of a plain
  `Error`, so consumers can narrow on it — the repo's no-generic-catch rule depends on
  it.

## Status of in-tree integration packages

⚠️ Only the FIRST is a plugin-contract implementation. The rest are libraries
their app imports directly, which is the shape every integration here has converged
on: **a platform-neutral library paired with an app that holds the Firestore-bound
half.**

| Package | Contract | Status |
|---|---|---|
| `nfe` | `InvoiceProvider` | **Built** — NF-e 4.00 generation, signing, SEFAZ transmission, DANFE. Paired with `apps/nfe`; XSD→TS types are generated (ADR 0004) |
| `mercado-pago` | none (#1429) | **Built** — OAuth, the REST client, response schemas, the `mpPaymentToPagamento` mapper. Paired with `apps/mercado-pago`, which holds OAuth persistence and the webhook reconciler |
| `whatsapp-cloud-api` | none | **Built** — typed client + webhook envelope schemas, paired with `apps/whatsapp` |
| `mercado-livre` | none (ADR 0015) | **Built** — OAuth, the 62-operation REST client, wire schemas, pure mappers. Paired with `apps/mercado-livre`, which holds every stateful flow |
| `freight-br` | none (#262) | **Built** — Melhor Envio (OAuth + quote + buy/print/track), paired with `apps/melhor-envio` |

The five throw-only marketplace scaffolds (`shopee`, `amazon-sp-api`, `magalu`,
`loja-integrada`, `facebook`) were **deleted** in #815. They existed only to typecheck
against `MarketplaceChannel` and had no importer anywhere. That those channels are
planned is recorded by `INTEGRACAO_TIPO` and their `MARKETPLACE_TIPO_CAPS` rows.

⚠️ Adding a second **payment** provider follows the procedure documented on
`tipoIntegracaoPgtoSchema` in `@delfrance/schemas` — widen the tipo enum, add
`apps/<provider>` mirroring `apps/mercado-pago`, and introduce a capability table
at that point, not before.
