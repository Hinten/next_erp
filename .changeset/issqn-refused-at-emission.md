---
"@delfrance/nfe-app": patch
---

Refuse an item whose resolved imposto carries `configuracaoISSQN` at generation, before a número is consumed (#1656).

This ERP emits no `<ISSQNtot>`, so an NF-e conjugada is not supported: `aggregateISSQN` has no caller, an ISSQN item's `vProd` counts in `ICMSTot.vProd`, and `buildISSQN` copies the config's fixed R$ `vBC`/`vISSQN` onto every sale whatever its price or quantity. Such an item used to emit an NF-e with an `<ISSQN>` det group and no ISSQN totals. It now fails as a 400 `NFeOrchestratorError` naming the pedido, item and produto (batch errorCode `'NFeOrchestratorError'`), on the same pre-flight seat as #506, so no número is consumed. Pedidos whose NF-e is already authorized/blocked, in flight, EPEC-approved or awaiting a crash-window retransmit of its stored bytes are unaffected by the live config, as before.
