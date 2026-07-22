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
- A purpose-built generator — added during the spike.

## Decision criteria

1. Generates TS types that compile with strict mode and match the XSD shape closely.
2. Imports stay clean (no global pollution).
3. Tolerates the `xs:choice` and recursive types in the NFe XSD without manual fixups.
4. Maintained.

## Outcome

**Decision: a purpose-built, zero-dependency generator** —
`packages/integrations/nfe/src/codegen/generate.mjs`, run via
`pnpm --filter @delfrance/integrations-nfe gen:nfe-types`.

Spike findings against the real layout-4.00 pack
(`PL_009i_NT2021_004_v100d` + the `PL_010c_NT2022_002v1.30` leiaute delta,
20 vendored XSDs in `packages/integrations/nfe/schemas/`):

- The off-the-shelf generators (`cxsd`, `xsd2ts`, `xml-schema-ts`) emit types
  but **not** the ordered field metadata SEFAZ serialization needs. NF-e XML is
  position-sensitive (the signed `infNFe` digest depends on exact element
  order); a plain `interface` loses `xs:sequence` order, and an object's key
  order is not a contract. The generator must emit an explicit ordered
  descriptor table, which no surveyed tool does.
- The SEFAZ XSDs use a deliberately small, regular construct set —
  `complexType` / `simpleType` / `element` / `sequence` / `choice` /
  `attribute` only; no `extension`, `group`, `union`, `list`,
  `complexContent` or `simpleContent`. A focused generator covering exactly
  those is small and fully under our control.
- `cxsd` is unmaintained (last release 2018); the local npm registry also has
  a TLS-interception issue, so a zero-dependency tool (built-in minimal XML
  parser) is more robust and reproducible.

The generator produces a single committed file,
`packages/integrations/nfe/src/types/nfe-schema.ts` (167 interfaces, 13 root
elements), containing:

- a TypeScript `interface` per `complexType` (all leaf values typed as
  `string` for exact decimal control on the wire; enumerations as
  string-literal unions);
- `META` — an ordered `FieldDef[]` per type, the contract the XML
  (de)serializer (Phase A, `src/xml/`) walks to build/parse documents in
  `xs:sequence` order, with `choiceGroup` tagging for `xs:choice` members;
- `ROOTS` — the root element → complexType map.

Generated output is committed and regenerated only when the XSD packs change
(never wired into `turbo build`). The vendored packs and their provenance are
tracked in `schemas/MANIFEST.json` so the SEFAZ update-watch routine can diff
them against the portal.

**Note — the paths above are superseded.** The XSDs and the codegen output
later moved under `packages/integrations/nfe/generated/moc<version>/`
(`schemas/` and `types/`) so MOC versions can sit side by side, and the
generator now emits **two** files: `nfe-schema.ts` plus a Zod mirror,
`nfe-schema-zod.ts`. What remains at `src/types/nfe-schema*.ts` are re-export
shims. The decision recorded above is unchanged — only the layout moved. See
the package `CLAUDE.md` for the current version-pinning playbook.

## Status

Accepted.
