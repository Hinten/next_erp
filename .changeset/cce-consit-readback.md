---
"@delfrance/integrations-nfe": minor
---

Read an NF-e's events back from SEFAZ's consSit reply (#1094 F1b, groundwork — no behaviour change for existing callers).

- `consultarSituacaoNFeComXml` is `consultarSituacaoNFe` that also returns the reply's raw XML (`retConsSitXml`); `consultarSituacaoNFe` now delegates to it, so the two cannot drift.
- `extrairEventosNFe(retConsSitXml, tpEvento?)` lists every event SEFAZ holds for the NF-e — `tpEvento`, `nSeqEvento`, `cStat`, `nProt`, `dhRegEvento`, the CC-e `xCorrecao` — plus the signed `procEventoNFe` sliced out as SEFAZ sent it, made standalone (XML prolog, and the default namespace when the reply declared it only on its root) so its signature still verifies. It throws instead of guessing on a malformed event.
- `parseCceRetorno` (and so the DANFE-CC-e) accepts a `procEventoNFe` as well as a `retEnvEvento`, so a CC-e recovered that way prints its REAL registration.
