# MISSING — NT 2025.002 — Reforma Tributária do Consumo (IBS / CBS / IS)

**Priority**: 🔴 **TIER 1 — CRITICAL** (the single biggest gap in the skill)

## What this document is

The Nota Técnica that adapts NF-e (model 55) and NFC-e (model 65) **layout
4.00** to the Reforma Tributária do Consumo (RTC). Introduces three new tax
categories at the item and total level:

- **IBS** — Imposto sobre Bens e Serviços (state + municipal)
- **CBS** — Contribuição sobre Bens e Serviços (federal)
- **IS**  — Imposto Seletivo (federal, "sin tax")

Each comes with new XML groups, fields, CSTs, alíquotas, base de cálculo
formulas, and a fresh batch of `cStat` rejection codes — none of which the
current skill mentions.

- **Initial publication**: Março/2025
- **Version at time of writing**: v1.10 (Junho/2025) — there may be later
  versions; grab the most recent the portal shows.
- **Production date**: **2026-01-01** — mandatory and with legal validity
  since. **The skill is wrong about this today.**

## Download

| Source | URL |
|---|---|
| SEFAZ portal NT index | https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY= |
| Direct PDF (NT 2025.002 specific page on portal) | https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY%3D (find "NT 2025.002" in the list) |
| RTC-specific PDF (Reforma Tributária - Adequações NF-e / NFC-e) | https://www.nfe.fazenda.gov.br/portal/exibirArquivo.aspx?conteudo=B7DBKw+UPbs= |

The portal index has both the **NT PDF** and an **anexo with the XSD schema
pack**. Grab the PDF for sure; the schemas are useful but optional for this
skill update (they matter for `packages/integrations/nfe/schemas/` regen,
which is a separate task).

## Save as

`sources/nt/2025/nt-2025-002-vX.XX-rtc.pdf` — replace `X.XX` with the
actual version number on the cover page (e.g. `v1.10`).

Optional schema pack: `sources/nt/2025/nt-2025-002-schemas.zip`.

After saving, **delete this placeholder file**.

## Why we want it (critical)

The current skill at MOC 7.0 baseline knows nothing about:

- The new XML group `gIBSCBS` (and per-UF, per-município sub-groups).
- The new `gIS` group for Imposto Seletivo.
- New CST codes for IBS/CBS/IS classifications.
- New `total` block fields aggregating IBS/CBS/IS.
- Transition-period rules: which fields are "informativo" (no fiscal
  effect) in 2025 vs "com validade jurídica" from 2026 onwards.
- Interaction with legacy ICMS/PIS/COFINS during the transition window
  (both sets coexist in the XML during the phase-in).
- New rejection `cStat` codes specific to IBS/CBS/IS validation.

Without this, any NF-e the skill helps generate today will be **rejected
by SEFAZ** for missing mandatory RTC fields.

## Skill files unblocked

- **NEW** `references/rtc-ibs-cbs-is.md` — dedicated reference file
  (planned in `~/.claude/plans/fala-claude-estude-novamente-vectorized-babbage.md`)
- `leiaute.md` — adds pointer to RTC groups
- `cstat-rejeicoes.md` — appends RTC-specific rejection codes
- `homologacao.md` — RTC fake-data rules for `tpAmb=2`
- `SKILL.md` — bumps triggers (`IBS`, `CBS`, `IS`, `RTC`, `gIBSCBS`,
  `Reforma Tributária`, `NT 2025.002`) and adds RTC to the critical-facts
  block

## If the PDF is too large to attach in chat

NT 2025.002 with all anexos can be 10–20 MB. Workarounds:

- **Best**: push it directly to the PR branch on GitHub (web UI accepts
  files up to 25 MB; CLI up to 100 MB). Chat upload limits don't apply
  there.
- **Trim it**: the most critical sections are:
  - Resumo / Visão Geral (usually pp. 1–10)
  - Tabela de novos grupos (gIBSCBS, gIS) — leiaute pages
  - Tabela de Regras de Validação — RV pages
  - Tabela de cStats novos
  
  Skip XML examples in the appendix; they're nice but not essential.
- **Two parts**: split into front (pages 1–N) and back (pages N+1–end)
  and upload as `nt-2025-002-part1.pdf` / `part2.pdf`. Concatenate later.
