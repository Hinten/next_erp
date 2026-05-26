# MISSING — MOC 7.0, Anexo I — Leiaute + Regras de Validação

**Priority**: Tier 2 (current skill was built from this; re-diff catches drift)

## What this document is

The authoritative layout and validation-rule reference for NF-e and NFC-e:

- Every XML field group (A through ZD), with element name, ID, occurrence,
  data type, size, and field-level description.
- Every Regra de Validação (RV) the SEFAZ Autorizador applies server-side,
  cross-referenced to the `cStat` rejection codes they raise.

This is the document the SEFAZ authorizer actually implements against. The
XSD schemas in `packages/integrations/nfe/schemas/` are generated from this
document's tables.

- **Published**: Novembro/2020
- **Pages**: ~500 (large)
- **Publisher**: ENCAT / CONFAZ
- **Document family**: MOC 7.0, Anexo I

## Download

| Source | URL |
|---|---|
| CONFAZ (canonical) | https://www.confaz.fazenda.gov.br/legislacao/arquivo-manuais/moc7-anexo-i-leiaute-e-rv.pdf |
| SEFAZ portal index | https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE= |

## Save as

`sources/moc7/anexo-i-leiaute-rv.pdf` (same directory as this placeholder)

After saving the PDF, **delete this placeholder file**.

## Why we want it

The current skill's `leiaute.md` and `cstat-rejeicoes.md` were built from
this document. A re-pass mostly:

1. Validates the existing field-group table against the canonical source.
2. Catches RV codes we may have skipped originally.
3. Establishes the **MOC 7.0 baseline** so subsequent NTs (2021–2026)
   can be expressed as diffs against it.

Without this baseline committed, future skill refreshes have to
re-download from SEFAZ — and the agent sandbox can't reach SEFAZ.

## Skill files unblocked

- `leiaute.md` — field-group table, formatting rules
- `cstat-rejeicoes.md` — full RV-to-cStat mapping
- `homologacao.md` — fake-data rules (a few RVs differ in `tpAmb=2`)
- baseline for future NT diffs

## If the PDF is too large

This is the big one — typically 5–15 MB. If you can't push the whole file:

- **Best**: send it anyway via git push (PR diffs don't care about binary
  size as long as the file is under GitHub's 100 MB limit).
- **Acceptable**: trim to the leiaute tables only. Use:
  ```
  pdftk anexo-i.pdf cat 1-30 80-200 output anexo-i-trimmed.pdf
  ```
  where ranges roughly cover front matter + group tables. The exact
  ranges depend on the PDF — open it and pick by section.
- **Skip entirely**: low-risk. The current `leiaute.md` is already
  distilled from this; we just lose easy verification.
