---
title: Architecture
description: Multi-app split, plugin contracts, data layer.
---

The monorepo splits Next.js apps **by persona/runtime**, not by ERP domain. The trade-offs and rationale are recorded as Architecture Decision Records (ADRs).

## Apps split

- `apps/web` — internal ERP UI. Client-first; the server runtime exists but does almost nothing.
- `apps/integrations` — API-only for external systems (webhooks, OAuth, NFe SEFAZ async).
- `apps/docs` — this site.

## Why client-first in `apps/web`

The ERP is behind authentication. No SEO, no public crawling. RSC's main wins (initial paint speed, server-side data fetching) don't pay off when most data is real-time `onSnapshot` anyway. Client-first keeps server compute cost minimal on Firebase App Hosting and removes a category of complexity (middleware, session cookies, server actions) that we don't need.

## Integrations — there is no plugin system

⚠️ **`packages/core` declares no plugin contract, and nothing composes into a registry at app boot.** Five contracts existed here over time and all five were deleted — `FreightProvider` (#262), `MarketplaceChannel` ([ADR 0015](/adr/0015-no-marketplace-mega-contract/)), `PaymentGateway` (#1429), and `TaxProvider` + `InvoiceProvider` with `PluginRegistry` and `@delfrance/plugin-sdk` (#1444) — each once a real implementation proved a registry interface cannot express work that needs Firestore, Storage and a token refresher.

Every integration resolves its account **per request** from a Firestore document (`integracao` / `int_frete` / `metodo_pgto`), which is what makes **one App Hosting backend per channel** possible. What a provider supports is declared by a capability table — `MARKETPLACE_TIPO_CAPS`, `FREIGHT_TIPO_CAPS` in `@delfrance/schemas` — not by an interface it implements. See the [integration authoring guide](/guides/integration-authoring/).

Brazilian fiscal features stay **opt-in** by packaging, not by contract: `packages/integrations/nfe` is imported by `apps/nfe`, and `packages/core` stays locale-agnostic.

## Data layer

`packages/schemas/<domain>.ts` is the single source of truth (Zod). `packages/data/defineCollection<T>` wraps the Firestore SDK with typed converters and query helpers — **no codegen** for queries, forms, or types.
