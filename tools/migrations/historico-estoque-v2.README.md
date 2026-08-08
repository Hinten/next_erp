# `historico-estoque-v2` — make the stock ledger summable

Reshapes every `historicoEstoque` row from v1 to v2 (ADR 0014, #695).

```bash
# dry-run (default) — logs every row it WOULD touch, writes nothing
pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- --project <project-id>

# write
pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- --project <project-id> --apply
```

## ⚠️ Read this before scheduling the run

**This belongs inside the cutover window** (root `CLAUDE.md` rule 8 / ADR 0013),
not before it. The Flutter app still writes v1 rows, so any earlier run is
partially undone by every write that lands afterwards. Running early is not
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
invent one**. It writes `movimento: null` and logs a skip with the reason.

| verdict                  | meaning                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `migrado`                | converted, delta known                                                 |
| `movimento-desconhecido` | converted, but `movimento: null` — logged as a skip                    |
| `ja-migrado`             | already v2 (numeric `movimento`) — untouched                           |
| `sem-dados`              | unrecognized row shape, or a path yielding no keys — untouched, logged |

A null `movimento` reads downstream as _unknown_ and **fails open**: the Mercado
Livre sweep sends rather than skips. Guessing the counted value as if it were a
delta would instead be silently wrong in the one direction nothing can detect —
`sum(movimento)` would drift and the sweep would skip sends it should make.

The run prints a final count of these; grep the JSONL for `balanço sem`.

## Verifying a run

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
