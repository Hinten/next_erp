---
title: 0004 — NFe XSD → TypeScript types
description: Generate TypeScript types from SEFAZ NFe XSD schemas instead of porting Dart models.
---

## Context

The NFe (Nota Fiscal Eletrônica) implementation in Flutter (`packages/nfe_client/`) has hand-written models that mirror SEFAZ XSDs. For the TS rewrite, deriving types directly from the canonical XSD avoids drift and saves engineering time.

## Candidates

- `cxsd` — XSD → TS generator.
- `xsd2ts` — alternative.
- `xml-schema-ts` — runtime + types.
- `xmlbuilder2` (manual) — fallback if generators don't fit.

## Decision criteria

1. Generates TS types that compile with strict mode and match the XSD shape closely.
2. Imports stay clean (no global pollution).
3. Tolerates the `xs:choice` and recursive types in the NFe XSD without manual fixups.
4. Maintained.

## Outcome

*To be filled by spike against an NFe homologation XSD (e.g. `nfe_v4.00.xsd`).* Target: a generated `packages/integrations/nfe/src/types/` directory imported by the rest of `packages/integrations/nfe/`.

## Status

Open.
