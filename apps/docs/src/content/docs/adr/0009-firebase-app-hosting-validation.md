---
title: 0009 — Firebase App Hosting validation
description: Confirm Firebase App Hosting supports our Next.js 16 usage before committing to it for apps/web and apps/integrations.
---

## Context

The plan is to deploy `apps/web` and `apps/integrations` to Firebase App Hosting (the Next.js-aware managed Firebase hosting product). It's relatively new vs. classic Firebase Hosting + Cloud Run. Before building all of Phase 1+ on top, validate it handles what we need.

## Items to validate

1. **App Router** — full support for `app/` directory, layouts, route groups.
2. **Server Components / Server Actions** — even though `apps/web` is client-first (ADR-0002), App Hosting must support them in case we need to opt into either.
3. **Route handlers** — required by `apps/integrations` for webhook endpoints.
4. **Middleware** — not used in `apps/web` per ADR-0002, but should work if we ever need it.
5. **Environment variables / secrets** — wired from Cloud Secret Manager, available at both build and runtime.
6. **Cold-start latency** — acceptable for webhook endpoints (hot-reload <1s; cold start <3s).
7. **Per-app deploy targeting** — `firebase deploy --only hosting:<app>` works without coupling.
8. **Region** — us-central1 acceptable for now; document if we need multi-region later.

## Plan B

If App Hosting fails any blocker (e.g. doesn't support route handlers in API-only Next.js), fall back to:

- `apps/web` → Vercel or Cloud Run with a custom Dockerfile.
- `apps/integrations` → Cloud Run directly (skip Hosting layer entirely; map a domain to the Cloud Run service).

## Outcome

*To be filled by spike: deploy a minimal Next.js 16 app exercising each item above against the staging Firebase project and confirm.*

## Status

Open.
