# Delfrance — Next.js ERP

Open-source ERP for business process automation: clients, products, orders, payments, invoicing (NFe), chat, and marketplace integrations. Next.js rewrite of the original Delfrance Flutter app, sharing the same Firebase backend.

> **Status**: Early development (WIP). Not production-ready. The full architectural plan will be mirrored under `apps/docs/src/content/docs/architecture/` once Phase 0 ships ADRs.

## Architecture

Multi-app Turborepo monorepo split by **persona/runtime**, not by ERP domain:

| App | Persona | Runtime | Hosting |
|---|---|---|---|
| `apps/web/` | Internal staff (auth) + customer-facing public pages | SSR | Firebase App Hosting |
| `apps/integrations/` | External systems (webhooks, OAuth callbacks) | SSR API-only | Firebase App Hosting |
| `apps/webchat/` | End-visitor on tenant's site | Static export | Firebase Hosting |
| `apps/docs/` | Contributors / users | Astro Starlight | external (TBD) |
| `apps/example/` | OSS demo | Static / SSR | external |

Heavy webhook work is dispatched from `apps/integrations` to **Cloud Functions** (Node 20 + the existing Python functions).

Shared code lives under `packages/`:

- `packages/schemas/` — Zod schemas + collection metadata (single source of truth).
- `packages/data/` — `defineCollection<T>` + cascade runtime, no codegen.
- `packages/auth/` — permission helpers, BigInt-encoded custom claims.
- `packages/ui/` — Mantine v9 theme + primitives.
- `packages/core/` — money, address, documents, tenant, plugin contracts.
- `packages/integrations/*/` — domain integrations behind plugin contracts (NFe, Mercado Pago, marketplaces, freight).
- `packages/plugin-sdk/` — public surface for third-party plugin authors.
- `packages/config-*` — shared ESLint/TS/Prettier configs.

## Stack

- Next.js 16 (App Router), React 19.2, TypeScript 6 strict
- Mantine v9
- Turborepo + pnpm workspaces
- react-hook-form + Zod
- next-intl (default `pt-BR`, `en` from day 1)
- Firebase (Firestore, Auth, App Hosting, Cloud Functions)
- Sentry, pino
- Vitest, Playwright (against `<your-firebase-project>` — no emulators)

## Quick start

```bash
pnpm install
pnpm dev
```

Boots `apps/web` on :3000 and `apps/integrations` on :3001.

## Domain plugins

Brazilian features (NFe, Mercado Pago, marketplaces) are **opt-in plugins** behind contracts in `packages/core/plugins/`. The core is locale-agnostic.

# Useful Commands:

pnpm --filter @delfrance/test-fixtures seed:pedidos
pnpm --filter @delfrance/test-fixtures seed:nfe              # varied estados (all NFCell branches)
pnpm --filter @delfrance/test-fixtures seed:nfe --estado=a   # all → Aprovada (run again with n, e, etc.)
pnpm --filter @delfrance/test-fixtures seed:nfe --clean      # remove NFe docs, keep pedidos

## Contributing

See `CONTRIBUTING.md`. Code of conduct: `CODE_OF_CONDUCT.md`. Security disclosures: `SECURITY.md`.

## License

Apache-2.0.
