---
title: Architecture
description: Multi-app split, plugin contracts, data layer.
---

The monorepo splits Next.js apps **by persona/runtime**, not by ERP domain. The trade-offs and rationale are recorded as Architecture Decision Records (ADRs).

## Apps split

- `apps/web` — internal ERP UI. Client-first; the server runtime exists but does almost nothing.
- `apps/integrations` — API-only for external systems (webhooks, OAuth, NFe SEFAZ async).
- `apps/webchat` — embeddable widget; static.
- `apps/docs` — this site.
- `apps/example` — minimal OSS demo.

## Why client-first in `apps/web`

The ERP is behind authentication. No SEO, no public crawling. RSC's main wins (initial paint speed, server-side data fetching) don't pay off when most data is real-time `onSnapshot` anyway. Client-first keeps server compute cost minimal on Firebase App Hosting and removes a category of complexity (middleware, session cookies, server actions) that we don't need.

## Plugins

Brazilian features are **opt-in**. Three contracts live in `packages/core/src/plugins/`: `TaxProvider`, `InvoiceProvider` and `PaymentGateway`. The core stays locale-agnostic.

⚠️ **Nothing in-tree composes into a registry at app boot** — that sentence used to sit here and was never true of any channel. `PluginRegistry` is the surface for *third-party* plugins published to npm; every in-tree integration resolves its account **per request** from a Firestore document (`integracao` / `int_frete` / `metodo_pgto`), which is what makes one App Hosting backend per channel possible.

⚠️ **Sales channels and freight are not plugins.** `MarketplaceChannel` and `FreightProvider` both existed here and were both deleted ([ADR 0015](/adr/0015-no-marketplace-mega-contract/), #262) once a real implementation proved a registry interface cannot express work that needs Firestore, Storage and a token refresher. They are declared by capability tables instead — `MARKETPLACE_TIPO_CAPS` and `FREIGHT_TIPO_CAPS` in `@delfrance/schemas`.

## Data layer

`packages/schemas/<domain>.ts` is the single source of truth (Zod). `packages/data/defineCollection<T>` wraps the Firestore SDK with typed converters and query helpers — **no codegen** for queries, forms, or types.
