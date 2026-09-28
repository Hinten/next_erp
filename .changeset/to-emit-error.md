---
"@delfrance/nfe-app": patch
---

`toEmitError` reports only known failure classes; the web no longer auto-retries emits (#1654 §3).

Until now `emitirPedidosLote` filed ANY `Error` a member threw as an ordinary per-pedido `EmitError` with `errorCode: reason.name` — a bug (a `TypeError`, a plain `Error`) read forever as one more refused pedido inside a 200, at prep, in the chunk cascade, at generate/sign, in EPEC, in the no-receipt persist and in the per-chave outcome alike.

Now:

- **`toEmitError` reads the one failure table** (`descreverFalhaConhecida`, `orchestrator/falhas.ts`, the table the sweep's catches already use). A known class is reported by its literal code and its own message. The codes are unchanged for every class that sets its own `name`; two change, both from the `'Error'` they used to inherit: a failed Cloud Tasks enqueue is now `'FirebaseFunctionsError'` (firebase-admin never sets `name`), and an Admin-SDK Firestore failure is `'FirestoreRpcError'`. `NFeConsumoIndevidoError` stays a per-member report.
- **Any other class is rethrown** (rule 6): the batch rejects and `POST /api/nfe/emitir-lote` answers 500, losing every other member's report in that request. At prep one bug aborts all ≤50 pedidos with nothing written or sent; at generate/sign the chunk's healthy fresh members are already unsent #396 anchors, which a re-emit retransmits with their stored bytes (or the sweep's consSit recovers); after the send each member's reply is audited before its write, so a member whose write threw is still its anchor.
- **`apps/web`'s `withNFeRetry` retries `emitir` and `emitirLote` only on the pre-send 503** (`NFeRuntimeNotReadyError`), no longer on a 5xx or a network error. Its "server-deduped" premise was false: an emit re-POST is a no-op only for a bloqueada or `nRec`-in-flight pedido, while `runChunkAllocateTx` / `runAllocateGenerateSignTx` regenerate and re-send every `rejeitada`/`error` one — so an auto-retry after a lost response re-sent whatever the first attempt had just seen refused. A transient 5xx on emit now reaches the operator, who re-clicks. (`@delfrance/web` is not versioned by changesets.)

**Deploy apps/web no later than apps/nfe**: an older web re-POSTs the new 500 up to three times, each re-POST re-sending the members the previous attempt left `rejeitada`/`error`.
