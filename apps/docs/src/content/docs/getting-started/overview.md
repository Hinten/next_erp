---
title: Overview
description: What this project is, what it isn't, and how it's organized.
---

Delfrance is an **open-source ERP** for business process automation. The Next.js rewrite delivers feature parity with the original Flutter app while shipping as a contributable, plugin-extensible OSS project.

## Apps

| App | Purpose |
|---|---|
| `apps/web` | Internal ERP UI. Client-first Next.js on Firebase App Hosting. |
| `apps/integrations` | API-only Next.js for webhooks and OAuth callbacks. App Hosting. |
| `apps/webchat` | Embeddable chat widget. Static export on Firebase Hosting. |
| `apps/docs` | This documentation site (Astro Starlight). |
| `apps/example` | OSS demo using only `packages/core` + plugin stubs. |

## Stack

- Next.js 16 App Router, React 19.2, TypeScript 6 strict
- Mantine v9 (in `apps/web` only)
- Turborepo + pnpm workspaces
- Firebase: Firestore, Auth, App Hosting, Cloud Functions
- Vitest + Playwright (against your Firebase project, no emulators)
