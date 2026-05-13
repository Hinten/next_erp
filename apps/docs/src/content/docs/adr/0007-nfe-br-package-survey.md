---
title: 0007 — Brazilian NFe package survey
description: Survey existing npm libraries that already package NFe end-to-end.
---

## Context

If a maintained npm package already glues together XSD types, signing, and SOAP for NFe, we should use it instead of composing the layers ourselves (ADRs 0004–0006). Even if it covers only 80% of what we need, wrapping it is cheaper than reimplementing.

## Candidates to investigate

- `node-nfe`
- `nota-fiscal-eletronica`
- `sefaz`
- `nfe-ts` / `nfe-node` (community variants)

## Decision criteria

1. Covers NFe v4.00 model 55 issuance + cancellation against SEFAZ homologação.
2. Optionally: NFC-e (model 65), CT-e (cargo).
3. Maintained (commits within last 12 months, issues handled).
4. Not abandoned with critical security issues.
5. Plays well as a dependency of a wrapping plugin (`packages/integrations/nfe/`) — i.e. doesn't pull in incompatible deps or assume CommonJS-only.

## Outcome

*To be filled.* If a candidate scores ≥4 of 5 criteria, adopt and `packages/integrations/nfe/` becomes a thin wrapper. Otherwise, compose from ADRs 0004–0006.

## Status

Open.
