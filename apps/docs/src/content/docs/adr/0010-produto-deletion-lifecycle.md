---
title: 0010 — Produto deletion lifecycle (orphan cleanup + reference cascade)
description: How deleting a produto (or its variation children) cleans up subcollections, storage objects, and inbound references — server-side, in apps/functions.
---

## Context

When the Next app deletes a produto — a variation child via the Variações-tab
flush (the `flushStagedChildren` closure in
`apps/web/app/(app)/produtos/_components/VariationManager.tsx`) or a parent via
the editor's Excluir — it deletes **only the doc**. Three classes of debris are left behind,
each tracked by its own issue:

1. **Subcollection orphans (#136).** The Flutter app's generated
   `Produto.deleteCascade` sweeps the doc's 13 known subcollections:
   `produtoshopee`, `variacaoshopee`, `produtoamazon`, `produtoMercadoLivre`,
   `variacaoMercadoLivre`, `produtomagalu`, `produtointegrada`, `historicopreco`,
   `historicocusto`, `produtoextradata`, `imposto`, `foto`, `estoque`. Next's
   plain delete leaves all of these as invisible orphans under
   `produtos/<deletedId>/…`.

2. **Arquivo / Storage orphans (#95).** The storage port (#92) deliberately
   shipped **only** the image-resize pipeline. The interim arquivo deletion
   signal (`onArquivoDeleted`, a refcount-aware Storage object delete) and the
   orphan sweep (`cleanupOrphanArquivos`, a daily full-`produtos` scan) were
   **removed** before merge, to be redesigned here: the full-collection scan was
   a per-read-billing workaround, and with **Firebase Enterprise edition + the
   pipeline API** cross-collection joins/anti-joins are now viable, so orphan
   detection should be redesigned rather than ported as-is.

3. **Inbound references (#135).** A variation-deletion-integrity change ships a
   **block** today: a produto cannot be deleted while inbound references exist —
   kit entries (`componentesKit` map keys, queryable via the
   `componentesKitKeys` array) and marketplace variation links (the parent's
   `variacaoMercadoLivre.produtoVariacaoOuterRef`, `variacaoshopee`, Magalu/Amazon/
   Integrada equivalents). The block is correct but blunt; a proper cascade would
   let the user delete in one confirmed operation.

All three share the **same delete event** and the **same deployment surface**
(`apps/functions`, codebase `storage`), so they are designed together here even
though they ship in phases.

**Coexistence constraint.** The Flutter app still runs its own `deleteCascade`
on its deletes, and the `manutencaoFotosProduto` Cloud Function still cleans up
photo orphans. Every function added here must therefore be **idempotent** and
tolerate already-clean docs.

**Emulator constraint.** Firestore **pipeline queries do not run in the
emulator** — the venue for the storage CI suite (`ci-storage.yml`). Phase 2's
unreferenced sweep uses a pipeline for its regex candidate scan, so its **core
logic is emulator-tested via seams** (`fetchCandidates` / `resolveReferenced`
injected) while the **pipeline itself is validated live** against the real test
Firebase project. Every other function here is fully emulator-testable.

## Decision

Handle the lifecycle **server-side** in `apps/functions` (client-side cascade was
considered and rejected — see Alternatives), split into event-triggered cleanup
(cheap, emulator-testable) and scheduled orphan reconciliation (bounded; core
logic emulator-tested via seams, the regex candidate pipeline validated live), and
phase the work so the debris-producing deletes are covered first.

### Phase 1 — event-triggered cleanup (ship first)

- **`onDocumentDeleted('produtos/{id}')` (#136)** — sweep the 13 known
  subcollections in batched deletes. Idempotent; tolerant of partially-cleaned
  docs (Flutter may have already swept some). Fully exercisable on the Firestore
  emulator in `ci-storage.yml`.
- **`onArquivoDeleted` (#95)** — on `arquivos/{id}` delete, delete the Storage
  object the doc owned (and, for a product-image original, cascade to its 3
  derivative objects + docs). Product media is **product-scoped** (paths are
  `produtos/<id>/…`, ids are `<produtoId>_<hash>`), so there is no cross-product
  object sharing and an **owner-scoped delete needs no refcount table** — the
  earlier "refcount-aware" framing was for a shared-object model this layout
  rules out. Guards a content-addressed race with a **dedup-resurrection check**
  (skip the delete if a doc with the same id exists again — a re-upload recreated
  it) rather than a `criadoEm` time window. Core extracted as
  `processArquivoDeletion` so the emulator suite drives it directly (Firestore
  triggers on a **named** database are awkward to exercise in the emulator).
  Targets the named `default` database explicitly. Emulator-testable.

  This pairs with a **create-first** upload contract in `@delfrance/storage`
  (the maturation of #202): the client writes the `arquivos` doc — the lifecycle
  **anchor** — BEFORE uploading the bytes, stamping `uploadState: 'pending'` and
  tagging the object with its `arquivoId` in custom metadata; the
  `onObjectFinalized` trigger flips `uploadState` to `'finalized'`. The old order
  (upload-then-`setDoc`) orphaned the OBJECT when the client died mid-write;
  create-first instead leaves a detectable phantom DOC.

- **`onProdutoMediaChanged` (`onDocumentUpdated('produtos/{id}')`)** — the
  produto-**edit** sibling of #136 (which covers produto-**delete**). When an edit
  removes a photo/video, the `fotos`/`videos` array is rewritten without the entry
  but the arquivo is left behind. Rather than wait for Phase 2 to *rediscover* this
  via the regex pipeline + owner lookup, the trigger diffs `before`/`after` media
  refs (`reconcileProdutoMediaMarks`, exported for the emulator suite) and **marks**
  each removed arquivo (`markedForDeletionAt = now`); a re-added ref clears the mark.
  The mark is only a **signal** — the delete is deferred to Phase 2's
  `sweepMarkedForDeletion` (short grace + owner re-verify), so a buggy/partial/bulk
  save that drops `fotos` can only mark (reversibly), never instantly destroy photos.
  Writes touch only `arquivos` (never `produtos`) → no self-retrigger; one batched
  `getAll` + `WriteBatch` per edit, zero work when the edit doesn't touch media.
  Plain admin writes (no pipeline) → fully emulator-testable. Scoped to `fotos` +
  `videos` (anexos stay on the Phase 2 backstop). Targets the named `default` database.

### Phase 2 — scheduled orphan reconciliation (`reconcileArquivoOrphans`)

`onSchedule`, every 48h, three bounded passes:

- **Marked-for-deletion sweep** (`sweepMarkedForDeletion`) — the back half of the
  eager reap above: delete arquivos `onProdutoMediaChanged` flagged
  (`markedForDeletionAt < cutoff`, past a **short** `ARQUIVO_MARKED_GRACE_HOURS`
  grace, default 1h, oldest-first — single-field index `arquivos(markedForDeletionAt)`),
  **re-verifying** via `resolveReferencedArquivoRefs` that the owning produto still
  doesn't reference them (a missed unmark clears the mark instead of deleting). A
  plain admin range query (no pipeline → emulator-testable), so it runs first and
  cheapest. This makes the common "photo edited out" case prompt; the unreferenced
  sweep below is now the **backstop** (produto deletes until #136, console edits,
  missed trigger deliveries).

- **Phantom-doc sweep** (`sweepPhantomDocs`) — query
  `arquivos where uploadState == 'pending' AND criadoEm < cutoff orderBy criadoEm asc`
  (oldest-first, grace window excluded in the query — composite index
  `arquivos(uploadState, criadoEm)`); for each, if its Storage object is absent,
  delete the doc (an abandoned create-first upload), or self-heal to `'finalized'`
  if the object is present. Subsumes #189's product-image phantoms.
- **Unreferenced-arquivo sweep** (`sweepUnreferencedArquivos`) — the **backstop** for
  product photos + videos (`produtos/<id>/originals|videos`) past the grace window that
  **no produto references**, that the eager `onProdutoMediaChanged` mark missed: a
  produto deleted entirely (until #136), a Firestore-console edit, or a dropped trigger
  delivery. Candidates come from a
  **regex pipeline** (`regexContains('filepath', …) AND criadoEm < cutoff`, sorted,
  on the `arquivos(criadoEm)` index) — server-side scoped so non-product docs are
  never loaded. The reference check is an **owner-document lookup**, not a
  collection scan: a product arquivo encodes its owner `produtoId` in its storage
  path, so `resolveReferencedArquivoRefs` reads ONLY the produtos owning the
  candidate batch — one batched `getAll`, field-masked to `fotos`/`videos`/`anexos`
  — making it O(distinct produtos), never O(all produtos). Deleting the doc lets
  `onArquivoDeleted` free the bytes.

**Emulator note.** The candidate scan is a Firestore **pipeline** (regex on
`filepath`), which needs Enterprise + `@google-cloud/firestore` v8 (firebase-admin
v14, scoped to `apps/functions`) and does **not** run in the emulator. So both the
candidate fetch and the owner lookup are **seams** (`fetchCandidates` /
`resolveReferenced`) the emulator suite overrides — it exercises the delete loop +
the real `resolveReferencedArquivoRefs` (plain `getAll`), while the pipeline is
validated live. The earlier storage-orphan sweep was dropped: create-first
guarantees an object always has a doc, so object-with-no-doc can't arise.
`criadoEm` is microseconds-since-epoch (schema default `nowMicros()`), so the grace
window is a numeric range query.

**Coverage caveat.** The candidate scan still re-reads the oldest docs, so a large
head of long-lived referenced photos can starve newer orphans; a persisted
round-robin cursor is the planned fix (#234) — and it does not affect the marked sweep,
which only reads what the trigger flagged. This Firestore Enterprise edition creates no
index automatically, so all three sweep indexes — `arquivos(uploadState, criadoEm)`,
`arquivos(criadoEm)` and `arquivos(markedForDeletionAt)` — are declared in
`firestore.indexes.json` and deployed via `firebase deploy --only firestore:indexes`.

The remaining "produto deleted entirely" case is still the **produto-delete**
path (#136: `onDocumentDeleted('produtos/{id}')` deletes the `arquivos` docs →
`onArquivoDeleted` frees Storage).

### Phase 3 — reference cascade (#135), replaces the block

Replace the delete-block with a confirmed cascade:

1. **Kit entries** — remove the deleted id from every referencing produto's
   `componentesKit` map and `componentesKitKeys` array (and decide the
   empty-kit semantics).
2. **Local marketplace variation links** — delete/unlink the parent's
   `variacaoMercadoLivre`/`variacaoshopee`/… docs that point at the deleted child.
3. **Remote marketplace state** — unlinking locally is not enough: the listing
   variation still exists on the channel. A real cascade needs a delist/update
   call per channel, which belongs in `apps/integrations` / Cloud Functions, not
   the client. **Open design questions:** ordering (remote delist *before* local
   unlink?) and partial-failure handling (marketplace API down mid-cascade).

**Until the remote-delist path exists, keep today's block.** Removing it while
only local unlink is implemented would leave dangling remote listings — worse
than blocking. Phase 3 lands only once the `apps/integrations` delist design is
settled.

### Deployment

All functions ship through the manual, coordinated deploy lane added for the
storage codebase in #137 / PR #169 — a functions-only `firebase.functions.deploy.json`
config plus an `apps/functions/DEPLOY.md` runbook (those files land with that PR,
not this one). No automated deploy workflow yet.

## Consequences

- **Easier:** Next-side deletes stop producing orphans (Phase 1); the orphan set
  becomes bounded and then reconcilable (Phase 2); users eventually delete
  referenced produtos in one operation (Phase 3).
- **Harder / new risk:** idempotency is now a hard requirement because Flutter
  cascades concurrently during coexistence; the cross-package remote-delist
  (Phase 3) introduces partial-failure states that need explicit handling.
- **Cost:** both sweeps are bounded (BATCH 100). The unreferenced sweep's candidate
  batch is regex-scoped server-side (only product photos/videos load) and reads only
  the produtos that own it (one batched `getAll`, field-masked) — O(distinct
  produtos in the batch), never the whole collection. The phantom + candidate queries
  are index-backed via declared composite/single-field entries in
  `firestore.indexes.json` (`arquivos(uploadState, criadoEm)` + `arquivos(criadoEm)`)
  — required because this Enterprise edition auto-creates none. The candidate scan
  being a pipeline (regex) re-cements the firebase-admin v14 dependency in
  `apps/functions`.

## Alternatives considered

- **Client-side cascade** (port `deleteCascade` to the web client) → rejected:
  keeps the client lean and makes cleanup authoritative/server-owned; a client
  cascade can't be trusted to complete (tab closed mid-delete) and can't reach
  Storage refcounts safely.
- **Port the old full-`produtos` orphan scan as-is, or a pipeline anti-join over
  `produtos`** → both rejected: each reads the whole `produtos` collection every
  run (a pipeline's `collection()` source still bills 1 read per produto —
  projection cuts bandwidth, not read count). The owner-document lookup reads only
  the produtos that own the candidate batch, because a product arquivo's storage
  path already names its owner.
- **Keep the delete-block permanently** (no cascade) → rejected as the end state,
  but **retained as the interim** until remote delist exists.

## Status

Proposed (2026-06). Phasing: Phase 1 **arquivo side** done — `onArquivoDeleted`
+ the create-first upload contract (#95/#202) — plus `onProdutoMediaChanged`, the
produto-**edit** eager-reap trigger (marks an arquivo when a photo/video is edited out,
clears it on re-add); the produto-**delete** `onDocumentDeleted('produtos/{id}')`
subcollection sweep (#136) still follows. Phase 2 **implemented** as
`reconcileArquivoOrphans` (every 48h): the marked-for-deletion sweep (the eager reap's
back half — re-verifies the owner before deleting), the phantom-doc sweep, and the
unreferenced-arquivo sweep (now the backstop), all oldest-first with the grace window
excluded in the query. The unreferenced check is an owner-document lookup
(`resolveReferencedArquivoRefs` reads only the produtos owning the candidate batch
via `getAll`), which replaced the original full-`produtos` pipeline anti-join; the
candidate scan is a regex pipeline that scopes server-side to product photos/videos
(so firebase-admin v14 / `@google-cloud/firestore` v8 stays required). Both sweep
queries are index-backed via declared `firestore.indexes.json` entries (Enterprise
auto-creates none). The delete loop + `resolveReferencedArquivoRefs` are emulator-
tested via seams; the pipeline is live-validated. A coverage follow-up (persisted
round-robin cursor for the candidate scan) is tracked in #234. Phase 3 blocked on
the `apps/integrations` remote-delist design. Refs #136,
#95, #135, #202, #234.
