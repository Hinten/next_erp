---
"@delfrance/schemas": minor
"@delfrance/integrations-nfe": minor
"@delfrance/nfe-app": minor
"@delfrance/data": patch
"@delfrance/web": patch
---

Notas de débito with an IBS/CBS adjustment group — the third part of #330. Débito 01, 02, 03, 05, 07 and 08 are now emitted; every nota de débito tipo is covered.

- **The tipo decides, the item states the amounts.** A tipo that binds a fixed cClassTrib (UB14-70) now emits it. The tipo supplies CST + cClassTrib + group (`grupoDeAjusteDoTipo`, derived from the vendored Anexo III indicators rather than typed as a table); each item states its IBS/CBS amounts in the new `itens[*].ajusteRtc: { vIBS, vCBS, competApur } | null` (nullable, default null; not a legacy field). The produto's own `configuracaoIBSCBS` is not read for these items.
  - débito 01/05 → `gTransfCred`;
  - débito 02/03/08 → `gAjusteCompet` (with `competApur`, AAAA-MM);
  - débito 07 → `gEstornoCred`, with the `IBSCBSTot/gEstornoCred` total (W59e–g), and its item keeps ICMS.
- **Totals.** Adjustment amounts never enter `IBSCBSTot` vBC/vIBS/vCBS, which sum `gIBSCBS` only (W35/W47/W56).
- **Shared rules.** New: the adjustment amounts are required on each item; they must be finite and non-negative; 1129 and 1171 (IBS or CBS above zero); `competApur` must be AAAA-MM and the emission month or earlier (UB113); amounts on a tipo that ignores them are a warning. The UB14 checks judge the cClassTrib the tipo supplies.
- **Still refused, for reasons in the NT itself (v1.40; re-check against v1.50):**
  - crédito 02 (ZFM): cannot be emitted before 2029 (1145), and needs the item-level `tpCredPresIBSZFM`, which is not modelled;
  - crédito 05 (sucessão): its 800001 requires `gTransfCred` (1132), which UB106-30 allows only on a nota de débito (1133).
- **Web:** the pedido's Fiscal tab gains an "Ajuste de IBS/CBS" editor, shown for these tipos (or while stale amounts remain), with the same rule warnings. Duplicating a pedido drops the amounts; marketplace imports set them to null.
