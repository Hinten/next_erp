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
   `produtoshopee`, `variacaoshopee`, `produtoamazon`, `produtomercadolivre`,
   `variacoesml`, `produtomagalu`, `produtointegrada`, `historicopreco`,
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
   `variacoesml.produtoVariacaoOuterRef`, `variacaoshopee`, Magalu/Amazon/
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
emulator** — the venue for the storage CI suite (`ci-storage.yml`). Any
pipeline-based query must be validated against the **real test Firebase
project**, not the emulator.

## Decision

Handle the lifecycle **server-side** in `apps/functions` (client-side cascade was
considered and rejected — see Alternatives), split into event-triggered cleanup
(cheap, emulator-testable) and scheduled orphan reconciliation (needs the
pipeline API + a real-project CI lane), and phase the work so the
debris-producing deletes are covered first.

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

### Phase 2 — scheduled orphan reconciliation (deferred)

Reshaped from the original "pipeline anti-join" idea into **two existence-check
sweeps** (`onSchedule`, every 48h). `Produto.fotos` is an **embedded array** of
`arquivos/<id>` ref-strings, which makes a "no produto reference" anti-join an
array-contains join (pipeline-only, and pipeline queries **cannot run in the
emulator**). Anchoring on the `arquivos` doc instead lets both directions be
plain existence checks — **no pipeline API, fully emulator-testable** — so they
do **not** need the secret-gated real-project CI lane the anti-join would have:

- **Phantom-doc sweep** — query `arquivos where uploadState == 'pending'`
  (bounded `.limit`); for each doc older than a 48h grace window, if its Storage
  object is absent, delete the doc (an abandoned create-first upload). Subsumes
  #189's observation that product-image phantoms sit at `resizeState: 'pending'`
  forever.
- **Storage-orphan sweep** — paginate the bucket under `produtos/` + `media/`;
  for each object older than the window whose owning doc (`arquivoId` metadata,
  else derived from the path) is absent, delete the object.

The remaining "doc + object both exist but no `produto` references them" case is
handled at the **produto-delete** path (#136 deletes the `arquivos` docs →
`onArquivoDeleted` frees Storage), not by a storage sweep. Deferred until Phase 1
has stopped the orphan set from growing.

### Phase 3 — reference cascade (#135), replaces the block

Replace the delete-block with a confirmed cascade:

1. **Kit entries** — remove the deleted id from every referencing produto's
   `componentesKit` map and `componentesKitKeys` array (and decide the
   empty-kit semantics).
2. **Local marketplace variation links** — delete/unlink the parent's
   `variacoesml`/`variacaoshopee`/… docs that point at the deleted child.
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
- **Harder / new risk:** a new secret-gated real-project CI lane to maintain
  (Phase 2); idempotency is now a hard requirement because Flutter cascades
  concurrently during coexistence; the cross-package remote-delist (Phase 3)
  introduces partial-failure states that need explicit handling.
- **Cost:** the reshaped Phase 2 existence-check sweeps are bounded
  (`uploadState == 'pending'` query + 48h age filter + per-run `.limit`), so they
  avoid both the old full-collection per-read scan AND the Enterprise-only
  pipeline anti-join — they run on any pricing tier and in the emulator.

## Alternatives considered

- **Client-side cascade** (port `deleteCascade` to the web client) → rejected:
  keeps the client lean and makes cleanup authoritative/server-owned; a client
  cascade can't be trusted to complete (tab closed mid-delete) and can't reach
  Storage refcounts safely.
- **Port the old full-`produtos` orphan scan as-is** → rejected: it was a
  per-read-billing workaround; the Enterprise pipeline anti-join is the right
  primitive now.
- **Keep the delete-block permanently** (no cascade) → rejected as the end state,
  but **retained as the interim** until remote delist exists.

## Status

Proposed (2026-06). Phasing: Phase 1 in progress — the **arquivo side**
(`onArquivoDeleted` + the create-first upload contract, #95/#202) lands first;
the produto-side `onDocumentDeleted('produtos/{id}')` subcollection sweep (#136)
follows. Phase 2 reshaped into two emulator-testable existence-check sweeps (no
secret-gated lane needed). Phase 3 blocked on the `apps/integrations`
remote-delist design. Refs #136, #95, #135, #202.
