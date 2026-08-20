# `historico-estoque-v2` — make the stock ledger summable

Reshapes every `historicoEstoque` row from v1 to v2 (ADR 0014, #695).

```bash
# pre-flight — counts the stored shapes, logs no per-row lines, writes nothing
pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- --project <project-id> --report-only

# dry-run (default) — logs every row it WOULD touch, writes nothing
pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- --project <project-id>

# write
pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- --project <project-id> --apply
```

`--report-only` is the pass to run **first**. It answers the question a dry-run
cannot — _what is actually stored?_ — and in particular the one number worth
knowing before committing: how many balanços will come out with no recoverable
delta. It prints a verdict tally plus a breakdown by reason. Same scan, same
cost as a dry-run; it just tallies instead of enumerating.

## ⚠️ Read this before scheduling the run

**This belongs inside the cutover window** (root `CLAUDE.md` rule 8 / ADR 0013),
not before it. The Flutter app keeps writing v1 rows into the source project
until the window switches it off, so any earlier run is superseded by every
legacy write that lands afterwards. Running early is not
_harmful_ — the pass is idempotent and re-runnable — it is simply **not
finished**. The authoritative run is the one after Flutter stops writing.

**Order within the window**: this is a data pass, so it goes after the index and
rules deploys and before the functions/apps flip (ADR 0013's ordering). The
`historicoEstoque(timestamp, parentId, depositoOuterRef)` COLLECTION_GROUP index
should already be deployed — not for this script, which needs none, but because
the sweep starts summing the rows this produces.

**Cost**: it walks _every_ `historicoEstoque` row via a collection-group scan,
and Enterprise bills data scanned. There is no cheaper shape — the rows to
convert are exactly "all of them", so no predicate narrows it, and filtering on
`movimento == null` would need an index over a field no row has yet. The walk is
paged by document key (native ordering, no index required).

## What it changes

| v2 field                           | comes from                                                        |
| ---------------------------------- | ----------------------------------------------------------------- |
| `movimento` / `movimentoReservada` | v1 `quantidade` / `quantidadeReservada` — **except on a balanço** |
| `saldo` / `saldoReservada`         | v1 `quantidadeDepois` / `quantidadeReservadaDepois`               |
| `parentId` / `depositoOuterRef`    | the document **path** (never stored on the row)                   |

The v1 fields are left in place rather than deleted: they cost nothing at rest,
and keeping them means an aborted window can still read the old shape.

## The balanço, and the one thing this script refuses to do

v1 stored a balanço's **counted value** in the same field a movement used for its
**signed delta**, discriminated only by `ehBalanco`. That overload is the whole
reason for the reshape — a field whose meaning depends on a sibling cannot be
summed.

Converting a balanço therefore needs `contado − anterior`, and `anterior` is only
knowable when the row also carries `quantidadeAntes`. The pedido sync always
wrote that pair. The **read-free manual path never did** — and a manual balanço
is exactly the kind of row that path produces.

So for many balanços the delta is **unrecoverable, and this script does not
invent one**. It writes the row **without a `movimento` field at all** and logs a
skip with the reason.

| verdict                  | meaning                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `migrado`                | converted, delta known                                                 |
| `movimento-desconhecido` | converted, but `movimento` left **absent** — logged as a skip          |
| `ja-migrado`             | already v2 (numeric `movimento`) — untouched                           |
| `sem-dados`              | unrecognized row shape, or a path yielding no keys — untouched, logged |

⚠️ **Absent, not `movimento: null`.** The ML sweep spots an unreadable row with
`countIf(not(exists('movimento')))`, so _absent_ is the single wire
representation of "unknown" its fail-open path can see. An explicit null would
read as present, be skipped by `sum` anyway, and drop the pair back into the
silent-skip hole that counter exists to close. Zod still surfaces it to readers
as `movimento: null` — absent on the wire, null in the model, both meaning
unknown. Anything that later writes an explicit null here re-opens the hole.

An unknown `movimento` **fails open**: the sweep sends rather than skips.
Guessing the counted value as if it were a delta would instead be silently wrong
in the one direction nothing can detect — `sum(movimento)` would drift and the
sweep would skip sends it should make.

The same reasoning applies to a _movimentação_ with no readable `quantidade`:
that records nothing, so it takes the unknown path too rather than a confident
`movimento: 0`. (A missing `quantidadeReservada` is different and genuinely
means 0 — the reservation did not move.)

The run prints a final count of these; grep the JSONL for `sem`, or read the
`--report-only` breakdown.

## Verifying a run

0. `--report-only` first, and keep the output. It is the baseline every later
   count is judged against, and the only place the corpus is described rather
   than enumerated.
1. Dry-run and read `out/<stamp>-historico-estoque-v2-dryrun.jsonl`. Sanity
   check: `kind: 'skip'` lines should be dominated by balanços, and their count
   should be plausible against how many inventory counts the store has done.
2. `--apply`, then **run it a second time**. The second pass is the idempotence
   check: `docsChanged` should fall to roughly the number of unrecoverable
   balanços (those re-report deliberately, so operators keep seeing the number)
   and every ordinary movement should now read `ja-migrado`.
3. Spot-check a produto in the app: the pedido Estoque tab renders
   `saldo − movimento → saldo`, and the produto movement modal shows an em-dash
   for any row whose `movimento` is null.

⚠️ **Staging does not need to migrate.** It is disposable and re-seedable from
`tools/test-fixtures`; a staging run is a **rehearsal** (dry-run counts, then a
clean second pass), never a data-preservation goal.
