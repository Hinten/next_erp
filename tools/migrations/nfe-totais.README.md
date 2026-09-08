# Migration: NF-e `totais` backfill (`2026-09-nfe-totais`)

Gives every already-authorized NF-e the `totais` block that emission started
writing in #1541 — `<ICMSTot>` lifted out of `xml_nfe_proc` into modeled numbers,
including the derived `totais.receitaBruta` the monthly Simples Nacional apuração
sums. Part of #1491.

## ⚠️ This is the feature's ON-SWITCH, not a tidy-up

The apuração counts every `aprovada` note in its 12-month window that lacks
`totais.receitaBruta` as `notasIlegiveis`, and **refuses to publish a rate while
that counter is above zero** — because Firestore's `sum()` skips a missing field
in silence, so an unread note would shrink RBT12, drop the company into a lower
faixa, and under-declare tax with every job still reporting success.

Until this script runs, every note emitted before #1541 is in that count. Which
means: **no filial gets a computed rate at all.** Scheduling this is not
optional follow-up work — the monthly runner does nothing useful without it.

## What it does

One pass over `collectionGroup('nfev4')`. For each document:

| stored state                    | verdict                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| no `xml_nfe_proc`               | `sem-xml` — never authorized, or an EPEC whose proc has not landed yet |
| XML present, no `totais`        | **`ausente` → write.** The main population                             |
| XML present, `totais` differs   | **`divergente` → write.** See below                                    |
| XML present, `totais` identical | `ja-igual` — the idempotence                                           |
| XML present, unreadable         | `ilegivel` — **no block written**, logged by path, counted             |

`divergente` is a real population, not a hypothetical: slice 1 (#1541) wrote the
block _without_ `receitaBruta`, and slice 2 added the field. Every note emitted
between the two carries a block that is complete by the schema of its day and
incomplete for the monthly sum. Recomputing from the same bytes is safe because
`xml_nfe_proc` has exactly one non-null writer in the repo (`swapAnchorForProc`)
and is never rewritten once set.

An `ilegivel` note is left **without** a block on purpose. Folding a malformed
component to `0` would leave the note looking readable and let the apuração
publish a rate over a revenue it had itself corrupted. Without the block the note
stays in `notasIlegiveis`, the rate is withheld, and a human is told.

## Scope: the whole group, no `estado` filter

Firestore cannot express "field is missing" as a filter — an absent key is in no
index — so there is no query that returns only the notes needing work; the pass
has to read all of them. Given that, an `estado` filter would buy nothing but a
new composite index, and it would _lose_ the cancelled notes, which keep their
`xml_nfe_proc` and their block. The rule is the emitter's own: **every note
carrying an authorized XML gets the block, whatever its estado.** What counts as
revenue is the apuração's decision (it sums `aprovada` only), not this script's.

## Rule 7: no lost-update guard, deliberately

Tier 0 — the race is impossible rather than guarded. `swapAnchorForProc` is the
only writer that sets `xml_nfe_proc` non-null, it writes `totais` in the same
operation, and it never rewrites either. So both writers compute the same
function of the same immutable bytes; there is no losing side. The write is a
field-scoped `update`, never a `set`, so it also cannot blow away a sibling field
— which matters because the documents are read through a `select()` projection.

## Cost

Each `nfev4` document carries a full NF-e XML, and Enterprise bills **data
scanned**, so this pass is expensive by construction — it is a one-shot manual
run, never anything scheduled. The `select('xml_nfe_proc', 'totais')` projection
does **not** reduce that bill (the document is read either way); it keeps
`xml_assinado`, `xml_epec_proc` and `infNFe` — three more whole XMLs — off the
wire and out of the process, which is why the page size is only 100.

## Running it

```bash
# 1. What shapes are actually in this corpus? Writes nothing, logs no per-doc rows.
pnpm --filter @delfrance/migrations migrate:nfe-totais --project <staging-id> --report-only

# 2. Dry run — every intended change and every ilegível note, to out/*.jsonl
pnpm --filter @delfrance/migrations migrate:nfe-totais --project <staging-id>

# 3. Apply
pnpm --filter @delfrance/migrations migrate:nfe-totais --project <staging-id> --apply

# 4. ⚠️ The idempotence proof, not a formality: this must report ZERO changes.
pnpm --filter @delfrance/migrations migrate:nfe-totais --project <staging-id>
```

Read the `ilegivel` count at step 1. It is the number of notes that will keep the
apuração from publishing a rate, and it does not shrink by re-running the script
— those notes need a human to look at their XML.

## Timing

**The authoritative run is inside the migration window** (root `CLAUDE.md` rule 8
/ ADR 0013). The legacy Flutter app is the sole live writer of the source project
until the window switches it off, so anything run earlier is partially superseded.
A staging run is a **rehearsal**: the dry-run counts, then a clean second pass.

A Firestore import fires no Cloud Functions triggers and this backfill is not a
trigger either — nothing recomputes `totais` on arrival, so this script has to run
**after** the import, before the first apuração of the new project.
