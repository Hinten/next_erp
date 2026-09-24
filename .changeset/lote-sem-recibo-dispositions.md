---
"@delfrance/nfe-app": patch
---

Persist the outcome of an async NF-e lote whose `retEnviNFe` carries no `infRec`, instead of reporting every member as still processing (#512).

Until now `processChunk` wrote nothing when SEFAZ answered a lote without a receipt. It returned every member as `aguardandoResposta` while the doc stayed the pre-send `enviando` anchor with no cStat, so a lote SEFAZ had refused outright (108 paralisado, 656 consumo indevido, a lote-level rejection) looked like one still in flight. It was consulted by chave member by member on the next sweep tick, and a re-emit retransmitted the same bytes. Now each member gets one disposition, taken from the LOTE cStat alone (any `protNFe` in the reply and any xMotivo `[nRec:…]` marker are ignored):

- **Fresh members:** 656 → `error`. 108/109/113/114 and every rejection, 4-digit cStats included → `rejeitada`, keeping SEFAZ's cStat/xMotivo. The backstop sweep no longer scans either.
- **#396 crash-window members**, retransmitted with their stored signed bytes, stay `aguardandoResposta` on any refusal, so they keep their anchor. On 656 their next consult waits 1 h (`CONSUMO_INDEVIDO_ESPERA_MS`).
- **103/105/106** → `aguardandoResposta`, with the usual pacing.
- **A per-NF-e verdict or an anomaly at lote level** (100/150, 101/151, 102, 110/301/302, 104, 107, duplicidade, or a cStat that is not 3–4 digits, such as an empty `<cStat/>`) → `enviando`, with the cStat recorded. It is never `aprovada` without a proc, and it is left for the sweep's consSit.

No task is enqueued, and no SEFAZ call is made beyond the lote itself. Each write goes through `persistPatchUnlessFinal`, so a doc that went final while the lote was in flight is left alone. That function gains an optional `PersistGuard { expectedIdLote }`. With a guard, it also skips a doc that a newer lote re-stamped. A skipped member reports that doc's live estado and `nRec` with `reused: true`, because another run wrote that state and it is not this run's outcome. When the doc is missing, it throws `NFeOrchestratorError` rather than creating a partial doc. The written:false result gains `nRecAtual`. Behaviour change in `apps/web`, with no code change there: in the emitir-lote dialog, a fresh member refused this way moves from "Em processamento" (`processando`) to "Falhas" (`falhas`), where it can be re-emitted.
