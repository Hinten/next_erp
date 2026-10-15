---
"@delfrance/integrations-nfe": minor
---

Read an NF-e's events back from SEFAZ's consSit reply (#1094 F1b, groundwork), and make the XML reader decode what SEFAZ may legally send.

- `consultarSituacaoNFeComXml` is `consultarSituacaoNFe` that also returns the reply's raw XML (`retConsSitXml`); `consultarSituacaoNFe` now delegates to it, so the two cannot drift.
- `extrairEventosNFe(retConsSitXml, tpEvento?)` lists every event SEFAZ holds for the NF-e — `tpEvento`, the signed `nSeqEvento`, `cStat`, `nProt`, `dhRegEvento`, the CC-e `xCorrecao` — plus the signed `procEventoNFe` sliced out as SEFAZ sent it, made standalone (XML prolog, and the NF-e default namespace when the reply declared it only on its root) so its signature still verifies. The `tpEvento` filter runs before validation, so a malformed event of another type cannot block a lookup; a returned event that is malformed, or that uses a namespace prefix declared outside it, throws `NFeEventoError` instead of being guessed at.
- `parseCceRetorno` (and so the DANFE-CC-e) accepts a `procEventoNFe` as well as a `retEnvEvento`, so a CC-e recovered that way prints its REAL registration.
- **Behaviour change in the shared XML reader** (every `parse()`): numeric character references (`&#231;`, `&#xE3;`) are now decoded — they were left raw, so an `xMotivo` could reach the operator as `Rejei&#231;&#227;o`; CDATA is kept literal instead of being entity-decoded a second time; a `>` or `/>` inside a quoted attribute value no longer ends or self-closes the tag; and a stray close tag is ignored instead of crashing the parse.
