# preco — pricing

Pushing ERP prices onto ML listings, as a bulk job or a hand-picked push. The
shape mirrors `estoque/` closely; the two share
`estoque/bulkEstoquePlan.ts` for family discovery and, since #1200,
`anuncios/linksNaoEnumerados.ts` for the link-side walk that names what that
discovery cannot reach.

- `precoPlan.ts` — the compute core: keyset page discovery of linked families.
  ⚠️ Its anchor terms are bound to the link walk's classifier: the
  `fetchPrecoPage ⇔ classificarLinkNaoEnumerado` describe in `precoPlan.test.ts`
  seeds the same 24-document matrix and runs `fetchPrecoPage` itself over it
  (the suite's fake evaluates the query's own clauses), so a term added here
  reds until `anuncios/linksNaoEnumerados.ts` moves with it.
- `precoDraftSend.ts` — the per-listing sender holding the eight-gate ladder,
  shared by the bulk job and the manual push. **No direct test sibling** —
  exercised through `precoSync.test.ts`.
- `precoSync.ts` — the "Atualizar preços" bulk job core. Manual-only by design.
- `precoReconciliacao.ts` — the links-side phase, reporting what the plan could
  not enumerate. ⚠️ **Since #1200 the walk and the classifier are not here**:
  they live in `anuncios/linksNaoEnumerados.ts`, shared with the monthly stock
  audit (`estoque/auditoriaNaoEnumerados.ts`), because both sweeps open with
  the same two anchor terms. This file keeps only what is price-shaped — the
  `MERCADO_LIVRE_PRECO_RECONCILIACAO_ENABLED` flag, the page-size env tunable
  (`fetchPrecoReconPage` defaults the shared walk's REQUIRED `pageLimit` to
  `precoReconPageLimit()` — the walk reads no env), the page cap and the
  job-facing types — and re-exports
  `classificarLinkNaoEnumerado`. `precoReconciliacao.test.ts` was kept
  byte-unchanged by the move: it is the regression proof that the walk still
  behaves the same through this binding. Class 2 (a produto missing the conta)
  is still REPORTED here, but the stock audit now heals it monthly — one array
  serves both sweeps.
- `precoManual.ts` — "enviar preço agora" for a hand-picked produto set.
- `precoMotivos.ts` — the price vocabulary (`MENSAGEM_POR_MOTIVO` + `mensagemDe`),
  extracted from `precoManual.ts` so a ROUTE can import the wording without
  dragging the manual-push machinery (`runPool`, `resolverAnchors`,
  `fetchPrecoFamiliasByIds`) into a bundle that only wants a string. Its test
  walks this folder, the `atualizar-precos` route folder AND one FILE outside
  both — `anuncios/linksNaoEnumerados.ts`, which emits the four
  `NAO_ENUMERADO_*` codes — so every code any of them emits must have a
  message. ⚠️ That file root is load-bearing by PATH: moving or renaming the
  walk makes the scan throw `ENOENT` rather than silently drop the four codes.
- `mlPriceSyncTasks.ts` — the task-queue scheduler for the bulk job.

⚠️ **The backend owns the operator-facing wording**, and `precoMotivos.ts` is
where it lives. Each route returns a pt-BR `mensagem` per listing and the caller
passes it through verbatim; a second copy of the skip vocabulary would drift from
the gates it describes. A persisted report row therefore stores the `motivo` CODE
only and renders the message at read time, so fixing a message here applies
retroactively to runs already recorded.
