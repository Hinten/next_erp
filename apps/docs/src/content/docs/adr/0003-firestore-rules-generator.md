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

*To be filled by spike.* If at least one package meets criteria 1–4, adopt it and skip writing `packages/rules-gen/`. Otherwise, write a small TS generator (~200 LOC) that reads `CollectionMetadata` from `packages/schemas/` and emits `firestore.rules`.

## Status

Open.
