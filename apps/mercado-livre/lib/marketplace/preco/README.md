# preco — pricing

Pushing ERP prices onto ML listings, as a bulk job or a hand-picked push. The
shape mirrors `estoque/` closely; the two share
`estoque/bulkEstoquePlan.ts` for family discovery.

- `precoPlan.ts` — the compute core: keyset page discovery of linked families.
- `precoDraftSend.ts` — the per-listing sender holding the eight-gate ladder,
  shared by the bulk job and the manual push. **No direct test sibling** —
  exercised through `precoSync.test.ts`.
- `precoSync.ts` — the "Atualizar preços" bulk job core. Manual-only by design.
- `precoReconciliacao.ts` — the links-side phase, reporting what the plan could
  not enumerate.
- `precoManual.ts` — "enviar preço agora" for a hand-picked produto set.
- `precoMotivos.ts` — the price vocabulary (`MENSAGEM_POR_MOTIVO` + `mensagemDe`),
  extracted from `precoManual.ts` so a ROUTE can import the wording without
  dragging the manual-push machinery (`runPool`, `resolverAnchors`,
  `fetchPrecoFamiliasByIds`) into a bundle that only wants a string. Its test
  walks this folder AND the `atualizar-precos` route folder, so every code any
  of them emits must have a message.
- `mlPriceSyncTasks.ts` — the task-queue scheduler for the bulk job.

⚠️ **The backend owns the operator-facing wording**, and `precoMotivos.ts` is
where it lives. Each route returns a pt-BR `mensagem` per listing and the caller
passes it through verbatim; a second copy of the skip vocabulary would drift from
the gates it describes. A persisted report row therefore stores the `motivo` CODE
only and renders the message at read time, so fixing a message here applies
retroactively to runs already recorded.
