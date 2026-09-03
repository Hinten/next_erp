# estoque — stock sync

Keeping ML's available quantity in step with ERP stock, on a sweep and on
demand. ⚠️ The invariant under everything here is
`disponivel = quantidade − quantidadeReservada`, so a **negative** reservation
_increases_ availability — the one failure direction that makes ML sell stock
the store does not have. See ADR 0014 §7.

- `bulkEstoquePlan.ts` — the compute core (~2,200 lines): produtos-first family
  discovery, keyset paging, the `changedSinceMs` window and the durable cursor.
  **No IO.** ⚠️ Eleven files import this, spanning `preco/` and `anuncios/` —
  it is really the shared linked-family discovery core, and hoisting it to
  `core/` is the obvious future move if those edges start to chafe.
  ⚠️ Also the `deployShellSource` that `tools/deploy-env/preflight.test.js`
  reads by path.
- `estoqueSend.ts` — the `sendMercadoLivreStock` task handler; one task, one ML
  stock write. ⚠️ Its transaction (`podarVariacoesFantasma`, #707) straddles a
  network call: the stored half is re-read inside the callback so a concurrent
  import aborts this attempt rather than losing to it. Losing would mark a
  **live** variation `closed` and silently stop its stock.
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
- `estoqueSweep.ts` — the 15-minute and 02:00 `onSchedule` sweeps.
- `estoqueManual.ts` — "enviar estoque agora" for a hand-picked produto set.
- `mlStockTasks.ts` — the task-queue scheduler for the stock send queue.
- `stockSendMaxAttempts.test.ts` — no source sibling. Pins
  `STOCK_SEND_MAX_ATTEMPTS` against the queue's `retryConfig` in
  `functions/src/sendStock.ts`. ⚠️ Its `__dirname` path is depth-sensitive.
