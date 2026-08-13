---
title: 0011 — Write-path concurrency (lost-update discipline)
description: How a Firestore write in this repo decides whether a newer concurrent write already won — the four-tier ladder, the traps that make a guard inert, and when to drop versus surface a conflict.
---

## Context

Firestore imposes **no ordering** on writes. A `merge()` or `update()` is applied
when it arrives, not when it was decided; the last one to commit wins, field by
field. `runTransaction` narrows this — a document read with `tx.get` is
version-checked at commit and the callback **retries** on conflict — but the
retry re-runs the callback, it does **not** re-derive anything captured in the
closure. A value read *before* the transaction (or before an `await` inside it)
is re-applied verbatim on retry, so the loser of a race overwrites the winner
with data it read minutes earlier. That is the lost update.

Three independent concurrency sources make this routine here, not theoretical:

1. **Dual-run coexistence.** The legacy Flutter ERP still writes the same
   Firestore documents (see `guides/coexistence`). Every pedido, pagamento,
   produto and estoque doc has at least two writers today, in two codebases,
   with no shared lock.
2. **At-least-once event delivery.** Marketplace and freight webhooks arrive out
   of order by design — a delayed `posted` after `delivered`, two payment
   notifications for the same payment id, a shipment event overtaken by the next
   one. On top of that, the shared notification pipeline's reprocess sweep
   re-drives *stored, hours-old* payloads through the **same** handler as a fresh
   task, and Cloud Tasks retries do the same. A handler that writes without a
   freshness check is an out-of-order writer by construction.
3. **Two humans, or two tabs.** The ERP is a multi-user internal app; the same
   pedido or produto can be open in two editors.

### What this repo does today

There is no generic mechanism. The state of play at the time of this ADR:

- **Five hand-rolled** "update-if-newer" guards, in **three different
  spellings** — `packages/data/src/admin/pedidoReconcile.ts` (`>=` → skip), the
  Mercado Livre order/payment/shipment imports (`<` → proceed), and the WhatsApp
  status handler (timestamp compare **plus** a forward-only transition matrix,
  the most careful one, and non-transactional).
- **One** use of Firestore's monotonic transforms —
  `apps/functions/src/estoques/aplicarEstoque.ts`, which pairs
  `FieldValue.increment` with `FieldValue.maximum` on the watermark.
- **Zero** uses of `DocumentReference.update(data, { lastUpdateTime })`,
  Firestore's own compare-and-swap precondition.

> **Update (2026-08, issue #824).** The last point is no longer true, and that
> is the ADR working: tier 1 is now used **twice**, both in Mercado Livre —
> `publish.ts` (the listing write-back) and `import.ts` (the produto price
> import) — and both are pinned by test fakes that *enforce* the precondition
> rather than merely recording it, so a stale `lastUpdateTime` throws in the
> test the way it would in Firestore. Copy those when reaching for tier 1. The
> repo-wide audit that established this also found the other counts still
> accurate, and reclassified all ~79 transaction sites; see #824.
- An explicit acknowledgement in `apps/web/lib/produtos/revert.ts`: *"there is no
  optimistic locking anywhere in this app (last-write-wins)"*.

### Why the legacy pattern is a floor, not a ceiling

The Flutter app takes this seriously — roughly 25 guards across Mercado Livre,
Mercado Pago, Shopee, Amazon, Magalu, Loja Integrada, WhatsApp and NF-e — but
every one is the *same* shape, hand-written at each call site: compare a stored
`ultimaModificacao` / `lastMarketplaceUpdate` against the incoming provider clock
inside a transaction, and return early when stale. Hand-writing that ~25 times
produced five distinct failure modes, all in shipped legacy code:

- a **wrong-way null default** in the ML shipment handler, so a freight block
  that was never stamped can never be updated — the guard rejects *everything*;
- a Shopee tracking handler whose watermark advance is **commented out**, so the
  guard never rejects *anything*;
- an order-table action that re-reads the pedido in the transaction but tests
  every predicate against the **stale outer variable** — isolation for the write,
  no isolation for the decision;
- a `now() + 3s` **clock-skew hack** in the inventory-count path, deliberately
  written to beat a `maximum` transform (and therefore also beating later
  legitimate writes);
- a sibling channel (Facebook Messenger status) doing the same job as the
  WhatsApp status handler with **no guard at all**.

The pattern is right. Copying it by hand, site by site, is what fails. And it is
also incomplete: it only ever addresses out-of-order *events*, never the
concurrent-editor case and never the cheaper primitives Firestore already offers.

## Decision

Every write picks the **cheapest tier that holds**, and the choice is recorded at
the call site. Tiers are ordered by cost, not by strength — a lower tier is
preferred whenever it applies.

| Tier | Mechanism | Use when | Cost |
| --- | --- | --- | --- |
| **0 — make the race impossible** | `FieldValue.increment`, `FieldValue.maximum` / `minimum`, `arrayUnion` / `arrayRemove`, or a deterministic doc id derived from `event.id` | counters, quantities, watermarks, floors, at-least-once trigger rows | nothing to compare, nothing to drop, no retry |
| **1 — native precondition** | `ref.update(patch, { lastUpdateTime: snap.updateTime })` | the patch is derived from a document you just read, especially across an `await` | Admin SDK only; one argument; caller retries on `FAILED_PRECONDITION` |
| **2 — event-clock watermark** | re-read inside a transaction, compare the stored watermark against the incoming one, drop when not fresher, and advance the watermark on the winning write | out-of-order provider events, where the loser is a *later-delivered older truth* | a watermark field + unit discipline + a transaction |
| **3 — tell the human** | a typed conflict error surfaced in the UI | interactive edits (`ObjectView`, the pedido editor) | a read; the user re-applies their change |

Tier 0 is the goal state: a commutative or monotonic write has no loser, so there
is nothing to detect. Tier 1 is the default for server-side read-then-write —
it detects **any** concurrent change, needs no schema surface, and the version
token (`updateTime`) is server-maintained, so it cannot be forgotten, skewed, or
left un-advanced. Tier 2 remains necessary for provider events because the
competing write is not concurrent at all: a stale event legitimately sees an
unchanged document and simply carries older truth, which no precondition can
detect. Tier 3 exists because a human's unsaved work is not ours to discard.

### Two traps that make a guard inert

- **A predicate re-checked against a binding read outside the transaction is not
  a guard.** OCC gives the *write* isolation; it gives the *decision* nothing.
  Re-derive every input the predicate depends on from a `tx.get` result inside
  the callback. The pre-transaction read stays only as a cheap early-out.
- **The stamps are not interchangeable.** `ultimaModificacao` is **microseconds**
  on pedido / pagamento / produto but **milliseconds** on the Mercado Livre link
  documents; `historicoEstadoPedido.data` is µs while `historicoFtIni.data` is
  ms. A comparison across units is a guard that silently never fires (µs values
  always dwarf ms ones). Any watermark comparison must name its unit.

### Drop versus surface

- **Server-side event handlers drop and log.** Returning a structured
  `skipped: 'stale'` is correct and expected; the sweep converges. What is *not*
  acceptable is dropping without a record — staleness must stay observable.
- **Interactive edits surface.** A losing user-initiated save raises a typed,
  narrowable error (per Critical rule 6) and the UI tells the operator the record
  changed elsewhere. Silently discarding what someone typed is never the answer.

### Where this is enforced

Root `CLAUDE.md` Critical rule 7 is the short form. The repo-wide sweep, the
shared helper in `packages/data`, and the lint rule that catches the
stale-closure shape are tracked as issues, not shipped here.

## Consequences

- **Easier:** the decision at a write site becomes a four-way choice with a
  default, instead of an open design question re-answered per call site. Tier 1
  in particular turns a whole class of bug into a one-argument change on a write
  the code already performs.
- **New schema surface, and therefore rules drift.** Any tier-2 watermark added
  to a schema on the generator's validator whitelist means regenerating **both**
  rulesets and **both** snapshots (Critical rule 2). Tier 1 adds none — that is
  a large part of why it outranks a hand-rolled version field.
- **Tier availability is asymmetric between SDKs.** `lastUpdateTime`
  preconditions and `FieldValue.maximum` / `minimum` are **Admin-only**; the
  client SDK has `increment` and `arrayUnion` but neither of the other two. Since
  `apps/web` is client-first (ADR 0002), browser writes can reach tiers 0
  (partially), 2 and 3 only. Work that genuinely needs a precondition belongs in
  an API-only sibling app or `apps/functions`.
- **Tier 0's transforms re-cement the dependency floor.** `FieldValue.maximum` /
  `minimum` need `@google-cloud/firestore` ≥ 8.6.0, i.e. firebase-admin v14 —
  already a fixed decision, now with a second reason behind it.
- **Tier 1 is deliberately pessimistic.** It fails on *any* concurrent change to
  the document, including one to an unrelated field, so it needs a bounded retry
  and is the wrong choice for a genuinely disjoint-field merge. Where two writers
  own disjoint fields by design, say so at the call site — that is a tier-0
  argument, not an absence of one.
- **Cost:** tier 1 is cheaper than the transaction it replaces (no extra read, no
  retry storm). Tier 2 costs a transaction and one read; on Firestore Enterprise,
  where billing follows data scanned, that read must be a document get, never a
  scan for the document.

## Alternatives considered

- **Port the legacy compare-and-drop to every write site** → rejected. It is
  tier 2 applied uniformly, including where tier 0 or 1 is cheaper and safer, and
  hand-writing it is precisely what produced the five failure modes above.
- **A per-document `rev` integer** → rejected. Incrementing it requires a
  read-modify-write, it is schema surface on every collection (and therefore
  rules drift on every collection), and it duplicates `updateTime`, which
  Firestore already maintains for free and which no writer can forget to bump —
  including the Flutter app, which would never learn to maintain a `rev`.
- **`FieldValue.serverTimestamp()` as the watermark** → rejected for tier 2. It
  records *our* write time, not the *event* time; two events processed in the
  wrong order both get a forward-moving server stamp, so the guard cannot tell
  them apart. Out-of-order detection needs the provider's clock.
- **Pessimistic locking (a lease document per record)** → rejected. It adds a
  write, a TTL, and a new failure mode (a stale lease blocking a legitimate
  edit), for a contention level this workload does not have.
- **Do nothing and rely on review** → rejected: three instances of the same
  stale-closure bug reached production in reviewed code within a single audit
  pass.

## Status

Proposed (2026-08). Codified as Critical rule 7 in the root `CLAUDE.md`. The
repo-wide audit, the shared helper, and the automated check are tracked
separately; no call sites are migrated by this ADR.
