---
title: Integration authoring
description: How to add a marketplace, payment provider, freight provider or fiscal integration to Delfrance — and why none of them is a plugin.
---

**Delfrance has no plugin system.** It had one. Every contract in it was deleted, each
after its first real implementation disproved it. This page is what replaced the
authoring guide: a router to the right pattern for the thing you are adding.

:::danger[There is no registry, and nothing registers into one.]
There is no `delfrance.config.ts`, no boot step that seeds a registry, and no
`@delfrance/plugin-sdk`. If you came here looking for the interface to implement,
there isn't one — find your row in the table below.
:::

## What to read for what you are adding

| Adding… | Read | Shape |
| --- | --- | --- |
| A **marketplace** (Shopee, Magalu, Amazon, Loja Integrada) | [ADR 0015](/adr/0015-no-marketplace-mega-contract/) and the `marketplace-integration` skill | one App Hosting backend `apps/<channel>`, resolved per request from its `integracao` document, declared by a row in `MARKETPLACE_TIPO_CAPS` (`@delfrance/schemas`) |
| A **payment** provider | the docstring on `tipoIntegracaoPgtoSchema` in `@delfrance/schemas`, beside the enum you widen | mirror `apps/mercado-pago`; add a capability table when provider #2 lands, not before |
| A **freight** provider | the `freight-integrations` skill | `@delfrance/integrations-freight-br` plus the `FREIGHT_TIPO_CAPS` table |
| **Fiscal** behaviour (NF-e, tax) | the `nfe` skill | `packages/integrations/nfe` paired with `apps/nfe`. Tax is the `impostoProduto` / `impostoCategoria` / `regraImposto` resolver chain, not a provider interface |

## Why there is no plugin contract

Five were declared, and all five were deleted:

| Contract | Removed | What disproved it |
| --- | --- | --- |
| `FreightProvider` | #262 | a three-method `quote`/`purchase`/`track` could not express OAuth → quote → cart → checkout → label |
| `MarketplaceChannel` | #815, [ADR 0015](/adr/0015-no-marketplace-mega-contract/) | three of four required members threw in the one channel built against it; ~25 support types had no importer; five packages existed only to typecheck against it |
| `PaymentGateway` | #1429 | all three members threw. Its `webhook` had already shipped **outside** the contract; its `createCharge` mis-described the real write (a Checkout Pro _preference_ — a link and an expiry, not a charge id and a status); its `refund` had no precedent in this repo or the legacy one |
| `TaxProvider` | #1444 | `calculate({ amount, ncm })` carries no CRT, no CST/CSOSN, no origem and no UF pair, while the real engine (`buildImpostoXml`) emits XSD-valid XML per CST |
| `InvoiceProvider` | #1444 | `issue(orderId)` → three statuses cannot express `aguardandoVinculo`, cStat 136 reconciliation, SVC/EPEC contingência, filial, ambiente or série. Its one implementation, `createNFeProvider()`, had zero callers |

They failed for one reason, stated in ADR 0015: **a registry interface in
`packages/core` can only describe fetch-and-return operations, while the real work
needs Firestore, Storage and a token refresher.** The contracts were never too small.
They were at the wrong altitude.

⚠️ Two of them stayed live for months while this page instructed authors to implement
members that every implementation threw from. Nothing failed, because nothing
registered — which is the whole hazard.
`packages/config-eslint/rules/removed-plugin-contracts.test.js` is the guard that now
turns a re-creation into a red build.

## How integrations are actually wired

**One App Hosting backend per channel**, with the account resolved **per request** from
the Firestore `integracao` (or `int_frete`, or `metodo_pgto`) document the request
names. Mercado Livre is the worked example — every ML route starts at
`loadMercadoLivreContext(db, integracaoId)`, which reads the document, rejects it
unless `tipo === INTEGRACAO_TIPO.mercadoLivre`, resolves the account's OAuth token (or
refreshes it), and hands back a `ChannelContext` bound to that one account.
**The routing key is the Firestore document, not a plugin id.**

That is not an accident of implementation. An integration needs per-account
credentials, Firestore access, and its own deploy / scale / failure isolation — none
of which a process-global id→implementation map provides.

## Package layout

Every integration is a **platform-neutral library paired with an app that holds the
Firestore-bound half**:

| Package | App | Status |
| --- | --- | --- |
| `nfe` | `apps/nfe` | NF-e 4.00 generation, signing, SEFAZ transmission, DANFE. XSD→TS types are generated (ADR 0004) |
| `mercado-livre` | `apps/mercado-livre` | OAuth, the 62-operation REST client, wire schemas, pure mappers |
| `mercado-pago` | `apps/mercado-pago` | OAuth, the REST client, response schemas, the `mpPaymentToPagamento` mapper |
| `whatsapp-cloud-api` | `apps/whatsapp` | typed Graph client + webhook envelope schemas |
| `freight-br` | `apps/melhor-envio` | Melhor Envio: OAuth, quote, cart→checkout, label print, tracking |
| `shopee` | `apps/shopee` | Shopee Open Platform: HMAC request signing, hosts, consent URL + token endpoints, wire schemas |

⚠️ Four throw-only marketplace scaffolds (`amazon-sp-api`, `magalu`, `loja-integrada`,
`facebook`) were deleted in #815 and stay deleted. `shopee` came back as a **real**
fetch-only package — the ADR-0015 shape, the opposite of the scaffold. That those
other channels are planned is recorded by `INTEGRACAO_TIPO` and their
`MARKETPLACE_TIPO_CAPS` rows.

## Naming and testing

- Package name: `@delfrance/integrations-<channel>`.
- Errors: throw a named error class (`MyChannelNotConfiguredError`) rather than a plain
  `Error`, so consumers can narrow on it — the repo's no-generic-catch rule depends on
  it.
- Unit tests: Vitest, deterministic, no network.
- Integration tests: against a real upstream, or recorded fixtures. Mark these
  `*.contract.test.ts` so they can be skipped when offline.
