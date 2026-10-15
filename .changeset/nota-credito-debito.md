---
"@delfrance/schemas": minor
"@delfrance/integrations-nfe": minor
"@delfrance/nfe-app": minor
"@delfrance/web": patch
---

Nota de crédito and nota de débito — finNFe 5/6 (NT 2025.002) — second part of #330.

- **Operação:** `finNFe` accepts 5 (nota de crédito) and 6 (nota de débito), with the new `tpNFDebito` ('01'–'08') and `tpNFCredito` ('01'–'05') fields (nullable, default null). `tpNFCredito` 06 waits for the PL_010f XSD pack. The operação form shows the tipo select for its finalidade and validates B25-110/120, B25.1 and B25.2 with the same rules the emission uses.
- **Shared rules:** `violacoesDoDocumento` now also covers the finalidade and tipo (1161, 1162, 1139, 1009, 1163, 1164, 1145, 1152), the note-level reference of a nota de crédito (254, 255, 269, 678, 1027, 1003), the cClassTrib a tipo binds (UB14-60/70/80: 1202, 1200, 1201), and the débito item-reference rules (1038, 1039, 1042, plus the tpNFDebito 03 exceptions to 1048 and 1130). New: `violacoesDaOperacao`, and `notaCreditoDebito.ts` with the tipo → cClassTrib tables (UB14-60 derived from UB14-70/80, pinned against the NT) and `modoGruposImposto`.
- **IBS/CBS-only items:** a nota de crédito/débito carries only `IS` + `IBSCBS` on each item (B25-80, cStat 1001), except crédito 03/04 and débito 07. `buildImpostoXml` and `aggregateTotals` take the same `grupos` mode, derived once per nota in `apps/nfe` (`modoGruposFor`), so the det and the total never disagree. `ide` emits `tpNFDebito`/`tpNFCredito` and refuses an inconsistent tipo.
- **Refused before a número is consumed:** a nota 5/6 with the Reforma Tributária off, an item without IBS/CBS configuration, and the 8 tipos whose items need an adjustment group not built yet (débito 01/02/03/05/07/08, crédito 02/05 — #330 part 3). The document rules now run before the item projection, so these messages come first. Emittable today: débito 04 and 06, crédito 01, 03 and 04.
- **Simples Nacional:** finNFe 5/6 are neutral in the receita bruta (sign 0, counted in `notasNeutras`); the totals reader and the apuração aggregate accept them instead of reading them as unknown codes, which would block the apuração.
- **Live (homologação, advisory):** one nota de débito 06 case in the RTC suite, serie 4.
