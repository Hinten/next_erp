---
"@delfrance/schemas": minor
"@delfrance/integrations-nfe": patch
---

Move the NF-e tax-config emission rules into one `@delfrance/schemas` home, as verdicts (#1655).

`@delfrance/schemas` gains `imposto/regrasDeEmissao.ts`: `ehCrtSimplesNacional`, `usaIssqn`, `SUBCONFIGS_ICMS_SN`, `SUBCONFIG_POR_CSOSN`, the ICMSSN XSD sub-group tables (`GRUPO_XSD_FCP_ST`, `GRUPOS_XSD_ICMSSN500`, `GRUPOS_XSD_ICMSSN900`, `GRUPOS_XSD_POR_SUBCONFIG`), `vereditoIcmsSn` (naoSimplesNacional / semCsosn / subConfigAusente / gruposIncompletos / ok with the sub-config typed per CSOSN), `vereditoPisCofins` with `ALIQUOTA_PIS_COFINS_LIMITE` and the Aliq/Qtde/NT/Outr CST subsets. Pure functions over the parsed shapes that return data, never a Zod refine, so a stored doc still never drops to a lower resolver tier.

`@delfrance/integrations-nfe` re-exports them from `tribute/schemas.ts`, and `buildImpostoXml` now reads them instead of its own copies: no behaviour change. Every `NFeTributeError` message is byte-identical and every precedence is unchanged (CRT, then CSOSN, then the sub-config, then its XSD groups; PIS before COFINS before ICMS), pinned by exact-message tests, and the emitted XML is identical.
