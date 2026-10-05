---
title: 0001 — Multi-app split by persona/runtime
description: Why we split into multiple Next.js apps and what defines the boundaries.
---

:::note[Partially superseded — 2026-09-07]
`apps/webchat` no longer exists. The embeddable widget was **dropped** rather than
ported, and the app, its `firebase.json` hosting entry and the `/canais/webchat`
configuration screen were deleted (issues #153 and #558, closed as not planned).

The decision below is **left as written** because it is the record of a choice that was
actually taken — the widget really was a persona in the split, and the split is still
sound for the personas that remain. Only the webchat lines are obsolete: the deploy
topology is now App Hosting backends plus Cloud Functions, with no classic Hosting site,
and one fewer persona.

⚠️ What survives the removal is the **data**: the `site` origem stays in
`conversaSchema` (it is the schema default, and the imported legacy corpus carries `site`
conversas the inbox must still render). The widget was the writer; the reader stays.
:::

## Context

The Flutter app being rewritten covers ERP UI, customer-facing chat widget, marketplace webhooks, and OAuth flows in one codebase. In Next.js, we considered keeping it as one app, splitting by ERP domain (clients, products, orders), or splitting by persona/runtime.

## Decision

Split by **persona/runtime**:

- `apps/web` — internal ERP UI (one app, all modules together).
- `apps/integrations` — webhooks + OAuth callbacks (API-only).
- `apps/webchat` — embeddable widget (static).
- `apps/docs` — Astro Starlight.
- `apps/example` — OSS demo. ⚠️ **Removed in #1444.** It demoed the plugin registry
  alongside the schemas, and had drifted out of sync with them — nothing ever ran it,
  so its `pedidoSchema` call had been throwing for months. A replacement written
  against the current schemas is planned; the persona split itself is unchanged.

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
