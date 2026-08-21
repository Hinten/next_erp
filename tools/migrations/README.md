# tools/migrations/

One-time, re-runnable scripts that reshape data that already exists. This is the
repo's answer to a schema change on live data — **not** a dual-shape read, a
compat branch, a lazy backfill-on-read, or a derived field kept in sync by a
trigger. Those all buy "survive indefinitely without a cutover", and there **is**
a cutover (root `CLAUDE.md` rule 8 / ADR 0013), so they pay for something already
bought and leave permanent compat code nobody deletes.

Ten dated subfolders live under `src/` today — eight that write
(`migrate.ts`, or `backfill.ts`) and two read-only audits (`audit.ts`). Most
carry a runbook beside this file — `telefone-e164.README.md`,
`historico-estoque-v2.README.md`, and so on — with the reasoning, the target
ordering and the verification for that one job. This file is only the contract
they share.

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
pnpm --filter @delfrance/migrations migrate:<name> -- --project <staging-id>
pnpm --filter @delfrance/migrations migrate:<name> -- --project <staging-id> --apply
```

⚠️ **Agents never run these against production.** Staging is a rehearsal —
dry-run counts, then a clean second pass as the idempotence check — and staging
data is disposable and re-seedable from `tools/test-fixtures`, so a script only
has to be correct against _production_ shapes. The production run belongs to the
migration window; surface it, ask, and open a `needs-migration-window` issue.

⚠️ **A merged script nobody runs is a no-op** — the script is not done until its
issue exists.
