---
name: arquivos
description: >-
  Use when uploading, attaching, displaying, removing or deleting files in this
  monorepo — the `arquivos` collection, product photos/videos, generic media —
  and when extending file handling to a new entity, or touching the storage
  Cloud Functions / orphan sweeps. Triggers on: arquivo(s), upload, foto/photo,
  vídeo/video, anexo/attachment, storage, file, media, PhotoManager,
  VideoManager, uploadProductImage, uploadProductVideo, uploadFile, uploadFromUrl,
  arquivoOuterRef, buildFotoRefs, derivative/thumbnail, orphan sweep,
  onArquivoDeleted, onProdutoMediaChanged, markedForDeletionAt, resizeProductImage,
  reconcileArquivoOrphans, content-addressed, create-first, doc-anchored.
---

# Arquivos (files & storage)

How to upload, display, remove and delete files in this ERP, which helpers and
components already exist to reuse, and how the delete/maintenance machinery works
so you don't leak orphaned Storage objects. **The system is produto-only today**
but is built to extend — §9 is the recipe for wiring it into another entity.

The deep *why* and the full lifecycle diagrams live in
`apps/docs/src/content/docs/architecture/arquivo-lifecycle.md` and
`apps/docs/src/content/docs/adr/0010-produto-deletion-lifecycle.md`. This skill is
the *how-to-use / how-to-reuse / how-to-extend* guide — it points at those, it
does not duplicate them.

## 1. When to use / when NOT

**Use** when you touch files in any way: uploading bytes, importing an image from
a URL, rendering a photo/video, removing one from an entity, deleting a file, or
working on the storage Cloud Functions and sweeps. Also when **extending** file
handling to a new entity (pedidos, clientes, …) — see §9.

**Do not use** for: plain schema-driven CRUD forms (that's the
`schema-driven-crud` skill); NF-e XML/PDF artifacts (those are domain documents
under `pedidos/{id}/nfev4`, not `arquivos`). Freight labels are ME PDFs, not
arquivos either (`freight-integrations` skill).

## 2. Mental model in one breath

- **Doc-anchored** — the `arquivos` Firestore doc is the source of truth, *not*
  the Storage object. Deleting the doc is what frees the object (a Cloud Function
  cascades). **Never delete a Storage object directly.**
- **Create-first** — the client writes the doc *before* uploading the bytes, so a
  dead upload leaves a detectable *phantom doc*, never an orphan object.
- **Content-addressed** — the doc id is `sha512(bytes)` (hex). Re-uploading
  identical bytes is a no-op (dedup): `putArquivo` sees the doc already exists and
  reuses it.
- **Product-scoped** — product files live under `produtos/<produtoId>/…` with a
  product-scoped doc id (`<produtoId>_<hash>`); no cross-product sharing, so
  deletion is owner-scoped and needs no refcount table.

## 3. Architecture map

| Layer | Path | Holds |
| --- | --- | --- |
| **Client upload** | `packages/storage` (`@delfrance/storage`) | `uploadProductImage/Video`, `uploadFile`, `uploadFromUrl`, `putArquivo` (create-first), the client `arquivoCollection` handle, `sha512Hex` |
| **Schema + paths + ref shapes** | `packages/schemas/src/storage/{arquivo,storagePaths,foto,video}.ts` + `produto/collection/embedded/anexo.ts` | `arquivoSchema`, path/id builders, `Foto`/`Video`/`Anexo` wire shapes, `buildFotoRefs` |
| **Admin handles** | `@delfrance/data/admin/collections` | `arquivoCollection`, `produtoCollection` (Admin SDK, converter-less) |
| **Server (functions)** | `apps/functions/src/{arquivos,product-images}` | the 5 Cloud Functions: finalize/resize, the deletion cascade, the eager reaper, the 48h sweeps |
| **Produto UI** | `apps/web/app/(app)/produtos/_components/{PhotoManager,VideoManager}.tsx` | the canonical media editors (dropzone, reorder, thumbnails, staged delete) |

## 4. Client: upload a file

All entry points live in `packages/storage/src/upload.ts` and take `storage` +
`db` (from `getFirebaseStorage()` / `getFirebaseFirestore()` in
`apps/web/lib/firebase/client.ts`). They all funnel through **`putArquivo`** —
the create-first + dedup core — and return `UploadResult = { id, arquivo }`.

| Function | Args (besides `storage`/`db`) | Storage path · doc id | Notes |
| --- | --- | --- | --- |
| `uploadProductImage` | `produtoId, bytes, contentType, originalFilename?` | `produtos/<id>/originals/<hash>.<ext>` · `<id>_<hash>` | throws if not `image/*`; sets `resizeState:'pending'` → resize trigger generates derivatives |
| `uploadTabMediImage` | `tabMediId, bytes, contentType, originalFilename?` | `tabMedi/<id>/originals/<hash>.<ext>` · `<id>_<hash>` | throws if not `image/*`; sets `resizeState:'pending'` — resized exactly like a product image |
| `uploadProductVideo` | `produtoId, bytes, contentType, originalFilename?` | `produtos/<id>/videos/<hash>.<ext>` · `<id>_<hash>` | throws if not `video/*`; **not** resized |
| `uploadFile` | `bytes, contentType, filepath?, originalFilename?` | `<filepath ?? media>/<hash>[.ext]` · `<hash>` | generic media; `filetype` derived via `filetypeFromMime` |
| `uploadFromUrl` | `url, filepath?, originalFilename?` | (fetches, then `uploadFile`) | importing a marketplace image |

The **create-first contract** (`putArquivo`, `upload.ts:62`): (1) if a doc already
exists at the content-addressed id → return it (dedup, no re-upload); (2) write the
anchor doc with `url:null`, `uploadState:'pending'`, `criadoEm:nowMicros()`; (3)
`uploadBytes` tagging the object with `customMetadata.arquivoId = <docId>` (so the
finalize trigger maps object→doc); (4) patch `url`. The trigger flips
`uploadState→'finalized'` once the bytes land. **Always go through these helpers**
— never hand-roll `setDoc`/`uploadBytes`, or you lose dedup, the anchor doc, and
the object→doc tag.

Path/id math (pure, no Firebase) lives in `packages/schemas/src/storage/storagePaths.ts`:
`productOriginalPath`, `productVideoPath`, `productDerivativePath`, `mediaPath`,
`ownedArquivoId`, `productArquivoId`, `tabMediArquivoId`, `derivativeArquivoId`,
`parseOwnedOriginalPath`, `parseOwnedMediaDir`, `isWatchedOriginal`,
`isDerivativeName`, `ownedDerivativePath`, `tabMediOriginalPath`,
`firebaseDownloadUrl`, `normalizeName`, `PRODUCT_IMAGE_VARIANTS` (`200`/`400`/`jpeg`).

⚠️ The **owner-aware** names are the live ones: `isWatchedOriginal` matches
`produtos/` **and** `tabMedi/` originals, which is what puts size-chart photos
through the resize pipeline. `parseProductOriginalPath` / `parseProductMediaDir`
are produto-only VIEWS over them, kept for the produto-scoped callers.

## 5. Attach a file to a produto (the canonical wiring)

```ts
import { uploadProductImage } from '@delfrance/storage';
import { buildFotoRefs, type Foto } from '@delfrance/schemas';

// produto must already have an id — for a NEW produto mint it first
// (doc(collection(db,'produtos')).id) and save before uploading.
const { id } = await uploadProductImage({ storage, db, produtoId, bytes, contentType });
const hash = id.slice(produtoId.length + 1);          // <produtoId>_<hash>
const foto: Foto = { ...buildFotoRefs(produtoId, hash) }; // original + 3 derivative refs
onChange([...(value ?? []), foto]);                    // push into produto.fotos
```

`buildFotoRefs(produtoId, hash)` returns the 4 optimistic ref strings
(`arquivoOuterRef` + `arquivo{200px,400px,jpeg}OuterRef`); the derivative docs are
created asynchronously by the resize function at those deterministic ids. Videos
are the same shape minus derivatives (push a `Video` into `produto.videos`).
`anexos` has a schema (`anexoSchema`, `{ arquivoOuterRef }`) but **no UI yet** —
it sits in `PRODUTO_EXCLUDED_FIELDS`.

## 6. Reusable UI components

`PhotoManager` (`apps/web/app/(app)/produtos/_components/PhotoManager.tsx`) and
`VideoManager` are the canonical editors. Both take
`{ produtoId, db, storage, value, onChange, disabled }` (PhotoManager also
`grupos` for per-variation galleries). They render a Mantine **Dropzone**,
**dnd-kit** drag-reorder, **live derivative thumbnails**, and **staged-delete** UI,
and call the §4 upload helpers internally. `produtoId === null` (create mode) shows
a "save first" state.

**Wiring into `ObjectView`** — a field config (`FieldConfig`) with a custom input:

```ts
fotos: {
  label: 'Fotos',
  section: 'Fotos',
  renderInput: (p) => <PhotoManager produtoId={id} db={db} storage={storage}
                        value={p.value} onChange={p.onChange} disabled={p.disabled} />,
  prepareForSave: stripMarkedForDeletion,   // staged deletion (below)
}
```

PhotoManager/VideoManager `renderInput`s are wired **per page** (they need the
page's `produtoId`/`db`/`storage`), not in the shared `produtoFields.ts` overrides
— see the produto `novo` / `[id]/editar` pages.

**Staged deletion** (mandatory convention — `apps/web/CLAUDE.md` rule 7):
destructive removal inside an editor is never immediate. Mark the item in place
with `DELETE_MARK` (keep it visible, dimmed, with undo); the removal only lands on
save via `prepareForSave: stripMarkedForDeletion`. Both from `@delfrance/ui`
(`packages/ui/src/object/markForDeletion.ts`). `ObjectView` runs `prepareForSave`
at save time. The `arquivos` doc + Storage object are reaped *after* the produto
write drops the ref — by the eager reaper (§8), not by the form.

**Thumbnail URL resolution** — refs are doc-path strings, not URLs. Resolve the
arquivo doc live and prefer the 200px derivative, falling back to the original
until resize finishes:

```ts
const id = arquivo200pxOuterRef?.replace(/^arquivos\//, '');
const snap = useDocSnapshot(id ? arquivoCollection.docRef(db, {}, id) : null); // client arquivoCollection
const url = snap.data?.data?.url ?? originalSnap.data?.data?.url ?? null;
```

## 7. Reference (wire) shapes

- **`arquivoOuterRef` is a plain `'arquivos/<id>'` string** (NOT the
  `documents/<col>/<id>` cross-model form). True for `Foto`, `Video`, `Anexo`.
- **`Foto`** (`storage/foto.ts`): `arquivoOuterRef` (required) +
  `arquivo200pxOuterRef`/`arquivo400pxOuterRef`/`arquivoJpegOuterRef` (nullable,
  filled by the resize fn) + `grupoDeVariacoesOuterRef`/`variantePath` (per-variant
  galleries). No `ordem` — array position is the order. Build with `buildFotoRefs`.
- **`Video`** (`storage/video.ts`): `arquivoOuterRef` + `formato`,
  `duracaoSegundos`, `larguraPx`/`alturaPx`, `usarMercadoLivre`/`usarShopee`,
  `dataCadastro`, `nomeArquivo` (all metadata computed client-side at upload).
- **`Anexo`** (`produto/.../embedded/anexo.ts`): `{ arquivoOuterRef }` only.
- **`arquivoSchema`** (`storage/arquivo.ts`, `.passthrough()`): `filetype`,
  `filepath` (dir, no filename), `filename`, `originalFilename`, `contentType`,
  `url`, `externalIds`, plus the lifecycle markers:
  - `uploadState` `pending`→`finalized` (bytes arrived) — all uploads.
  - `resizeState` `pending`→`done` (derivatives written) — **image originals of
    a watched owner** (`produtos/` and `tabMedi/`); `null` otherwise. ⚠️ Also
    `null` on size-chart photos uploaded before that owner was watched — they
    have no derivatives until a backfill stamps `'pending'` and lets
    `reconcileProductImages` pick them up.
  - `criadoEm` µs-since-epoch, required, default `nowMicros()` (sweeps range-query
    it).
  - `markedForDeletionAt` µs or `null` (default) — set by `onProdutoMediaChanged`
    when a photo/video is edited out, cleared on re-add.

## 8. Delete signals & maintenance

**The doc-anchored rule:** to free a file, **delete its `arquivos` doc**. The
`onArquivoDeleted` trigger frees the Storage object (and cascades derivatives).
Deleting a Storage object directly leaves a dangling doc — don't.

Five Cloud Functions own the server side (codebase `storage`, region `FUNCTIONS_REGION`,
`apps/functions/src/index.ts`):

| Function | Trigger | Job |
| --- | --- | --- |
| `resizeProductImage` | `onObjectFinalized` | `uploadState→'finalized'` + generate 200/400/jpeg derivatives |
| `reconcileProductImages` | `onSchedule` 48h | backfill derivatives the trigger missed (`where resizeState=='pending'`) |
| `onArquivoDeleted` | `onDocumentDeleted('arquivos/{id}')` | free the object + cascade derivatives (with a dedup-resurrection guard) |
| `onProdutoMediaChanged` | `onDocumentUpdated('produtos/{id}')` | **eagerly mark** a removed photo/video's arquivo for deletion (clears on re-add) |
| `reconcileArquivoOrphans` | `onSchedule` 48h | `sweepMarkedForDeletion` → `sweepPhantomDocs` → `sweepUnreferencedArquivos` |

The common case — a photo edited out of a produto — is handled **eagerly**:
`onProdutoMediaChanged` → `reconcileProdutoMediaMarks` diffs `fotos`+`videos`
(`MEDIA_FIELDS`) by `arquivoOuterRef` and stamps `markedForDeletionAt`; the
**short-grace** `sweepMarkedForDeletion` (default 1h) deletes it after re-verifying
the produto still doesn't reference it. The expensive `sweepUnreferencedArquivos`
(regex pipeline, 48h) is the **backstop** for produto deletes, console edits and
missed deliveries. See the architecture doc for the flow/state diagrams.

Grace windows (env, read per-call): `ARQUIVO_ORPHAN_GRACE_HOURS` (48),
`ARQUIVO_MARKED_GRACE_HOURS` (1); all sweeps bounded at `BATCH_LIMIT=100`.

## 9. ⭐ Recipe: extend arquivos to a NEW entity

Wiring files onto, say, `pedidos` or `clientes`:

1. **Path scope.** Generic, ungoverned files → `uploadFile` (lands in `media/`).
   Entity-scoped, sweepable files → add a subdir + path/id builders to
   `storagePaths.ts` (mirror `productOriginalPath`/`productArquivoId`), so the
   owner is recoverable from the path.
2. **Ref shape.** Add an `arquivoOuterRef` string field (or an array of
   `{ arquivoOuterRef }`, mirroring `anexoSchema`) to the entity's schema in
   `packages/schemas`. Keep it a plain `'arquivos/<id>'` string.
3. **UI.** Reuse `PhotoManager`/`VideoManager` if the entity wants product-style
   galleries, else follow their pattern for a new manager. Wire via `ObjectView`
   `renderInput` + `section` + `prepareForSave: stripMarkedForDeletion`. Upload
   through the §4 helpers — never hand-roll.
4. **🔴 Deletion — the trap.** The sweeps are **produto-scoped**:
   `fetchUnreferencedCandidates` only matches `produtos/<id>/(originals|videos)`
   (via `parseProductMediaDir`), and `resolveReferencedArquivoRefs` reads produto
   `fotos`/`videos`/`anexos`. **A new entity's files are NOT auto-reaped.** You must
   either (a) extend `parseProductMediaDir` + the candidate query + `resolveReferenced`
   to cover the new owner, and/or (b) add an eager trigger modeled on
   `onProdutoMediaChanged` (diff the entity's ref array → mark). Skip this and you
   create **silent orphans** that nothing ever cleans up. If you knowingly defer
   it, say so and open an issue — don't leave it implicit.

The produto-*delete* cascade (`onDocumentDeleted('produtos/{id}')`, #136) and a
generic `anexos` uploader are the known next steps in this space — start from the
patterns above.

## 10. Server-side reuse

- **Admin handles** (`@delfrance/data/admin/collections`): `arquivoCollection`,
  `produtoCollection`. `defineAdminCollection` gives converter-less `.ref`/`.docRef`
  (Admin SDK needs raw refs for `.update`/`.delete`/`collectionGroup`); validate
  explicitly via `.parse`/`.set` (the `.set` parses against the schema input type).
  Note: there are **two** `arquivoCollection`s — the **client** one
  (`@delfrance/storage`, `defineCollection`, used by the UI) and this **admin** one.
- **`getDb()`** (`apps/functions/src/lib/admin.ts`) → the **named `'default'`**
  database (`FIREBASE_DATABASE_ID ?? 'default'`) — Firestore Enterprise, never
  `(default)`.
- **Reusable cores** (call instead of re-deriving): `resolveReferencedArquivoRefs(db, produtoIds)`
  (field-masked `getAll`, O(distinct owners)), the sweep functions, the idempotent
  `processProductOriginal(bucket, db, name)` (shared by the trigger + reconcile),
  `markUploadFinalized`, `arquivoIdForObject`.

## 11. Pitfalls

- **Firestore Enterprise**: the DB is named `'default'`; it **auto-creates no
  indexes**. All three sweep queries are declared in `firestore.indexes.json` —
  `arquivos(uploadState, criadoEm)`, `arquivos(criadoEm)`,
  `arquivos(markedForDeletionAt)` — and must be deployed:
  `firebase deploy --only firestore:indexes` (Lucas's job — shared infra).
- **`.nullable().default(null)`, never bare `.optional()`** — Firebase JS SDK v12
  rejects `undefined` in `setDoc`/`addDoc`.
- **Rules**: the `arquivos` rules block is **permission-only** over a
  `.passthrough()` schema — adding an arquivo field causes **no rules-gen drift**.
  Still run `pnpm --filter @delfrance/rules-gen gen:rules` (CI's drift check
  confirms). Never hand-edit `firestore.rules` (it's generated).
- **Functions deploy does not read `.env.local`** — the build bundles src and
  inlines the region; secrets/config come from the deploy env, not the file.
- **Norton/TLS (dev box)**: `pnpm run <script>` hangs; run tooling via node
  directly (`node node_modules/.../tsc`, `vitest.mjs`, `eslint.js`); commit
  `--no-verify`. Never `git add` the untracked `infra/` (Lucas's Terraform).

## 12. Testing & verification

- **Emulator suite** (`ci-storage.yml`, Storage + Firestore emulators, ports
  8080/9199): `apps/functions/src/**/*.storage.test.ts`. This is the authority for
  trigger/sweep behavior. Locally:
  `firebase emulators:exec … "pnpm --filter @delfrance/functions test:storage"`.
- The unreferenced sweep pages `arquivos` by document key (a classic
  `FieldPath.documentId()` query, no Pipelines API involved since #234) and persists
  its round-robin cursor to `arquivoOrphanSweepState/cursor` — it runs in the
  emulator without a seam, though `fetchPage`/`resolveReferenced` stay overridable
  for cursor-mechanics unit tests. Grace envs are set to `0` in tests so
  freshly-written docs qualify.
- **Shared-emulator-bucket isolation**: the emulator bucket is shared across test
  files and there's no per-test teardown, so bucket-listing assertions are
  order-fragile — **delete any stray object you write** after your assertions
  (a real flake fixed this way in `resizeProductImage.storage.test.ts`).

## See also

- `apps/docs/src/content/docs/architecture/arquivo-lifecycle.md` — the flow + state-machine + coverage diagrams.
- `apps/docs/src/content/docs/adr/0010-produto-deletion-lifecycle.md` — the design decisions.
- `apps/functions/CLAUDE.md` — operational notes for the 5 functions + deploy gotchas.
- `schema-driven-crud` skill — for the surrounding form/`ObjectView` mechanics.
