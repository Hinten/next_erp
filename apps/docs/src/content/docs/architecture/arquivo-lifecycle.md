---
title: Arquivo (file) lifecycle
description: Upload, maintenance and deletion flow for the arquivos collection — create-first, doc-anchored, product-scoped — with a coverage map of every failure mode.
---

A managerial, high-level view of how files (`arquivos`) move through the system —
**upload → finalize/resize → maintenance → deletion** — and which mechanism covers
each happy path and each failure mode. The design *decisions* live in
[ADR 0010 — Produto deletion lifecycle](/adr/0010-produto-deletion-lifecycle/); this
page is the **map** to verify nothing falls through the cracks.

## The model in one breath

- The **`arquivos` Firestore doc is the anchor**, not the Storage object.
- **Create-first**: the client writes the doc *before* uploading the bytes, so a dead
  upload leaves a detectable *phantom doc*, never an orphan object.
- **Content-addressed**: the doc id is `sha512(bytes)` — re-uploading identical bytes
  is a no-op (dedup).
- **Product-scoped**: every product file lives under `produtos/<produtoId>/…` with a
  product-scoped doc id, so there is no cross-product sharing — deletion is
  owner-scoped and needs no refcount table.
- Four Cloud Functions own the server side (codebase `storage`, region `us-east1`):

| Function | Trigger | Job |
| --- | --- | --- |
| `resizeProductImage` | `onObjectFinalized` | Confirm upload (`uploadState→'finalized'`) + generate image derivatives |
| `reconcileProductImages` | `onSchedule` (48h) | Backfill derivatives the trigger never finished |
| `onArquivoDeleted` | `onDocumentDeleted('arquivos/{id}')` | Free the object + cascade derivatives when a doc is deleted |
| `reconcileArquivoOrphans` | `onSchedule` (48h) | Reap phantom docs + arquivos no produto references anymore |

## Storage layout & doc model

| Kind | Storage path | Doc id | Resized? |
| --- | --- | --- | --- |
| Product image **original** | `produtos/<id>/originals/<hash>.<ext>` | `<id>_<hash>` | ✅ (watched) |
| Image **derivative** | `produtos/<id>/derivatives/<hash>_<key>.jpeg` | `<id>_<hash>_<key>` | server-only (`resized:true`) |
| Product **video** | `produtos/<id>/videos/<hash>.<ext>` | `<id>_<hash>` | ❌ |
| Generic **media** | `media/<hash>.<ext>` | `<hash>` | ❌ |

Each `arquivos` doc carries two **orthogonal** lifecycle markers plus a queryable
timestamp:

- **`uploadState`**: `pending` → `finalized` (the bytes arrived). Set on every
  non-derivative upload.
- **`resizeState`**: `pending` → `done` (derivatives written). **Product image
  originals only**; `null` for videos / generic media.
- **`criadoEm`**: microseconds since epoch, schema default `nowMicros()` — a required
  numeric field so the sweeps can range-query it for the grace window.

Derivative variants are `200` (200px), `400` (400px), and `jpeg` (full-size re-encode).

## 1 · Upload (create-first) + finalize

```mermaid
sequenceDiagram
    actor Client
    participant FS as Firestore (arquivos)
    participant GCS as Cloud Storage
    participant Fn as resizeProductImage (onObjectFinalized)

    Note over Client: id = sha512(bytes)
    Client->>FS: getDoc(arquivos/id)
    alt doc already exists (dedup hit)
        FS-->>Client: reuse existing arquivo — stop
    else new file
        Client->>FS: setDoc — uploadState 'pending', url null, criadoEm now, resizeState 'pending' (product images)
        Client->>GCS: uploadBytes — customMetadata.arquivoId = id
        Client->>FS: updateDoc — url (download URL)
        GCS-->>Fn: object finalized event
        Fn->>FS: markUploadFinalized — uploadState 'finalized'
        opt product image original
            Fn->>GCS: write 200 / 400 / jpeg derivatives (resized true)
            Fn->>FS: create derivative docs
            Fn->>FS: original.resizeState 'done'
        end
    end
```

Entry points (`packages/storage/src/upload.ts`): `uploadProductImage` (originals →
resized), `uploadProductVideo`, `uploadFile` / `uploadFromUrl` (generic `media/`). All
route through `putArquivo`, which does the dedup check, the doc-before-bytes write, and
the post-upload `url` patch.

## 2 · Lifecycle state machine

```mermaid
stateDiagram-v2
    state "uploadState pending" as Pending
    state "uploadState finalized" as Finalized
    state "finalized + resizeState done" as Resized
    state "phantom (no object)" as Phantom
    state "unreferenced" as Unreferenced

    [*] --> Pending: create-first setDoc
    Pending --> Finalized: onObjectFinalized (object arrived)
    Pending --> Finalized: sweepPhantomDocs self-heal (object present, trigger missed)
    Finalized --> Resized: processProductOriginal (product image only)
    Pending --> Phantom: object absent, past 48h grace
    Phantom --> [*]: sweepPhantomDocs deletes the doc
    Finalized --> Unreferenced: no produto reference, past grace
    Resized --> Unreferenced: no produto reference, past grace
    Unreferenced --> [*]: sweepUnreferencedArquivos deletes (onArquivoDeleted frees object + derivatives)
```

Videos and generic media stop at **finalized** (they never get `resizeState`). Only
product image originals reach **resized**.

## 3 · Maintenance — scheduled reconciliation (every 48h)

```mermaid
flowchart TD
    Sched[onSchedule · every 48h]

    Sched --> RPI[reconcileProductImages]
    RPI --> RPIQ["query arquivos<br/>where resizeState == 'pending' (limit 100)"]
    RPIQ --> PPO["processProductOriginal<br/>backfill missing 200 / 400 / jpeg derivatives"]

    Sched --> RAO[reconcileArquivoOrphans]

    RAO --> SP[sweepPhantomDocs]
    SP --> SPQ["query where uploadState == 'pending'<br/>AND criadoEm &lt; cutoff<br/>orderBy criadoEm (oldest first, limit 100)"]
    SPQ --> SPO{object exists?}
    SPO -->|yes| Heal["self-heal → uploadState 'finalized'"]
    SPO -->|no| DelP[delete phantom doc]

    RAO --> SU[sweepUnreferencedArquivos]
    SU --> FUC["fetchUnreferencedCandidates — regex pipeline:<br/>filepath ~ produtos/&lt;id&gt;/originals or /videos<br/>AND criadoEm &lt; cutoff, oldest first (limit 100)"]
    FUC --> RR["resolveReferencedArquivoRefs<br/>getAll owning produtos → fotos / videos / anexos refs"]
    RR --> REF{referenced by<br/>its produto?}
    REF -->|yes| Keep[keep]
    REF -->|no| DelU["delete doc → onArquivoDeleted"]
```

Two independent scheduled functions:

- **`reconcileProductImages`** — a *filtered* query (`resizeState == 'pending'`), so it
  scans only originals whose derivatives are missing, never the whole catalog. Shares
  the idempotent `processProductOriginal` with the finalize trigger (writes only what's
  missing, skips the download when complete).
- **`reconcileArquivoOrphans`** — two bounded passes:
  - **`sweepPhantomDocs`** — a `pending` doc past the grace window whose object never
    arrived is deleted; if the object *is* present (the finalize event was missed), the
    doc self-heals to `finalized`. The selection (pending + past grace + oldest first)
    is entirely in the query, backed by the composite index
    `arquivos(uploadState, criadoEm)`.
  - **`sweepUnreferencedArquivos`** — product photos/videos that **no produto
    references anymore** (e.g. a photo edited out of `produto.fotos`). Candidates come
    from a **regex pipeline** scoped server-side to `originals|videos`; each candidate's
    owner `produtoId` is parsed from its path, and only the owning produtos are read
    (`getAll`, field-masked to `fotos`/`videos`/`anexos`) — **O(distinct produtos in the
    batch)**, never O(all produtos). Deleting the doc lets `onArquivoDeleted` free the
    object and its derivatives.

## 4 · Deletion + cascade

```mermaid
flowchart TD
    T1[App / admin deletes the arquivo doc]
    T2[sweepUnreferencedArquivos]
    T3["produto-delete cascade<br/>(#136 — NOT built yet)"]

    T1 --> OAD
    T2 --> OAD
    T3 -. planned .-> OAD

    OAD["onArquivoDeleted<br/>onDocumentDeleted(arquivos/&lt;id&gt;)"]
    OAD --> G{"same id re-created?<br/>(dedup-resurrection)"}
    G -->|yes| Skip[skip — a new upload owns the object]
    G -->|no| DelObj[delete the owned Storage object]
    DelObj --> Orig{product image original?}
    Orig -->|yes| Casc["cascade: delete 200 / 400 / jpeg<br/>objects + derivative docs"]
    Orig -->|no| Done[done]
```

Deletion is **doc-anchored**: deleting the `arquivos` doc is what frees Storage, so the
same code path covers an explicit delete, a sweep delete, and (in future) a
produto-delete cascade. The dedup-resurrection guard skips the object delete if a doc
with the same content-addressed id exists again (a re-upload recreated it).

## Coverage matrix

| Scenario | Covered? | By what |
| --- | --- | --- |
| Normal upload (image / video / media) | ✅ | create-first + `onObjectFinalized` → `finalized` (+ derivatives for images) |
| Re-upload of identical bytes (dedup) | ✅ | content-addressed id → `putArquivo` reuses the existing doc, no re-upload/re-trigger |
| Client dies **before** the doc write | ✅ | nothing created — no debris |
| Client dies **mid-upload** (doc, no object) | ✅ | phantom doc → `sweepPhantomDocs` deletes after grace |
| Client dies **after upload, before url patch** | ⚠️ partial | `uploadState` still finalizes; `url` stays `null` — product images render via derivative URLs; generic media needs a re-patch (deferred refinement) |
| Finalize event missed / lagged | ✅ | `sweepPhantomDocs` self-heals to `finalized` when the object is present |
| Resize fails / partial derivatives | ✅ | `reconcileProductImages` retries; `processProductOriginal` writes only the missing variants |
| Resize trigger fires twice (race) | ✅ | idempotent — second run sees the derivatives exist and only stamps `done` |
| Photo edited out of a produto | ✅ | `sweepUnreferencedArquivos` reaps it after grace → `onArquivoDeleted` |
| Explicit arquivo delete (app/admin) | ✅ | `onArquivoDeleted` frees object + cascades derivatives |
| Re-upload races a delete (resurrection) | ✅ | dedup-resurrection guard skips the object delete |
| **Produto deleted** | ⚠️ delayed | no produto-delete trigger yet (#136) — the produto's arquivos become unreferenced and are reaped by the 48h sweep, not immediately |
| Manual Firestore-console produto delete | ⚠️ delayed | same as above — eventual cleanup via the sweep, no real-time block |

## Indexes & cost

This project runs Firestore **Enterprise**, which **auto-creates no indexes**, so both
sweep queries are declared in `firestore.indexes.json` and must be deployed
(`firebase deploy --only firestore:indexes`):

- `arquivos(uploadState, criadoEm)` — the phantom sweep (equality + range + orderBy).
- `arquivos(criadoEm)` — the unreferenced candidate pipeline (range + sort; the regex is
  a residual filter).

Both sweeps are bounded at **100 docs/run**; the grace window is
`ARQUIVO_ORPHAN_GRACE_HOURS` (48h). The unreferenced sweep's read cost is the candidate
batch plus one `getAll` over the *distinct* owning produtos — not the whole `produtos`
collection.

## Known gaps & follow-ups

- **#136 — produto-delete cascade (not built).** An `onDocumentDeleted('produtos/{id}')`
  function would sweep the produto's 13 subcollections and delete its referenced arquivos
  docs *promptly*. Until it ships, a deleted produto's arquivos linger until the 48h
  unreferenced sweep reaps them. This is the next planned step (ADR 0010 Phase 1).
- **#234 — persisted-cursor coverage.** Both sweeps re-read the oldest docs each run, so a
  large head of long-lived referenced photos can starve newer orphans; a persisted
  round-robin cursor is the planned fix.
- **#135 — reference cascade (Phase 3, blocked).** Replace the produto delete-*block* with
  a confirmed cascade (kit entries, marketplace variation links, remote delist) — blocked
  on the `apps/integrations` remote-delist design.

## See also

- [ADR 0010 — Produto deletion lifecycle](/adr/0010-produto-deletion-lifecycle/) — the design decisions behind this lifecycle.
- `apps/functions/CLAUDE.md` — operational notes for the four functions + deploy gotchas.
- Source: `packages/storage/src/upload.ts`, `apps/functions/src/arquivos/*`, `apps/functions/src/product-images/*`, `packages/schemas/src/storage/{arquivo,storagePaths}.ts`.
