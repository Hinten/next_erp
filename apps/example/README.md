# `@delfrance/example`

Minimal Node CLI demo that exercises the public surface a contributor touches to build an ERP feature on top of the framework, without depending on Firebase or any other `apps/*` subapp.

## What it demonstrates

1. **Schemas** — parse a `Cliente`, `Produto`, and `Pedido` from `@delfrance/schemas`; compute the order total via `pedidoTotal()`.
2. **Core primitives** — `money` arithmetic with currency safety; BR document validators.
3. **Plugin SDK** — author a tiny `TaxProvider` via `defineIntegration()` from `@delfrance/plugin-sdk`, register it in a `PluginRegistry`, and call it.
4. **Permission helpers** — check a BigInt-encoded permissions claim against required bits.

## Run

```bash
pnpm install
pnpm --filter @delfrance/example demo
```

Expected output (abridged):

```
=== 1. Schemas ===
cliente: Maria Silva · 529.982.247-25
produto: Camiseta básica · SKU CB-001
pedido D-001 · total: R$ 99,80

=== 2. Money primitives ===
add: R$ 20,00

=== 3. Plugin registry ===
tax breakdown: Demo flat tax (10%): R$ 15,00

=== 4. Permission claim check ===
can read cliente? true
can delete cliente? false
```

## Why this lives outside the apps/web ERP

The Delfrance ERP (`apps/web`) is opinionated about Firebase + Mantine. Plugin authors consuming `@delfrance/core/plugins` and `@delfrance/plugin-sdk` shouldn't need any of that to validate their integration locally. This example shows the smallest possible host loop.
