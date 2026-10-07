---
"@delfrance/data": patch
---

A devolução's items no longer inherit the origin sale line's `imposto`. Both builders — the troca (#488) and the devolução integral (#551) — now clear it on every cloned line, so the NF-e resolves each item's tax under the DEVOLUÇÃO operação (its produto/categoria imposto for that operação, its regras, its default).

A stamped item imposto wins over the operação at emission, so a sale line's saída CFOP (5102/6102) carried into a finNFe=4 entrada would be refused by SEFAZ with cStat 327 (MOC Anexo I, I08-140), and no screen lets the operator change an item's CFOP. Today this is a guard, not a behaviour change: no writer in this repo or in the legacy Flutter app (2,672 commits) has ever persisted an item imposto, so every existing item already carries `null`.
