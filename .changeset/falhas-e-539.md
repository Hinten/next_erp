---
"@delfrance/nfe-app": patch
"@delfrance/data": patch
"@delfrance/integrations-nfe": patch
---

Keep the consSit breaker across a failed reconcile, isolate a vanished doc, and write the 539 chave swap in the caller's own write (#1654 §2c, §2d).

Until now a lote reconcile that threw lost the consSit breaker it had tripped: `reconcileByRecibo` held it in a local and returned it only on success, so after a 656 the backstop sweep went on to consult the same filial's next lote by chave. Two ordinary causes made it throw: a doc deleted between the in-flight query and its guarded write (the guarded persist refuses a missing doc), and any Firestore failure on one doc, both of which also aborted the rest of the lote. `recoverFrom539` swapped the recovered chave with a plain merge of its own, BEFORE and outside the caller's guarded write, so a write refused by a concurrent writer still left the chave swapped. And the sweep's four per-item catches recorded ANY exception, a bug included, as an ordinary per-doc error (rule 6).

Now:

- **`@delfrance/data`** exports `isGrpcStatusError` (an `Error` with an integer gRPC code 1–16) and `isTransientGrpcError` (codes 4, 8, 10, 13, 14) from `admin/grpcErrors`.
- **`NFeDocAusenteError`** (a subclass of `NFeOrchestratorError`, so the routes' 400 and the batch errorCode are unchanged) is what the guarded persist throws on a missing doc; it carries the doc's `path`.
- **One failing doc no longer aborts the round** in `reconcileByRecibo`, but only for three named causes: a vanished doc is skipped (in no tally), a transient Firestore failure leaves the doc pending and uncounted, and a transport/XSD/XML failure of the 539 recovery's own `consReciNFe` counts the round like any other in flight (terminal at the cap, with the round's blocking cStat). Every other class is still rethrown.
- **The breaker lives in a cell the caller owns** (`DisjuntorConsSit`, the `disjuntor` parameter that replaces `bloqueioConsSit`): `reconcilePorChave` writes every trip into it in place, the moment the consSit answer (or its thrown 656 / transport failure) says so and before any further await. The sweep builds one per lote before its `try` and registers it after its `catch`, on success and on a recorded failure alike, so a lote that throws after a 656 still stops the filial's next lote. `ReconcileLoteResult.bloqueioConsSit` still reports it.
- **`recoverFrom539` / `recover539IfNeeded` write nothing** and drop their `nfeRef` parameter. The chave swap rides each caller's own write of the recovered patch (`extrasDaTrocaDeChave`): under `persistPatchUnlessFinal` in the reconcile and the manual verify, so a refused write swaps nothing (the manual verify then reports the doc's original chave); inside the plain `persistPatch` of the sync emit path and of the sweep's legacy consult by chave, where it is now atomic with the outcome but still cannot be refused (follow-up).
- **Rule 6 in the sweep**: its four catches read the failure through `descreverFalhaConhecida` (new `orchestrator/falhas.ts`, one table of known failure classes with literal codes; a Firestore gRPC error is `'FirestoreRpcError'`). A known class is recorded with the message it always had; an unknown class aborts the run (the scheduled function fails and the next tick retries; the manual `processar-pendentes` route answers 500).
- **`@delfrance/integrations-nfe`** exports `NFeDetError` and `NFePartiesError` from the generator and the root barrel, so the table can name them.

Not changed: the sweep's legacy consult by chave for docs without an `nRec` (still plain `applyOutcome`, uncounted, unguarded), and a bug after a trip on the task path, which still reaches the queue retry without the breaker.
