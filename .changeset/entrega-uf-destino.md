---
"@delfrance/integrations-nfe": minor
"@delfrance/nfe-app": patch
"@delfrance/schemas": patch
---

Decide an NF-e's interstate status from the delivery address and emit `<entrega>`; read canonical `documents/…` outer refs (#422).

**Delivery address.** The destination UF used for `ide.idDest` AND the per-item CFOP pick (`cfop` vs `cfopInterestadual`) is now the UF of the pedido's delivery address (`freteInicial.enderecoFreteOuterReference`) when that is a different document from the fiscal one, and the fiscal UF otherwise — legacy Flutter parity. The two are derived from one function, `ufDestinoOperacao`, so CFOP and idDest cannot disagree (SEFAZ 732/733). When the delivery address decides, the nota also carries the `<entrega>` group (`TLocal`), which is what exempts it from 772/523. `<enderDest>` stays the fiscal address. The group's identity is the delivery address's recebedor (CPF/CNPJ + name) or else the pedido's cliente, check-digit validated; a malformed recebedor document is refused, never replaced. `GeneratorInput` gains an optional `enderecoEntrega` (absent ⇒ byte-identical XML); `buildEntrega`, `NFePartiesError` and `ufDestinoOperacao` are exported.

A delivery ref that cannot be followed (missing document, malformed ref, an `estado` that is not a UF, an unresolvable município) does not fall back to the fiscal UF: it fails as a 400 `NFeOrchestratorError` naming the reason, before any número is consumed — on the batch path through the same pre-flight as #506 (`assertItemsBuildable` is now `assertNotaBuildable`). The loader itself does not throw for it, so `consultarPedido` and stored-bytes retransmits are unaffected. A delivery ref naming the fiscal document itself costs no extra read.

**Canonical refs.** `loadPedidoBundle` (and the cancelamento legacy fallback) handed stored outer refs to `fs.doc()` verbatim. The Admin SDK refuses the canonical `documents/<col>/<id>` form (odd segment count) — the form every app writer stores (`toOuterRef`, the marketplace importers, Flutter `pathWithDocuments`) — so those pedidos could not be loaded for emission at all. Refs are now normalized to the bare document path (`toDocPathOrNull`, new in `@delfrance/schemas`), which is also the batch read-memo key, and a set-but-malformed ref reports the field as malformed instead of "missing".
