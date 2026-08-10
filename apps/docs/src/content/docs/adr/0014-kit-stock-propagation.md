---
title: 0014 — Kit stock propagation and the tiered stock sweep
description: Why a kit's available quantity is never materialized, why the Mercado Livre stock sweep deliberately under-sends, and why the estoque ledger must stay summable.
---

## Context

### The catalogue shape this is designed around

The store sells school uniforms in two families: unprinted uniforms, and printed
t-shirts. **A printed t-shirt is modelled as a kit of `{blank shirt, print}`** —
`ehKit: true` with two entries in `componentesKit`. Kits also exist to bundle a
larger quantity of one product, or to mix different products, but the shirt+print
shape dominates the catalogue by count.

The decisive fact: **thousands of those kits share the exact same two
components.** A kit for size 02 in artwork A and a kit for size 02 in artwork B
both consume the same blank shirt and the same print; only the design differs.
Most of that catalogue is seasonal and barely moves.

Everything below follows from that one number. Read it before changing anything
in this area.

### How kit stock works

A kit produto holds no stock of its own. `calcularAlteracoesEstoque`
(`packages/data/src/pedido/estoquePlan.ts`) expands a kit into its
`limitarEstoque` components and moves **only** the component estoques — the kit
produto is deliberately never touched. Availability is derived at read time:

```
kitDisponivel = floor( min over limitarEstoque components of ( disponivel / quantidade ) )
```

`kitEstoqueDisponivel` in `packages/schemas/src/produto/pureLogic/kitEstoque.ts`
is the single implementation; every consumer calls it rather than re-deriving.

So a kit sale leaves **no trace on the kit itself** — no `historicoEstoque` row,
no `ultimaModificacao` bump on any doc belonging to the kit. That absence is the
problem this ADR resolves.

### The arithmetic that kills the obvious fix

The obvious fix is to propagate: when a component's stock moves, update every kit
that contains it. Both variants of that idea die on the same number.

- **Materialize** the kit's computed availability on the kit's own estoque doc.
  Per affected kit this needs a read of every *sibling* component at that
  depósito, plus a write. **This was built and measured; the cost was
  prohibitive.** It is recorded here as measured experience, not as a theoretical
  objection.
- **Only stamp a timestamp** on each affected kit — no reads, just a write. It is
  cheaper per unit and identical in order of magnitude: one sale of one printed
  shirt touches two shared components, and those components belong to roughly
  **2 000 kits**. That is ~2 000 document writes per sale, on the order-ingestion
  path.

> **Any per-component fan-out is `O(kits containing the component)`, and that
> number is in the thousands here.** Only per-order-line work is affordable.
> Check any proposed design against that number first.

### What the sweep did before this ADR

The Mercado Livre stock sweep (`apps/mercado-livre/lib/marketplace/estoquePlan.ts`)
compensated for the missing signal in two places, and paid for it twice:

1. **A correlated component aggregate in the window filter** (`maxComp`): for each
   candidate anchor, take the max `ultimaModificacao` over its components'
   estoques. This *does* detect that a kit changed — and it detects it for all
   ~2 000 siblings at once, every 15 minutes. Nearly all of those sends transmit a
   number Mercado Livre already holds.
2. **A separate pipeline pass over `pedidos`** (`fetchSoldProdutoIds`) returning
   the distinct produto ids sold in the last 30 days, capped at 10 000 — the cap
   is issue #806 S10. It existed only to answer "did this kit sell", a question
   the kit's own documents could not answer.

## Decision

### 1. The kit quantity stays computed at query time

It is **not** materialized, and no trigger fans out over the kits containing a
moved component. The sweep continues to join component estoques in its projection
to compute the number it sends.

### 2. Only the *sold* signal is persisted, and only per order line

`sincronizarEstoquePedido` stamps `ultimaModificacao` on the estoque doc of every
produto that appears as a **pedido line** but received no stock delta — i.e. the
kits. The kit ids come from `pedido.itens[*].produtoUid`, which the sync
transaction has already loaded, so this costs **zero extra reads** and is
`O(lines in the pedido)` — not `O(kits containing the component)`.

The write is read-free and ADR 0011 **tier 0**: `FieldValue.maximum(now)` for the
monotonic stamp, `FieldValue.minimum(now)` for `dataCriacao`, and
`FieldValue.increment(0)` on the quantity fields as a get-or-create that
initializes a missing field to `0` and cannot clobber an existing value. The doc
is created when absent, because the sweep's window filter coalesces a missing
estoque to `0` and would otherwise never see the family.

**No `historicoEstoque` row is written** for that stamp: no quantity moved, and
the ledger must stay summable (see 4).

### 3. The sweep runs three tiers and deliberately under-sends

| Tier | Cron | Window | Candidates | Send policy |
|---|---|---|---|---|
| incremental | every 15 min | ~15 min | kits that **sold** + products whose own stock moved | changed **and** `min(anterior, atual) ≤ LIMIAR_ALTO` |
| daily | 02:00 | 24 h | same query, wider window | changed |
| full | monthly | force-all (`changedSinceMs: -1`) | everything | changed since the last full run |

The window filter no longer joins components. **Tiers 1 and 2 are therefore blind
to sibling kits**: a kit whose component moved, but which did not itself sell, is
not a candidate and can stay stale on Mercado Livre for up to a month.

⚠️ **This is the accepted trade, not a bug.** It is what makes the design
affordable, and the monthly pass is the corrector. Do not "fix" it by restoring
the component join without redoing the cost arithmetic above.

### 4. The estoque ledger is summable

`historicoEstoque` records `movimento` (and `movimentoReservada`) as a **signed
delta on every row, including a balanço**. Previously `quantidade` held a signed
delta for movements but an *absolute counted value* for a balanço, discriminated
only by `ehBalanco` — an overload that made the ledger impossible to sum and
forced any reversal scheme to carry an always-send exception set.

Consequence for the write paths: the balanço branch of `aplicarMovimento` reads
the current value inside a transaction so it can record `counted − current`.
Entrada and saída stay **read-free** (their delta is known a priori), which
preserves the tier-0 design from #387. `saldo` is therefore best-effort — filled
by writers that already read, `null` on the read-free path.

Rows also carry `parentId` and `depositoOuterRef`, the join keys the collection
lacked. That turns "what was the stock at time T" into **one grouped aggregate**
for a whole sweep tick:

```ts
db.pipeline().collectionGroup('historicoEstoque')
  .where(field('timestamp').greaterThanOrEqual(janelaInicioMs))
  .aggregate({
    accumulators: [
      sum('movimento').as('dq'),
      sum('movimentoReservada').as('dr'),
      countIf(not(exists('movimento'))).as('nDesconhecido'),
    ],
    groups: ['parentId', 'depositoOuterRef'],
  })
```

`anterior = (quantidade − dq) − (quantidadeReservada − dr)`, fed through the same
`kitEstoqueDisponivel`. A product absent from the result never moved.

**Failing open is an explicit accumulator, not an emergent property.** `sum`
silently skips a row that carries no `movimento` — a legacy Flutter v1 row, and
Flutter is a *live concurrent writer* through the whole dual run. Left at that,
such a window sums to zero, `anterior` reconstructs to `atual`, and the sweep
concludes "nothing changed" about a movement that certainly happened: a silent
skip, the one failure mode this design cannot tolerate. So the aggregate
**counts those rows per group**, and the reconstruction drops any member whose
own estoque — or whose kit component's estoque — sits in a flagged pair. The
send policy reads a missing member as *unknown* and sends.

That makes the representation of "unknown" load-bearing: it is the **absent
key**, tested with `exists`. v2 writers always write `movimento`, and the v1→v2
migration omits the key rather than storing an explicit `null` when it cannot
recover a balanço's delta — precisely so one existence test is complete. A
future writer that stores `movimento: null` would defeat the counter.

⚠️ Still blind to a quantity written with **no ledger row at all** — the ML
import's unaudited `merge` (`import.ts`, `importVariations.ts`). There is
nothing in the window to count, so that one is closed at the source by making
the importer append a row, tracked separately.

⚠️ It needs the covering index `historicoEstoque(timestamp, parentId,
depositoOuterRef)`, COLLECTION_GROUP. An uncovered aggregate buffers every group
in the 128 MiB budget and can `RESOURCE_EXHAUSTED`.

### 5. The high-stock rule, and why it compares the minimum

On the incremental tier only, a send is skipped when the quantity is comfortably
high on **both** sides of the movement:

```
send  ⟺  anterior ≠ atual  ∧  ¬( incremental ∧ min(anterior, atual) > LIMIAR_ALTO )
```

`LIMIAR_ALTO` defaults to 100 (`MERCADO_LIVRE_STOCK_LIMIAR_ALTO`). Rationale:
going 100 → 99 cannot cause an oversell within a 15-minute window — nobody drains
99 units that fast — so it can wait for the daily pass.

⚠️ **It is `min(anterior, atual)`, never `atual` alone.** Gating on the current
value would skip `110 → 95`, which is exactly the movement that walks a listing
into the danger zone, and the next sale would oversell. Comparing the minimum
makes **every crossing send, in both directions**. This is the most likely line
in the whole design for someone to "simplify" into a real bug.

This subsumes the old `limiarEstoqueBaixo` (default 5) heuristic: low stock now
always sends, because `min(...) ≤ LIMIAR_ALTO` holds.

### 6. `estoque.ultimaModificacao` means "stock changed **or** sold"

On a kit's estoque doc the field no longer means only "the quantities changed" —
it also means "this kit was an order line". The name does not say so; this ADR
does. It was verified to have no consumer outside the Mercado Livre sweep, so the
overload breaks nothing today.

⚠️ Unit: `estoque.ultimaModificacao` is **milliseconds**. Several sibling
documents use microseconds (ADR 0011's named trap) — a stamp builder copied
across is wrong by 1000×.

### 7. A negative reservation can never increase availability

`estoqueDisponivel` floors the reservation at zero **before** subtracting:

```ts
return e.quantidade - Math.max(0, e.quantidadeReservada);
```

Without that floor a negative reservation *adds* to availability — `8 − (−2) = 10`
— so one bad value invents two units that do not exist. This is the worst failure
direction in this whole design: every other inaccuracy here makes the sweep send a
number redundantly, while this one makes Mercado Livre **sell stock the store does
not have**. The same helper feeds the pedido form's availability check and the
print assembler, so the invention spreads well beyond the sweep.

The floor belongs in `estoqueDisponivel` because that helper is the single
derivation of `disponivel` in the repo — kits included, since `kitEstoqueDisponivel`
consumes its output rather than re-deriving. Fixing it anywhere else would leave a
consumer behind.

⚠️ **`quantidadeReservada: z.number().min(0)` in the schema is not the guarantee.**
It validates a write through a Zod converter, and three live paths reach the
availability calculation around it:

- the ML sweep consumes **raw** pipeline rows, never Zod-parsed;
- the sweep's window-start reconstruction *synthesizes*
  `quantidadeReservada − ΣmovimentoReservada`, arithmetic that can land below zero
  on its own whenever the stored counter was floored but the ledger recorded the
  unclamped delta;
- the live Flutter app and every Admin SDK writer bypass this schema entirely
  (root `CLAUDE.md` rule 7 — assume a second writer).

The write paths do floor: `aplicarMovimento` clamps a balanço's counted reservation
in `planMovimentacao` and follows an entrada/saída `increment` with
`FieldValue.maximum(0)` on the same doc. Those floors are necessary and not
sufficient — they only bind writes that go through them.

📌 **Open follow-up:** nothing yet *audits* production for a stored negative
`quantidadeReservada`. The floor above makes such a row harmless to availability,
but it would still be a real data defect worth finding and explaining. A tracking
issue for that audit is to be opened after this stack merges.

## Consequences

**Easier.** The window filter loses its correlated component aggregate and one
level of subquery nesting, so the pipeline's still-open level-two nesting spike
stops being load-bearing. The `pedidos` sales pre-pass and its silent 10 000-id
cap (#806 S10) are deleted outright. `deveEnviarIncremental`'s three heuristics
(sold / recently created / below limiar) collapse into one exact predicate
computed from the ledger. Re-reading fresh quantities on a task retry (#693)
becomes point reads by deterministic estoque id.

**Harder.** Staleness for sibling kits is now bounded by the *monthly* pass rather
than by incidental re-sends, so the full pass is load-bearing and its flag must
stay on. Anyone reading the sweep will find families it knowingly does not
refresh; without this ADR that reads as a defect.

**New risks.**

- Reshaping `historicoEstoque` requires a one-time `tools/migrations` script and
  the migration window (ADR 0013). Until it runs, rows without `movimento` make
  the aggregate fail open — correct, but noisier.
- The Mercado Livre listing import writes estoque with a plain `merge` and **no
  history row** (`apps/mercado-livre/lib/marketplace/import.ts`). That leaves a
  hole in the sums and is tracked separately.
- `historicoEstoque` is deliberately **not** `serverOwned` — the Flutter app still
  writes rows during the dual run — so the ledger is client-writable and only as
  trustworthy as that. Revisit when the Flutter sender is decommissioned (#431).

## Alternatives considered

- **Materialize the kit quantity on the kit's estoque doc** → rejected on
  *measured* cost. One sale fans out into thousands of reads and writes.
- **Component-driven fan-out that only stamps a timestamp** (an `onDocumentWritten`
  trigger over `estoques` plus `produtos where componentesKitKeys array-contains …`)
  → rejected on the same arithmetic: ~2 000 writes per sale. Cheaper per write,
  identical in magnitude.
- **Keep `maxComp` in the window filter** (the status quo) → rejected. It is
  correct and unaffordable: it makes ~2 000 sibling kits candidates 96× a day.
- **Reverse `historicoEstoque` per family**, as #695 first proposed → superseded
  rather than rejected. With the join keys and a uniform signed delta, the
  reversal became one grouped aggregate per tick instead of a per-family probe,
  and the balanço / legacy-`tipo: null` exception set disappeared.
- **Last-sent state on the link documents** (#891 / #893) → not rejected. It is
  `O(1)` per listing with no history scan and is exact against what was
  *delivered* rather than against the ERP ledger, at the cost of five permanent
  schema fields and a TTL. It remains the honest competitor for the full pass's
  change check; decide on measured staging numbers.
- **A separate `ultimaVenda` field** instead of overloading `ultimaModificacao` →
  not taken. Cleaner semantics, but a second field and index entry for a signal
  nothing else currently distinguishes. Revisit if a tier needs to treat "sold"
  and "stock moved" differently.

## Status

Accepted.
