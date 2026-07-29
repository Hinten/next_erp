---
name: firestore-pipelines
description: >-
  Use when querying Firestore with the Pipelines API in this monorepo —
  buildPipeline/PipelineSpec, usePipelineSnapshot, admin
  @google-cloud/firestore/pipelines, pipeline vs classic query, Enterprise
  indexing (no auto indexes, silent full-scan billing), and testing code that
  touches pipelines (emulator can't run them). Also covers server-side joins:
  perform-joins-with-sub-pipelines, correlated subquery, define/variable,
  toScalarExpression/toArrayExpression, the subcollection stage, pipeline
  aggregate/distinct/unnest/union/sample/replaceWith, findNearest, and the
  pipeline update/delete DML output stages.
---

# Firestore Pipelines

How and when to use the Firestore **Pipelines API** in this repo — the client
wrapper in `packages/data`, the admin surface (joins, aggregations, DML),
Enterprise indexing, and how to test code that depends on either without an
emulator. **Full stage/function catalog: `references/api.md`.**

## 1. When to use a pipeline vs a classic query

Pipelines are a **one-shot** read: `execute(pipeline)` (client) or `.execute()`
(admin) returns a snapshot once — there is no `onSnapshot` analogue in
firebase@12 / admin v14 yet. Reach for one when you need a capability classic
`Query` doesn't have. The full set:

- **Correlated subqueries (server-side joins)** — a nested pipeline runs per
  outer document: lookups, per-parent arrays, correlated aggregates, anti-joins,
  INNER-JOIN-shaped `unnest`. Classic Firestore has no join at all (§4).
- **Aggregate / distinct with grouping** — `aggregate(...)` (count/sum/avg/min/
  max/first/last/arrayAgg…), optionally grouped; `distinct(...)`; HAVING-style
  `where` after `aggregate`. Classic aggregation is count/sum/avg only, ungrouped.
- **Server-computed fields** via `addFields`/`select` — the whole function catalog
  (arithmetic, string, timestamp, array, map, type, reference, vector).
- **`unnest`** (array → one row per element), **`union`**, **`sample`**,
  **`replaceWith`**, **`offset`**, **`findNearest`** vector KNN (dim ≤ 2048).
- **Substring / accent-insensitive search** (`regexContains`, RE2 — §2), **field
  projection** (`select`), **explicit id set** (`documents([...])`, wrapped `idIn`).
- **DML output stages** — `update()` / `delete()` write the result set back
  (admin/server only, **@beta**, no rules, no transactions — §4, §9).

Stay on the classic `buildQuery` path (`packages/data`'s query builders) when
you need:

- **Realtime** — anything behind `onSnapshot`/`useSnapshot`. A pipeline result
  goes stale the moment something else writes; it does not refresh itself.
- **Cursors / pagination** — pipelines have no `startAfter`/`startAt`/`endAt`;
  use `offset`+`limit` or a keyset predicate (§5), or bridge a cursored `Query`
  via `PipelineSource.createFrom(query)`.
- **The emulator lane** — `ci-storage.yml`, `ci-rules.yml`, `e2e-emulator.yml`
  cannot run pipelines at all (§7). Emulator-tested code needs a classic-query
  path even if a pipeline path also exists for staging/prod.

`TableView` (`packages/ui/src/table/TableView.tsx`) is the reference for "try
pipeline, fall back to classic": it builds a pipeline, and only when
`buildPipeline` throws `PipelineUnsupportedError` (or `queryOverride` is passed)
does it build the equivalent classic `Query`. Both branches share the same
filter/sort/limit inputs so they stay in lockstep — copy that shape rather than
inventing a third one.

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
**except** `array-contains-any`, which takes a candidate list — passing an array
to any other op throws (`filterExpr`'s runtime guard: the TS type admits an
array on every op, so this is the check that turns a would-be-silent nonsense
comparison into a clear error). Two empty-list throw rules mirror each other and
both mean the same thing — the caller must short-circuit to an empty result set
**before** calling `buildPipeline`, not let it throw as control flow:

- `array-contains-any` filter with `value: []`.
- `idIn: []`.

`TableView` does exactly this (`extraEmpty`/`lookupEmpty` checks before the
`buildPipeline` call).

**Select + the `rowId` round-trip.** `.select()` makes the server return ad-hoc
records with no document key, so `PipelineResult.ref` comes back `undefined` —
you lose row identity unless you ask for it back. `select` entries can be a bare
field-path string, or `{ field, as }` to project under an alias
(`PipelineSelectEntry = string | { field: string; as: string }` — useful for
pulling a nested path like `changes.precos` out under a short name). Whatever you
pass, `buildPipeline` always appends one more projection:
`documentId(field('__name__')).as(PIPELINE_ID_FIELD)` (`PIPELINE_ID_FIELD =
'rowId'`, a plain alias — Firestore reserves `__`-wrapped names for projection
output). `usePipelineSnapshot` (`packages/data/src/hooks/usePipelineSnapshot.ts`)
reads `rowId` back off each result and deletes it from `row.data` before handing
rows to the caller, so consumers never see the alias leak through. The `rowId`
output name is RESERVED — `buildPipeline` throws if any select entry (bare string
or `{ as }`) would emit its own field under it.

**Search** (`buildSimilarityPattern`/`buildSimilarityRegExp`): input is trimmed,
NFD-normalized to strip diacritics, lowercased, regex-escaped, then each ASCII
vowel/`c`/`n`/`y` is expanded back to its accented character class (e.g. `"Açaí"`
→ `(?i)[aàáâãäå][cç][aàáâãäå][iìíîï]`) and prefixed with the pipeline-only `(?i)`
inline flag. Empty/whitespace input returns `''`/`null` so callers can skip the
filter without branching. `buildSimilarityRegExp` strips `(?i)` and applies JS's
`i` flag instead — use it for **client-side** filtering on the classic-query
fallback, which can't push a regex to the server.

## 3. Admin surface (`@google-cloud/firestore/pipelines`)

There is no `@delfrance/data` admin wrapper — Cloud Functions import the builders
directly, namespaced (the module is `export =`d, so a named import doesn't work).
The full expression/stage catalog lives in the `FirebaseFirestore.Pipelines`
namespace of `@google-cloud/firestore` v8; **`references/api.md`** enumerates it.

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

This was `fetchUnreferencedCandidates` in
`apps/functions/src/arquivos/arquivoOrphanSweep.ts` until #234: the regex-on-
`filepath` scan rode the `arquivos(criadoEm)` index but always re-read the same
oldest documents, so a large head of long-lived referenced photos could starve
newer orphans out of the scan window forever. The fix pages by document key
instead (`FieldPath.documentId()`, a **classic** query with a persisted cursor —
see the `arquivos` skill and `apps/functions/CLAUDE.md`), which does not need
this shape at all — there is currently no live admin pipeline consumer in the
repo. The snippet above is kept as the reference shape for the next one: `row.ref`
is present here because there's no `select` stage; when you do add one
server-side, the same "ref disappears" rule from §2 applies — project the id back
explicitly if you need it. Requires firebase-admin v14 / `@google-cloud/firestore`
v8 — see root `CLAUDE.md` rule on the admin floor.

**Method spellings are the SDK's, not the docs'.** The public docs are internally
inconsistent (`.equals()`, `eq()`, `Field.of()`, `.let()`, `.asScalarExpression()`,
snake_case `.replace_with(...)`). The installed v8.6.0 typings expose only
`.equal()`, `field(...)`, `.define(...)`, `.toScalarExpression()`,
`.replaceWith(...)`. Trust the typings — `references/api.md` §"v8.6.0 deltas"
lists every doc-vs-SDK divergence and every documented function the installed SDK
does **not** ship (`literals`, `cmp`, `error`, `currentContext`, `manhattanDistance`,
`referenceSlice`, `log`, `replaceWith` merge modes, …).

## 4. Correlated subqueries / joins (admin/server)

Enterprise supports relational-style joins through **correlated subqueries**: a
nested `db.pipeline()...` is embedded as an *expression* (not a top-level stage)
inside `select`/`addFields`/`where`/`sort`, and executes once per outer document.
The correlation mechanism is `define` + `variable`. Examples below elide the
`pipelines.` namespace prefix on builders (`field`, `variable`, `average`, …) —
import them as in §3.

Three embed shapes (all present and typed in v8.6.0):

- **`toScalarExpression()`** — subquery must yield 0 or 1 row; 0 rows → `null`;
  **>1 row → runtime error**. Single output field is unwrapped to a raw scalar;
  multiple fields wrap into a map. Use for lookups and correlated aggregates.
- **`toArrayExpression()`** — subquery yields an array (0 rows → **empty array**,
  never null); the subquery's `sort` controls element order; single-field rows
  unwrap to raw values, multi-field rows stay as objects.
- **standalone `subcollection('name')`** — a database-less source that joins on
  the outer doc's `__name__` implicitly (parent `/cities/SF` →
  `/cities/SF/name`). **Only valid inside a subquery**; executing it directly
  fails. Empty/absent subcollection → empty result (not an error).

```ts
// Lookup (scalar subquery on __name__):
db.pipeline()
  .collectionGroup('reviews')
  .define(field('restaurant').as('restaurant_name'))
  .addFields(
    db.pipeline()
      .collectionGroup('restaurants')
      .where(field('__name__').equal(variable('restaurant_name')))
      .select('name', 'type')
      .toScalarExpression()
      .as('restaurant'),
  );

// Per-parent array (top-N to bound memory):
db.pipeline()
  .collectionGroup('restaurants')
  .define(field('__name__').as('restaurant_name'))
  .select(
    field('name'),
    db.pipeline()
      .collectionGroup('reviews')
      .where(field('restaurant').equal(variable('restaurant_name')))
      .sort(field('rating').descending())
      .limit(2)
      .select('rating', 'reviewer_id')
      .toArrayExpression()
      .as('top_reviews'),
  ); // restaurant with 0 reviews → { name, top_reviews: [] }

// Correlated aggregate:
.aggregate(average('rating').as('avg')).toScalarExpression().as('avg_rating')

// Anti-join (NOT EXISTS) / filter on a subquery:
.where(
  db.pipeline().collectionGroup('reviews')
    .where(field('restaurant').equal(variable('restaurant_name')))
    .aggregate(count().as('c')).toScalarExpression().equal(0),
)

// INNER JOIN shape — unnest a per-parent array into flat rows
// (outer doc duplicated per element; parents with 0 matches drop out):
.unnest(
  db.pipeline().collectionGroup('reviews')
    .where(field('restaurant').equal(variable('restaurant_name')))
    .select('rating', 'reviewer_id')
    .toArrayExpression()
    .as('review'),
)

// Subcollection sugar (count children without naming the join key):
.addFields(subcollection('restaurants').toArrayExpression().length().as('restaurant_count'))
```

**Scope semantics** (the trap): a **field** (`field('x')`) is *local* to the row
the subquery is currently processing — an undefined field evaluates to **absent**,
no error. A **variable** (`variable('x')`) is *global* to the pipeline and all
nested subqueries — referencing an **undefined variable is a runtime error**. So
correlate to the outer row only through `define`d variables, never by hoping a
field name resolves upward. Variables fall out of scope at the first `aggregate`
/`distinct` (a "merging" stage) and are omitted from output unless re-`select`ed.
Multi-condition joins: `.define(field('owner_id'), field('__name__'))` binds
several at once. Nesting depth ≤ 20; the 128 MiB materialization limit spans the
**whole** query including joined docs, so `select`/`where`/`limit` *inside* the
subquery to keep arrays small. Each subquery's `where` needs its **own** index
(§6) — a join without a seekable index full-scans per outer row.

## 5. Pagination

No cursor API on `Pipeline`. Two options:

- **`offset(n)` + `limit(n)`** — the documented mechanism, but `offset` still
  **scans and bills** every skipped row (Enterprise bills data scanned), so deep
  pages get linearly more expensive. Fine for a few shallow pages.
- **Keyset pagination** (preferred for deep paging) — sort by the page field plus
  `__name__` as a total-order tiebreaker, then filter past the last row of the
  previous page with a tuple predicate:

  ```ts
  .sort(field('criadoEm').ascending(), field('__name__').ascending())
  .where(
    or(
      greaterThan(field('criadoEm'), lastCriadoEm),
      and(
        equal(field('criadoEm'), lastCriadoEm),
        greaterThan(field('__name__'), constant(lastRef)),
      ),
    ),
  )
  .limit(pageSize)
  ```

  The composite index **must declare `__name__` explicitly** — Enterprise omits
  the implicit trailing `__name__` that Standard-edition indexes carry (§6).

To reuse an existing cursored classic `Query` (with `startAfter`, etc.), convert
it: `db.pipeline().createFrom(existingQuery)` — the only bridge that carries
cursors into a pipeline.

## 6. Indexing

**Every** pipeline query needs an entry in `firestore.indexes.json`, exactly like
a classic query — Firestore *Enterprise* edition auto-creates **zero** indexes,
and an unindexed query does not fail, it silently full-scans and Enterprise bills
by **data scanned**. There is no one-click index link to notice the mistake by.
Two Enterprise deltas from what you'd expect off Standard-edition docs: the
database is the literally-named `default` (not `(default)` — every admin/pipeline
call here goes through `getDb()`, never a bare `getFirestore()`), and index JSON
has **no** implicit trailing `__name__` field (add it explicitly for keyset
tiebreakers, §5).

Beyond the top-level query, **each correlated sub-pipeline's `where` needs its
own index consideration** (§4) — a join seeks the inner collection once per outer
row, and without an index that seek is a scan multiplied by the outer count.
`aggregate` and `distinct` without a covering index buffer all groups/values in
the 128 MiB memory budget and can `RESOURCE_EXHAUSTED`.

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
firestore:indexes`) — not something an agent runs. **Verify live** that a query
actually rode the index rather than trusting the JSON. For a classic query, run
`.explain({ analyze: true })` against a real project and assert
`metrics.planSummary.indexesUsed` is non-empty (`analyze: true` really executes,
billed as a read — see `apps/functions/scripts/check-sweep-indexes.mjs`, which
explains all three `arquivos` sweep queries and exits non-zero on any missing
index). A **pipeline has no `.explain()` method** — its explain rides on
`execute({ explainOptions: { mode: 'analyze' } })`, read via
`snapshot.explainStats.text` (only `'text'` output is typed in v8.6.0). The
emulator can't run explain either form — live project only.

## 7. Testing seams

Pipelines **never run in the emulator** — no client pipeline, no admin pipeline,
no `explain`. Anything the emulator-only suites (`ci-storage.yml`, `ci-rules.yml`,
`e2e-emulator.yml` — every `*.emulator.e2e.spec.ts` / `*.storage.test.ts`) need
to exercise must either avoid pipelines or take a seam:

- **Client unit tests** — mock the whole subpath and assert the stages
  `buildPipeline` produces, not real Firestore behavior:
  `vi.mock('firebase/firestore/pipelines', () => mockPipelinesExports)` with a
  `vi.hoisted` fixture whose builder functions return small tagged objects
  (`{ kind: 'equal', l, r }`, …) so assertions read as
  `expect(stage.where).toHaveBeenCalledWith(expect.objectContaining({ kind:
  'and', ... }))`. Full pattern in `packages/data/src/pipeline-queries.test.ts`.
- **Admin code** — default-parameter dependency injection. Functions that read
  from a pipeline should take the fetch as an overridable parameter defaulting to
  the real implementation, e.g. `someSweep(db, fetchCandidates =
  fetchCandidatesViaPipeline, resolveReferenced = ...)` — the emulator suite calls
  it with a stub `fetchCandidates` that returns fixture rows, exercising the
  surrounding delete/keep/error-isolation logic without ever calling
  `.pipeline()`. Gate anything that truly needs a live pipeline behind
  `describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)` style guards only where
  the *rest* of the suite is emulator-only — don't let one pipeline-dependent
  assertion silently skip a whole file.
- **Live verification** stands in for what the emulator can't cover:
  `check-sweep-indexes.mjs` (§6) is the "does this actually work against a real
  project" backstop for the seam you stubbed in the emulator suite.

## 8. Recipes

- **TableView column/search filters** — `packages/ui/src/table/TableView.tsx`
  (~L508-545 builds the pipeline, ~L566+ the classic fallback). Per-column
  filters become `PipelineFieldFilter`s; `meta.defaultQuery` base filters and
  page-owned `extraFilters` are AND-combined with them; the visible columns (plus
  any virtual-column `dependsOn`) become `select`; a subcollection lookup (e.g.
  filtering pedidos by a resolved NF-e chave) becomes `idIn`. Empty-candidate
  short-circuits happen **before** `buildPipeline` is called
  (`extraEmpty`/`lookupEmpty`), never inside a try/catch around it.
- **A produto history view** (`ProdutoHistoryButton`,
  `apps/web/app/(app)/produtos/_components`) — `filters: [{ field: 'campos', op:
  'array-contains', value: 'precos' }]` scopes to entries touching the `precos`
  field, `orderBy: [{ field: 'timestamp', direction: 'desc' }]`, and `select`
  projects only `changes.<field>` (aliased to a short name) + `timestamp` — a
  document with a large `changes` map never crosses the wire in full. Needs the
  `historicoDeModificacoes(campos CONTAINS, timestamp DESC)` index (§6).
- **Search across a directory-shaped field** — §3's snippet (`filepath` regex
  plus a `criadoEm` range, sorted, limited) is the pattern to copy for a NEW
  sweep that genuinely needs server-side substring scoping. The arquivo orphan
  sweep itself moved off this shape in #234 (a persisted round-robin cursor over
  a classic document-key query fixed a coverage gap the regex-pipeline sort
  couldn't) — see `apps/functions/CLAUDE.md` — but the snippet remains the right
  starting point for a query that DOES need `regexContains`.
- **A correlated-join sweep** (pattern, not yet in-repo) — for "parents with an
  aggregate over their children" in one round trip, prefer a
  `define`+`toScalarExpression` subquery (§4) over N+1 classic reads; keep each
  subquery indexed and bounded (`limit`/`select`), and wrap it in the DI seam
  since it is staging/prod-only (no emulator, §7).

## 9. Gotchas

- **Zero-result executions carry NO `explainStats`** (admin v8.6.0,
  staging-verified): `execute({ explainOptions: { mode: 'analyze' } })` returns
  `explainStats: undefined` whenever `results` is empty — the plan is simply
  lost, even though the backend computed one. When capturing plans (e.g.
  `check-stock-indexes.mjs`-style gates), make sure the probed window/filters
  actually match rows, or retry with a widened constant of the SAME stage shape
  and label it.
- **Always feature-detect, don't assume.** `isPipelineSupported(db)` checks
  `typeof db.pipeline === 'function'`; `buildPipeline` throws
  `PipelineUnsupportedError` if you skip the check and the SDK predates Pipelines.
  Catch *only* that specific error type to fall back to `buildQuery` — anything
  else escaping `buildPipeline` (a bad field path, an SDK bug) is a real bug and
  must propagate, not be swallowed into a silent fallback.
- **One-shot staleness** — a pipeline result does not update itself. A row created
  or deleted elsewhere won't appear/disappear until something re-executes the
  pipeline (a manual refresh action, an update-monitor banner, a remount). Don't
  build UI that assumes it behaves like `onSnapshot`.
- **Stages may be reordered by the optimizer; result order is unstable without
  `sort`.** The chained stages only guarantee the *result* equals in-order
  execution, not the physical plan; every input stage returns an unstable order,
  so add an explicit `sort(...)` whenever order matters (append `field('__name__')`
  for a total order). `limit`/`offset`/`sample` without a preceding `sort` can
  return different rows across runs.
- **Absent field vs undefined variable.** A missing `field(...)` is *absent* (safe,
  filtered out by `where`); an undefined `variable(...)` is a hard runtime error
  (§4). `where` filters out any row where the condition is **non-true** — that
  includes `null`, absent, and error results, not just `false`.
- **`.select()` silently drops `PipelineResult.ref`/`id`.** Projected, aggregated,
  or subquery-shaped rows are "non-document results" → `ref`/`id`/`createTime`/
  `updateTime` are `undefined`. `buildPipeline` re-projects the id as `rowId` (§2);
  a hand-rolled admin pipeline must carry `__name__` through itself for identity.
- **The `(?i)` inline flag is pipeline-only.** Reusing `buildSimilarityPattern`'s
  output as a JS `RegExp` source will throw or behave oddly — use
  `buildSimilarityRegExp`, which strips the flag and applies `i` the JS way, for
  any client-side regex fallback.
- **DML stages are @beta, ruleless, and non-transactional.** `update()`/`delete()`
  run only admin/server-side, ignore Security Rules (rule-based attempts denied),
  can't run in a transaction, fail on first error (partial success possible), and
  must be the terminal stage over a `where`-filtered set — a `delete()` with no
  `where` wipes the collection. Not usable from `apps/web`.
