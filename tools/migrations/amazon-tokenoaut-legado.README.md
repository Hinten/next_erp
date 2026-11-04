# Migration: legacy Amazon `tokenoaut` deletion (`2026-10-amazon-tokenoaut-legado`)

Deletes every document under `integracao/{contaId}/tokenoaut/`, the legacy
Amazon LWA token store, from the migrated corpus. It touches no other
subcollection and never the `integracao` document itself.

The legacy app kept its Amazon LWA token documents in that subcollection, a
**live refresh token** included. This app never
models the subcollection and no source file reads it: the Amazon credential this
app uses lives in the generic admin-only `integracao/{id}/credenciais/current`
document, written by the Amazon OAuth callback (Amazon master plan, step 2). So
once the data has moved, every `tokenoaut` document is a credential with no
reader.

This is window item **W3** of the Amazon master plan
(`.master_plans/amazon/amazon-marketplace-integration.md` §5). Production
execution is a coordinated cutover operation in
[#1208](https://github.com/Hinten/next_erp/issues/1208), never part of deploying
this code, and its tracking issue is opened only after this script merges.

## ⚠️ Why this runs only inside the migration window

**The legacy app keeps writing `tokenoaut` on the source project until it is
switched off**, so every export carries those documents again and an earlier run
is superseded. A run on the new project before the import deletes nothing that
matters, and a run before the freeze is superseded by the next export.

The authoritative run is the one inside the window, **after the Phase-2 import
and before Phase-3 traffic** (ADR 0013 phase order). Never point it at the legacy
project: the legacy app reads the subcollection for as long as it serves Amazon.

An import fires no Cloud Functions triggers, and nothing in this codebase reads
or derives anything from `tokenoaut`, so nothing needs recomputing before or after
the deletion.

The script is idempotent, so a dry run or a staging rehearsal earlier is
harmless. Only `--apply` on the production project is window-bound.

## Prerequisite: the key index

The deletion pages each parent's subcollection by document key
(`orderBy(FieldPath.documentId())`). Firestore Enterprise has no implicit
document-key index (#1874, #1895), and a conta's subcollection is not bounded
in size, so the walk rides a declared, **migration-only** index:

```json
{
  "collectionGroup": "tokenoaut",
  "queryScope": "COLLECTION",
  "fields": [{ "fieldPath": "__name__", "order": "ASCENDING" }]
}
```

It is in the repo-root `firestore.indexes.json`, paired with its row in
[`key-walks.json`](key-walks.json) (`src/keyWalks.indexes.test.ts` pins the
pairing). It deploys with the other indexes in phase 0 (W9), well before this
run in phase 2, and #1896 deletes it after the cutover.

⚠️ **`scripts/check-key-walks.mjs` does not prove this walk.** Its probe builds
a **root** `collection(<name>)`, and the root `collection('tokenoaut')` is empty,
so it would plan nothing about a per-parent walk. The row therefore carries
`"parent": "integracao"`, and the checker prints it as
`NOT PROBED collection(integracao/{id}/tokenoaut)` and counts it toward no exit
code. Its other walks keep their verdicts, so an exit 2 still means a genuinely
empty collection. Confirm instead that the index above shows **READY** in the
project's index list before step 3 below. Probing the walk itself through a
parent is a follow-up: how the Enterprise plan names a subcollection's
collection-scope key index has not been measured.

## What it decides

| per `integracao` parent (from `listDocuments()`)                  | verdict                                    |
| ----------------------------------------------------------------- | ------------------------------------------ |
| `tokenoaut` holds ≥ 1 document, any `tipo`                        | **delete** every document in it            |
| `tokenoaut` holds documents, parent document **missing** (orphan) | **delete** every document; reported `orfa` |
| `tokenoaut` is empty or absent                                    | nothing                                    |

- **Every document goes, whatever it holds.** A `revoked: true` document and a
  live one are deleted alike: no field of a token document is ever read.
- **Exact name.** Only `tokenoaut` is addressed, by name; the script never
  enumerates a parent's subcollections. `tokenOaut`, `tokenoauth`, `token6h`,
  `tokenDuravel`, `credenciais` and every other sibling are never touched.
- **The parent is never written.** Its `tipo` is read through a field mask (no
  other field of it reaches the process), and it is used for the report only.
- **Orphans are found.** `listDocuments()` also returns parents whose document
  no longer exists but which still hold subcollections. A conta deleted without
  its subcollections would otherwise hide its token documents from a walk over
  existing contas, and an import fires no cascade that could reclaim them.
- **The listing is checked, not trusted.** Whether Enterprise's
  `listDocuments()` returns every missing parent is unmeasured, so the census
  also counts the whole `tokenoaut` collection group, which does not depend on
  the listing. A difference from the listed parents' sum is printed as
  `DIVERGÊNCIA`, and `--apply` fails unless the group reads 0 after its deletes.

**Race tier 0** (root `CLAUDE.md` rule 7): a blind delete of a named document is
idempotent and order-free, and nothing is derived from a read beyond "this name
exists", so there is nothing to compare or guard. No Cloud Functions trigger
watches a `tokenoaut` document, so a delete fires nothing.

## Nothing a token document holds is read, logged or printed

- The key walk is `select()` with an **empty projection**: the answer carries
  document names only.
- The census is a `count()` per parent plus one `count()` of the group.
- A JSONL row names the document path and its parent's `tipo`, nothing else:

```json
{
  "kind": "change",
  "path": "integracao/<conta-id>/tokenoaut/<doc-id>",
  "field": "documento",
  "from": { "tipo": 8 },
  "to": "apagado"
}
```

`transform.test.ts` pins all three against a fake whose token documents throw on
any field read, with a sentinel credential value (deliberately not token-shaped)
that must appear in no row, census line or error.

## Running it

`--project` is required, never inferred, and matched against the service
account. Dry-run by default. Every command below is run by a person, in order;
agents never run it against production.

1. **Census first.** Writes nothing and logs no per-document rows.

   ```bash
   pnpm --filter @delfrance/migrations migrate:amazon-tokenoaut-legado --project <new-project-id> --report-only
   ```

   Read the `CENSO` line and the per-`tipo` lines: contas and documents per
   `tipo`, with orphans as `orfa` and a non-numeric `tipo` as `desconhecido`.
   Expect the Amazon `tipo` (8) and possibly a few orphans. The
   `grupo tokenoaut (sem a listagem)` line must equal the `CENSO` document
   total. A `DIVERGÊNCIA` line means token documents sit where the parent
   listing does not reach. Stop there: `--apply` would fail on them (step 3).

2. **Dry run.** Writes nothing; walks every listed parent's names by key and logs
   one row per document it would delete to a timestamped `-dryrun` JSONL under
   `tools/migrations/out/`.

   ```bash
   pnpm --filter @delfrance/migrations migrate:amazon-tokenoaut-legado --project <new-project-id>
   ```

   Confirm the row count equals the census total, every path ends in
   `/tokenoaut/<doc-id>`, and no row carries anything but the path and `tipo`.

3. **Apply.** Walks each parent's names by key with a cursor, deleting page by
   page (300 names, one batch each), then re-counts the parent, and finally
   re-counts the whole group. Each JSONL row is written after its batch commits.

   ```bash
   pnpm --filter @delfrance/migrations migrate:amazon-tokenoaut-legado --project <new-project-id> --apply
   ```

   The `APAGADOS` line counts the deleted documents and what is left in the
   group. The runner's own summary line reports `0 writes`: its counter covers
   the shared `BatchWriter` only, which has no delete, and this script deletes
   through its own batches.

   It fails, without losing anything, in two cases:
   - `TokenoautRemanescenteError`: a parent's final `count()` was not 0, so
     something still writes there or a delete did not land. The error lists the
     parent paths and how many documents remain. A re-run is the fix.
   - `TokenoautForaDaListagemError`: every listed parent reads 0, but the
     `tokenoaut` group does not. Those documents sit under a parent the
     `integracao` listing did not return, or under another collection, and a
     re-run cannot reach them. The error carries the count only. Investigate
     before re-running; this script deletes nothing outside the listed parents.

4. **Census again: it must read 0.**

   ```bash
   pnpm --filter @delfrance/migrations migrate:amazon-tokenoaut-legado --project <new-project-id> --report-only
   ```

   Expect `0 com tokenoaut, 0 documento(s) de tokenoaut` and
   `grupo tokenoaut (sem a listagem): 0 documento(s)`.

## Verification

- **Census of 0.** Step 4 is the check: no listed parent, orphan or not, holds
  a `tokenoaut` document, and the group total, which does not depend on the
  listing, reads 0 too.
- **Idempotence.** A second `--apply` reports `APAGADOS: 0` and writes no row.
- Spot-check in the console that one previously affected `integracao/{id}` still
  carries its own fields (its `selling_partner_id` included) and its other
  subcollections (`credenciais` and the rest), and that `tokenoaut` is gone.

## What the conta delete cascade does and does not cover

Deleting an `integracao` document already reclaims its `tokenoaut` documents:
the generic conta delete trigger walks `listCollections()` and deletes whatever
subcollection exists, modelled or not. That does not help here. The contas this
script cleans are **live** contas, which nobody deletes, and orphans whose parent
was deleted on the legacy project, which the new project's trigger never saw
(an import fires no triggers).

## Order of operations

1. Rehearse on **staging** only if asked: `--report-only`, dry run, `--apply`,
   `--report-only` reading 0, then a second `--apply` as the idempotence check.
   Staging is disposable and re-seedable from `tools/test-fixtures`, so a
   rehearsal that finds nothing is fine.
2. In #1208's window, phase 0: deploy the indexes (W9), including
   `tokenoaut (__name__ ASC)`, and wait for READY.
3. Phase 2, after the `integracao` import and before Phase-3 traffic: steps 1–4
   above on the **new** project.
4. Never against the legacy project.

The parent listing is one `listDocuments()` over `integracao` (about ten
documents) plus a field-masked read of each parent's `tipo`. The census costs one
`count()` per parent and one `count()` of the `tokenoaut` group, and the key
walks read document names only. No group-scope index backs the group count
(none is declared, and a count needs no order), so on Enterprise it scans the
group rather than seeking: one pass over the legacy token documents before the
deletion, and over an empty group after it.
