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
- `estoqueSweep.ts` — the 15-minute and 02:00 `onSchedule` sweeps.
- `estoqueManual.ts` — "enviar estoque agora" for a hand-picked produto set.
- `mlStockTasks.ts` — the task-queue scheduler for the stock send queue.
- `stockSendMaxAttempts.test.ts` — no source sibling. Pins
  `STOCK_SEND_MAX_ATTEMPTS` against the queue's `retryConfig` in
  `functions/src/sendStock.ts`. ⚠️ Its `__dirname` path is depth-sensitive.
