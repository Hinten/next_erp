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

Brazilian features (NFe, Mercado Pago, marketplaces) are **opt-in** behind contracts in `packages/core/plugins/`:

- `TaxProvider`, `InvoiceProvider`, `PaymentGateway`, `MarketplaceChannel`, `DocumentProvider`.

The core is locale-agnostic. Plugins compose into a registry at app boot.

## Data layer

`packages/schemas/<domain>.ts` is the single source of truth (Zod). `packages/data/defineCollection<T>` wraps the Firestore SDK with typed converters and query helpers — **no codegen** for queries, forms, or types.
