# Firestore Pipelines — full stage & function catalog

Distilled from the public docs sweep (42 pages, "last updated 2026-07-20 UTC")
plus the **installed `@google-cloud/firestore` v8.6.0** typings
(`node_modules/.pnpm/@google-cloud+firestore@8.6.0/.../types/firestore.d.ts`,
namespace `FirebaseFirestore.Pipelines`). Names below are the **admin-SDK
(camelCase)** spellings — the wire/doc names are snake_case (`array_contains` →
`arrayContains`). When the docs and the installed SDK disagree, **the SDK is
authoritative for what is callable today** — every divergence is in §7.

Conventions: `E`=`Expression`, `BE`=`BooleanExpression`, `FE`=`FunctionExpression`,
`AF`=`AggregateFunction`. Nearly every builder has a field-name-first twin —
`fn(fieldName: string, …)` ≡ `fn(field(fieldName), …)`; written `str|E`. Most
functions exist as **both** a free function (`arrayContains(field('g'), 'x')`)
**and** an `Expression` method (`field('g').arrayContains('x')`); noted where only
one form exists. Import: `import * as pipelines from '@google-cloud/firestore/pipelines'`
(admin) or `firebase/firestore/pipelines` (client `execute(pipeline)` helper).

Edition: Pipelines are a **Firestore Enterprise edition (Native mode)** feature.
Not available in the emulator. Global limits: **60s deadline** (`DEADLINE_EXCEEDED`),
**128 MiB** materialized-data memory (`RESOURCE_EXHAUSTED`), `INTERNAL` = contact
support. Enterprise runs any query shape without an index (it full-scans instead
of failing) and **bills data scanned** — index hot queries (see SKILL.md §6).

---

## 1. Input stages

Every input stage **must be the first stage** of a pipeline (or sub-pipeline).
Except `literals`, all return documents in **unstable order** — add an explicit
`sort(...)` for determinism. Entry point: `db.pipeline()` returns a
`PipelineSource`.

| Stage | Signature (v8.6.0) | Behavior |
|---|---|---|
| `collection` | `collection(path: string \| CollectionReference)` · `collection(options: CollectionStageOptions)` | All docs of one collection. Nested via full path `"/cities/NY/departments"`. Options: `{ collection, forceIndex? }`. |
| `collectionGroup` | `collectionGroup(id: string)` · `collectionGroup(options)` | All docs in any collection with that leaf id, regardless of parent. Options: `{ collectionId, forceIndex? }`. |
| `database` | `database()` · `database(options: DatabaseStageOptions)` | Every document across the whole database, all collections/nesting. |
| `documents` | `documents(docs: Array<string \| DocumentReference>)` · `documents(options: { docs })` | Batch-read-like. Cannot contain duplicate paths. A missing doc is **silently omitted** (no error). **Throws** if a ref targets a different project/database. Converters on the refs are ignored; needs ≥1 doc. |
| `subcollection` | `subcollection(path: string)` · `subcollection(options: { path })` | **Standalone function**, database-less; joins on the outer doc's `__name__`. Subquery-only — executing it directly fails. See §5. |
| `createFrom` | `createFrom(query: Query)` | **SDK-only bridge** (not a doc stage): convert a classic `Query`, including its cursors, into an equivalent Pipeline. The only way to carry `startAfter`/`startAt`/`endAt` into a pipeline. |

- `collection`/`collectionGroup` accept a `forceIndex?: string` to override the
  optimizer's index choice.
- **`literals(...objects)`** — documented input stage (deterministic order matching
  definition order; accepts expressions like `{ x: constant('foo').length() }`;
  "for testing stages in isolation" / "as join input"). **Not present in the
  v8.6.0 `PipelineSource`** — see §7.
- **`rawStage(name, params)`** — SDK-only generic escape hatch (a `Pipeline`
  method, not `PipelineSource`): `.rawStage("where", [field('published').lessThan(1900)])`.

---

## 2. Transformation stages

Class doc: "the chained stages do not prescribe exactly how Firestore will
execute the pipeline… only guarantees the result is the same as if executed in
order" — i.e. **the optimizer may reorder**. `where` early, `limit`/`offset`
after a `sort`.

### where — `where(condition: BE)` · `where(options: { condition })`
Keeps rows where `condition` is **TRUE**; every **non-true** result — `FALSE`,
`NULL`, absent, or an evaluation error — is filtered out. Chained `where` stages
AND together; an **OR must be a single `where`** (`a.or(b)`). Placed **after
`aggregate`**, it filters on accumulated fields (SQL `HAVING`). Stage order
matters: `limit(10).where(...)` limits *then* filters.
```ts
.where(field('location.country').equal('USA')).where(field('population').greaterThan(500000))
.where(field('state').equal('NY').or(field('state').equal('CA')))
```

### sort — `sort(...orderings: Ordering[])` · `sort(options: { orderings })`
`Ordering` via `ascending(str|E)` / `descending(str|E)` or `expr.ascending()` /
`expr.descending()`. Follows Firestore value-type order across mixed types. An
**absent field sorts as `null`**. Ties are **nondeterministic** — append
`field('__name__')` for a total order. Of **consecutive** sort stages **only the
last matters**. `sort` + `limit(N)` enables a memory-bounded top-N sort.

### limit / offset — `limit(n)` · `offset(n)` (+ options forms)
`limit` returns the first N; `offset` skips the first N. **Both are unstable
without a preceding `sort`.** `offset` still **scans and bills** skipped rows.

### select — `select(...(Selectable|string)[])` · `select(options: { selections })`
Projects a subset / computed fields (aliased via `.as(name)`). **Fields not
selected are inaccessible downstream** (a `select` before a `where` on a dropped
field yields zero rows). Missing nested map/array values simply **omit the output
key** (`{ city: "Atlantis" }`). Array/map access = `offset(...)` / `getField(...)`
semantics. Empty `selections` → an empty document. **Drops `ref`/`id`** (§SKILL 2/9).
```ts
.select(field('name').as('city'), field('location.country').as('country'), field('landmarks').arrayGet(0).as('top'))
```

### addFields — `addFields(...fields: Selectable[])` · `addFields(options: { fields })`
Extends the previous schema with new/aliased fields; **an alias equal to an
existing field overwrites it**. Nested dot-paths update map keys and **implicitly
create missing parents**.
```ts
.addFields(field('age').abs().as('age')).addFields(field('address.city').toLower().as('address.city'))
```

### removeFields — `removeFields(fieldOrPath, ...more)` · `removeFields(options: { fields })`
Output = previous doc minus the named fields. Nested (`"location.state"`) removes
one map key, keeping siblings. **Missing field = no-op** (not an error).
**Removing array elements is unsupported.**

### aggregate — `aggregate(...accumulators: AliasedAggregate[])` · `aggregate(options: { accumulators, groups? })`
Computes accumulators (see §4 Aggregate) over the input. **Without `groups` →
one output document**; with `groups` → one per unique group combination. Grouping
uses **equality semantics**: `null`s group together; numerically equal values
(int32/int64/float64/decimal) group together and the **emitted group value may be
any** of the equivalent values (do not rely on which). Without a covering index it
**buffers all groups in memory** (128 MiB) — filter first or index.
```ts
.aggregate(countAll().as('n'), average('population').as('avg'))
.aggregate({ accumulators: [sum('population').as('total')], groups: ['country', 'state'] })
```
`groups` entries may be field-name strings, `field(p).as(a)`, or arbitrary
expressions (`equal(field('state'), null).as('state_is_null')`).

### distinct — `distinct(group, ...more)` · `distinct(options: { groups })`
"Distinct combinations of values" for the given expressions (strings or
`field(p).op().as(a)`). Same equality/type-equivalence semantics as `aggregate`
grouping; `null` is its own distinct value; buffers all distinct values in memory
without an index.

### findNearest — `findNearest(options: FindNearestStageOptions)`
`{ field: Field|string; vectorValue: VectorValue|number[]; distanceMeasure:
'euclidean'|'cosine'|'dot_product'; limit?: number; distanceField?: string }`.
KNN over a vector field; results **sorted by computed distance ascending**;
`distanceField` writes the computed distance into a named field. Max embedding
dimension **2048**. Docs recommend normalized vectors with `dot_product` over
`cosine`. (Note: **no `manhattan` measure** — §7.)

### define (`let`) — `define(...aliased: AliasedExpression[])` · `define(options: { variables })`
Binds expressions to named variables, in scope for all later stages **and nested
subqueries**. The stage is `let(...)` in prose but **`.define(...)` in the SDK**
(`let` is a JS keyword). See §5.
```ts
.define(field('price').multiply(0.8).as('discounted')).where(variable('discounted').lessThan(50))
```

### replaceWith — `replaceWith(fieldName: string)` · `replaceWith(expr: Expression)` · `replaceWith(options: { map: Expression|string })`
Replaces the document with the map the argument evaluates to. **Errors if the
expression is not a map.** ⚠ The public docs describe a second `mode` argument
(`"full_replace"` / `"merge_overwrite_existing"` / `"merge_keep_existing"`) — the
**v8.6.0 typed surface has no `mode`** (§7). Only full-replace-with-a-map is
expressible; merges need `addFields`/`removeFields` upstream.

### sample — `sample(documents: number)` · `sample(options: OneOf<{ percentage: number } | { documents: number }>)`
Documents mode: pick up to N random docs (uniform; if N ≥ input, all in random
order). Percent mode: `{ percentage }` a double in `0.0–1.0`, ~`count*percent`
docs, **preserving pre-existing order**, may return none or all. **Still scans
and processes all input** — no cost saving. (Docs prose says "percent"; the typed
key is `percentage`.)

### search — `@beta search(options: SearchStageOptions)`
**Must be the first stage.** Full-text / geospatial search. `SearchStageOptions`
in 8.6.0: `{ query: BE|string; languageCode?; retrievalDepth?; sort?; offset?;
limit?; addFields? }`. Companion expressions: `documentMatches(rquery)`, `score()`,
`geoDistance(field, location)` (all @beta, search-stage-only). `select`,
`queryEnhancement`, `snippet`, `matches`, `between` are commented-out TODOs — **not
available** (§7). Detailed behavior is delegated to the text-search / geospatial
guides (Pre-GA).

### union — `union(other: Pipeline)` · `union(options: { other })`
Runs a second pipeline in parallel and **concatenates** results. **No dedup**
(follow with `distinct`/`aggregate` to remove duplicates). **Nondeterministic
order** (follow with `sort`). Stages after `union` apply to the combined stream.
```ts
.collection('cities/SF/restaurants').where(field('type').equal('chinese'))
.union(db.pipeline().collection('cities/NYC/restaurants').where(field('type').equal('italian')))
.where(field('rating').greaterThanOrEqual(4.5))
```

### unnest — `unnest(selectable: Selectable, indexField?: string)` · `unnest(options: { selectable, indexField? })`
One output row per array element; each row = the input doc plus the element under
the alias. The alias **overwrites** a same-named field; `indexField` (if given)
holds the 0-based element index and likewise overwrites. **Non-array input →
passthrough** with `indexField` = `NULL`. **Empty array → no rows emitted.** Nested
arrays need sequential `unnest` stages. Produces the SQL INNER-JOIN shape when the
array is a correlated subquery (§5).

### rawStage — `rawStage(name: string, params: any[])`
SDK escape hatch to emit an arbitrary named backend stage.

---

## 3. Output / DML stages (@beta, admin/server only)

Both are **terminal** (last stage before `.execute()`) and require the incoming
documents to carry `__name__`. **Preview / Pre-GA.** Result snapshot summarizes
modifications, e.g. `{ documents_modified: 3L }`.

Shared semantics:
- **No Security Rules** — DML attempts through rules are denied; this is a
  server/Admin surface only.
- **No transactions** — cannot run inside a transaction during Preview.
- **Non-atomic across docs** — each document is processed independently;
  **fails on first error, partial success is possible**.
- **Fails if any target document doesn't exist** (for `update`).
- **Duplicate `__name__`** from the preceding stage: each instance is processed —
  `update` applies **multiple times**; `delete`'s later attempts are **no-ops**.

### update — `update()` · `update(transformedFields: AliasedExpression[])`
Writes the pipeline's transformed document (upstream `addFields`/`removeFields`
are what persist). Optional `transformedFields` act like a final `addFields`
evaluated against the previous documents right before writing.
```ts
await db.pipeline().collectionGroup('users')
  .where(not(exists(field('preferences.color'))))
  .addFields(constant(null).as('preferences.color')).removeFields('color')
  .update().execute();
```

### delete — `delete()`
Deletes **any** document referenced by `__name__` — **not restricted to the
source collection**. Always precede with a `where` to avoid mass deletion.
```ts
await db.pipeline().collectionGroup('users')
  .where(field('address.country').equal('USA'))
  .where(field('__create_time__').timestampAdd('day', 10).lessThan(currentTimestamp()))
  .delete().execute();
```

**Stages allowed before a DML stage:** `collection`, `collectionGroup`, `where`,
`select`, `addFields`, `removeFields`, `define`(let), `sort`, `limit`, `offset`.
**Not allowed before DML:** `aggregate`, `distinct`, `unnest`, `findNearest`, and
any multi-query stage (`union`, joins, sub-queries).

---

## 4. Function catalog (grouped as in the docs)

Scalar functions are usable in any expression-accepting stage (`where`, `select`,
`addFields`, `sort`, `distinct`, subquery embeds). Aggregate functions are only
valid inside `aggregate(...)`. Free-function and `.method()` forms are equivalent
unless flagged **method-only** / **free-only**.

### Aggregate — inside `aggregate(...)`, named via `.as(alias)`
| fn | signature | behavior / null-absent |
|---|---|---|
| `countAll` | `countAll() -> AF` | Count of all input docs. Free-only (zero-arg). |
| `count` | `count(str\|E) -> AF` · `expr.count()` | Count docs where expr is **non-NULL**. |
| `countIf` | `countIf(BE) -> AF` · `be.countIf()` | Count docs where the boolean is TRUE. |
| `countDistinct` | `countDistinct(str\|E) -> AF` | Count of unique **non-NULL, non-absent** values. |
| `sum` | `sum(str\|E) -> AF` | Sum of numeric values; non-numeric ignored; **NaN if any NaN**; int→double widening on overflow of int repr. |
| `average` | `average(str\|E) -> AF` | Mean of numeric values; non-numeric ignored; **NaN if any NaN; NULL if no numeric values**. |
| `minimum`/`maximum` | `minimum(str\|E) -> AF` | Min/max **non-NULL, non-absent** value (incl. when zero docs → `NULL`); ties return an arbitrary equal value; cross-type value ordering. |
| `first`/`last` | `first(str\|E) -> AF` | Value of expr for the first / last returned document (order-dependent → pair with `sort`). |
| `arrayAgg` | `arrayAgg(str\|E) -> AF` | Array of all values; absent→NULL; **order unstable**. |
| `arrayAggDistinct` | `arrayAggDistinct(str\|E) -> AF` | Array of distinct values; absent→NULL; order unstable. |

### Arithmetic — global rules: **NULL if any input NULL; NaN if any NaN; error on overflow/underflow.** Widening INT32 < INT64 < FLOAT64 < DECIMAL128 (int→float may lose precision).
| fn | signature | behavior |
|---|---|---|
| `add` | `add(str\|E, E\|num, ...more) -> FE` | Variadic `x+y`. |
| `subtract` | `subtract(str\|E, E\|num) -> FE` | `x-y`. |
| `multiply` | `multiply(str\|E, E\|num, ...more) -> FE` | Variadic `x*y`. |
| `divide` | `divide(str\|E, E\|num) -> FE` | `x/y`; **integer division truncates**; `int/0` → error; `1.0/0.0` → ±inf. |
| `mod` | `mod(str\|E, E\|num) -> FE` | Remainder; `y=0` **int → error**, `y=0.0` → **NaN**. |
| `ceil` | `ceil(str\|E) -> FE` | Smallest int ≥ x. |
| `floor` | `expr.floor() -> FE` | Largest int ≤ x. **Method-only** (no top-level `floor`). |
| `round` | `round(str\|E, places?) -> FE` | Round; away-from-zero on halves; negative `places` rounds left of decimal; overflow→error. |
| `trunc` | `trunc(str\|E, places?) -> FE` | Truncate toward zero; supports DECIMAL128. |
| `pow` | `pow(base: str\|E, exp: E\|num) -> FE` | `base^exp`; `base<=0 && exp<0` → error; `pow(_,0)`=1. |
| `sqrt` | `sqrt(str\|E) -> FE` | √x; negative → error; NaN→NaN. |
| `exp` | `exp(str\|E) -> FE` | e^x. |
| `ln` | `ln(str\|E) -> FE` | Natural log; `x<=0` → error; `ln(+inf)`=+inf. |
| `log10` | `log10(str\|E) -> FE` | Base-10 log; `x<=0` → error. |
| `abs` | `abs(E) -> FE` | Absolute value. **Expression-arg only** (no field-name overload). |
| `rand` | `rand() -> FE` | Uniform double in `[0.0, 1.0)`. Free-only. |
| `arraySum` | `arraySum(str\|E) -> FE` | Scalar sum of an array's numeric elements (≠ aggregate `sum`); non-numeric ignored; NaN if any NaN; no numeric → NULL. |

(**`log(number, base)`** — documented two-arg log; **not in v8.6.0**, §7. Scalar
cross-type `logicalMinimum`/`logicalMaximum` are under Logical below.)

### Array (scalar)
| fn | signature | behavior |
|---|---|---|
| `array` | `array(elements: unknown[]) -> FE` | Build an array; an absent element → NULL. |
| `arrayConcat` | `arrayConcat(str\|E, arrays..., ) -> FE` | Concatenate arrays. |
| `arrayContains` | `arrayContains(str\|E, value) -> BE` | Membership; nested-array equality; non-array → error. |
| `arrayContainsAll` | `arrayContainsAll(str\|E, values[]\|E) -> BE` | All present; `([...],[])`→true. |
| `arrayContainsAny` | `arrayContainsAny(str\|E, values[]\|E) -> BE` | Any present. |
| `arrayGet` | `arrayGet(str\|E, index: num\|E) -> FE` | 0-based; negative from end; **out-of-range → absent**; non-int index → error; non-array → error; `null`→null. |
| `arrayLength` | `arrayLength(str\|E) -> FE` | Element count. |
| `arrayReverse` | `arrayReverse(str\|E) -> FE` | Reverse. |
| `arrayFirst`/`arrayLast` | `(str\|E) -> FE` | First/last element; empty → absent. |
| `arrayFirstN`/`arrayLastN` | `(str\|E, n) -> FE` | First/last n; `n<0` → error. |
| `arrayIndexOf` | `arrayIndexOf(str\|E, value) -> FE` | First index; -1 if absent. |
| `arrayLastIndexOf` | `arrayLastIndexOf(str\|E, value) -> FE` | Last index. **SDK — not on the docs array page.** |
| `arrayIndexOfAll` | `arrayIndexOfAll(str\|E, value) -> FE` | All indices; `[]` if none. |
| `arraySlice` | `arraySlice(str\|E, offset, length?) -> FE` | **offset+length** (not start/end); negative offset from end; `length` non-negative. |
| `arrayMaximum`/`arrayMinimum` | `(str\|E) -> FE` | Max/min within the array; NULLs ignored; empty/all-null → NULL. |
| `arrayMaximumN`/`arrayMinimumN` | `(str\|E, n) -> FE` | n largest (desc) / smallest (asc); NULLs ignored; `n<0` → error. |
| `arrayFilter` | `arrayFilter(str\|E, alias: string, predicate: BE) -> FE` | **Lambda filter** — element bound to `variable(alias)`; non-bool/non-null predicate → error. |
| `arrayTransform` | `arrayTransform(str\|E, alias, transform: E) -> FE` | **Lambda map**; output same length. |
| `arrayTransformWithIndex` | `arrayTransformWithIndex(str\|E, elemAlias, idxAlias, transform) -> FE` | Lambda map with element + 0-based index vars. |
| `join` | `join(str\|E, delimiter: string\|E) -> E` | Join STRING/BYTES array into a string. ⚠ **2-arg only in SDK** (docs' 3rd `null_text` arg not typed, §7). |

### Comparison — relational ops **never match across incomparable types** (return FALSE, no error); every relational comparison involving **NaN is FALSE**; `equal` treats `NaN==NaN` TRUE and `NULL==NULL` TRUE but `NULL==ABSENT` FALSE (`notEqual` → TRUE); `1.0==1L` TRUE.
| fn | signature | notes |
|---|---|---|
| `equal` | `equal(str\|E, E\|unknown) -> BE` · `expr.equal(v)` | Equality. |
| `notEqual` | `notEqual(str\|E, E\|unknown) -> BE` | Inequality. |
| `lessThan`/`lessThanOrEqual` | `(str\|E, E\|unknown) -> BE` | `<` / `<=`; `NULL<=NULL` TRUE, `NULL<NULL` FALSE. |
| `greaterThan`/`greaterThanOrEqual` | `(str\|E, E\|unknown) -> BE` | `>` / `>=`. |
| `equalAny` | `equalAny(str\|E, values[]\|E) -> BE` | SQL `IN`; NULL matches a NULL element; NaN matches NaN. |
| `notEqualAny` | `notEqualAny(str\|E, values[]\|E) -> BE` | SQL `NOT IN`. |
| `exists` | `exists(str\|E) -> BE` | TRUE unless absent (NULL exists → TRUE). |
| `isType` | `isType(str\|E, type: string) -> BE` | Type match; absent input → NULL; **unknown type string → error**. |

(**`cmp(x, y)`** — documented cross-type 3-way compare (-1/0/1, sort-order-consistent,
`cmp(NULL,ABSENT)=0`); **not in v8.6.0**, §7.)

### Debugging / error-handling — operate on **ABSENT** (NULL counts as existing)
| fn | signature | behavior |
|---|---|---|
| `exists` | (above) | TRUE unless absent. |
| `isAbsent` | `isAbsent(str\|E) -> BE` | TRUE only if absent (FALSE for explicit `null`). |
| `ifAbsent` | `ifAbsent(str\|E, replacement) -> FE/E` | Replace if absent; **NULL is not replaced**. |
| `isError` | `isError(E) -> BE` | TRUE if `try` throws during evaluation. |
| `ifError` | `ifError(try, catch) -> FE/BE` | Value/catch fallback (type-preserving overloads). |
| `ifNull` | `ifNull(str\|E, replacement) -> FE` | Fallback when value is **NULL**. Docs table: **ABSENT is passed through, not replaced** (`ifNull(ABSENT,2)→ABSENT`). |
| `coalesce` | `coalesce(str\|E, replacement, ...more) -> FE` | First non-NULL, non-absent arg, lazily evaluated. **SDK — not on the docs logical page.** |

(**`error(message)`** — documented terminating error (lazily evaluated in
unreached `switchOn` branches); **not exported in v8.6.0**, §7.)

### Generic
| fn | signature | behavior |
|---|---|---|
| `currentDocument` | `currentDocument() -> E` | Map of all fields in current scope (`.define(currentDocument().as('doc'))` then `variable('doc').getField('title')`). |
| `concat` | `concat(first: E, second, ...more) -> FE` | Concatenate same-typed STRING/BYTES/ARRAY; **null → null; single arg → error; mixed types → error.** |
| `length` | `length(str\|E) -> FE` | Polymorphic length of STRING/BYTES/ARRAY/VECTOR/MAP; null→null; number→error. |
| `reverse` | `reverse(str\|E) -> FE` | Reverse STRING/BYTES/ARRAY; null→null; non-supported type→error. |

### Logical — three-valued: `and` a definite FALSE dominates → FALSE else NULL; `or` a definite TRUE dominates → TRUE else NULL; `xor`/`nor` mirror but **xor is strict** (any NULL/absent → NULL).
| fn | signature | behavior |
|---|---|---|
| `and`/`or`/`nor` | `(BE, BE, ...BE[]) -> BE` | Min 2 args. |
| `xor` | `xor(BE, ...BE[]) -> BE` | TRUE iff an odd number of inputs are TRUE; NULL/absent → NULL. |
| `not` | `not(BE) -> BE` · `be.not()` | Negation. |
| `conditional` | `conditional(cond: BE, then: E, else: E) -> FE` · `be.conditional(t, e)` | if/else; **NULL/ABSENT condition takes the else branch**. |
| `switchOn` | `switchOn(cond1, res1, ..., [default]) -> FE` | First TRUE wins; odd trailing arg = default; **no default + no match → error**. |
| `logicalMaximum`/`logicalMinimum` | `(str\|E, E\|unknown, ...more) -> FE` | Row-wise max/min across args by cross-type value order; skip NULL/absent; all NULL/absent → NULL. (Scalar counterpart of aggregate `maximum`/`minimum`.) |
| `equalAny`/`notEqualAny` | (Comparison) | IN / NOT IN. |
| `ifNull` | (Debugging) | |

### Map
| fn | signature | behavior |
|---|---|---|
| `map` | `map(elements: Record<string, unknown>) -> FE` | Build a map from an object literal (values may be expressions). Docs show variadic `map(key, value, …)`; **SDK takes one object** (§7). |
| `mapGet` | `mapGet(str\|E, key: string) -> FE` | Value by key; **missing key or non-map → ABSENT (no error)**. |
| `mapSet` | `mapSet(str\|E, key, value, ...moreKV) -> FE` | Immutable copy with entries set; **value ABSENT deletes the key**; non-map → absent. |
| `mapRemove` | `mapRemove(str\|E, key: string\|E) -> FE` | Copy with keys removed. |
| `mapMerge` | `mapMerge(str\|E\|Record, second, ...more) -> FE` | Merge maps; **last-wins** (left→right). |
| `mapKeys`/`mapValues` | `(str\|E) -> FE` | Keys / values array (**order not guaranteed**). |
| `mapEntries` | `mapEntries(str\|E) -> FE` | `[{k, v}, ...]`; `{}` → `[]`. |
| `getField` | `getField(str\|E, key: string\|E) -> E` | Get field from a map/document expr; **key may be dynamic** (`variable(...)`). |

(**`currentContext()`** — documented "map of all fields at this point"; **not in
v8.6.0**, §7 — use `currentDocument()`.)

### Reference — the REFERENCE type is a pointer to a document
| fn | signature | behavior |
|---|---|---|
| `documentId` | `documentId(E\|string\|DocumentReference) -> FE` | Document id of a ref (`documentId(field('__name__'))`). Return type ANY. |
| `parent` | `parent(E\|string\|DocumentReference) -> FE` | Parent ref; **root → NULL**. |
| `collectionId` | `collectionId(str\|E) -> FE` | Leaf collection id of a ref. |

(**`referenceSlice(ref, offset, length)`** — documented ref-segment slice; **not
in v8.6.0**, §7.)

### String — regex uses **RE2**; `like` uses `%` (any run) / `_` (single char), `\%` escapes a literal.
| fn | signature | behavior |
|---|---|---|
| `like` | `like(str\|E, pattern) -> BE` | Case-sensitive wildcard match. |
| `regexContains` | `regexContains(str\|E, pattern) -> BE` | Partial match; invalid regex → error. |
| `regexMatch` | `regexMatch(str\|E, pattern) -> BE` | **Full** match. |
| `regexFind`/`regexFindAll` | `(str\|E, pattern) -> FE` | First match / array of matches. **SDK — not on the docs string page.** |
| `stringContains` | `stringContains(str\|E, substr) -> BE` | Literal substring (empty → true). |
| `startsWith`/`endsWith` | `(str\|E, affix) -> BE` | Prefix/suffix (empty affix → true). |
| `toLower`/`toUpper` | `(str\|E) -> FE` | Case fold (STRING/BYTES; non-alpha passthrough). |
| `trim` | `trim(str\|E, chars?) -> FE` | Trim a char/byte **set** both ends (default whitespace); type-mixing STRING/BYTES → error. |
| `ltrim`/`rtrim` | `expr.ltrim(chars?)` / `expr.rtrim(chars?)` | Trim leading/trailing. **Method-only.** |
| `stringConcat` | `stringConcat(str\|E, second, ...more) -> FE` | Concatenate STRINGs; **zero args → error**. |
| `substring` | `substring(str\|E, position, length?) -> FE` | Code-point (STRING) / byte (BYTES) indexed; negative position from end; length non-negative. |
| `charLength`/`byteLength` | `(str\|E) -> FE` | Unicode-codepoint / byte length. |
| `reverse`/`stringReverse` | `(str\|E) -> FE` | Reverse (docs `STRING_REVERSE` → method `.reverse()`). |
| `split` | `split(str\|E, delimiter) -> FE` | Split to array; STRING default delimiter `,`; **BYTES requires a delimiter**; empty delimiter → codepoints/bytes; `""`→`[""]`. |
| `stringIndexOf` | `expr.stringIndexOf(search)` | First index (codepoints/bytes); -1 if absent; empty search → 0. **Method-only.** |
| `stringRepeat` | `expr.stringRepeat(n)` | Repeat n times; **result > 1 MB → error**. **Method-only.** |
| `stringReplaceAll`/`stringReplaceOne` | `expr.stringReplaceAll(find, repl)` | Case-sensitive; non-overlapping; empty `find` → no-op. **Method-only.** |
| `concat`/`length` | (Generic) | polymorphic. |

### Timestamp — `TimeUnit` = microsecond…day (add/sub/diff); `TimeGranularity` adds week[(day)]/isoweek/month/quarter/year/isoyear (truncate); `TimePart` adds dayofweek/dayofyear (extract). Timezones = tz-database names or GMT offsets; default UTC.
| fn | signature | behavior |
|---|---|---|
| `currentTimestamp` | `currentTimestamp() -> FE` | Request-time timestamp; **stable within a query**. |
| `unixMicrosToTimestamp`/`Millis`/`Seconds` | `(str\|E) -> FE` | Epoch int → TIMESTAMP; invalid → error. |
| `timestampToUnixMicros`/`Millis`/`Seconds` | `(str\|E) -> FE` | TIMESTAMP → epoch int (truncates down). |
| `timestampAdd` | `timestampAdd(str\|E, unit: TimeUnit, amount: num\|E) -> FE` | Add duration (negative = subtract); out-of-range → error. |
| `timestampSubtract` | `timestampSubtract(str\|E, unit, amount) -> FE` | Subtract. (Docs `TIMESTAMP_SUB` → **method `timestampSubtract`**.) |
| `timestampDiff` | `timestampDiff(end: str\|E, start: str\|E, unit) -> FE` | Whole units between; **negative if end < start**; truncates fractional. |
| `timestampTruncate` | `timestampTruncate(str\|E, granularity: TimeGranularity, timezone?) -> FE` | Truncate to granularity (respects DST). (Docs `TIMESTAMP_TRUNC`.) |
| `timestampExtract` | `timestampExtract(str\|E, part: TimePart, timezone?) -> FE` | Extract a part as INT64 (`dayofweek` 1=Sun..7=Sat; `isoweek`/`isoyear` ISO-8601). |

### Type
| fn | signature | behavior |
|---|---|---|
| `type` | `type(str\|E) -> FE` | Type name string (`"null"`,`"int64"`,`"map"`,`"reference"`,`"vector"`, …); **absent → NULL**. |
| `isType` | `isType(str\|E, type: string) -> BE` | (Comparison) — absent → NULL; unknown type string → error. |

`Type` union (v8.6.0): `'null'|'array'|'boolean'|'bytes'|'timestamp'|'geo_point'|
'number'|'int32'|'int64'|'float64'|'decimal128'|'map'|'reference'|'string'|
'vector'|'max_key'|'min_key'|'object_id'|'regex'|'request_timestamp'`. (`isType`
docs also list `'bson_timestamp'`; the SDK union has `'request_timestamp'` — treat
`decimal128`/`request_timestamp` as backend-generated.)

### Vector
| fn | signature | behavior |
|---|---|---|
| `cosineDistance` | `cosineDistance(str\|E, E\|VectorValue\|number[]) -> FE` | Cosine distance. |
| `dotProduct` | `dotProduct(str\|E, …) -> FE` | Dot product. |
| `euclideanDistance` | `euclideanDistance(str\|E, …) -> FE` | Euclidean distance. |
| `vectorLength` | `vectorLength(str\|E) -> FE` | Dimension count. |

(**`manhattanDistance(x, y)`** — documented; **not in v8.6.0**, and not a
`findNearest` measure, §7.)

### Sorting / aliasing (support)
`ascending(str|E) -> Ordering`, `descending(str|E) -> Ordering`, and
`Expression.ascending()/.descending()`. `Expression.as(name) -> AliasedExpression`
is the aliasing bridge for `select`/`addFields`/`aggregate`/`define`.
`AggregateFunction.as(name) -> AliasedAggregate`. `Expression.asBoolean() -> BE`.

---

## 5. Correlated subqueries (the join mechanism)

Enterprise joins are **correlated subqueries**: a nested `db.pipeline()...` is
embedded as an **expression** (never a top-level stage) inside `select` /
`addFields` / `where` / `sort`, and executes **once per outer document**. All four
pieces are present and typed in v8.6.0 (none `@beta`).

**Fields vs variables (the semantics table):**

| | `field("x")` | `variable("x")` | `constant(v)` |
|---|---|---|---|
| Scope | local to the current document | **global** to pipeline + all nested subqueries | global |
| Undefined reference | evaluates to **absent** (no error) | **runtime error** | n/a |
| Set by | the row being processed | `define()` (a.k.a. `let`) | literal |

Correlate to the outer row **only through `define`d variables** — a bare `field`
inside a subquery refers to the *subquery's* current document, and an undefined
`variable` is a hard error, not a silent absent. Variables fall out of scope at
the first **merging** stage (`aggregate`/`distinct`) and are omitted from output
unless re-`select`ed.

**1. `define(...)`** — bind expressions to variables (multi-bind:
`define(field('owner_id'), field('__name__'))`). **2. `variable(name)`** — read
one inside the subquery. **3. Embed shapes:**

- **`Pipeline.toScalarExpression(): Expression`** — subquery must yield **0 or 1**
  row. **0 → `null`; >1 → runtime error.** Single output field unwraps to a raw
  scalar; multiple fields wrap into a map. Use for lookups and correlated
  aggregates.
- **`Pipeline.toArrayExpression(): Expression`** — yields an **array** (0 rows →
  **empty array, never null**). The subquery's `sort` controls element order;
  single-field rows unwrap to raw values, multi-field rows stay as objects.
- **`subcollection(path)`** — a database-less source joining on the outer doc's
  `__name__` implicitly (parent `/cities/SF` → `/cities/SF/<path>`). **Subquery-
  only**; executing directly fails. Empty/absent subcollection → empty result
  (not an error). Manual equivalent: `collectionGroup(...).where(field('__name__')
  .parent().equal(variable('...')))`.
- **`currentDocument()`** — bind the whole outer row: `.define(currentDocument()
  .as('doc'))` then `variable('doc').getField('title')`.

```ts
// Lookup (scalar subquery on __name__)
db.pipeline().collectionGroup('reviews')
  .define(field('restaurant').as('restaurant_name'))
  .addFields(db.pipeline().collectionGroup('restaurants')
    .where(field('__name__').equal(variable('restaurant_name')))
    .select('name', 'type').toScalarExpression().as('restaurant'));

// Per-parent array with top-N (bounds subquery memory)
db.pipeline().collectionGroup('restaurants')
  .define(field('__name__').as('restaurant_name'))
  .select(field('name'), db.pipeline().collectionGroup('reviews')
    .where(field('restaurant').equal(variable('restaurant_name')))
    .sort(field('rating').descending()).limit(2)
    .select('rating', 'reviewer_id').toArrayExpression().as('top_reviews'));

// Correlated aggregate
db.pipeline().collection('restaurants').define(field('id').as('rid'))
  .addFields(db.pipeline().collection('reviews')
    .where(field('restaurant_id').equal(variable('rid')))
    .aggregate(average('rating').as('avg')).toScalarExpression().as('avg_rating'));

// Anti-join (NOT EXISTS)
.where(db.pipeline().collectionGroup('reviews')
  .where(field('restaurant').equal(variable('restaurant_name')))
  .aggregate(count().as('c')).toScalarExpression().equal(0))

// INNER JOIN via unnest (outer doc duplicated per element; 0-match parents drop)
.unnest(db.pipeline().collectionGroup('reviews')
  .where(field('restaurant').equal(variable('restaurant_name')))
  .select('rating', 'reviewer_id').toArrayExpression().as('review'))

// subcollection sugar (count children without naming the join key)
.addFields(subcollection('restaurants').toArrayExpression().length().as('restaurant_count'))

// uncorrelated subquery as a filter threshold
.where(field('rating').greaterThan(db.pipeline().collection('reviews')
  .aggregate(average('rating').as('avg')).toScalarExpression()))
```

**Best practices & limits (docs, verbatim-faithful):** use `select`/`where`/
`limit` inside a `toArrayExpression()` subquery — "materializing a large number
of documents can exhaust the query memory limit (128 MiB)". Index fields used in a
subquery's `where` — "performant joins rely on… index seeks rather than full
table scans". `subcollection(...)` is subquery-only (needs a parent doc context).
**Nesting depth ≤ 20 layers.** The 128 MiB limit applies across the **entire**
query including all joined documents.

---

## 6. Limits, quotas, regional & locations

- **Deadline** 60s (`DEADLINE_EXCEEDED`); **memory** 128 MiB materialized
  (`RESOURCE_EXHAUSTED`); `INTERNAL` = contact support. No small-N caps on
  `IN`/`OR` (Enterprise).
- **No auto-indexes; unindexed = silent full-scan; Enterprise bills data
  scanned.** Index best-practice order: equality fields (any order) → sort fields
  (same order) → range/inequality fields by decreasing selectivity. Covered
  queries (all returned fields present in a secondary index) skip document fetch.
- **Known limitations:** Pipelines don't yet support the existing `array-contains`
  & vector index types — Firestore falls back to ascending/descending indexes, so
  `array_contains`/`find_nearest` are slower than their classic equivalents. **No
  realtime and no offline** for pipelines. `findNearest` embedding dim ≤ 2048.
  `stringRepeat` result ≤ 1 MB.
- **DML (`update`/`delete`)**: Preview/Pre-GA; no rules; no transactions;
  non-atomic across docs; terminal only; restricted pre-DML stage set (§3).
- **Search stage**: Pre-GA; minimal in 8.6.0 (§2).
- **Regional endpoints** (`/pipelines/regional-endpoints`): set a regional/multi-
  regional API endpoint to keep processing in-region. Global default host
  `firestore.googleapis.com`; regional `firestore.REGION.rep.googleapis.com`
  (Java/Go append `:443`); multi-regional uses `us` (nam5/nam7) / `eu` (eur3):
  `firestore.us.rep.googleapis.com`. **Wrong-region endpoint → `PermissionDenied`
  (not NOT_FOUND).** Server client libs only (Node.js, Go, Java, Python, …); web/
  mobile unsupported. Regional/multi-regional endpoints **don't support realtime
  listeners**. Locational endpoints are **deprecated**.
- **Locations** (`/pipelines/locations`): multi-region `eur3` / `nam5` / `nam7`;
  many single regions incl. `southamerica-east1` (São Paulo). Location is **fixed
  at creation** and determines operation cost ("during Preview"). This repo's DB
  is the literally-named **`default`** (§SKILL 6) — pass it explicitly.

---

## 7. v8.6.0 installed-SDK deltas (docs vs `firestore.d.ts`)

The installed typings are authoritative for what compiles/calls **today**. Do not
blend the two surfaces — prefer the SDK names; treat the below docs-only features
as unavailable until a version bump exposes them.

**Documented but NOT in the installed v8.6.0 typed surface:**

| Documented | Reality in 8.6.0 | Use instead |
|---|---|---|
| `literals(...)` input stage | Not on `PipelineSource` | `documents([...])`, or seed via `addFields` |
| `replaceWith(expr, mode)` merge modes | `replaceWith` takes only `fieldName` / `Expression` / `{ map }` — **no `mode`** | full-replace map, or `addFields`/`removeFields` |
| `cmp(x, y)` | No top-level or method form | `equal`/`lessThan`/… or sort |
| `error(message)` | Not exported | `conditional`/`switchOn` + surface error upstream |
| `currentContext()` | Not exported | `currentDocument()` |
| `referenceSlice(ref, offset, length)` | Not exported | `parent()` chains |
| `manhattanDistance(x, y)` | Not exported; not a `findNearest` measure | `euclidean`/`cosine`/`dotProduct` |
| `log(number, base)` | Not exported | `ln` / `log10` |
| `join(array, delim, null_text)` 3-arg | SDK `join` is **2-arg** | pre-`ifNull` the elements |
| `.asScalarExpression()` (subcollection doc typo) | Only `.toScalarExpression()` / `.toArrayExpression()` | `toScalarExpression` |
| `map(key, value, …)` variadic | SDK `map(elements: Record)` | pass an object literal |
| `.let(...)` stage name | SDK `.define(...)` | `define` |
| `Field.of(...)`, `eq(...)`, `gte(...)`, `.equals(...)` | Doc shorthands | `field(...)`, `equal(...)`, `greaterThanOrEqual(...)`, `.equal(...)` |
| Search `matches()`, `snippet()`, `between()`, search `select`/`queryEnhancement` | Commented-out TODOs | — (unavailable) |
| JSON/structured explain | `explainOptions.outputFormat` only typed `'text'` | `snapshot.explainStats.text` / `.rawData` (proto Any) |
| Pipeline cursors (`startAt`/`After`/`endAt`) | None on `Pipeline` | `offset`+`limit`, keyset predicate, or `createFrom(query)` |

**In the installed SDK but NOT on the swept doc pages** (usable now):

- `PipelineSource.createFrom(query: Query)` — bridge a classic (cursored) Query.
- `rawStage(name, params)` and `rawOptions` escape hatches — `StageOptions
  .rawOptions?: { [k]: unknown }` per stage and `PipelineExecuteOptions.rawOptions`
  globally (snake_case backend names, dot-notation for nested, takes precedence
  over SDK-set options).
- `forceIndex?: string` (collection/collectionGroup options); `indexMode:
  'recommended'` (execute options).
- `coalesce(...)`, `regexFind`/`regexFindAll`, `arrayLastIndexOf`,
  `arrayTransformWithIndex`, `getField(map, dynamicKey)`, `currentDocument()`.
- Options-bag form of every stage (`where({ condition })`, `aggregate({
  accumulators, groups })`, `select({ selections })`, `sample({ percentage })`, …)
  alongside the positional form. Note: the `where` options key is **`condition`**,
  not `filter`.
- `Pipeline.stream(): NodeJS.ReadableStream` of `PipelineResult` (vs `execute()`
  → `PipelineSnapshot`). `Expression.asBoolean()`.

**`@beta`-tagged in 8.6.0** (present, but Preview — expect churn): `delete`,
`update`, `search`, `documentMatches`, `score`, `geoDistance`,
`PipelineExecuteOptions.explainOptions`, and the `PipelineSnapshot.results`
getter.

**Result surface:** `execute(opts?) -> Promise<PipelineSnapshot>` with
`.results: PipelineResult[]`, `.executionTime`, `.explainStats?`. A
`PipelineResult` that is not a stored document (projected / aggregated / subquery-
shaped) returns `ref`/`id`/`createTime`/`updateTime` = `undefined`; `.data()`
gives the field map, `.get(path)` a single field.
