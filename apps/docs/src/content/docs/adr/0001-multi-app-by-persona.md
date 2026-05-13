---
title: 0001 — Multi-app split by persona/runtime
description: Why we split into multiple Next.js apps and what defines the boundaries.
---

## Context

The Flutter app being rewritten covers ERP UI, customer-facing chat widget, marketplace webhooks, and OAuth flows in one codebase. In Next.js, we considered keeping it as one app, splitting by ERP domain (clients, products, orders), or splitting by persona/runtime.

## Decision

Split by **persona/runtime**:

- `apps/web` — internal ERP UI (one app, all modules together).
- `apps/integrations` — webhooks + OAuth callbacks (API-only).
- `apps/webchat` — embeddable widget (static).
- `apps/docs` — Astro Starlight.
- `apps/example` — OSS demo.

## Consequences

Easier:
- ERP UX stays SPA-like — staff move between modules without hard nav.
- Webhook failures can't take down the ERP UI.
- 1:1 mapping with Firebase Hosting sites.
- `apps/webchat` bundle stays small (no Mantine).

Harder:
- Schema changes require typecheck across N apps (mitigated by Turborepo cache).
- Deploy topology has 3 sites + Cloud Functions instead of 1.

## Alternatives considered

- **One app**: webhooks would deploy with UI; failures coupled.
- **Split by ERP domain**: cross-module navigation becomes hard nav constantly. Bad ERP UX.

## Status

Accepted.
