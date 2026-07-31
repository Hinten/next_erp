---
name: firestore-read-cache
description: >-
  Use when a server surface in this monorepo repeats the same Firestore read —
  caching a config document or a query result in memory, cutting Firestore
  reads / scanned data, TTL, staleness, invalidation, single-flight / in-flight
  dedup, negative caching, warm instances. Covers the
  `@delfrance/data/admin/cache` primitive: createReadCache,
  createCachedDocReader, READ_CACHE_TTL, cacheKeyOf / queryCacheKey, isFresh,
  DATA_READ_CACHE_DISABLED, __resetAllReadCaches, readCacheStatsSnapshot — and
  the three reads that must NEVER be cached (transactional tx.get, read-modify-
  write, OAuth tokens). Triggers on work in the channel context loaders
  (loadMercadoLivreContext, loadWhatsappContext, loadMelhorEnvioContext,
  loadMercadoPagoContext, resolveIntegracaoByUserId) and on any "this document
  never changes, why are we reading it every time" question.
---

# Firestore read cache

`@delfrance/data/admin/cache` is a **process-scoped, TTL-bounded** read cache with
in-flight deduplication. Every server surface here is a long-lived Node process —
Cloud Functions gen2 container instances persist across invocations, App Hosting /
Cloud Run Next servers persist across requests — so module-scope state survives.

Why it matters more here than in a normal app: Firestore **Enterprise bills data
scanned**, and several of the reads we repeat are *queries*, not document gets. A
deduplicated query saves scanned bytes, not just a document count.

Source: `packages/data/src/admin/cache/`. Rationale and rejected alternatives:
ADR 0011 (`apps/docs/src/content/docs/adr/`).

## 1. Decide first — three reads that must NEVER be cached

These are hard exclusions, not guidelines. Each has a live instance in this repo.

1. **Anything read inside `runTransaction`.** A `tx.get()` is a lock acquisition:
   it enters the transaction's read set, and that is what makes a concurrent write
   abort and retry the closure. A cached value silently drops the document from
   that set and changes the consistency guarantee. Live instance:
   `apps/functions/src/estoques/sincronizarEstoquePedido.ts` reads `operacao` and
   `integracao` via `tx.get()`. The API makes this hard to get wrong — every entry
   point takes a `Firestore`, never a `Transaction`.

2. **Read-modify-write.** Any value the caller conditionally writes back: the
   decision is made on stale data and the write clobbers whatever landed in
   between. The cautionary shape is
   `apps/mercado-livre/lib/marketplace/import.ts`, which *creates* the produto when
   its SKU lookup misses — a cached miss manufactures a duplicate produto. Same
   story at `itemsStatusSync.ts` and `itemsPricesSync.ts`, which read a produto and
   then write to that same document.

3. **OAuth credentials / tokens.** `apps/mercado-livre/lib/marketplace/tokenStore.ts`
   picks the newest valid token by query, and all three of its reads are load-bearing
   *because* they are fresh: the re-check honours a refresh that landed mid-flight,
   and the loser fallback exists to observe a write another process — or the
   still-running Flutter app — made microseconds earlier. ML refresh tokens are
   single-use and rotate, so a cached read resurrects a rotated-out token and turns a
   survivable race into a hard `invalid_grant`.

Then the positive test: **is this read repeated, and is it read-only?** "Repeated"
means repeated *within one warm instance's TTL window* — a once-a-day sweep gains
nothing. If you cannot name the loop or the fan-out that repeats it, do not cache it.

## 2. Three shapes

### A config document → `createCachedDocReader`

The typed layer. `AdminCollectionHandle` deliberately has no `get`, so the
"read one doc → parsed value or null" idiom is hand-copied all over the repo
(`massImport.ts`' `readJob`, `precoSync.ts`, both `credentialStore.ts`,
`filial-cert.ts`). This wraps it once, keyed by the resolved document path.

```ts
// module scope — never per request
const integracaoReader = createCachedDocReader(integracaoCollection, {
  name: 'ml:integracao',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 64,
  isFresh: (conta) => conta.user_id != null, // §5
});

// in the loader — the reader replaces the READ, not the contract
export async function loadMercadoLivreContext(db: Firestore, integracaoId: string) {
  const conta = await integracaoReader.get(db, {}, integracaoId);
  if (conta == null) throw new MercadoLivreContaNotConfiguredError(/* … */);
  // …unchanged from here…
}
```

`get` returns `z.infer<T> | null` — absent is `null`, governed by `negativeTtlMs`.
Callers that threw on absence keep throwing; only the read moved.

⚠️ **Cache the parsed document, never a context object.** The four channel loaders
return closures over `db` and a live token store; Melhor Envio's also builds a live
API client. The cacheable seam is the `.get()`, which is the loader's only I/O.

### A query → `createReadCache` + a tuple key

A Firestore `Query` cannot be introspected to derive its own key (the admin SDK
keeps its filters internal, and this package holds `firebase-admin` at arm's
length). So you compose the key from the same values you feed the predicates:

```ts
const integracaoByUserId = createReadCache<readonly [number], string | null>({
  name: 'ml:integracao-by-user-id',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 64,
  negativeTtlMs: 0, // see §3 — "no account" is not cacheable here
});

const id = await integracaoByUserId.get([userId], () =>
  resolveIntegracaoByUserId(db, userId),
);
```

Use `queryCacheKey(collectionPath, ...predicateValues)` when one cache serves more
than one query shape — it namespaces by collection so the shapes cannot collide.
Keep the key construction adjacent to the query: **omitting a predicate value is
the one way to get a wrong hit.**

### Anything else

`load` is an arbitrary `() => Promise<V>`, so an aggregate (`V = number`), a
pipeline execution (`V = readonly Row[]`) or a non-Firestore call all fit. The
exclusions in §1 still apply.

## 3. TTL — the policy

Instances do not coordinate. **The TTL *is* the staleness bound**: after a write, a
warm instance serves the old value for up to `ttlMs`.

| Tier | Value | For |
| --- | --- | --- |
| `READ_CACHE_TTL.config` | 15 min | **The default.** Config a human edits once or twice a year: `integracao`, `metodo_pgto`, `int_frete`, `filial`, `operacao`. |
| `READ_CACHE_TTL.volatile` | 60 s | A document the app itself mutates and must pick up quickly. |
| `READ_CACHE_TTL.negative` | 5 s | Default lifetime for an absent result. |

`ttlMs` is **required** — there is no implicit default and no infinite mode. Name a
tier rather than writing a literal; a bare number in review means nobody can tell
whether 15 min was chosen or inherited.

**`negativeTtlMs: 0` — never cache absence — wherever an absent value drives an
irreversible decision.** The canonical case: `resolveIntegracaoByUserId` returning
`null` produces `{ kind: 'no-account' }`, which is a *deterministic ack*. Cache that
for a seller who connected 30 seconds ago and their notifications are dropped, not
retried. Same reasoning anywhere a miss triggers a create (§1.2).

## 4. Two obligations at every adoption

1. **Invalidate on your own writes.** If this process writes a document it also
   caches, evict it. `exchangeAndPersist`
   (`apps/mercado-livre/lib/marketplace/mercadoLivre.ts`, and the identical shape in
   `mercado-pago/lib/payments/mercadoPago.ts`) merges `user_id` onto the very
   `integracao` document its own loader read — and `user_id` is exactly what
   `resolveIntegracaoByUserId` queries on.

   ```ts
   await integracaoCollection.merge(db, {}, integracaoId, { user_id: resp.user_id });
   integracaoReader.invalidate({}, integracaoId);
   ```

   This covers **this instance only**. Other warm instances stay stale until the
   TTL — which is what `isFresh` is for.

2. **Reset the caches between tests.**

   ```ts
   beforeEach(() => {
     __resetAllReadCaches();
   });
   afterEach(() => {
     __resetAllReadCaches();
   });
   ```

   Mandatory in `*.storage.test.ts` — those files share one process, so without it a
   cache populated by one test serves the next. Mirrors
   `__resetFilialCertCacheForTests` in `apps/nfe/lib/nfe/filial-cert.ts`.

## 5. `isFresh` — re-validate instead of shortening the TTL

`isFresh` runs on every **hit** of a present value; returning `false` evicts and
re-reads (counted as a miss). It is the repo's existing move — `filial-cert.ts`
re-runs its cert-expiry assertion on every hit rather than time-bounding the entry.

Reach for it when *one field* has a tighter freshness requirement than the document
as a whole. `isFresh: (conta) => conta.user_id != null` refuses an `integracao`
document that predates the connect-time back-fill, on **every** instance rather than
only the one that handled the OAuth callback — which is what makes a 15-minute TTL
safe there. Costs nothing in steady state: once the field is populated, it passes.

Do not use it for anything that needs a read to evaluate. It is a synchronous
predicate over the already-cached value.

## 6. Testing

Never sleep. Inject the clock:

```ts
let now = 1_700_000_000_000;
const cache = createReadCache<string, string>({ /* … */ now: () => now });
```

Prove the **staleness contract**, not just the hit — a test that only asserts "the
second call did not read" passes even if the TTL never expires:

```ts
await reader.get(db, {}, 'i1');
await reader.get(db, {}, 'i1');
expect(db.reads).toHaveLength(1); // the hit
now += READ_CACHE_TTL.config;
await reader.get(db, {}, 'i1');
expect(db.reads).toHaveLength(2); // the re-read — this is the assertion that matters
```

The TTL boundary is **exclusive**: at exactly `expiresAt` the entry is expired.
`packages/data/src/admin/cache/*.test.ts` are the worked examples, including the
`FakeDb` shape for a `createCachedDocReader` test.

## 7. Operating it

- **Kill switch**: `DATA_READ_CACHE_DISABLED=1` turns every `get` into a
  passthrough, so a suspected staleness bug is one env var away from neutralized —
  no rollback. Read per call, so a test flips it with
  `vi.stubEnv(READ_CACHE_DISABLED_ENV, '1')`.
- **Hit rate**: each cache emits one line every `sampleEvery` gets (default 500),
  prefixed `[read-cache]`. For a boundary log — end of a sweep tick, end of a task
  handler — call `readCacheStatsSnapshot()` and emit it through that surface's own
  logger. Without a number in Cloud Logging nobody can tell whether the cache is
  doing anything; report before/after when you adopt it.

## 8. Two contracts that bite

- **The cached value is SHARED by reference.** N callers receive the identical
  object or array. Never mutate what `get` returns — copy first. This matters far
  more for a cached query result (an array a caller might `sort()`) than for a
  config document.
- **`createReadCache` belongs at MODULE scope.** A per-request cache never hits and
  leaks into the reset registry; a duplicate `name` warns for exactly that reason.

## 9. Adoption checklist

- [ ] Not a transactional read, not read-modify-write, not a token (§1).
- [ ] The repeat is named: which loop, sweep or fan-out re-reads this?
- [ ] `ttlMs` is a `READ_CACHE_TTL` tier, or a literal with a comment saying why.
- [ ] `negativeTtlMs: 0` if an absent value drives an irreversible decision (§3).
- [ ] Every self-write to a cached document invalidates its entry (§4.1).
- [ ] `__resetAllReadCaches()` in the suite's `beforeEach`/`afterEach` (§4.2).
- [ ] A test proves the re-read after `ttlMs`, not just the hit (§6).
- [ ] `pnpm turbo run lint typecheck test` green.
