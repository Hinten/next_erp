---
title: 0002 — apps/web is client-first
description: Default to 'use client' to keep server compute minimal and reduce cost.
---

## Context

The internal ERP is behind authentication. No SEO. No public crawling. Most data is consumed via real-time `onSnapshot`, not initial server fetches. Firebase App Hosting bills compute time.

## Decision

In `apps/web`:

- Default to `'use client'` for all pages and components.
- No `middleware.ts`. Auth guard is `useRequireAuth()` (`onAuthStateChanged` + redirect).
- Server Actions, route handlers, and Server Components are **opt-in only with PR justification**.
- All Firestore reads/writes happen client-side via the JS SDK + TanStack Query for one-shot; custom `useSnapshot` hooks for real-time.

`apps/integrations` keeps server runtime since webhooks require it.

## Consequences

Easier:
- Server compute on `apps/web` is near-zero (only serves shell + bundle).
- No middleware/session-cookie machinery.
- Real-time fits naturally with the SDK on the client.

Harder:
- Initial bundle larger than RSC. Mitigated via Next.js dynamic imports per route + Mantine tree-shaking.
- Brief auth flicker on first load. Mitigated by Firebase IndexedDB persistence + skeleton in shell.
- Lose server-side route protection. Acceptable: Firestore rules are the security boundary; client guard is UX.

## Alternatives considered

- **RSC default**: higher compute cost, complexity for negligible benefit on this app.
- **Static export (`output: 'export'`)**: zero compute but loses Server Actions/route handlers entirely if we ever want them.
- **Hybrid (static default, SSR per route)**: more configuration burden than warranted.

## Status

Accepted.
