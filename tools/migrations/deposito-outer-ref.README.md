# `deposito-outer-ref` — one encoding for `depositoOuterRef`

Normalizes every stored `depositoOuterRef` to the canonical
`documents/depositos/<id>` form.

```bash
# pre-flight — counts the stored forms per collection, logs no per-doc lines, writes nothing
pnpm --filter @delfrance/migrations migrate:deposito-outer-ref -- --project <project-id> --report-only

# dry-run (default) — logs every doc it WOULD touch, writes nothing
pnpm --filter @delfrance/migrations migrate:deposito-outer-ref -- --project <project-id>

# write
pnpm --filter @delfrance/migrations migrate:deposito-outer-ref -- --project <project-id> --apply
```

`--report-only` is the pass to run **first**. A dry-run enumerates documents; the
numbers that decide anything are _how many docs are in the bare form, per
collection_ and _whether any `desconhecido` exists_ — the latter needs a human
before an `--apply` run, not after it.

## ⚠️ Read this before scheduling the run

**Inside the cutover window, and after #933.** Two reasons, in that order:

1. The Flutter app is the **sole live writer** on `estoques` in the _source_
   project until the window switches it off. A run before that is superseded by
   every legacy write that lands afterwards. The pass is idempotent,
   so an early run is not _harmful_ — it is simply not finished, and the
   authoritative run is the one inside the window.
2. The `historicoEstoque` v1 → v2 pass (#933) **authors canonical
   `depositoOuterRef` values** on the rows it converts. Running it first leaves
   this pass strictly less to do.

**This normalizes data only — no reader is narrowed.** The Mercado Livre sweep's
two-form disjunction and its accumulate-don't-overwrite aggregate stay exactly as
they are, because the migrated corpus carries both encodings. Tightening
readers to a single encoding is a separate, post-cutover question (#836). That
also means this pass can be skipped or re-run freely without breaking anything:
nothing depends on it having happened.

## What it changes

| collection         | scope            | field                                   |
| ------------------ | ---------------- | --------------------------------------- |
| `estoques`         | collection group | required (`outerRefSchema`)             |
| `historicoEstoque` | collection group | nullable, added by the v2 reshape       |
| `integracao`       | root collection  | nullable — the conta's default depósito |

Only the prefix changes. `depositos/dep-1` becomes
`documents/depositos/dep-1`; the id is opaque and is never split, trimmed or
re-cased.

| verdict        | meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `ja-canonico`  | already `documents/depositos/<id>` — untouched                 |
| `normalizado`  | bare form → canonical, the only case that writes               |
| `ausente`      | no field (legal on the two nullable collections) — untouched   |
| `desconhecido` | present but neither form — **untouched**, logged with a reason |

## The one thing this script refuses to do

A value matching neither accepted encoding is **reported, never guessed at** —
same discipline the v2 pass uses for an unrecoverable balanço. A
`depositoOuterRef` pointing at another collection, carrying a nested path, or
holding a non-string is a data problem someone should look at. Rewriting it would
convert a visible defect into a plausible-looking wrong pointer, and this field
is a **join key**: a wrong one silently attaches stock to the wrong depósito,
which is far worse than an obviously broken one.

⚠️ **Carrying the canonical prefix does not exempt a value from that check.**
`depositos` is a root collection, so a valid ref is exactly one segment after the
prefix — `documents/depositos/dep1/sub` is a broken join key that no equality
comparison will ever match, and reporting it as `ja-canonico` would tell you it
is already fine. Both encodings run through the same id validator for that
reason.

## Why the field is worth normalizing at all

Readers tolerate both forms by invariant, so nothing is _broken_ today. But the
field is joined on, and the ML sweep's ledger aggregate **groups by the raw
value** — so one `(produto, depósito)` pair stored under both encodings returns
as two groups. The sweep accumulates rather than overwrites precisely because the
data forces it to. Any future consumer that compares with a single encoding
silently misses the other half.

## Cost

Two collection-group scans plus one root-collection scan, and Firestore
Enterprise bills **data scanned**. Paged by document key — Firestore's
always-available native ordering, so **no index is needed**. A `where` could not
narrow it: the docs needing a change are the ones _not_ equal to a canonical
value, and Firestore has no "not prefix" predicate.

## Verifying a run

1. `--report-only` → note `normalizado` per collection, and confirm
   `desconhecido` is zero (or triaged).
2. `--apply`.
3. `--report-only` again: `normalizado` must be **0** and `ja-canonico` must have
   absorbed the previous `normalizado` count. That second pass is the idempotence
   check — the transform is a fixed point, pinned by a unit test.
4. The JSONL in `out/` carries one line per doc with `from`/`to`, so a spot-check
   against the console is one `grep`.
