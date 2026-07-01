# RTC IBS/CBS code tables — source pointer (cClassTrib / CST / cCredPres / alíquotas)

**This is a SOURCE POINTER, not the table itself.** The IBS/CBS code tables are
published by SEFAZ as **`.xlsx` spreadsheets**, updated *outside* the NT cycle,
and the agent sandbox cannot reach `*.fazenda.gov.br` — so the binary files are
**not vendored** in this skill (matching the skill's "operational data isn't
versioned" convention). This file records *where* they are, *that they're
published*, and the *confirmed key codes*, so the update-watch routine knows
exactly where to refresh them.

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

## Machine-readable access (two surfaces)

1. **Browser export (no auth, simplest refresh).** The SVRS interactive portal
   above renders the full ~250-code table client-side with **CSV / Excel / JSON**
   export buttons. A human clicks **JSON** once and drops the file in — this is
   the intended refresh path (the agent sandbox can't trigger a client-JS export).
2. **Programmatic JSON (cert-gated).** `https://dfe-portal.svrs.rs.gov.br/CFF/Servicos`
   returns the CST + cClassTrib tables (filter by CST or the full list) over
   **ICP-Brasil mutual-TLS** — i.e. it needs the A1 certificate. SVRS asks for
   **no looping** ("a daily GET per company is sufficient"). A future
   `fetch:rtc-tables` mTLS script (deferred) would use this; today the browser
   export is the refresh mechanism.

## Confirmed key code (regra geral)

Verified against the **SVRS** table (2026-06):

- **`cClassTrib = 000001`** → *"Situações tributadas integralmente pelo IBS e
  CBS"*, under **`CST = 000` (Tributação integral)**. SVRS lists `000001` as the
  CST-000 entry. This is the standard taxable-sale code the repo fixture
  (`impostoCsosn102ComRtc`) uses.
- The first 3 digits of `cClassTrib` mirror the `CST`; the last 3 select the
  specific legal hypothesis under LC 214/2025.

## Vendored seed in this repo (#333)

A **verified seed** (not the full table) lives in
`packages/schemas/src/imposto/cclasstrib.ts` — currently the CST-000
"tributação integral" family (`000001`–`000005`) plus the CST IBS/CBS indicator
labels. It powers the shared imposto picker (`components/imposto/RtcSection`) +
the structural CST↔cClassTrib validator, and is exported from `@delfrance/schemas`
(consumed by both the UI and the emit-time tribute schema). Codes outside the seed
are still **free-typeable** (the UI warns but never blocks), and emission only
enforces the structural `cClassTrib[0:3] === CST` rule — so a stale seed cannot
block a valid NF-e. `cClassTribIS` (Anexo II) and `cCredPres` (Anexo IV) are
**not** seeded (Anexo II unpublished; cCredPres subgroup out of scope).

## How to refresh (update-watch routine)

1. From the SVRS interactive portal, click **JSON** to download the full
   `cClassTrib` + CST table (and `cCredPres` from its own table page).
2. Note the new version/date here, and reconcile the `CST_IBSCBS_LABELS`
   descriptions against the official "Indicadores CST" table.
3. Expand `CCLASSTRIB_SEED` in `cclasstrib.ts` with the verified rows you need
   (or, when the deferred `fetch:rtc-tables` mTLS script lands, regenerate from
   the fresh export). The validator + picker pick the new codes up automatically.

## References

- NT 2025.002 v1.40 PDF (this folder) — layout + RVs; page 82 points here.
- `../../rtc-ibs-cbs-is.md` §"CST + cClassTrib model" — the in-skill summary.
- Tecnospeed / NFE.io / Taxcel / SVRS — secondary guides used to corroborate.
