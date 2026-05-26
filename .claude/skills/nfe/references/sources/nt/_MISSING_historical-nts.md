# MISSING — Historical Notas Técnicas (2020 → 2024)

**Priority**: Tier 3 — nice-to-have, low individual impact, batchable

## What we need

Every NT published **after MOC 7.0 (Nov/2020)** and **before NT 2025.001**
(already received). These fill out `notas-tecnicas-historico.md` — the
chronological NT changelog that lets future tasks decide quickly whether
a given NT is relevant.

Each NT is small (~10–50 pages), so individually they upload easily. The
volume is what makes this Tier 3 — there are many.

## Source

SEFAZ portal NT index:
**https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=**

The page lists every NT with its publication date and a PDF link. Filter
mentally for documents dated **between Dec/2020 and Mar/2025**.

## Suggested NTs to grab (priority order within Tier 3)

| NT | Topic (best guess from public summaries) | Save as |
|---|---|---|
| **NT 2023.004** | (most recent before 2025.001) | `2023/nt-2023-004.pdf` |
| **NT 2023.003** | | `2023/nt-2023-003.pdf` |
| **NT 2023.002** | | `2023/nt-2023-002.pdf` |
| **NT 2023.001** | | `2023/nt-2023-001.pdf` |
| **NT 2022.003** | | `2022/nt-2022-003.pdf` |
| **NT 2022.001** | DTe (Domicílio Tributário Eletrônico) | `2022/nt-2022-001.pdf` |
| **NT 2021.004** | | `2021/nt-2021-004.pdf` |
| **NT 2021.003** | | `2021/nt-2021-003.pdf` |
| **NT 2021.002** | | `2021/nt-2021-002.pdf` |
| **NT 2021.001** | | `2021/nt-2021-001.pdf` |
| **NT 2020.007** | | `2020/nt-2020-007.pdf` |
| **NT 2020.006** | | `2020/nt-2020-006.pdf` |
| **NT 2024.001**+ | Anything published in 2024 | `2024/nt-2024-XXX.pdf` |

Don't worry about getting the version suffix exactly right — drop the
file in the right year folder with any reasonable name and Claude will
sort it out.

## Save under

`sources/nt/<year>/<filename>.pdf` — there's a folder per year already
created (2020, 2021, 2022, 2023, 2024, 2026).

## What I extract from each

For each NT, only ~5 pages matter for the skill:

- **Cover** — version, publication date, production date.
- **Resumo** — one-paragraph summary of what changed.
- **Histórico de Alterações** — version-by-version delta table.
- **One or two "Alteração" sections** — to confirm scope.

Everything else (XML examples, full RV tables) goes in only if Claude
detects something significant for the skill files.

## If you only have time for a few

Best ROI:

1. **NT 2023.004** — latest pre-2025 baseline.
2. **NT 2022.001** — DTe changed how rejection notifications work.
3. **NT 2020.007** — closest follow-up to MOC 7.0 itself.

The rest can be deferred to a future skill refresh.

## Action when done

**Delete this placeholder** once you've added the NTs you can. If you've
added all of them, also empty the year folders' `.gitkeep` files (none
exist yet — git ignores empty folders, but a `.gitkeep` lets us commit
the structure).
