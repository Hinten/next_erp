---
"@delfrance/schemas": minor
"@delfrance/integrations-nfe": minor
"@delfrance/nfe-app": patch
"@delfrance/data": patch
---

Item-level references to another NF-e — `det/DFeReferenciado` (NT 2025.002 Grupo VC) — first part of the nota de crédito/débito work (#330).

- **Schema:** `itens[*].dfeReferenciado: { chaveAcesso, nItem | null } | null` (new, not a legacy field; nullable, default null). Its shape is checked by the page model — a chave must pass the check digit, `nItem` must be 1–990 — so a half-typed value gets a readable message on the Fiscal tab instead of a failed save. Duplicating a pedido drops it; marketplace imports set it to null.
- **Shared rules:** `violacoesDoDocumento` (`@delfrance/schemas`) evaluates the document rules SEFAZ applies to item references — 1010, 1048, 1072, 1130, plus 1193/1194 as warnings, since a Nota Fiscal Avulsa is their MOC exception and this ERP cannot see one — and returns verdicts as data with one shared pt-BR text per rule. The pedido editor shows them as warnings; `apps/nfe` refuses a nota with a blocking one before a número is consumed, on both paths. Item references are emitted only with the Reforma Tributária on.
- **Chave de acesso:** the módulo-11 check digit now lives once, in `@delfrance/schemas` (`dvChaveAcesso`, `chaveAcessoValida`, `decomporChaveAcesso`); the generator's `computeCDV` wraps it.
- **Generator:** `GeneratorItem.dfeReferenciado` emits the group as the last child of `<det>`; absent ⇒ byte-identical XML.
- **Web:** the pedido's Fiscal tab gains a per-item reference editor (chave, nItem, "apply to all") with the rule warnings.
