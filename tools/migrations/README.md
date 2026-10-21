# tools/migrations/

One-time, re-runnable scripts that reshape data that already exists. This is the
repo's answer to a schema change on live data — **not** a dual-shape read, a
compat branch, a lazy backfill-on-read, or a derived field kept in sync by a
trigger. Those all buy "survive indefinitely without a cutover", and there **is**
a cutover (root `CLAUDE.md` rule 8 / ADR 0013), so they pay for something already
bought and leave permanent compat code nobody deletes.

Twenty dated subfolders live under `src/` today — sixteen that write
(`migrate.ts`, or `backfill.ts`; `2026-09-produto-sem-variacoes` also carries an
`audit.ts`) and four read-only audits (`audit.ts` alone). Most
carry a runbook beside this file — `telefone-e164.README.md`,
`historico-estoque-v2.README.md`, and so on — with the reasoning, the target
ordering and the verification for that one job. This file is only the contract
they share.

⚠️ Two do not, and neither satisfies point 5 below as written:
`2026-08-ml-lastmarketplaceupdate` has no runbook, no pure module and no test,
and `2026-08-ml-precos-ghost-keys` has no runbook. They are the exceptions, not
the pattern.

One undated folder sits beside them: `src/intFreteAdocao/`, the `int_frete`
adoption pass that two dated folders bind — `2026-10-shopee-int-frete` and
`2026-10-li-int-frete`, each a thin `transform.ts` + `backfill.ts` over the same
plan (`plano.ts`) and I/O (`executar.ts`), so the STOP verdict exists once.

## The contract

1. **Idempotent and re-runnable.** Not optional: the legacy app keeps writing
   the source project until the window switches it off, so a run before the
   migration window is superseded and the authoritative run is the one
   _inside_ it.
2. **`--project <id>` is required and is matched against the service account.**
   The runner never infers the target from the environment, and `migrationDb`
   refuses when the credentials name a different project (`src/admin.ts`) — so a
   stray `FIREBASE_PROJECT_ID` cannot silently point a destructive backfill at
   production.
3. **Dry-run by default; `--apply` writes.** `--report-only` classifies and
   counts stored shapes without writing at all, and cannot be combined with
   `--apply`.
4. **Every intended change and skip is logged to a timestamped `.jsonl` in
   `out/`** (gitignored), suffixed `-dryrun` when nothing was written.
5. **The decision lives in a pure module with unit tests beside it** —
   `transform.ts` for a write, `predicate.ts` for an audit. `migrate.ts` does
   the Firestore I/O and nothing else, so the part that can be wrong is the part
   `vitest` can reach.

## Writing one

`src/runner.ts` is the shared harness — `parseArgs`, `runMigration`,
`BatchWriter`, `ChangeSink`, `isMainModule` — and `src/admin.ts` builds the
project-bound Firestore handle. Copy the shape of
`src/2026-08-telefone-e164/` (`migrate.ts` + `transform.ts` +
`transform.test.ts`), add a `migrate:<name>` script to `package.json`, and write
the runbook as `<name>.README.md` here.

```bash
pnpm --filter @delfrance/migrations migrate:<name> --project <staging-id>
pnpm --filter @delfrance/migrations migrate:<name> --project <staging-id> --apply
```

### Walking a whole collection: declare its key index

Almost every script here pages a whole collection (or collection group) with
`orderBy(FieldPath.documentId()).limit(PAGE_SIZE).startAfter(cursor)`. On
Firestore **Standard** that order is native. On **Enterprise**, which is where
these run (staging rehearsals, then the NEW project after the import), there is
**no implicit document-key index**. Without a declared one, each page walks some
other index — or the whole table — end to end and sorts in memory, so a walk
costs N²/page instead of N. Nothing fails. Measured on staging, 2026-10-13
(#1874, #1895):

- `collection('pedidos')` read all 1,665 index rows on page 1 **and** the cursor
  page, to return 300;
- `collectionGroup('enderecos')`, which has no index at all, table-scanned all
  6,342 documents (2.2 MiB) on every page.

So a key walk needs exactly one index, and it must be declared:

1. Add a row to [`key-walks.json`](key-walks.json): script, collection, and
   `COLLECTION` or `COLLECTION_GROUP` scope. A walk that pages one subcollection
   per parent (`<parent>/{id}/<collection>`) also names its `parent`.
2. Declare `{ collectionGroup, queryScope, fields: [{ fieldPath: "__name__", order: "ASCENDING" }] }`
   in the repo-root `firestore.indexes.json`, unless that (collection, scope)
   already has one. `src/keyWalks.indexes.test.ts` fails until both exist, and
   when a key-only index has no listed reader.
3. After the index deploy, prove the planner uses it:
   `node --env-file=../../.env.local scripts/check-key-walks.mjs --project <id>`
   (exit 1 = a page that scans, 2 = an empty collection it couldn't plan,
   0 = every probed walk seeks). A row with `parent` is not probed: the checker
   builds a root `collection(<collection>)`, which plans nothing for a per-parent
   subcollection walk. It prints that row as `NOT PROBED`, counts it toward no
   exit code, and its index is confirmed **READY** in the project's index list
   instead ([`amazon-tokenoaut-legado.README.md`](amazon-tokenoaut-legado.README.md)).

Filtering stays in code on the fetched page: the key index is the only index a
walk needs, and no filter or composite index should be added for a one-time
script. These key indexes are **migration-only**: once the window's walks have
run they have no reader, and #1896 deletes them after the cutover. The exception
is `arquivos(__name__ ASC)`, which the arquivo orphan sweep keeps for good.

⚠️ **Agents never run these against production.** Staging is a rehearsal —
dry-run counts, then a clean second pass as the idempotence check — and staging
data is disposable and re-seedable from `tools/test-fixtures`, so a script only
has to be correct against _production_ shapes. The production run belongs to the
migration window; surface it, ask, and open a `needs-migration-window` issue.

⚠️ **A merged script nobody runs is a no-op** — the script is not done until its
issue exists.
