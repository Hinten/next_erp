# `produto-ultima-modificacao` — give every produto the key its list sort needs

Writes `ultimaModificacao` on every `produtos/{id}` document that is **missing
the key**, so none is hidden by the `/produtos` default sort.

```bash
# dry-run (default) — logs every doc it WOULD touch, writes nothing
pnpm --filter @delfrance/migrations migrate:produto-ultima-modificacao --project <project-id>

# write
pnpm --filter @delfrance/migrations migrate:produto-ultima-modificacao --project <project-id> --apply
```

## Why it is needed

Firestore `orderBy` **silently skips documents that are missing the ordered
field**. Since #159 `produtoMeta.defaultQuery` orders by `ultimaModificacao
desc`, so a produto without that key does not appear in `/produtos` at all — no
error, no empty state, just a row that is not there.

The key went absent because `produtoSchema.ultimaModificacao` was declared
`.nullable().optional()` with no `.default(null)`: Zod **drops** an optional key
the caller did not supply, and the document was written without it. #159 changed
the declaration to `.nullable().default(null)`, which fixes every future write.
This script repairs what is already on disk.

Known producers of key-less produtos:

| producer                                | note                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| `VariationManager` variation children   | `produtoSchema.parse({...})` with no stamp                   |
| Mercado Livre imports before 2026-08-06 | PR #861: imported produtos "never appeared in DESC listings" |
| e2e / dev fixture seeders               | Admin `.set()` bypasses Zod entirely — fixed in #159         |

⚠️ A stored `null` is **not** the bug and is deliberately left alone: the key
exists, so the row is indexed and sorts last in DESC. Only an absent key hides a
row. The transform keys on `'ultimaModificacao' in data`, never on truthiness —
`0` and `null` are both "present".

## ⚠️ Read this before scheduling the run

**Inside the cutover window.** The Flutter app is the sole live writer on the
_source_ project until the window switches it off, and it writes produtos
without going through this repo's schema. A run before the window is a
**rehearsal**, not the authoritative pass — every legacy write that lands
afterwards can reintroduce the gap. Root `CLAUDE.md` rule 8 / ADR 0013.

The pass is **idempotent and re-runnable**: the only write branch requires the
key to be absent and it writes a key, so a second run finds `present` and does
nothing. An early run is therefore harmless, just unfinished.

**Order relative to the index deploy:** deploy
`produtos (paiId ASC, ultimaModificacao DESC)` **first**. Until it exists the new
default query full-scans (Enterprise never raises `FAILED_PRECONDITION` — it
bills you instead). Running the backfill before the index is not wrong, it is
just paying for an unindexed list in the meantime.

## What it changes

| collection | scope                                          | field               | value                                           |
| ---------- | ---------------------------------------------- | ------------------- | ----------------------------------------------- |
| `produtos` | full walk — parents **and** variation children | `ultimaModificacao` | the doc's own `timestamp`, else the run's clock |

The value prefers the produto's own `timestamp` (creation, already millis on
produto — same unit, no conversion) so repaired rows keep their real relative
order instead of collapsing into one indistinguishable block at the migration
instant. Anything non-finite — absent, `null`, a legacy ISO string that never got
normalized on disk — falls back to a single per-run clock.

## Why a full walk, and what it costs

Firestore **cannot query for a missing field**: an absent key is simply not in
any index, so there is no filter that selects these rows. Every produto has to
be read and inspected. On Enterprise that is billed by data scanned — which is
why this is a one-shot manual run rather than anything scheduled.

Paging is by document id (`orderBy(FieldPath.documentId())` + `startAfter`), a
stable cursor with bounded memory, 300 docs per page.

## Verifying

1. Dry-run and read the summary line: `<n> missing the key, <m> already had it`.
2. `--apply`, then **re-run the dry-run**. A converged collection reports
   `0 missing the key` — that second pass is the idempotence check, not a
   formality.
3. In the app: `/produtos` should show the same row count as an unsorted
   `produtos` count, and variation children should still be hidden by
   `paiId == null` (that is the base filter, not this field).
