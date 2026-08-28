# Audit: estoque documents with a negative `quantidadeReservada` (#931)

**Status: AUDIT ONLY — this script has no `--apply` path and never writes.**

## Why

`disponivel = quantidade − quantidadeReservada`, so a **negative** reservation
_increases_ availability:

```
quantidade = 8, quantidadeReservada = -2
disponivel = 8 - (-2) = 10      ← two units that do not exist
```

That is the worst failure direction in this area: every other inaccuracy makes
the stock sweep send a number redundantly, while this one makes Mercado Livre
**sell stock the store does not have**.

#925 floored the reservation inside `estoqueDisponivel` (the single derivation of
`disponivel` in the repo) and #931 floored the two `importCore` sites that did
their own arithmetic. So a row like this is **harmless to availability today** —
but it is still a real data defect, nothing had ever looked for one, and the
writer that produced it may well still exist.

This report finds them and attributes each one to a writer.

## Run it

```bash
pnpm --filter @delfrance/migrations audit:estoque-reservada-negativa --project <project-id>
```

Output: `tools/migrations/out/<timestamp>-estoque-reservada-negativa-dryrun.jsonl`,
one line per flagged estoque, plus a per-`kind` count and a total
`unidadesInventadas` on stdout.

**Staging first**, to confirm the walk and the paging cursor work against a real
project. Then production. Credentials come from `FIREBASE_SERVICE_ACCOUNT` /
`FIREBASE_SERVICE_ACCOUNT_PATH` (the script loads `.env.local`) or
`--service-account <path>`. `--project` is required and never inferred; the
service account is checked against it.

⚠️ Per root `CLAUDE.md` rule 8, the production run is a **human, coordinated
step** — agents surface it, they do not run it.

## Reading the output

`unidadesInventadas` on each row is the number that matters: how much stock that
row would invent without the floor, i.e. how much Mercado Livre could have
oversold. Sum it across the report to size the whole defect.

| `kind`          | What it means                                                                                                                                                                                                                         | What to do                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sem-historico` | Negative counter, **no ledger rows at all**. Some writer moved the counter and appended nothing — the ML import's unaudited `merge` (ADR 0014 §4 names it), a console edit, or a pre-trail Flutter write.                             | Check `ultimaModificacao` against the ML import's activity. If the import is the writer, it is already fixed by #931 going forward.                                                                         |
| `historico-v1`  | At least one row is **missing the `movimentoReservada` key** — the legacy Flutter shape. The ledger cannot be summed, so nothing more precise is claimable.                                                                           | Most likely Flutter-era, i.e. a writer that dies at the cutover (#431). Read `ultimasLinhas` for the `motivo` text.                                                                                         |
| `desvio-ledger` | Every row is v2, but `Σ movimentoReservada` **≠** the stored counter. Something changed the counter without appending a row, or a counter floored by `FieldValue.maximum(0)` drifted from a ledger that recorded the unclamped delta. | The gap (`quantidadeReservada − somaMovimentoReservada`) is the unrecorded amount. This is the kind most likely to name a live bug.                                                                         |
| `historico-v2`  | Every row is v2 and the sum **reconciles**. The trail genuinely records the movements that produced the negative.                                                                                                                     | `ultimasLinhas` names the writer directly — `pedidoNumero` ties the row to an order, `usuarioOuterRef` is present only on a manual movement, and `tipo` / `motivo` describe it. Read it and fix the writer. |

There is deliberately **no fifth kind** guessing at intent. Every row carries the
numbers and the last 10 ledger rows so a human can judge, rather than a script
putting a confident label on a guess.

### What is deliberately NOT flagged

A **missing or non-numeric** `quantidadeReservada`. It reads as `0` everywhere —
the Zod schema defaults it, the sweep coalesces it — so it cannot invent stock,
which is the thing this audit looks for. Flagging it would bury every real hit
under the kit-sold stamp, which writes no counters at all by design (ADR 0014 §2).

## Cost

**No index is needed, and none should be added.** The walk is a plain
`orderBy(documentId())` key-order scan over `collectionGroup('estoques')`, with
the `< 0` test done in memory — the one ordering Firestore always serves without
a declared index. Only a document that actually holds a negative pays for the
`historicoEstoque` read.

The narrower `where('quantidadeReservada','<',0)` looks cheaper and is not. On
Firestore **Enterprise** an undeclared range filter never throws
`FAILED_PRECONDITION` — it silently full-scans and bills data scanned. On
**Standard**, where production still lives (rule 8), it throws and demands a new
composite (`quantidadeReservada ASC, __name__ ASC`). Either way it costs an index
deploy and a build wait for a one-off read-only report.

### If the collection-group walk is refused

Pass `--target produtos` for the fallback: walk `produtos` by document id and read
each one's `estoques` subcollection. Same report, more round trips, and it needs
nothing beyond the native key ordering on a plain collection. The flag exists so
the fallback is a runtime choice rather than a code edit mid-run.

```bash
pnpm --filter @delfrance/migrations audit:estoque-reservada-negativa --project <id> --target produtos
```

## Correcting the rows is NOT part of this

`--apply` is **rejected**, not ignored. Deciding what a stock counter _should_ be
is a decision about real inventory, and per root `CLAUDE.md` rule 8 a bulk write
against production belongs in the coordinated cutover window — a correction run
before it is superseded by the legacy app's own later writes to the source
project anyway.

If the report finds rows that need correcting, that correction is its own
`needs-migration-window` issue.

## Related

- `apps/docs` → **ADR 0014 §7**, "A negative reservation can never increase
  availability" — the floor, why it is a helper rather than an inline `Math.max`,
  and why the schema must not be made into the guarantee.
- `tools/migrations/ml-pedido-pago-audit.README.md` — the audit this one is
  modeled on, including the same no-index walk reasoning.
- `tools/migrations/historico-estoque-v2.README.md` — the v1→v2 ledger migration.
  Its run (#933) normalizes the `historico-v1` rows this report flags, so running
  this audit **before** it is what preserves the v1 evidence.
