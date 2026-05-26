# SEFAZ source documents — drop zone

This folder holds the **original SEFAZ PDFs** the `nfe` skill is distilled from.
The curated Markdown reference files one level up (`../*.md`) are the
operational artifact Claude loads at runtime; the PDFs here are the
**source of truth** they cite, kept committed so future skill refreshes can
diff against them.

## Status legend

- **`*.pdf`** — actual source committed, processed into the `.md` references.
- **`_MISSING_*.md`** — placeholder. Replace with the real PDF (and delete
  the placeholder) to unblock the skill update for that section.

## Workflow for adding a missing PDF

1. Open the matching `_MISSING_*.md` placeholder — it has the download URL,
   the target filename to save it as, and which skill files it unblocks.
2. Download the PDF from the URL.
3. Save it in the **same directory** as the placeholder, using the **exact
   filename** the placeholder specifies.
4. Delete the placeholder `_MISSING_*.md`.
5. Commit. Claude will pick it up on the next skill-refresh pass.

If a PDF is too large to attach in chat or to push directly:

- **Split it.** Most SEFAZ PDFs only need the front matter (Resumo, Histórico
  de Alterações, and the leiaute/RV tables). Skip image-heavy appendices.
  Use `pdftk source.pdf cat 1-30 output trimmed.pdf` or any PDF splitter.
- **Git LFS.** If the repo grows large with these sources, switch this
  folder to LFS (`.gitattributes`: `*.pdf filter=lfs`). Not enabled yet —
  we'll switch when total size warrants it.
- **Out-of-band.** As a last resort, drop the PDF anywhere accessible
  (cloud bucket, signed URL) and link it from the placeholder; Claude can
  read via WebFetch if the host is allowlisted.

## Folder layout

```
sources/
├── moc7/                   MOC 7.0 (CONFAZ, Nov/2020) — baseline manual
│   ├── visao-geral.pdf
│   ├── anexo-i-leiaute-rv.pdf
│   ├── anexo-ii-danfe.pdf
│   ├── anexo-iii-contingencia.pdf      ✅ committed
│   └── anexo-iv-contingencia-nfce.pdf  (optional — NFC-e out of scope)
└── nt/                     Notas Técnicas published after MOC 7.0
    ├── 2020/
    ├── 2021/
    ├── 2022/
    ├── 2023/
    ├── 2024/
    ├── 2025/
    │   ├── nt-2025-001-v1.03-simplificacao.pdf  ✅ committed
    │   └── nt-2025-002-vX.XX-rtc.pdf            ❌ CRITICAL gap
    └── 2026/
```

## Priority tiers

| Tier | Documents | Why |
|---|---|---|
| **T1** | NT 2025.002 (RTC) | The skill currently knows nothing about IBS/CBS/IS. RTC has legal validity since 2026-01-01 — any NF-e written today must comply. **Must-have.** |
| **T2** | MOC 7.0 — Anexo I (Leiaute + RV) | Baseline of every field definition. Current skill was built from it, but a re-diff catches drift. ~500 pages — big. |
| **T2** | MOC 7.0 — Visão Geral | Lifecycle / state machine. High-level; existing skill content is solid. |
| **T3** | NT 2020.006 → NT 2024.xxx | Inter-MOC changes — small cStat additions, field tweaks. Each NT is ~10–50 pages. Powers `notas-tecnicas-historico.md`. |

## Source index — SEFAZ portal

- **MOC pages**: https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE=
- **NT index**:  https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=
- **CONFAZ mirror (MOC PDFs)**: https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/

Direct PDF links are inside each `_MISSING_*.md` placeholder.

## Why we commit these (and not extract+discard)

The skill's runtime artifact is the curated `.md` references, not the PDFs.
But keeping the originals committed pays off for three reasons:

1. **Provenance.** Every non-trivial claim in the `.md` references can be
   traced back to a specific page of a specific PDF version. Without the
   PDFs in-tree, audits depend on SEFAZ keeping the same URLs forever
   (they don't).
2. **Reproducibility.** Future skill refreshes can `diff` the new MOC
   against the committed one without re-downloading the old version.
3. **Sandbox immunity.** This repo's CI/agent sandbox blocks outbound
   traffic to `*.fazenda.gov.br`. Re-fetching during a skill update isn't
   possible from inside the sandbox; the in-tree copy is the only path.

Trade-off: ~10–30 MB of binary in the repo over time. Acceptable; revisit
with LFS when it grows past ~100 MB.
