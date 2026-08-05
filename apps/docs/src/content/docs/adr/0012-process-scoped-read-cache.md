---
title: 0012 — Process-scoped TTL read cache for repeated Firestore reads
description: Why repeated config reads are cached in the warm Node process with a mandatory TTL, why the TTL default is 15 minutes, and why onSnapshot, Redis and Firestore bundles were rejected.
---

## Context

Every server surface in this monorepo is a long-lived Node process. Cloud Functions
gen2 container instances persist across invocations (`maxInstances: 10`, no
`minInstances`, so a cold start begins empty); each App Hosting / Cloud Run Next
server persists across requests — something we already rely on for the admin app
singleton and `getNFeRuntime()`. Module-scope state therefore survives.

Yet every invocation re-reads the same handful of configuration documents. The
`integracao` document behind `loadMercadoLivreContext`, the `int_frete` document
behind `loadMelhorEnvioContext`, the `metodo_pgto` document behind
`loadMercadoPagoContext` — and, highest-volume of all, the three-predicate query
`resolveIntegracaoByUserId` on **every** inbound Mercado Livre notification. These
documents change once or twice a year.

This matters more here than in a typical app because **Firestore Enterprise bills
data scanned**, and several of the repeated reads are *queries* rather than document
gets. Deduplicating them saves scanned bytes, not merely a document count. The
legacy Flutter backend exploited exactly this — it reused its warm Cloud Run process
to cache the config reads it repeated per request. The rewrite dropped the technique
and never got it back.

Two ad-hoc caches already existed, and between them they framed the design:

- **`BatchReadContext`** (`apps/nfe/lib/nfe/orchestrator/bundle.ts`) — promise-valued,
  so concurrent readers of one key issue a single read. It has no TTL, and needs
  none: it is discarded when the batch returns, so its staleness window is zero. Its
  scope is also its limitation — every new invocation starts cold.
- **`certCache` / `runtimeCache`** (`apps/nfe/lib/nfe/filial-cert.ts`) — process-scoped,
  with an explicit evict on the upload path and a test reset. It has no TTL either,
  and that is the cautionary tale: `apps/nfe/CLAUDE.md` rule 4 has to state that
  rotating a filial's certificate requires an `apps/nfe` restart.

Nothing generic existed; a repo-wide search for a shared memoize/cache helper returned
none, and no high-frequency config read used either of the two above.

## Decision

Ship `@delfrance/data/admin/cache` — a **process-scoped, TTL-bounded, promise-valued**
read cache — and adopt it only at reads that are demonstrably repeated and read-only.

Load-bearing properties, in the order they matter:

1. **TTL is mandatory.** No implicit default, no infinite mode. Instances do not
   coordinate, so **the TTL *is* the staleness bound**: after a write, a warm instance
   serves the old value for up to `ttlMs`. Making that a required argument keeps the
   bound a stated choice rather than an inherited one.
2. **Single-flight.** The cache stores the *promise*, not the resolved value, so N
   concurrent callers on one instance issue one read — the dominant win under burst
   (a sweep enqueuing hundreds of tasks). A rejected promise deletes its entry, so a
   transient failure is never cached for the TTL.
3. **Negative caching, separately bounded.** Absence is cached under its own
   `negativeTtlMs`, and `0` disables it entirely. That escape hatch is not optional
   polish: `resolveIntegracaoByUserId` returning `null` produces a *deterministic ack*,
   so caching "no account" for a seller who connected 30 seconds ago silently drops
   their notifications instead of retrying them.
4. **Bounded size**, least-recently-used first. A long-lived process with a cache keyed
   by an entity id is otherwise a memory leak.
5. **Injectable clock**, matching the repo's existing explicit-`now` convention, so TTL
   expiry is provable without sleeping.
6. **A kill switch** — `DATA_READ_CACHE_DISABLED=1` — so a suspected staleness bug is
   one env var away from neutralized, with no rollback.

### Why the default TTL is 15 minutes

The documents this is sized for change **once or twice a year**. A 60-second TTL
discards nearly the whole win to buy a staleness bound almost nobody can observe, so
`READ_CACHE_TTL.config` is 15 minutes and adopting call sites lower it (to
`READ_CACHE_TTL.volatile`, 60 s) when a document is genuinely hotter.

The one real hazard of a long TTL is answered by **`isFresh`** rather than by
shortening it for everyone: a synchronous predicate re-run on every hit, where `false`
evicts and re-reads. This is not new — `filial-cert.ts` already re-runs its
certificate-expiry assertion on every hit instead of time-bounding the entry. The
motivating case is `exchangeAndPersist`, which merges `user_id` onto the very
`integracao` document its own loader read: the writing instance can evict its own
entry, but no other instance can be told. `isFresh: (conta) => conta.user_id != null`
refuses a pre-back-fill document everywhere, and costs nothing once the field is set.

### Hard exclusions

Documented at the top of the module, because each failure mode is silent:

- **Anything read inside `runTransaction`.** A `tx.get()` is a lock acquisition — it
  enters the transaction's read set, which is what makes a concurrent write abort and
  retry the closure. A cached value drops the document from that set and changes the
  consistency guarantee. The API takes a `Firestore` and never a `Transaction`, so
  this cannot be opted into by accident.
- **Read-modify-write.** The decision would be made on stale data and the write would
  clobber whatever landed in between. The sharpest instance is the Mercado Livre
  importer, which *creates* the produto when its SKU lookup misses — a cached miss
  manufactures a duplicate produto.
- **OAuth credentials / tokens.** The `tokenDuravel` store's "one wins" refresh depends
  on always reading the newest document, and races cross-process with the still-running
  Flutter app during the dual-run migration. ML refresh tokens are single-use and
  rotate, so a cached read resurrects a rotated-out token and converts a survivable
  race into a hard `invalid_grant`.

## Consequences

**Easier.** Repeated config reads collapse to roughly one per warm instance per TTL
window, and the saving is scanned bytes on the query-shaped ones. Adoption is small:
`createCachedDocReader` also closes a real gap, since `AdminCollectionHandle` exposes
no `get` and the "read one doc → parsed value or null" idiom is hand-copied at a dozen
call sites. Hit rates are reportable from Cloud Logging.

**Harder.** Every adoption now carries an invalidation obligation (a self-write must
evict its own entry) and a test-hygiene obligation (`__resetAllReadCaches()` between
tests — mandatory in `*.storage.test.ts`, which share one process). Debugging gains a
new question: "is this instance serving a stale value?" — which is what the kill switch
and the `stats()` counters exist to answer quickly.

**New risks.** Invalidation reaches one instance only, so a config edit propagates in
up to `ttlMs` regardless. The cached value is shared by reference across callers, so a
caller that mutates a returned array corrupts every other reader — stated as a contract
and pinned by a test. And the primitive makes it *easy* to cache the wrong thing, which
is why the exclusions are in the module doc, in the `firestore-read-cache` skill, and in
the root `CLAUDE.md`.

## Alternatives considered

- **`onSnapshot` live mirror** → near-zero steady-state read cost, but Cloud Functions
  instances are frozen between invocations, so the listener stalls and resumes with an
  unbounded backfill. It also holds a gRPC stream per instance across `maxInstances: 10
  × N` functions. Not viable on the Functions surface, and adopting it only on App
  Hosting would split the model.
- **Redis / Memorystore** → real cross-instance coherence and real invalidation, at the
  cost of a VPC connector for Functions, new infrastructure and a new failure mode.
  Disproportionate for documents that change a couple of times a year.
- **Firestore bundles** → a build-time snapshot; wrong shape for configuration that
  changes at runtime.
- **Wrapping `lru-cache`** (already present transitively via `firebase-admin` →
  `jwks-rsa`) → its `fetch()` is genuine single-flight and a rejected `fetchMethod`
  deletes the entry, but it offers **no injectable clock** (it captures the clock at
  module load) and no hit/miss counters. Of the properties above it covers four; the
  rest is wrapper code either way. Since `catalogMode: strict` also makes a direct
  dependency a catalog entry, and every existing cache in this repo is a hand-rolled
  `Map`, the wrapper won on cost and on testability.

## Status

Accepted.
