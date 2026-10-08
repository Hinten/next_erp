# Migration: legacy `token_id` removal (`2026-10-li-token-legado`)

Deletes the legacy `token_id` field from every `integracao` document that
carries it, whatever the document's `tipo`, and touches nothing else.

`token_id` is where the legacy app kept its Loja Integrada credential: on the
`integracao` document itself, which any client holding the `d_integracao` read
permission can read. This app never models it (`integracaoSchema` rejects it
under `.strict()`, pinned in `packages/schemas/src/integracao.test.ts`) and no
source file reads it. The credential this app uses is stored apart, in the
server-only `integracao/{id}/credenciaisLojaIntegrada/current` subcollection
document, written by the credential panel (master plan step 2). So once the data
has moved, the legacy field is only an exposed secret with no reader.

Production execution is a coordinated cutover operation in
[#1208](https://github.com/Hinten/next_erp/issues/1208), never part of deploying
this code. Tracked by [#1829](https://github.com/Hinten/next_erp/issues/1829).

## ⚠️ Why this runs only inside the migration window

**The legacy app still reads `token_id` until it is switched off.** Deleting the
field from the legacy project would break the integration that app still serves,
so this script is never pointed at the source project while that app is live.

It also cannot usefully run earlier on the new project: the export carries the
field with every other `integracao` row, and any run made before the import is
superseded by it. The authoritative run is the one inside the window, **after
the `integracao` data has been imported into the new project and before the
channel takes traffic**. Because an import fires no Cloud Functions triggers,
nothing else needs to be recomputed first, and nothing else depends on this
deletion.

The script is idempotent, so a dry run or a staging rehearsal earlier is
harmless. Only `--apply` on the production project is window-bound.

## What it decides

| stored document                                             | verdict                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| has a `token_id` key (any value, including `null` and `''`) | **delete** that one field                                 |
| no `token_id` key                                           | skip (not logged: nearly every document)                  |
| `token_id` nested inside another map, or a similar name     | skip: only the top-level `token_id` key is the legacy one |
| any `tipo`                                                  | the same: the field is an exposed credential on any tipo  |

Presence is the test, not truthiness. The patch is
`{ token_id: FieldValue.delete() }` and carries no other key.

**Race tier 0** (root `CLAUDE.md` rule 7): deleting one named field is
idempotent and order-free, and nothing is derived from the read beyond "the key
is there", so there is nothing to compare or guard.

## The value is never read out, logged or printed

The plan carries the document's `tipo` and the fact that the field is present,
never what it holds. A log row looks like:

```json
{
  "kind": "change",
  "path": "integracao/<doc-id>",
  "field": "token_id",
  "from": { "present": true, "tipo": 3 },
  "to": "removed"
}
```

The `--report-only` output is a count per `tipo`. `transform.test.ts` pins the
property with a token-shaped sentinel that must appear in no plan, log
description or patch.

## Running it

`--project` is required, never inferred, and matched against the service
account. Dry-run by default. Every command below is run by a person, in order;
agents never run it against production.

1. **Count first.** Writes nothing and logs no per-document rows.

   ```bash
   pnpm --filter @delfrance/migrations migrate:li-token-legado --project <new-project-id> --report-only
   ```

   Read the count per `tipo`. Expect one or a few documents (the collection holds
   about ten in all).

2. **Dry run.** Writes nothing; logs one row per document it would change to a
   timestamped `-dryrun` JSONL under `tools/migrations/out/`.

   ```bash
   pnpm --filter @delfrance/migrations migrate:li-token-legado --project <new-project-id>
   ```

   Confirm the rows name the documents and `tipo` values you expect, and that no
   row contains a credential.

3. **Apply.**

   ```bash
   pnpm --filter @delfrance/migrations migrate:li-token-legado --project <new-project-id> --apply
   ```

## Verification

- **Idempotence check: a second pass reports zero.** Re-run step 1 or step 2
  after the apply. It must report `0` documents carrying `token_id` (step 1) and
  `0 with changes` (step 2).
- **Census of 0.** `--report-only` is the census. Nothing under `integracao`
  carries `token_id`.
- Spot-check in the console that one previously affected `integracao` document no
  longer shows the field, and that its sibling fields are unchanged.

## Order of operations

1. Rehearse on **staging**: `--report-only`, dry run, `--apply`, then a second
   `--report-only` that reads 0. Staging data is disposable, so a rehearsal that
   finds nothing is fine.
2. In #1208's window, after the `integracao` import and before the channel takes
   traffic: `--report-only` on the **new** project, dry run, `--apply`, second
   pass reporting 0.
3. Never against the legacy project.

The scan is a single root-collection read of about ten documents, paged by
document key, so its cost on Firestore Enterprise (billed by data scanned) is
negligible.
