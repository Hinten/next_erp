---
title: 0005 — NFe XML signing
description: Library for ICP-Brasil compatible XML digital signatures on NFe payloads.
---

## Context

NFe payloads must be signed with the issuer's ICP-Brasil A1/A3 certificate before submission to SEFAZ. The Flutter implementation uses Dart-side signing in `packages/nfe_client/`. The TS rewrite needs an equivalent: read certificate (PFX/P12), sign the relevant `<infNFe>` block, attach `<Signature>` per XMLDSig, validate against SEFAZ acceptance.

## Candidates

- `xml-crypto` — most-used npm XMLDSig lib; ICP-Brasil compatible historically.
- `xmldsigjs` — alternative; pure JS.
- `xadesjs` (XAdES) — overkill for SEFAZ but covers more standards if needed.

## Decision criteria

1. Signs an example NFe XML against a homologation A1 certificate and SEFAZ accepts it (returns success protocol).
2. Supports the canonicalization SEFAZ requires (`http://www.w3.org/TR/2001/REC-xml-c14n-20010315`).
3. Maintained.
4. Works in Node 20+ (no native deps that break in containers).

## Outcome

*To be filled by spike: sign a fixture NFe with each candidate against a homologation cert, submit to SEFAZ homologação, record protocol or rejection reason.* Target: lock the choice into `packages/integrations/nfe/`.

## Status

Open.
