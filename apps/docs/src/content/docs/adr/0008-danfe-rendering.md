---
title: 0008 — DANFE rendering
description: How to generate the DANFE PDF from an authorized NFe.
---

## Context

DANFE (Documento Auxiliar da Nota Fiscal Eletrônica) is the printable PDF representation of the authorized NFe. Required for shipping and customer delivery. The Flutter app generates it via `packages/danfe_nfe/` (Dart). The TS rewrite needs an equivalent.

## Candidates

- `danfe` / `node-danfe` (npm) — purpose-built BR libs, if maintained.
- `@react-pdf/renderer` — JSX-based PDF; we'd write the layout ourselves but get full control.
- `puppeteer` + HTML template — easiest to author but heaviest dep (Chromium).
- `pdfkit` — low-level but flexible; requires more layout code.

## Decision criteria

1. Renders a DANFE that matches the SEFAZ visual standard well enough for customer use.
2. Runs server-side in a Node container without GUI (rules out Electron-style approaches).
3. Bundle/runtime cost reasonable — Puppeteer's Chromium image is heavy but acceptable if it's the only option.
4. Maintainability — JSX/HTML template is friendlier than pdfkit imperative layout.

## Outcome

*To be filled.* Likely a small layered approach: try `node-danfe` first; fall back to `@react-pdf/renderer` with a hand-built layout if no maintained BR package exists.

## Status

Open.
