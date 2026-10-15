---
"@delfrance/schemas": minor
"@delfrance/data": minor
"@delfrance/integrations-nfe": patch
"@delfrance/nfe-app": patch
---

A devolução references its origin NF-e per item — `det/DFeReferenciado` — never per nota (NT 2025.002 v1.51 VC02-14, cStat 321, produção 05/10/2026; #1683).

A one-time SEFAZ-SP homologação probe settled what the NT left open: a devolução with `NFref` alone is refused (321) **with and without** the Reforma Tributária, a devolução referencing by item is authorized without it, and the rule is judged per item.

- **Det reader:** `lerItensDoProc` (`@delfrance/schemas`) reads the `<det>` lines (nItem, cProd, price, unit) of an authorized `xml_nfe_proc` — pure, browser-safe, all-or-nothing. `nItem` is a position fixed at emission, so the stored XML is its only source.
- **Matcher:** `referenciarItensDaDevolucao` / `preencherReferenciasPendentes` (`@delfrance/data/pedido`) find each returned item's origin line — `cProd` by priority (sku, gtin, produtoUid, each also cut to 60, the legacy app's code), the price among a product's lines, then line order; each line is claimed once; an item that cannot be placed keeps the chave with `nItem: null`, never a guessed number.
- **Builders:** the troca (#488) and integral (#551) devoluções set every item's `dfeReferenciado` from its own origin's approved NF-e and leave `chNFeReferenciadas` null. The origin's XML is already in the docs the flow reads — no extra read, no migration. `collectChNFeReferenciadas` is removed.
- **Rules:** VC02-14 blocks emission — one document-level 321 when no item is referenced, one per unreferenced item otherwise — whatever the RTC. Item references on a devolução no longer require the Reforma Tributária.
- **Web:** no "Emitir NF-e?" is offered for a devolução with incomplete references (a warning points to the Fiscal tab instead); the Fiscal tab gains "Preencher a partir das NF-e de origem".
- **DANFE:** the chaves referenced per item are printed in informações complementares (`DF-e ref. {chave}`), so a devolução's DANFE still shows the nota it returns.
