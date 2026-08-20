# apps/functions — CLAUDE.md

Guidance for Claude Code when working in the `@delfrance/functions` package
(the gen2 Cloud Functions, codebase `storage`). The root `CLAUDE.md` still
applies — this file adds what is specific to deploying and building functions.

## What this is

gen2 (2nd-gen / Eventarc) Cloud Functions. Twenty-eight exports:

- **`resizeProductImage`** (`onObjectFinalized`) — runs on every non-derivative
  finalize. (1) **Upload confirmed**: flips the owning `arquivos` doc's
  `uploadState` to `'finalized'` (`src/arquivos/markUploadFinalized.ts`) — the
  authoritative "the bytes arrived" signal, for images, videos AND generic media.
  (2) **Resize**: for a fresh product-image original (`src/product-images/guards.ts`:
  `produtos/<produtoId>/originals/<hash>.<ext>`, `image/*`, no `resized=true`
  loop-guard marker) generates the **200px / 400px / full-JPEG** derivatives + docs.
- **`reconcileProductImages`** (`onSchedule`, every 48h) — backfills derivatives for
  originals the trigger never finished (issue #189). Uploads are content-addressed
  and deduped, so a re-upload won't re-fire the trigger; instead, the client stamps
  each original's `arquivos` doc `resizeState: 'pending'`, the resize flips it to
  `'done'`, and the sweep queries ONLY `where resizeState == 'pending'` — a filtered
  query (O(missing)), never a full catalog scan. Both share the idempotent
  `processProductOriginal` (`src/product-images/processOriginal.ts`), which writes
  only missing derivatives and skips the download when complete.
- **`onArquivoDeleted`** (`onDocumentDeleted('arquivos/{id}')`) — doc-anchored
  Storage cleanup: deleting an `arquivos` doc deletes the object it owned; for a
  product-image original it cascades to the 3 derivative objects + docs. Core logic
  in `processArquivoDeletion` (exported for the emulator suite); a dedup-resurrection
  guard skips the delete if a doc with the same content-addressed id exists again.
  Pairs with the **create-first** upload contract in `@delfrance/storage`: the doc
  is written BEFORE the bytes (so a dead upload leaves a `uploadState: 'pending'`
  phantom, not an orphan object) and the object carries its `arquivoId` in custom
  metadata. ⚠️ Like every Firestore access here, the trigger targets the **named
  `default`** database (`database: FIREBASE_DATABASE_ID ?? 'default'`) — see
  gotcha #8; a trigger that omits `database` binds to `(default)` and never fires.
- **`onProdutoMediaChanged`** (`onDocumentUpdated('produtos/{id}')`) — the eager
  produto-**edit** reaper (sibling of the planned produto-**delete** #136). Diffs the
  edit's `before`/`after` `fotos` + `videos` + `anexos` arrays by `arquivoOuterRef`; a ref
  that disappeared → stamp `markedForDeletionAt: now` on that `arquivos` doc; a re-added ref
  → clear it (`null`). The mark is a **signal only** — `sweepMarkedForDeletion` does the
  delete after a short grace + owner re-verify, so a buggy/bulk save that drops `fotos`
  can only mark (reversibly), never instantly destroy photos. Core
  `reconcileProdutoMediaMarks` (exported for the emulator suite); one batched `getAll` +
  `WriteBatch`, touching only existing `arquivos` docs (already-swept ref → no-op, no
  resurrected phantom). Writes never touch `produtos` → no self-retrigger. Plain admin
  writes (no pipeline) → fully emulator-testable. All three media kinds are product-scoped
  (`produtos/<id>/originals|videos|anexos`). Targets the named `default` database (gotcha #8).
- **`reconcileArquivoOrphans`** (`onSchedule`, every 48h) — orphan cleanup, **three**
  bounded passes (ADR 0010 Phase 2), all **oldest-first** and excluding the grace
  window **in the query**. **Marked sweep** (`sweepMarkedForDeletion`, runs first —
  cheapest): `arquivos where markedForDeletionAt<cutoff orderBy markedForDeletionAt asc`
  (single-field index `arquivos(markedForDeletionAt)`, short grace
  `ARQUIVO_MARKED_GRACE_HOURS` default 1h) — deletes what `onProdutoMediaChanged`
  flagged, re-verifying via `resolveReferencedArquivoRefs` that the owner produto still
  doesn't reference it (a missed unmark clears the mark instead). Plain query, no
  pipeline → emulator-testable. **Phantom-doc sweep** (`sweepPhantomDocs`):
  `arquivos where uploadState=='pending' AND criadoEm<cutoff orderBy criadoEm asc`
  (composite index `arquivos(uploadState, criadoEm)`) whose object never arrived →
  delete the doc (or self-heal to `'finalized'` if the object IS present).
  **Unreferenced sweep** (`sweepUnreferencedArquivos`, the **backstop** for what the
  eager mark missed): product media (`produtos/<id>/originals|videos|anexos`) past
  the grace window that **no produto references** → delete (then `onArquivoDeleted` frees
  the object + cascades any derivatives) — a produto deleted entirely (until #136), a console
  edit, or a dropped trigger delivery. **Round-robin paging (#234)**: candidates come
  from `fetchArquivoPage`, a **classic** `orderBy(FieldPath.documentId())` query
  (Firestore's always-available native ordering, no declared index) paginated with
  `startAfter(lastKey)` — no pipeline, no server-side age/ownership filter. The
  grace-window (`criadoEm<cutoff`) and owner-media (`parseOwnedMediaDir`) scoping
  happen on the fetched page, in code. The last key reached is persisted to
  `arquivoOrphanSweepState/cursor` (admin-only, not in `ALL_DOMAINS`); the next tick's
  page starts right after it, and a page shorter than `BATCH_LIMIT` (end of the
  collection in key order) wraps the cursor back to `null`. This guarantees every
  arquivo is examined within `ceil(total / BATCH_LIMIT)` ticks regardless of orphan
  density — fixing the old oldest-`criadoEm`-first scan's liveness gap (a large head
  of long-lived referenced photos could starve newer orphans out of the window
  forever). The reference check is still an **owner-document lookup**, NOT a
  collection scan: a product arquivo encodes its owner `produtoId` in its storage
  path, so `resolveReferencedArquivoRefs` reads ONLY the produtos owning the candidate
  batch (one batched `getAll`, field-masked to `fotos`/`videos`/`anexos`) —
  O(distinct produtos), never O(all produtos). Both the page fetch and the owner
  lookup are **seams** (`fetchPage` / `resolveReferenced`) the emulator suite can
  override, though neither needs a pipeline anymore — the default page fetch runs in
  the emulator too. Grace is `ARQUIVO_ORPHAN_GRACE_HOURS` (0 in tests); `criadoEm` is
  microseconds-since-epoch (schema default `nowMicros()`).
  ⚠️ **Index requirement**: this Enterprise edition creates NO index automatically
  — the two remaining sweep indexes (`arquivos(uploadState, criadoEm)` +
  `arquivos(markedForDeletionAt)`) are declared in `firestore.indexes.json` and must
  be deployed (`firebase deploy --only firestore:indexes`); verify usage live with
  `scripts/check-sweep-indexes.mjs` (`explain({ analyze: true })`). The unreferenced
  sweep's own scan needs no index (document-key ordering is native), so it is
  deliberately NOT covered by that script.

- **`onProdutoDeleted`** (`onDocumentDeleted('produtos/{produtoId}')`) — the
  authoritative produto delete cascade (#226/#136/#199), core
  `cascadeProdutoDeletion(db, produtoId)` (exported for the emulator suite). On a
  produto delete (parent OR variation child) it does two things: **(1) #136** —
  one `deleteDocumentSubtree` over the produto's OWN document ref, deleting the
  (already-gone) doc **plus its entire descendant subtree** — all 14
  subcollections Firestore would orphan (`estoques` + the nested
  `historicoEstoque`, `imposto`, `extraData`, `historicoDePrecos`,
  `historicoDeCusto`, `historicoDeModificacoes`, and the seven marketplace links
  `produtoMercadoLivre` / `variacaoMercadoLivre` / `prodshopee` / `variashopee` /
  `produtoMagalu2` / `prodAmazon` / `produtolojaintegrada`), no name enumeration,
  new subcollections swept automatically; **(2) #199** — variation children are
  SIBLING top-level docs (`produtos where paiId == id`), not descendants, so a
  per-child subtree walk deletes each child + its subtree directly. The child
  delete re-fires this trigger; the trigger passes the deleted doc's own `paiId`
  (already in the event, no extra read) so that re-entry **skips the children
  query** — variations are one level deep, so it could never find anything. The
  client `deleteProdutoCascade` now deletes ONLY the parent doc (the
  inbound-reference guard stays client-side); this trigger is the sole cascade,
  with no dependency on the client/e2e cleanup. Idempotent — Eventarc delivers
  at least once, so never assume a first run.
- **`onEstoqueDeleted`** (`onDocumentDeleted('produtos/{produtoId}/estoques/{estoqueId}')`)
  — sweeps a single estoque's `historicoEstoque`, core `cascadeEstoqueDeletion`
  (exported for the emulator suite — the test used to re-implement the sweep
  inline and import nothing, so it asserted nothing about shipped code).
  Covers a standalone estoque delete; the produto-wide cascade already deletes
  history directly, so its re-fires of this trigger are idempotent no-ops.
- **`onOperacaoDeleted`** (`onDocumentDeleted('operacao/{operacaoId}')`) — sweeps
  an operação's `regras` subcollection, core `cascadeOperacaoDeletion` (exported
  for the emulator suite). Retires the client-side batched cascade
  `deleteOperacaoCascade` used to run from `apps/web/lib/operacoes/clientPort.ts`
  (#354); the two `/operacoes` pages now `deleteDoc` the parent only.
- **`onCategoriaDeleted`** (`onDocumentDeleted('categorias/{categoriaId}')`) —
  sweeps a categoria's `imposto` subcollection (the legacy Dart getter was named
  `impostocategoria`; the Firestore collection id is `imposto`), core
  `cascadeCategoriaDeletion` (exported for the emulator suite). Categoria had NO
  client-side cascade at all before this (#354) — a plain `deleteDoc` left
  `imposto` permanently orphaned.
- **`onBalancoDeleted`** (`onDocumentDeleted('balanco/{balancoId}')`) — sweeps a
  balanço's `movimentos` + `relatorios` subcollections, core
  `cascadeBalancoDeletion` (exported for the emulator suite). Unlike the other
  cascades this one is not merely a convenience: `relatorioBalancoMeta` is
  `serverOwned`, so the client is *denied* the writes its own delete cascade
  would need — deleting a balanço from the UI can only remove the parent doc, and
  without this trigger every finalize report would be orphaned permanently.
- **`onIntegracaoDeleted`** / **`onIntFreteDeleted`** / **`onMetodoPagamentoDeleted`**
  (`onDocumentDeleted`) — three credential-store cascades built from ONE factory,
  `defineCascadeCaroGenerico` (`src/lib/cascadeCaroGenerico.ts`), registered in
  `src/cascades/caroGenericoTriggers.ts`. Core `cascadeCaroGenerico(db, path, id)`
  (exported for the emulator suite) is a single `deleteDocumentSubtree` call.
  Before these, deleting a channel account / freight integration / payment method
  left a live OAuth `refresh_token` readable behind it — `metodo_pgto/{id}/credenciais`
  is default-deny for clients, so nothing but a trigger could ever reclaim it.
  **"Caro" is the warning label, not a joke**: the walk calls `listCollections()`
  on every document it reaches, leaves included, so the toll scales with subtree
  SIZE. It is noise on a two-document credential subtree deleted a few times a
  month, and the wrong tool on a hot delete path or a wide subtree — write a
  targeted kinded sweep there instead. The walk is discovery-driven on purpose:
  it reclaims `integracao/{id}/brandshopee`, which `integracaoMeta.cascade`
  never declared.
- ⚠️ **`pedidos` and `clientes` declare a cascade and deliberately have NO
  trigger** (owner call, 2026-08) — both carry fiscal data an emitted NF-e still
  depends on (`pedidos/{id}/nfev4`; and a cliente's endereço, which the NF-e
  orchestrator reads LIVE by ref rather than from a snapshot). They orphan on
  purpose; the reasoning is recorded at each `cascade:` declaration in
  `packages/schemas`. `chat/{conversaId}/mensagem` is deferred to its own issue.
- ⚠️ **None of the nine cascades may use `db.recursiveDelete` (#728).** It
  issues a kindless all-descendants query — `COLLECTION_GROUP * SELECT __name__
  LIMIT 5000` — which this Enterprise edition cannot index and cannot be *given*
  an index for: there is no wildcard index and no field predicate to seek on, so
  the console's "create index" button opens a blank form. It full-scans silently
  (nothing throws) and Enterprise bills data scanned: **~6,184 documents per
  call, 9,234 calls in 7 days = 93% of the staging project's read volume**, at
  the same price whether the produto had fifty subcollection docs or none. The
  replacement is `deleteDocumentSubtree` from `@delfrance/data/admin`, which
  asks `listCollections()` (~5 read units) and then runs one kinded, key-bounded
  keys-only query per subcollection that actually exists. **Do not swap it back
  for a schema-derived name list either** — Flutter writes subcollections
  `ALL_DOMAINS` does not register (`variacoesml` is the one the emulator suite
  pins), so a registry walk orphans them silently. Verify live with
  `scripts/check-delete-cost.mjs`.
- **`recalcularDimensoesKit`** (`onTaskDispatched`, `src/produtos/kitRollup.ts`)
  — recomputes a **kit's** stored `pesoBrutoKg`/`pesoLiquidoKg`/`alturaCm`/
  `larguraCm`/`profundidadeCm` when one of its COMPONENTS changes (#1152). The
  rollup used to run only in the browser (`KitManager`), so editing a component
  left every kit containing it stale forever — and `pesoPedido` reads the kit's
  **stored** weight (legacy parity, #1093), so that stale number becomes a wrong
  freight quote and then a carrier re-billing. `onProdutoChanged` gates on a raw
  before/after diff of those five fields and does **one enqueue, zero reads**;
  this worker does the fan-out.
  ⚠️ **A queue, not inline trigger work, because the fan-out is `O(kits
  containing the component)` — ADR 0014 measured ~2 000** for the printed-shirt
  catalogue where every kit shares the same blank shirt + print. That ADR
  *rejected* this exact fan-out for **stock**; the difference is frequency (a
  sale vs. a rare operator edit), and the ADR now carries the note. Paged with a
  `FieldPath.documentId()` cursor over
  `componentesKitKeys array-contains-any <=30 seeds>`, projected with `.select()`
  because Enterprise bills data scanned, and self-continuing through the
  scheduler seam (`kitRollupTasks.ts`, the `balancoTasks.ts` shape).
  ⚠️ **Two races, two ADR 0011 tiers, both named in the code.** *Superseded
  input* is **tier 2** with the five VALUES as the clock: every dispatch re-reads
  the root produto and drops the task when they no longer match the payload —
  deliberately not `updateTime`/`ultimaModificacao`, which also advance on an
  unrelated edit and would drop a task no successor replaces. *A concurrent
  writer on a kit* is **tier 1**: `update(..., { lastUpdateTime })`, with the
  `FAILED_PRECONDITION` losers re-read and retried exactly once.
  ⚠️ **Do NOT give the task a deterministic Cloud Tasks name for dedup** — a name
  cannot be reused for ~1h after the previous task with it completed, so an
  A → B → A edit inside that hour would have the third enqueue silently rejected
  and the rollup lost.
  ⚠️ **Do NOT reach for `@delfrance/data/admin/cache` here.** A process-scoped TTL
  cache would serve a warm instance the component's PRE-EDIT weight and persist
  it onto every kit — the very bug this function fixes. The reads are memoized
  per DISPATCH instead (zero staleness bound), and each distinct component set is
  computed once, which is where the win actually is.
  Both weight and box come from `dimensoesDoKit`
  (`packages/schemas/src/produto/pureLogic/dimensoesKit.ts`) — **the same
  function `KitManager` calls**, so the two directions cannot drift. The box half
  reuses the pedido estimator with `fatorOcupacao: 1`; the pedido level applies
  the 0.7 packing allowance, and applying it twice would declare ~2x the volume.
  A `null` result means "not derivable" and is never written.
  New infrastructure: its own Cloud Tasks queue (created by the deploy),
  `KIT_ROLLUP_TASKS_REGION` / `KIT_ROLLUP_TASKS_DISABLED`, and the
  `produtos(componentesKitKeys CONTAINS, __name__ ASC)` index for the paged
  query. `ci-storage.yml` sets `KIT_ROLLUP_TASKS_DISABLED=1` — there is no Cloud
  Tasks emulator and the live trigger fires on every produto write in that lane.
- **`onPedidoChanged`** (`onDocumentWrittenWithAuthContext('pedidos/{pedidoId}')`)
  — the SOLE writer of BOTH pedido audit trails: the order state
  (`pedidos/{pedidoId}/historicoEstadoPedido`) and the freight state
  (`pedidos/{pedidoId}/historicoFtIni`, tracking the EMBEDDED
  `freteInicial.estado` — no separate document to observe, which is exactly why
  it rides this trigger instead of its own). Replaces three hand-written
  appends at the call sites (the web editor, the client pagamento reconcile, the
  Mercado Pago admin reconcile) which together covered only 3 of the ~12 paths
  that change `estado` — every Mercado Livre writer and every creation path wrote
  no row at all. Observing the document instead of the call site makes coverage
  total: any writer, from anywhere, now produces a row, and
  `historicoEstadoPedidoMeta.serverOwned` denies client writes so the trail cannot
  be forged or erased (no `su` bypass). Records the opening `estado` on create and
  one row per transition after that — **per trail**, so ONE pedido write records up
  to TWO rows, one for each estado that actually moved (a Frete tab save typically
  moves only the freight one). A pedido with no `freteInicial` block never produces
  a frete row at all, and a delete or a write that left BOTH estados alone exits on
  the fast path with no reads/writes. Idempotent: each row's doc id IS
  `event.id`, so an at-least-once redelivery **overwrites its own row** instead
  of appending a duplicate — the two rows of one event share that id harmlessly,
  they live in different subcollections. `data` comes from `event.time` (never
  `Date.now()`) so the rewrite is normally content-identical too; the one
  exception is the `nowMillis()` fallback for an unparseable `event.time`, which
  can re-date a retried row but still cannot double-write it. ⚠️ The trails do NOT share a
  time unit: `data` is microseconds on `historicoEstadoPedido` and **milliseconds**
  on `historicoFtIni` (the unit the legacy Flutter ODM writes — `maybeDateTimeToJson`
  is `millisecondsSinceEpoch`), so a row-builder copied across is off by 1000×.
  **The repo's first `WithAuthContext`
  trigger** — `resolveUsuarioOuterRef` maps `event.authId` to
  `documents/usuarios/<uid>`, but only when it is uid-shaped: `authType` has no
  `user` literal (client-SDK writes arrive as `api_key`, console writes as
  `unknown` carrying an EMAIL), so anything not uid-shaped stores `null` rather
  than a wrong actor. Admin-SDK writes (webhooks, ML import) correctly record
  `null`. ⚠️ The actor CANNOT be verified in the emulator — it hardcodes `authId`
  to `fake-auth-id@gmail.com` (firebase-tools#7609, closed as not-planned); the
  emulator suite covers the write/idempotency and the resolver is unit-tested.
  No self-retrigger (the write lands in a subcollection). Targets the named
  `default` database (gotcha #8).
- **`onPagamentoChanged`** / **`onIncidenteChanged`**
  (`onDocumentWrittenWithAuthContext`, both built from
  `makeModificationHistoryTrigger`) — the two covered subcollections of the
  pedido modification history. The pedido DOCUMENT's own entry rides
  `onPedidoChanged` above rather than getting a fourth trigger: that
  function already observes every pedido write, so a separate one would double
  the event cost to record the same thing.
  ⚠️ **All three write ONE collection**, `pedidos/{id}/historicoDeModificacoes`,
  with child rows tagged `subcolecao: 'pagamentos' | 'incidentes'` — the same
  shape produto uses for `extraData`/`imposto`. That is what makes a pedido's
  edit history one chronological feed, and it supersedes the legacy Flutter
  `histpgto` (which recorded only `status_pagamento`, and only on saves made
  through one Dart method).
  ⚠️ **A pedido DELETE writes a tombstone, where produto returns early.** The
  difference is caused, not chosen: `onProdutoDeleted` sweeps a produto's
  subtree so the row would be swept or orphaned anyway, while `pedidos`
  deliberately has NO delete trigger — nothing sweeps here, so the row survives
  and is then the only record that the order existed and who removed it. For the
  same reason `requireParentExists` is left **OFF** on both subdoc sources: it
  would drop a pagamento delete arriving after its pedido is gone, i.e. exactly
  the event that most needs auditing.
  ⚠️ `PEDIDO_HISTORY_IGNORE_FIELDS` **imports** `CAMPOS_ESTOQUE_SYNC` rather
  than retyping it — `sincronizarEstoquePedido` writes those three fields back
  seconds after the save that caused them and does not stamp
  `ultimaModificacao`, so omitting any of them means every stock-moving save
  leaves a second, "Sistema"-attributed phantom row (#972's failure, one trail
  later).
  ⚠️ **TTL is not available on this collection** (#651): a Firestore TTL policy
  needs a native `timestamp`-typed field, and `historicoModificacaoSchema.timestamp`
  is an **int** (`microsSinceEpoch`). Retention needs a sweep, not a policy.
- ⚠️ **The whole modification-history family uses
  `onDocumentWrittenWithAuthContext`**, including the three produto triggers,
  which were plain `onDocumentWritten` before. `resolveUsuarioOuterRef`
  (`src/lib/authContext.ts`) is shared by it and the pedido estado trails. That
  variant registers a **different Eventarc event type**
  (`…document.v1.written.withAuthContext`), so a redeploy of an existing
  function may need a delete + redeploy — see gotcha #7 — with a short window in
  which those writes record no history.
- ⚠️⚠️ **`onPedidoEstadoChanged` was RENAMED to `onPedidoChanged`** (the file is
  now `pedidos/registrarHistoricoPedido.ts`) because it stopped being an
  estado-only recorder — it writes all three pedido trails. The export key IS the
  deployed function name, so this is a NEW function to Firebase and the old one
  is **not** replaced by the deploy. It must be deleted explicitly, or it lingers
  and keeps writing the estado/frete trails from its stale code:
  ```bash
  firebase functions:delete onPedidoEstadoChanged --region us-east1 --project <id> --force
  ```
  Both rows are keyed on `event.id`, so while both exist the duplicate estado /
  frete writes are content-identical and harmless — the zombie is a cost and
  clarity problem, not a correctness one. Deleting cloud functions is a
  destructive shared-infra action: **ask the user to run it.**
- **`aplicarEstoque`** (`onCall` — the repo's FIRST HTTPS callable) — server-owned
  estoque write path for the web client (replaces the direct client `writeBatch`
  from PR #217). Enforces auth + `PERM.estoque.write` itself (the `su` super-user
  claim short-circuits, like the rules) since the Admin SDK bypasses Firestore
  rules; the ruleset stays OPEN on `estoques` (ADR 0010). ⚠️ That was justified by
  a dual run which does not exist (root `CLAUDE.md` rule 8) — tightening it to
  `serverOwned` is an open question, not a settled design. Split per op into
  the exported (no-auth) `aplicarLocalizacao` / `aplicarMovimento` cores the
  emulator suite drives directly. **Movements** (#387, the old Flutter backend's
  transform design): ONE atomic **read-free WriteBatch** — the merge-set is the
  getOrCreate, entrada/saída deltas are server-side `FieldValue.increment`s,
  `quantidadeReservada` is floored at 0 by a follow-up `FieldValue.maximum(0)`
  write on the SAME doc (a batch's writes apply in order), `ultimaModificacao` is
  monotonic via `maximum(now)`, and `dataCriacao` uses `minimum(now)` (set-if-
  missing); balanço writes the absolute counted values with the reservada clamped
  in code. Server-owned arithmetic also self-heals stored non-numbers (transforms
  SET the operand). ⚠️ `FieldValue.maximum`/`minimum` exist only on firebase-admin
  14 / `@google-cloud/firestore` ≥ 8.6.0 (absent in v7) — one more reason this
  package stays on admin 14. `aplicarMovimento` reuses `planMovimentacao`
  (`@delfrance/data/produto`); `aplicarLocalizacao` keeps its small read-transaction
  and updates ONLY `localizacao` on an existing estoque (quantities are
  movement-owned; no `ultimaModificacao` bump on an existing doc — but the
  first-touch create still initializes `ultimaModificacao: now` like every other
  create path). ⚠️ On the app's critical path: the staging estoque tab + the estoque
  Playwright e2e only work once this is DEPLOYED — see the Deploying section in `apps/functions/CLAUDE.md`.
- **`reconciliarPagamentoPedido`** (`onCall`) — server-owned pedido `estado`
  reconcile for the web client (#308). The client SDK can't read a query inside
  `runTransaction`, so summing a pedido's pagamentos client-side before the tx
  let two concurrent reconciles (different tabs/sessions) settle on a stale
  estado. Delegates to the Admin-SDK `reconcilePedidoEstado`
  (`@delfrance/data/admin`), which reads the pedido AND every pagamento in ONE
  transaction. Same auth model as `aplicarEstoque`: `PERM.pedido.write` (or
  `su`), Zod-validated `{ pedidoId }`. ⚠️ On the app's critical path: the
  Pagamentos tab's `reconcileEstado()` calls this callable, so the pedido
  estado auto-transition only works once this is DEPLOYED — see the Deploying section in `apps/functions/CLAUDE.md`.
- **`finalizarBalanco`** (`onCall`) + **`processarBalanco`** (`onTaskDispatched`)
  — the server-owned stock-apply half of the balanço feature (#458), replacing a
  legacy Flutter finalize that wrote client-supplied quantities straight to
  `estoques` with no server validation. The payload is only
  `{ balancoId, zerarNaoContados }`: **every** quantity, plus `motivo`, `tipo`
  and `usuarioOuterRef`, is derived server-side from the balanço's own
  `movimentos` and its server-owned fields. The callable enforces
  `PERM.estoque.write` (with the `su` short-circuit) and takes the workflow lock
  in ONE transaction — the lock is unforgeable because both fields it tests
  (`estado`, `dataFinalizado`) are in `balancoMeta.serverOwnedFields`, so a
  double-finalize fails `failed-precondition` rather than re-applying. The worker
  then runs two phases: (A) aggregate the movimentos into deterministic
  `relatorios` shards, (B) apply each shard in 100-produto transactions. ⚠️ It is
  **resumable, not atomic** — Cloud Tasks redelivery and the 540s timeout are
  both normal, so idempotency is per-produto via a deterministic
  `historicoEstoque` doc id (`balanco-<balancoId>`): a produto whose marker
  already exists is skipped, which is what stops a retry recomputing
  `contado − atual` against a value the first run already moved. Reuses
  `planMovimentacao` + `movimentoEstoqueWrite` (both exported from
  `aplicarEstoque.ts`) so the balanço and manual-editor paths cannot drift on the
  reservada clamp or the `maximum(now)` stamp. ⚠️ The phase-A aggregate is a
  **Pipelines** query gated on `FIRESTORE_EMULATOR_HOST`, not on a caught error:
  the emulator is Standard edition and rejects pipelines while still exposing
  `db.pipeline()`, so probing for support answers yes and then fails at
  execution. ⚠️ `processarBalanco`'s export name **is** its Cloud Tasks queue name
  (`BALANCO_QUEUE` in `balancoTasks.ts`) — rename both together, and note the
  queue is NEW infrastructure the deploy has to create.
- ⚠️ Every trigger and callable above is a **second writer** on a document the
  web client, another handler, or a retry of this very trigger may be writing at
  the same instant — pick a tier from root `CLAUDE.md` Critical rule 7 and record
  which one at the call site (ADR 0011). `aplicarEstoque` is the tier-0
  reference (commutative/monotonic transforms, nothing to compare);
  `reconcilePedidoFromPagamento` is the tier-2 one (watermark compare inside the
  transaction).
- ⚠️ Every trigger and callable above targets the NAMED `default` database
  (gotcha #8). `@delfrance/auth` is a build-time dep (esbuild-bundled, like
  data/schemas) for `hasPerm`/`PERM`.

- The entry (`src/index.ts`) is **esbuild-bundled into a single ESM file**.
  Only `firebase-admin`, `firebase-functions`, `@google-cloud/firestore` (the
  orphan sweep imports pipeline builders from `@google-cloud/firestore/pipelines`),
  and `sharp` are `external`; everything else (incl. `@delfrance/data`,
  `@delfrance/schemas`) is inlined.
- The function **region is inlined at build time** (`build.mjs`, esbuild
  `define`), defaulting to `us-east1` — the Storage bucket region the gen2
  trigger must match. It is **never** read from `.env.local` (secrets). Override
  for another env via the `FUNCTIONS_REGION` env var only.

## Testing

- **CI**: `ci-storage.yml` runs the emulator suite (`firebase.functions.json`,
  Storage+Firestore emulators on 8080/9199) via `firebase emulators:exec … "pnpm
  --filter @delfrance/functions test:storage"`. This is the authority — it does
  **not** hit a real Firebase project.
- **Local**: `pnpm --filter @delfrance/functions test` (unit; `guards.ts` is pure
  and exhaustively tested) and `typecheck`.

## Deploying (manual & coordinated)

One command, from the checkout that carries `firebase.functions.deploy.json`, ASK USER FOR PERMISSION BEFORE RUNNING IT:

```bash
firebase deploy --only functions:storage \
  --config firebase.functions.deploy.json --project <project-id> --force
```

The `predeploy` hook regenerates the deploy artifact at **`<repo-root>/.deploy/functions`**
via `scripts/prepare-deploy.mjs`; `source` points there. **Do NOT deploy the
`apps/functions` directory directly** (see gotcha #3). Full lane + the 5-step
post-deploy photo verification live in `DEPLOY.md`.

## Deploy gotchas (hard-won — first successful deploy 2026-06-17)

Every one of these blocked the first real deploy. Read before touching the
deploy config or `prepare-deploy.mjs`.

1. **`dist/index.js does not exist`** — the bundle is git-ignored, so it only
   exists after a build. Fix: the `predeploy` hook builds the artifact every
   time; the build can't be skipped.

2. **Never read `.env.local` during deploy** (it holds secrets). The only
   build-time value is the region, a non-secret constant — `build.mjs` defaults
   it to `us-east1`. Do not reintroduce a `dotenv -e .env.local` predeploy.

3. **Cloud `npm install` cannot resolve pnpm `workspace:*`**
   (`EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`). The gen2
   buildpack's install also **parses `devDependencies` specs even with
   `--omit=dev`** — verified — so merely moving the workspace deps to
   `devDependencies` does NOT help, and an `.npmrc` `omit=dev` would not either.
   Fix: deploy a **generated, minimal `package.json`** carrying only the 4 real
   runtime `dependencies` (firebase-admin / firebase-functions /
   @google-cloud/firestore / sharp) — no `devDependencies`, no `workspace:*`, no
   build script. esbuild already bundled data/schemas, so the cloud needs
   nothing else. This is why `source` is a generated folder, not `apps/functions`.
   ⚠️ **That artifact carries no lockfile**, so the cloud install resolves each
   spec fresh and a `^` range installs whatever is newest *at deploy time* — a
   version no CI lane ever tested. `firebase-admin` + `firebase-functions` are
   therefore pinned **exact** (`14.2.0` / `7.3.2`); `firebase-functions@7.3.2`
   moved `express` 4→5 in a **patch** release, which under the old `^7.3.0` ran
   Express 5 in production against CI on Express 4. Bump them together with
   `pnpm-workspace.yaml`'s catalog and the four nested artifact manifests —
   `packages/config-eslint/rules/runtime-deps-pinned.test.js` fails on drift.
   (`@google-cloud/firestore` and `sharp` still float; a known carve-out.)

4. **`Failed to find location of Firebase Functions SDK`** — firebase-tools'
   *local* trigger analysis locates AND spawns the SDK from
   `<source>/node_modules/.bin/firebase-functions` and **does not walk up** to a
   parent `node_modules` (see `findFunctionsBinary` in firebase-tools
   `…/runtimes/node/index.js`, which checks only 4 fixed dirs). Fix:
   `prepare-deploy.mjs` junctions the workspace's `node_modules` into the
   artifact; `ignore: ["node_modules"]` keeps the junction OUT of the upload, so
   the cloud still reinstalls just the 4 deps.

5. **The junction's directory depth matters** — pnpm's symlinks inside
   `node_modules` are **relative**. The artifact MUST sit at the **same depth as
   `apps/functions`**, which is why it is `<repo-root>/.deploy/functions` and NOT
   `apps/functions/.deploy`. One level too deep makes the relative symlinks
   overshoot → `Cannot find module …/firebase-functions/lib/bin/firebase-functions.js`
   when the spawned SDK loads. (`.deploy` is not matched by the `pnpm-workspace`
   globs, so it is never treated as a workspace package.)

6. **Norton TLS interception (local machine only)** — running `firebase`/`npm`
   from a shell that does not trust Norton's MITM root fails with
   `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `Failed to make request to
   cloudresourcemanager.googleapis.com`. Fix: prefix the command with
   `NODE_EXTRA_CA_CERTS=<path>/norton-root.pem` (the user's own terminal already
   trusts it). This is also why the artifact uses a `node_modules` **junction**
   rather than a fresh `npm install` — a local registry install hits the same
   Norton TLS wall.

7. **`Changing from an HTTPS function to a background triggered function is not
   allowed`** — if a function with the same name already exists with a different
   trigger type (e.g. a leftover HTTPS stub from an earlier attempt), Firebase
   won't switch it in place. Delete it first, then redeploy:
   `firebase functions:delete resizeProductImage --region us-east1 --project <id> --force`.
   (Deleting deployed cloud functions is a destructive shared-infra action — the
   agent is correctly blocked from doing it; ask the user to run the delete.)

8. **gRPC `5 NOT_FOUND` at runtime on a Firestore `.get()`/write** — this project family uses the
   **named `default`** Firestore database (Firestore *Enterprise* edition: the database is
   literally named `default`, NOT `(default)`). `getDb()` (`src/lib/admin.ts`) defaults the id to
   `'default'`, overridable via `FIREBASE_DATABASE_ID` — never call `getFirestore()` without the
   id, or it targets the non-existent `(default)` database and every operation fails with
   `5 NOT_FOUND`. The emulator suite must read the same id (see the storage test's `getDb`). The
   convention is repo-wide (apps/web, apps/integrations, apps/nfe, tools/test-fixtures,
   `.env.example`).

## Build notes

- `build.mjs` exports `bundle(outfile)` and resolves paths from `import.meta.url`,
  so it runs from any cwd. Running it directly (`node build.mjs` /
  `pnpm --filter @delfrance/functions build`) writes `dist/index.js` for **local
  inspection only** — the deploy uses `.deploy/functions`, not `dist/`.
- Keep `firebase.functions.json` (the emulator config) separate from
  `firebase.functions.deploy.json` (the deploy config) — the former must never be
  pointed at `firebase deploy`.
