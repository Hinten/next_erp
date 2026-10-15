# RTC IBS/CBS code tables — source pointer (cClassTrib / CST / cCredPres / alíquotas)

**This is a SOURCE POINTER.** SEFAZ publishes the IBS/CBS code tables as
**`.xlsx` spreadsheets**, updated *outside* the NT cycle, and the agent sandbox
cannot reach `*.fazenda.gov.br` — so the spreadsheets are not in this skill. The
tables themselves ARE vendored in the code (see "Vendored tables" below), read
from the public SVRS mirror. This file records where they come from and how to
refresh them. Last refresh: **2026-09-28**.

## What's published, and where

Per **NT 2025.002 v1.40, page 82**, these annex tables are **NOT in the NT PDF**:

| Tabela | Anexo | Status | Onde |
|---|---|---|---|
| `cClassTrib` (IBS/CBS) | III | **Publicada** | Portal NF-e → Documentos → **Diversos** |
| `CST` IBS/CBS (indicadores) | — | **Publicada** (junto da IT 2025.002) | idem |
| `cCredPres` (crédito presumido) | IV | **Publicada** | idem |
| Alíquotas-padrão IBS/CBS 2026–2028 | — | **Publicada** | idem |
| NCM do Imposto Seletivo | I | *"A ser publicada"* (p.82) | idem (quando sair) |
| `cClassTribIS` (Imposto Seletivo) | II | *"A ser publicada"* (p.82) | idem (quando sair) |

- **Official portal (sandbox-BLOCKED):** `https://www.nfe.fazenda.gov.br` →
  aba **Documentos** → opção **Diversos**. The `cClassTrib` table is the
  `.xlsx` published there (transform to `.csv` for most importers).
- **Accessible official MIRROR (state SEFAZ — reachable from the sandbox):**
  - SVRS Conformidade Fácil (interactive): `https://dfe-portal.svrs.rs.gov.br/Cff/ClassificacaoTributaria`
  - cClassTrib + CST table: `https://dfe-portal.svrs.rs.gov.br/DFE/TabelaClassificacaoTributaria`
  - cCredPres table: `https://dfe-portal.svrs.rs.gov.br/DFE/TabelaCreditoPresumido`
- **First published:** 06/05/2025 (with IT/RT 2025.002 v1.00); revised across
  the NT's versions (cCredPres added in v1.10; layout consolidated by v1.40).
  The spreadsheet is updated periodically — always re-check the version/date.
  ⚠️ A newer **NT/IT 2025.002 v1.50** exists (mid-2026) — the skill body still
  cites v1.40; the table refresh + the v1.50 bump are tracked under #317.

## Machine-readable access

The SVRS table page (`…/DFE/TabelaClassificacaoTributaria`, redirects to
`…/DFE/ClassificacaoTributaria`) is **public and reachable from the agent
sandbox** (plain HTTPS GET, no login, no certificate). It embeds the whole table
as a JSON literal — `var dadosOriginais = [...]`, one entry per CST with its
`ClassificacoesTributarias` — which is what its CSV / Excel / JSON buttons
export. That literal is the refresh source: it carries named indicator fields
(`IndExigeTrib`, `IndTransferenciaCred`, `IndAjusteCompet`, `IndEstornoCred`, …),
the per-DF-e flags (`IndNfe`, `IndNfce`, …), `TipoAliq`, `PercRedIbs/Cbs`, and
the vigência dates. The cCredPres page has no JSON literal; its rendered table
is read instead.

The cert-gated `https://dfe-portal.svrs.rs.gov.br/CFF/Servicos` (ICP-Brasil
mTLS, "a daily GET per company is sufficient") is **not** used, deliberately:
the public page carries the same data, and a committed fetch script would be a
third code generator (root CLAUDE.md rule 3) holding the company certificate.

## Confirmed key code (regra geral)

- **`cClassTrib = 000001`** → *"Situações tributadas integralmente pelo IBS e
  CBS"*, under **`CST = 000` (Tributação integral)** — the standard taxable-sale
  code the repo fixture (`impostoCsosn102ComRtc`) uses, and the one the RTC live
  homologação case gets authorized with.
- The first 3 digits of `cClassTrib` mirror the `CST`; the last 3 select the
  specific legal hypothesis under LC 214/2025.

## Vendored tables in this repo (#333)

`packages/schemas/src/imposto/`, all exported from `@delfrance/schemas`:

- `cclasstrib.data.ts` — `CST_IBSCBS_TABELA` (all 18 CSTs + their indicators)
  and `CCLASSTRIB_TABELA` (the **NF-e rows only**, `IndNfe`, with indicators,
  `tipoAliquota`, `pRedIBS/CBS`, `inicioVigencia`), plus
  `CCLASSTRIB_PROVENIENCIA` (source, retrieval date, filter, row count).
- `cclasstrib.ts` — the API (`validateCstClassTrib`, the picker helpers,
  `cClassTribEntry`, `cstIbsCbsEntry`, the indicator/tipo constants). The CST
  labels are DERIVED from the table, so they are the official names.
- `ccredpres.ts` — Anexo IV, 13 codes stored as `'01'`…`'13'` (XSD `\d{2}`).

Membership stays a **UI warning** (`not-in-table`); emission enforces only the
structural `cClassTrib[0:3] === CST` rule, so a stale table can never block a
valid NF-e, and the picker still accepts a free-typed code. Anexo II
(`cClassTribIS`) and Anexo I (NCM do IS) are still *"a ser publicada"* — not
vendored.

## How to refresh (update-watch routine)

1. `curl` the two public pages (or open them) and read the `dadosOriginais`
   literal / the cCredPres rows. Keep the NF-e filter (`IndNfe === true`).
2. Rewrite `cclasstrib.data.ts` / `ccredpres.ts` with the SAME shape and folds
   (descriptions: CR/LF → space, collapse spaces, trim; codes, flags, rates and
   dates verbatim), and update the `*_PROVENIENCIA` date and row count.
3. Run `pnpm --filter @delfrance/schemas test` — the integrity tests pin the row
   count, the ordering, the CSTs with no NF-e row, and the codes the nota de
   crédito/débito work depends on; a refresh that changes any of them says so.
4. Note the new retrieval date here.

## References

- NT 2025.002 v1.40 PDF (this folder) — layout + RVs; page 82 points here.
- `../../rtc-ibs-cbs-is.md` §"CST + cClassTrib model" — the in-skill summary.
- Tecnospeed / NFE.io / Taxcel / SVRS — secondary guides used to corroborate.
