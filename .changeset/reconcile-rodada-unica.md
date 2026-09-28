---
"@delfrance/nfe-app": patch
"@delfrance/integrations-nfe": patch
---

One decision per `consReciNFe` round, and every round that leaves an NF-e in flight counts toward the cap (#1654).

Until now three reconcile chains had no end. A lote-level non-answer (103/106/107/108/109/113/114) kept `retries` as read and was exempt from the cap, so a receipt that kept answering 106 or 108 re-enqueued forever. A 104 whose `protNFe` for our chave carried a duplicidade other than 539 (204/205/218/635) zeroed `retries` through `applyOutcome` and re-read the same receipt, and with an `[nRec:X]` marker it re-keyed the doc onto receipt X. An `enviando` doc carrying an `nRec` escaped even the 105 cap. And a lote-level 656, or a rejection of the `consReciNFe` query itself (252, 215/225, 28x…), persisted a NON-blocking cStat (`error` 656, `rejeitada`), which made the número re-emittable.

`reconcileByRecibo` now routes each doc through `decidirRodadaDoRecibo` (`orchestrator/lote-sem-protocolo.ts`), which is total over the cStat space:

- **Our `protNFe` with a final answer** is applied, as before. The 105 and 104-with-our-`protNFe` patches are byte-identical.
- **A 539** is recovered, as before, and a recovery that stays in flight continues the doc's own count instead of restarting at 1.
- **By chave** (`reconcilePorChave`, which replaces `reconcileLoteSemProtocolo`): a 104 without our `protNFe`, a per-NF-e verdict at LOTE level (100/101/102/110/…, never a final estado without a protocol), a 106, and a duplicidade 204/205/218/635. The round is counted before any further SEFAZ call, then ONE `consSitNFe` is made for the chave (none on a 106's first round, since the receipt may not be indexed yet). The doc keeps the receipt's cStat and `nRec`, so a marker never re-keys it. The answer goes through one recovery table, `classificarConsSitDeRecuperacao(cStat, motivo)`: autorizada/cancelada/inutilizada apply; a 217 is `rejeitada` (the número is free) for a missing protocol or a 106, a blocking terminal for a duplicidade (539 is facultative, so the número may be held under another chave), and "still queued" for a 635 (counted, no breaker, terminal at the cap); a denegada applies only for a missing protocol (pinned since #513) and is a blocking terminal otherwise, since its número is consumed.
- **Nothing about the chave** (103/105/107/108/109/113/114, or a cStat that is not TStat-shaped): counted, and consulted again.
- **Terminal**: a 656, or a refused receipt query.

Every round that leaves a doc in flight advances `retries` by exactly one, and an `enviando` doc is written `aguardandoResposta`, so a doc gets at most `MAX_RECONCILE_ATTEMPTS` receipt rounds and consSit calls between two operator actions. The manual verify, a new emit lote and the sweep's consult-by-chave branch for docs without an `nRec` still reset the counter. Every terminal now carries a BLOCKING cStat (`terminalBloqueante`): the round's own 103/104/105, or 103, since SEFAZ issued the receipt, with the real cStat as an xMotivo prefix (`cStat 108: …`). `STATUS_BLOQUEADORES` is unchanged. Every write still goes through `persistPatchUnlessFinal` under the same `PersistGuard`.

A receipt answering serviço paralisado (108/109/113/114) is now paced: `@delfrance/integrations-nfe` exports `RECONCILE_INDISPONIVEL_DELAY_MS` (one hour) and `esperaMinimaDoRecibo(loteCStat)`. `runReconcile` re-enqueues at `max(nextConsultaDelayMs(attempt+1), espera)`, and the counted write stamps the same wait on `proximaConsultaEm`, so the sweep never runs ahead of the task. With the cap that rides out about ten hours of outage before the docs need a manual verify.

The manual verify (`consultarChavePersistida`, under "Verificar novamente" and the `consult:dev-pedido` CLI) reads the receipt through the same decision and recovery table, without counting and without the 106 first-round wait. It now consults by chave for a 104 without our `protNFe`, which it skipped before, so a doc left terminal by the cap can be resolved. `ConsultaChaveResult` gains `consumoIndevido`, and `verificarEnviNfeMsgs` stops the run on it instead of on the persisted cStat, which no longer shows the 656.
