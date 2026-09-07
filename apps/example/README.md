# `@delfrance/example`

Minimal Node CLI demo that exercises the public surface a contributor touches to build an ERP feature on top of the framework, without depending on Firebase or any other `apps/*` subapp.

## What it demonstrates

1. **Schemas** — parse a `Cliente`, `Produto`, and `Pedido` from `@delfrance/schemas`; compute the order total via `pedidoTotal()`.
2. **Core primitives** — `money` arithmetic with currency safety; BR document validators.
3. **Permission helpers** — check a BigInt-encoded permissions claim against required bits.

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

=== 3. Permission claim check ===
can read cliente? true
can delete cliente? false
```

## Why this lives outside the apps/web ERP

The Delfrance ERP (`apps/web`) is opinionated about Firebase + Mantine. Reading it is a poor way to find out what `@delfrance/schemas`, `@delfrance/core` and `@delfrance/auth` actually offer, because every call is tangled with Firestore and React. This example is the smallest program that uses those packages and nothing else.

⚠️ It used to demo a fourth thing — a `TaxProvider` registered into a `PluginRegistry` via `@delfrance/plugin-sdk`. Both were deleted in #1444: nothing in the repo ever registered a plugin, and the two contracts could not describe the engines that do the real work. Integrations are plain libraries imported directly by their app — see `packages/integrations/README.md`.
