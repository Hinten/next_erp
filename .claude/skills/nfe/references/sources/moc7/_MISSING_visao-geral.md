# MISSING — MOC 7.0, Visão Geral

**Priority**: Tier 2 (nice-to-have; current skill content is solid)

## What this document is

The introductory chapter of the Manual de Orientação ao Contribuinte 7.0.
Covers the high-level lifecycle of an NF-e: states, web services overview,
chave de acesso, signing, and the overall happy path. It's the document
that frames everything the Anexos detail.

- **Published**: Novembro/2020
- **Pages**: ~100
- **Publisher**: ENCAT / CONFAZ
- **Document family**: MOC 7.0 (this is the cover document; anexos are the
  technical detail)

## Download

| Source | URL |
|---|---|
| CONFAZ (canonical) | https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-visao-geral.pdf |
| SEFAZ portal index | https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE= |

## Save as

`sources/moc7/visao-geral.pdf` (same directory as this placeholder)

After saving the PDF, **delete this placeholder file**.

## Why we want it

Re-baseline the skill's lifecycle narrative in `SKILL.md` and the
state-machine description. The current skill content was distilled from
this exact document, so a re-pass mostly cross-checks for drift rather
than adds new content.

## Skill files unblocked

- `SKILL.md` — happy-path narrative, critical facts
- `webservices.md` — service inventory, async/sync framing (already
  superseded by NT 2025.001)
- `chave-acesso.md` — composition rules (stable since 2.0)

## If the PDF is too large

The whole document is fine to commit. If your network is choking, the
useful sections are roughly:

- Cap. 1–2 (Introdução, Conceitos)
- Cap. 3 (Características do Sistema)
- Cap. 4 (Modelo Operacional + Estados)
- Cap. 5 (Web Services — overview, not the full leiaute)

Skip the appendices and the DANFE chapter (those live in Anexo II).
