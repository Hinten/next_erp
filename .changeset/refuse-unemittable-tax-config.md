---
"@delfrance/schemas": minor
---

Refuse to save a tax config the NF-e engine would refuse to emit (#1655).

`@delfrance/schemas` gains `imposto/problemasDeEmissao.ts`: `problemasDeEmissaoDoImposto(unknown)` formats the `regrasDeEmissao` verdicts in pt-BR behind the engine's own tier gate (`impostoSchema.safeParse`, so a doc the engine would never read — no `origem`, a malformed code, a raw legacy value — is never refused), in the engine's build order (PIS, COFINS, ICMS unless ISSQN); `issuesDeEmissaoDasLinhas` maps an Impostos tab's rows to page issues, and `produtoPageIssues` now appends them. No rule is re-implemented and no stored schema gains a refine.

In `apps/web` (an ignored, unpublished package, so it carries no bump here): the imposto editor shows an orange "A NF-e recusaria esta configuração" Alert and inline field errors; the operação (edit + create), categoria and produto pages and the regra (Macros) save refuse such a config before any write; the produto and categoria Impostos tabs name the other operações whose stored row would be refused and jump to them. `IcmsSection` reads the SN predicate and the CSOSN → sub-config table from `@delfrance/schemas` instead of its own copies, and the four PIS/COFINS rate inputs show the wire's 4 decimals (display only — a stored value is never rewritten).

Blocked: a half-filled ICMSSN XSD group, a CSOSN whose sub-config was never filled (no `{}` seeding), a Simples Nacional CRT with no CSOSN, CST 01/02 without a rate, CST 03 without `vAliqProd`, a PIS/COFINS rate of 1000 or more, and CST 49–99 with both rates. Not blocked (follow-ups): a reachable tier with neither ICMS nor ISSQN, the IPI `IPITrib` pair, and the operação's `ehFiscal` (not gated). Once an Impostos tab is opened, a stored legacy row the engine already refuses blocks that page's save until fixed.
