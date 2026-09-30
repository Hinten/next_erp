---
"@delfrance/schemas": minor
---

Vendor the NT 2025.002 code tables: the NF-e rows of Anexo III (`cClassTrib`), the CST IBS/CBS table, both with their indicators, and Anexo IV (`cCredPres`) (#333).

Until now `cclasstrib.ts` carried a 5-row verified seed, so the RTC picker offered nothing beyond CST 000 and every other code raised a `not-in-table` warning. The data is now read from the public SVRS "Conformidade Fácil" page (the JSON literal its table and exports are rendered from), filtered to the rows valid for NF-e — 97 of 164 on 2026-09-28 — and committed as reviewed source with its provenance (`CCLASSTRIB_PROVENIENCIA`); a one-off script did the transcription, nothing generates it (root rule 3).

- `CST_IBSCBS_TABELA` / `CCLASSTRIB_TABELA` carry the `ind_g*` indicators (`IND_CST_IBSCBS`, `IND_CCLASSTRIB`), `tipoAliquota`, `pRedIBS/CBS` and `inicioVigencia`; new lookups `cClassTribEntry` and `cstIbsCbsEntry`.
- `CST_IBSCBS_LABELS` is now derived from the table, so it carries the official names — seven of the previous best-effort labels were wrong (011, 220, 221, 222, 810, 811, 820).
- `CCREDPRES_TABELA` + `cCredPresEntry`: 13 codes stored as `'01'`…`'13'` (XSD `TcCredPres`).
- **Breaking:** `CCLASSTRIB_SEED` is removed; use `CCLASSTRIB_TABELA`.

Membership stays a UI warning only — emission still checks the structural `cClassTrib[0:3] === CST` rule alone, so a stale table never blocks a valid NF-e.
