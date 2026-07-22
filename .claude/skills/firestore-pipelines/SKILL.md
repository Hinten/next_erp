---
name: firestore-pipelines
description: >-
  Use when querying Firestore with the Pipelines API in this monorepo —
  buildPipeline/PipelineSpec, usePipelineSnapshot, admin
  @google-cloud/firestore/pipelines, pipeline vs classic query, Enterprise
  indexing (no auto indexes, silent full-scan billing), and testing code that
  touches pipelines (emulator can't run them).
---

# Firestore Pipelines

How and when to use the Firestore **Pipelines API** in this repo — the
client wrapper in `packages/data`, the one real admin consumer, indexing, and
how to test code that depends on either without an emulator.

## 1. When to use a pipeline vs a classic query

Pipelines are a **one-shot** read: `execute(pipeline)` (client) or
`.execute()` (admin) returns a snapshot once — there is no `onSnapshot`
analogue in firebase@12 / admin v14 yet. Reach for one when you need a
capability classic `Query` doesn't have:

- **Substring / accent-insensitive search** (`regexContains` — see §2).
- **Field projection** (`select`) to cut payload on a wide document.
- **Restricting to an explicit id set** (`documents([...])`, wrapped as
  `idIn` — no classic equivalent besides chunked `in`/`==` on `__name__`).

Stay on the classic `buildQuery` path (`packages/data`'s query builders) when
you need:

- **Realtime** — anything behind `onSnapshot`/`useSnapshot`. A pipeline
  result goes stale the moment something else writes; it does not refresh
  itself.
- **Cursors / pagination** — pipelines have no `startAfter`. Paginate with a
  `lt`/`gt` range filter on the sort field instead (see `TableView`'s
  `effectiveLimit` + re-query-on-scroll pattern).
- **The emulator lane** — `ci-storage.yml`, `ci-rules.yml`, and
  `e2e-emulator.yml` cannot run pipelines at all (§5). Code that must be
  emulator-tested needs a classic-query path, even if a pipeline path also
  exists for staging/prod.

`TableView` (`packages/ui/src/table/TableView.tsx`) is the reference for
"try pipeline, fall back to classic": it builds a pipeline, and only when
`buildPipeline` throws `PipelineUnsupportedError` (or `queryOverride` is
passed) does it build the equivalent classic `Query`. Both branches share the
same filter/sort/limit inputs so they stay in lockstep — copy that shape
rather than inventing a third one.

## 2. Client surface (`packages/data/src/pipeline-queries.ts`)

`PipelineSpec` is a small declarative model over a `Pipeline`'s stages;
`buildPipeline(db, spec)` turns it into one:

| Spec field | Stage | Notes |
| --- | --- | --- |
| `collection` | `db.pipeline().collection(path)` | source, unless `idIn` is set |
| `idIn` | `db.pipeline().documents([...])` | non-empty → sources from those exact doc paths instead of the whole collection; **`idIn: []` THROWS** — an empty id set means "no rows", and falling through to the collection source would silently full-scan it |
| `search` | `.where(regexContains(...))`, OR-combined across fields | accent-folded substring match, see below |
| `filters` | `.where(...)`, AND-combined (with `search`, as a **second** `where` stage) | see the op table below |
| `orderBy` | `.sort(ascending\|descending(field(...)))` | |
| `select` | `.select(...)` | projection — see below |
| `limit` | `.limit(n)` | |

**Filter-op table** (`PipelineFieldFilter.op`): `contains` (accent-folded
`regexContains`), `startsWith`, `eq`, `lt`, `lte`, `gt`, `gte`,
`array-contains`, `array-contains-any`. Every op takes a scalar `value`
**except** `array-contains-any`, which takes a candidate list — passing an
array to any other op throws (`filterExpr`'s runtime guard: the TS type
admits an array on every op, so this is the check that turns a
would-be-silent nonsense comparison into a clear error). Two empty-list
throw rules mirror each other and both mean the same thing — the caller must
short-circuit to an empty result set **before** calling `buildPipeline`,
not let it throw as control flow:

- `array-contains-any` filter with `value: []`.
- `idIn: []`.

`TableView` does exactly this (`extraEmpty`/`lookupEmpty` checks before the
`buildPipeline` call).

**Select + the `rowId` round-trip.** `.select()` makes the server return
ad-hoc records with no document key, so `PipelineResult.ref` comes back
`undefined` — you lose row identity unless you ask for it back. `select`
entries can be a bare field-path string, or `{ field, as }` to project under
an alias (`PipelineSelectEntry = string | { field: string; as: string }` —
useful for pulling a nested path like `changes.precos` out under a short
name). Whatever you pass, `buildPipeline` always appends one more
projection: `documentId(field('__name__')).as(PIPELINE_ID_FIELD)`
(`PIPELINE_ID_FIELD = 'rowId'`, a plain alias — Firestore reserves
`__`-wrapped names for projection output). `usePipelineSnapshot`
(`packages/data/src/hooks/usePipelineSnapshot.ts`) reads `rowId` back off
each result and deletes it from `row.data` before handing rows to the
caller, so consumers never see the alias leak through.

**Search** (`buildSimilarityPattern`/`buildSimilarityRegExp`): input is
trimmed, NFD-normalized to strip diacritics, lowercased, regex-escaped, then
each ASCII vowel/`c`/`n`/`y` is expanded back to its accented character
class (e.g. `"Açaí"` → `(?i)[aàáâãäå][cç][aàáâãäå][iìíîï]`) and prefixed with
the pipeline-only `(?i)` inline flag. Empty/whitespace input returns `''`
(pattern) or `null` (RegExp) so callers can skip the filter unconditionally
instead of branching. `buildSimilarityRegExp` strips the `(?i)` flag and
applies JS's `i` flag instead — use it for **client-side** filtering on the
classic-query fallback, which can't push a regex to the server.

## 3. Admin surface (`@google-cloud/firestore/pipelines`)

There is no `@delfrance/data` admin wrapper — Cloud Functions import the
builders directly, namespaced (the module is `export =`d, so a named import
doesn't work):

```ts
import * as pipelines from '@google-cloud/firestore/pipelines';

const snap = await db
  .pipeline()
  .collection(ARQUIVOS_COLLECTION)
  .where(
    pipelines.and(
      pipelines.lessThan(pipelines.field('criadoEm'), cutoffMicros),
      pipelines.regexContains('filepath', OWNED_MEDIA_DIR_REGEX),
    ),
  )
  .sort(pipelines.ascending(pipelines.field('criadoEm')))
  .limit(BATCH_LIMIT)
  .execute();
```

This is `fetchUnreferencedCandidates` in
`apps/functions/src/arquivos/arquivoOrphanSweep.ts` — the regex-on-`filepath`
scope of `sweepUnreferencedArquivos`, the real (today, only) admin pipeline
consumer. `row.ref` is present here because there's no `select` stage; when
you do add one server-side, the same "ref disappears" rule from §2 applies
— project the id back explicitly if you need it. Requires firebase-admin v14
/ `@google-cloud/firestore` v8 — see root `CLAUDE.md` rule on the admin
floor.

## 4. Indexing

**Every** pipeline query needs an entry in `firestore.indexes.json`, exactly
like a classic query — Firestore *Enterprise* edition auto-creates **zero**
indexes, and an unindexed query does not fail, it silently full-scans and
Enterprise bills by **data scanned**. There is no one-click index link to
notice the mistake by. Two Enterprise deltas from what you'd expect off
Standard-edition docs: the database is the literally-named `default` (not
`(default)` — every admin/pipeline call here goes through `getDb()`, never a
bare `getFirestore()`), and index JSON has **no** implicit trailing
`__name__` field.

Entry shape (`arrayConfig` for an `array-contains`/`array-contains-any`
predicate, `order` for everything else, filters before sorts, matching
declaration order):

```json
{
  "collectionGroup": "historicoDeModificacoes",
  "queryScope": "COLLECTION",
  "fields": [
    { "fieldPath": "campos", "arrayConfig": "CONTAINS" },
    { "fieldPath": "timestamp", "order": "DESCENDING" }
  ]
}
```

Deploying is a manual, coordinated step (`firebase deploy --only
firestore:indexes`) — not something an agent runs. **Verify live** that a
query actually rode the index rather than trusting the JSON: run
`.explain({ analyze: true })` against a real project and assert
`metrics.planSummary.indexesUsed` is non-empty. `analyze: true` really
executes the query (billed as a normal read), which is what produces real
index + read stats — see `apps/functions/scripts/check-sweep-indexes.mjs`
for the pattern (it explains all three `arquivos` sweep queries and exits
non-zero if any comes back with no index used). The emulator can't run
`explain({ analyze: true })` — this check only runs against a live project.

## 5. Testing seams

Pipelines **never run in the emulator** — no client pipeline, no admin
pipeline, no `explain`. Anything the emulator-only suites
(`ci-storage.yml`, `ci-rules.yml`, `e2e-emulator.yml` — every
`*.emulator.e2e.spec.ts` / `*.storage.test.ts`) need to exercise must either
avoid pipelines or take a seam:

- **Client unit tests** — mock the whole subpath and assert the stages
  `buildPipeline` produces, not real Firestore behavior:
  `vi.mock('firebase/firestore/pipelines', () => mockPipelinesExports)` with
  a `vi.hoisted` fixture whose builder functions return small tagged objects
  (`{ kind: 'equal', l, r }`, …) so assertions read as
  `expect(stage.where).toHaveBeenCalledWith(expect.objectContaining({ kind:
  'and', ... }))`. Full pattern in `packages/data/src/pipeline-queries.test.ts`.
- **Admin code** — default-parameter dependency injection. Functions that
  read from a pipeline take the fetch as an overridable parameter defaulting
  to the real implementation, e.g. `sweepUnreferencedArquivos(db, bucket,
  fetchCandidates = fetchUnreferencedCandidates, resolveReferenced = ...)` —
  the emulator suite calls it with a stub `fetchCandidates` that returns
  fixture rows, exercising the surrounding delete/keep/error-isolation logic
  without ever calling `.pipeline()`. Gate anything that truly needs a live
  pipeline behind `describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)`
  style guards only where the *rest* of the suite is emulator-only —
  don't let one pipeline-dependent assertion silently skip a whole file.
- **Live verification** stands in for what the emulator can't cover:
  `check-sweep-indexes.mjs` (§4) is the "does this actually work against a
  real project" backstop for the seam you stubbed in the emulator suite.

## 6. Recipes

- **TableView column/search filters** — `packages/ui/src/table/TableView.tsx`
  (~L508-545 builds the pipeline, ~L566+ the classic fallback). Per-column
  filters become `PipelineFieldFilter`s; `meta.defaultQuery` base filters and
  page-owned `extraFilters` are AND-combined with them; the visible columns
  (plus any virtual-column `dependsOn`) become `select`; a subcollection
  lookup (e.g. filtering pedidos by a resolved NF-e chave) becomes `idIn`.
  Empty-candidate short-circuits happen **before** `buildPipeline` is called
  (`extraEmpty`/`lookupEmpty`), never inside a try/catch around it.
- **A produto history view** (`ProdutoHistoryButton`, `apps/web/app/(app)/produtos/_components`) —
  `filters: [{ field: 'campos', op: 'array-contains', value: 'precos' }]`
  scopes to entries touching the `precos` field, `orderBy: [{ field:
  'timestamp', direction: 'desc' }]`, and `select` projects only
  `changes.<field>` (aliased to a short name) + `timestamp` — a document with
  a large `changes` map never crosses the wire in full. Needs the
  `historicoDeModificacoes(campos CONTAINS, timestamp DESC)` index (§4).
- **The arquivo orphan sweep's regex pipeline** — §3's
  `fetchUnreferencedCandidates`: a `filepath` regex plus a `criadoEm` range,
  sorted, limited — the admin-side "search across a directory-shaped field"
  pattern to copy when a new sweep needs the same shape.

## 7. Gotchas

- **Always feature-detect, don't assume.** `isPipelineSupported(db)` checks
  `typeof db.pipeline === 'function'`; `buildPipeline` throws
  `PipelineUnsupportedError` if you skip the check and the SDK predates
  Pipelines. Catch *only* that specific error type to fall back to
  `buildQuery` — anything else escaping `buildPipeline` (a bad field path, an
  SDK bug) is a real bug and must propagate, not be swallowed into a silent
  fallback.
- **One-shot staleness** — a pipeline result does not update itself. A row
  created or deleted elsewhere won't appear/disappear until something
  re-executes the pipeline (a manual refresh action, an update-monitor
  banner, a remount). Don't build UI that assumes it behaves like
  `onSnapshot`.
- **`.select()` silently drops `PipelineResult.ref`.** If a query result is
  missing its document id downstream, check whether a `select` stage forgot
  to carry the `PIPELINE_ID_FIELD`/`rowId` projection through — `buildPipeline`
  does this automatically, but a hand-rolled pipeline (rare, but the admin
  surface has no wrapper) must add it manually.
- **The `(?i)` inline flag is pipeline-only.** Reusing
  `buildSimilarityPattern`'s output as a JS `RegExp` source will throw or
  behave oddly — use `buildSimilarityRegExp`, which strips the flag and
  applies `i` the JS way, for any client-side regex fallback.
