---
title: 0003 — Firestore rules generator
description: Whether to write our own Firestore rules generator or adopt an existing npm package.
---

## Context

The Flutter codebase generates `firestore.rules` (~134KB today) by aggregating per-package rule fragments via a custom Dart generator at `packages/backend/security/rules_generator/`. The TS rewrite needs the same capability: schema metadata in `packages/schemas/<domain>.ts` (collection path + permission bits) is the source of truth, and rules are derived from it.

Goal of this spike: decide whether an off-the-shelf npm package suffices or we need to write our own generator in `packages/rules-gen/`.

## Candidates

- `fireschema` — schema-driven; defines collections + types and emits rules. Status: investigate maintenance.
- `firestore-jet` — investigate scope and recency.
- `firestore-typed` — investigate.
- Other forks/community generators discoverable via npm search.

## Decision criteria

1. Reads structured metadata (not just types) so we can encode our permission bitmask + tenant scoping.
2. Output stays under the 256KB Firestore rules limit (current is 134KB; we target ≤200KB compiled).
3. Maintained (commits within last 12 months) and not abandoned.
4. Composable per package so each domain owns its slice.

## Outcome

No npm candidate survived the spike:

- `fireschema` — peer deps pinned to firebase 8 / firebase-admin 9 (2021-era), and rules are authored as free-text expression strings; it cannot be driven by our `CollectionMetadata` permission bitmask.
- `firestore-jet` — 404 on npm; unpublished or removed.
- `firestore-typed` — deprecated typed wrapper around the SDK; emits no rules at all.

**Decision: custom generator, `packages/rules-gen/`.** It consumes `ALL_DOMAINS` from `packages/schemas` (collection paths + permission bits) plus the per-domain `d_*` claims helpers in `packages/auth` (rules CEL has no bitwise operators, so the 128-bit `permissions` claim is undecodable in rules; the generator emits `(token.get('d_x', 0) / k) % 2 == 1` bit tests instead). Field validators are restricted to a critical-collection whitelist and a build-time size gate fails generation well below the 256 KiB deploy limit — both lessons from the Flutter generator, which hit that limit in production because the emulator does not enforce it.

CI validates three layers (`ci-rules.yml`): offline drift check (`gen:rules:check`), behavior tests on the Firestore emulator, and a server-side compile via `firebaserules.googleapis.com` `projects.test` with a source-only payload — it compiles on the production API and persists nothing (no ruleset created, no release touched), so no deploy-to-staging step is needed.

## Status

Closed (2026-06). Implemented in `packages/rules-gen/`; the committed `firestore.rules` is generated. Deploy remains manual/coordinated.
