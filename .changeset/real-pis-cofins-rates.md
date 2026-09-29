---
"@delfrance/schemas": patch
"@delfrance/integrations-nfe": patch
"@delfrance/nfe-app": patch
---

Accept `modBCST` '6' (Valor da Operação) and emit the configured PIS/COFINS instead of zeros, with ICMSTot totals that match the items (#509).

`modBCSTSchema` gains '6' (NT 2019.001 §1.6; the XSD has accepted it all along), with `MOD_BCST.valorOperacao` and its label — a stored '6' config used to fail every schema built on `taxConfigFields`, so the resolver silently fell to a lower tier.

`PISOutr`/`COFINSOutr` (CST 49–99) now emit the configured rate: a percent (`pPIS`/`pCOFINS` > 0) gives `(vBC + p)`, a per-unit `vAliqProd` > 0 gives `(qBCProd + vAliqProd)` with `qBCProd` = the item quantity, both at once throws `NFeTributeError` (a 400 before any número is allocated), and neither keeps the zero shape byte-identical. CST 03 (`PISQtde`/`COFINSQtde`) now scales with the quantity instead of a hardcoded `qBCProd` 1. A rate that does not fit the XSD (1000% or more) throws at build time. `tributeItemSchema` gains an optional `qTrib`, and `computePisCofinsItemValues` is exported as the single source for the item values and the totals.

ICMSTot `vPIS`/`vCOFINS` are now the sum of the items that carry `<ICMS>` (MOC 7.0 rules 602/603) instead of a hardcoded 0 — which also changes the totals of existing CST 01/02/03 notes. `vNF` is unchanged. Behaviour change for stored configs: a CST 49–99 doc whose `pPIS`/`pCOFINS` was filled only for the Shopee `tax_info` block now emits that rate on the NF-e; setting it to 0 keeps both the zero shape and the Shopee block.
