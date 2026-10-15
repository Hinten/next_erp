---
"@delfrance/schemas": minor
"@delfrance/integrations-nfe": minor
"@delfrance/nfe-app": minor
"@delfrance/data": patch
"@delfrance/web": patch
---

NT 2025.002 `ide` / `emit` fields beyond the tax groups (#331): `dPrevEntrega`, `gPagAntecipado`, `ISUFEmit`, and `gCompraGov` in the library only. All of them are emitted only with the Reforma Tributária on; with it off the XML is byte-identical.

- **dPrevEntrega (B10a):** derived from `freteInicial.dataPrevisaoEntrega`, read as a date in the emitente's time zone. It is **omitted**, never a refusal, outside the B10a windows: finalidade 1/4 only; not with modFrete 1/4/9; not before the emission date; at most 3 calendar months after it (`dPrevEntregaParaEmissao`).
- **gPagAntecipado (BC):** new pedido field `chNFePagamentoAntecipado: string[] | null` (nullable, default null), edited on the Fiscal tab. The page model refuses a chave that isn't an NF-e modelo 55 with a valid check digit, a duplicate, or more than 99. With the Reforma Tributária off the nota is refused rather than silently dropping them. Duplicating a pedido drops them.
- **ISUFEmit (C22):** new filial field `isuf` (8–9 digits, nullable). C22-10 (1185: only from the 12 ZFM/ALC municipalities) is refused before a número. C22-20 (the check digit) is left to SEFAZ, since the NT doesn't publish the algorithm.
- **gCompraGov (BB), library-only:** `buildCompraGov` builds the group and refuses the BB05 cardinality (`refDFeAnt` forbidden for tpOperGov 1/4, exactly one for 2, required for 3) and duplicates. No pedido carries it yet; that is the "full gCompraGov" follow-up.
- **Not modelled, documented:** `cIndOp` (its codes require a `<retirada>` group the ERP never emits) and `cMunFGIBS` (every nota here has a destinatário address).
- **Web:** the Fiscal tab's chave lists share one `ChaveListEditor`; each list's add button now has its own accessible name.
- **Rulesets:** `v_pedidos` gains the new key (both rulesets and both snapshots regenerated).
