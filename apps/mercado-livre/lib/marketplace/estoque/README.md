# estoque — stock sync

Keeping ML's available quantity in step with ERP stock, on a sweep and on
demand. ⚠️ The invariant under everything here is
`disponivel = quantidade − quantidadeReservada`, so a **negative** reservation
_increases_ availability — the one failure direction that makes ML sell stock
the store does not have. See ADR 0014 §7.

- `bulkEstoquePlan.ts` — the compute core (~2,200 lines): produtos-first family
  discovery, keyset paging, the `changedSinceMs` window and the durable cursor.
  **No IO.** ⚠️ Thirteen non-test modules under `lib/marketplace` import this
  (plus three files in `functions/src`), spanning `preco/` and `anuncios/` —
  it is really the shared linked-family discovery core, and hoisting it to
  `core/` is the obvious future move if those edges start to chafe.
  ⚠️ Also the `deployShellSource` that `tools/deploy-env/preflight.test.js`
  reads by path.
  ⚠️ Its S1 anchor terms (`paiId == null` AND `integracoesComProduto` contains
  the conta) are bound to the link walk's classifier: the
  `S1 ⇔ classificarLinkNaoEnumerado` describe in `bulkEstoquePlan.test.ts`
  evaluates the `where` S1 actually recorded over a 24-document matrix, so a
  term added here reds until `anuncios/linksNaoEnumerados.ts` moves with it.
  The `'conta-fora-do-produto'` rung of `buildSendTasks` is **by-ids-only** —
  S1 already filtered that field, so no sweep row can reach it; it fires only on
  the manual push (`estoqueManual.ts`), for trigger lag right after a publish,
  every link of the conta closed or never published, or denorm drift.
- `estoqueSend.ts` — the `sendMercadoLivreStock` task handler; one task, one ML
  stock write. ⚠️ Its transaction (`podarVariacoesFantasma`, #707) straddles a
  network call: the stored half is re-read inside the callback so a concurrent
  import aborts this attempt rather than losing to it. Losing would mark a
  **live** variation `closed` and silently stop its stock.
- `estoqueRetryRefresh.ts` — #693's delayed-task refresh. Attempt zero never
  reaches it; a real Cloud Tasks retry or pause re-enqueue performs one BatchGet
  for distinct target produtos and one for the union of target/component estoque
  refs. New tasks carry the exact estoque document ids already found by the
  sweep, including legacy auto-ids; a captured absence carries `null` and probes
  the canonical id only to detect a row created afterwards. There is no query,
  scan, depósito read or cache. Cost is `P` produto reads + `|P ∪ C|` estoque
  reads in at most two RPCs. If current kit composition is not covered, the
  whole task falls back to its original quantities — a bulk never mixes fresh
  and old values. Old tasks try canonical ids and also fall back atomically when
  an absent canonical row could hide a legacy auto-id. Old bulk payloads without
  child `produtoId` still skip so the next sweep can rebuild them.
- Every send task is measured as the actual UTF-8 `{ data: task }` JSON after
  Base64 encoding. The planner warns at 64 KiB and refuses the whole task above
  80 KiB (`task-excede-limite`), regardless of protocol or variation count.
- `variacoesReconciliacao.ts` — pure. Completes a legacy-model bulk
  `variations[]` patch against the listing ML actually holds (**#831**).
  ⚠️ **A `variations[]` body is not a patch: ML DELETES every variation the
  array omits** — its own docs call omission the removal mechanism — and
  `buildSendTasks` routinely emits a partial array, two of whose four drop
  reasons are ordinary configuration. So the planner's array never reaches the
  wire unreconciled, and a completion that cannot be proven complete refuses the
  send outright rather than degrading to the partial one. ⚠️ A planner-side
  check could not have covered this: a variation living on ML with no local link
  produces no child row, so nothing is skipped and the array looks complete.
- `estoqueSweep.ts` — `runStockSweep`, the core of all three sweep tiers
  (`incremental` every 15 minutes, `daily` at 02:00, the monthly
  `reconciliacao` force-all at 03:00 on the 1st — ADR 0014 §3). The
  `onSchedule` wrappers live in `functions/src/sweepStock.ts`.
- `auditoriaNaoEnumerados.ts` — **#1200**, the monthly **link audit** (02:30 on
  the 1st, just before the force-all). Not a fourth tier: it sends nothing and
  calls no ML API. Per active conta it runs the shared link walk
  (`anuncios/linksNaoEnumerados.ts`) to find the live anúncios S1 can never
  enumerate, HEALS a produto whose `integracoesComProduto` lost the conta
  (`anuncios/integracoesComProduto.adicionarContaSeViva`, tier 1) and raises one
  `anuncioForaDaSincronizacao` aviso per produto for everything a human must fix
  (a link on a variation child, an invalid `paiId`, an orphan link). Gated by
  the master `MERCADO_LIVRE_STOCK_SYNC_ENABLED` alone — the reconciliação flag
  is an ML-quota valve and this spends none.
  ⚠️ "Not found" resolves an aviso only after a COMPLETE walk AND a fresh
  re-read (`reclassificarProdutoNaoEnumerado`); a walk cut short by its page cap,
  its time budget or a stalled cursor heals and raises what it saw and resolves
  nothing. ⚠️ It lists a conta's avisos by DOCUMENT-KEY range
  (`[<tipo>:<conta>:, <tipo>:<conta>;)`, end EXCLUSIVE) — the `:` in the start is
  what keeps conta `c1` from resolving conta `c10`'s rows.
  ⚠️ Its source must never name the transaction API: the heal's transaction
  runs in `@delfrance/data/admin/produtos`, and
  `firestore-transaction-inventory.test.js` greps raw source text. Writes
  nothing to `estoqueMercadoLivreSync` (that strict schema throws on an unknown
  key and would kill the whole tick). The emulator suite
  (`auditoriaNaoEnumerados.firestore.test.ts`) runs the real collection-group
  paging, heal and aviso writes; ops detail is `functions/DEPLOY.md`, "The
  monthly link audit".
- `estoqueManual.ts` — "enviar estoque agora" for a hand-picked produto set.
- `mlStockTasks.ts` — the task-queue scheduler for the stock send queue.
- `stockSendMaxAttempts.test.ts` — no source sibling. Pins
  `STOCK_SEND_MAX_ATTEMPTS` against the queue's `retryConfig` in
  `functions/src/sendStock.ts`. ⚠️ Its `__dirname` path is depth-sensitive.
