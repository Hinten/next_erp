# @delfrance/rules-gen

Generates the Firestore rulesets from the Zod collection metadata in
`@delfrance/schemas`. **`firestore.rules` and `firestore.e2e.rules` at the repo
root are generated output — never hand-edit them.**

Why a custom generator instead of an npm package: **ADR 0003**
(`apps/docs/src/content/docs/adr/0003-firestore-rules-generator.md`).

## The two rulesets

| File                  | Consumed by                                                                               | Contents                                                    |
| --------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `firestore.rules`     | **production** — root `firebase.json`                                                     | the real rules                                              |
| `firestore.e2e.rules` | **staging** (`firebase.staging.json`) and the offline emulator lane (`firebase.e2e.json`) | the same rules **plus** one `e2e_<runId>_*` namespace block |

The `--e2e` variant exists because each e2e workflow run seeds its fixtures into
a per-run `e2e_<runId>` namespace. Under the production ruleset those
collections are default-denied, so **deploying the plain `firestore.rules` to
staging breaks e2e on every branch** (issue #160).

> ⚠️ **Never deploy `firestore.e2e.rules` to production** — it opens every
> `e2e_`-prefixed collection.

## Commands

```bash
pnpm --filter @delfrance/rules-gen gen:rules          # → firestore.rules
pnpm --filter @delfrance/rules-gen gen:rules:e2e      # → firestore.e2e.rules
pnpm --filter @delfrance/rules-gen gen:rules:check    # drift check (no write)
pnpm --filter @delfrance/rules-gen gen:rules:e2e:check
pnpm --filter @delfrance/rules-gen test               # unit + snapshot tests
pnpm --filter @delfrance/rules-gen test:rules         # emulator behavior suite
pnpm --filter @delfrance/rules-gen validate:api       # server-side compile
pnpm --filter @delfrance/rules-gen report:legacy-coverage        # see below
```

## What the Flutter app loses on cutover

A database has exactly one ruleset, so the day the generated `firestore.rules`
replaces the legacy Flutter one, every collection the legacy ruleset granted and
this one does not becomes **default-denied for the Flutter client** — silently,
with no error an operator can act on. Issue #783 found that the hard way for
Mercado Livre.

`report:legacy-coverage` turns that into a mechanical diff and writes
`apps/docs/src/content/docs/architecture/legacy-rules-coverage.md` (committed, so
it is readable without the legacy checkout). It also flags, heuristically, which
legacy collections the Flutter **client** actually touches versus the ones only
its Admin-SDK backend does — the latter lose nothing.

⚠️ It reads `.old/`, which is **gitignored**: run it from the main checkout, not
a worktree and not CI. The staleness check in `src/legacyCoverage.test.ts` skips
itself when `.old/` is absent; the parser tests always run.

Four Mercado Livre collections (`token6h`, `tokenDuravel`,
`notificacoesMercadoLivre`, `questionsML`) are currently registered **only** to
keep that grant alive during dual-run — #829 removes them.

Each `gen:` invocation writes **one** file, so a schema change needs **both**.

## After any `*Meta` / PERM / validator-whitelist change

1. Run `gen:rules` **and** `gen:rules:e2e`.
2. Refresh the two vitest file snapshots in `src/__snapshots__/` (`vitest run -u`
   in this package). These are `toMatchFileSnapshot` snapshots asserted by
   `src/generate.test.ts` — a stale snapshot fails the unit-test step, which is a
   _different_ failure from the drift check.
3. Commit the regenerated files. The snapshot diff is what shows reviewers the
   exact rules impact of a schema change.

Skipping step 1 or 2 reds `ci-rules.yml`.

## Size gate

`src/size-gate.ts` hard-fails generation above **120 KiB** and warns above
**90 KiB**, well under the platform's 256 KiB source / 250 KiB compiled limit.
Both rulesets are ~32 KB today. A validator-whitelist explosion therefore fails
locally at generation time rather than at deploy time.

## Super user (break-glass)

The generated rules carry a dedicated boolean `su` custom claim that
short-circuits every permission **and** tenancy check via `isSuperUser()`.
Field validators still apply. The claim is minted server-side for accounts with
`usuario.isSuperUser` and is **never** self-grantable.

```bash
pnpm --filter @delfrance/test-fixtures create-super-user <email>
```

That is durable — it also sets `usuarios/<uid>.isSuperUser`. Note that
`grant-all-perms` is **not** the same thing: it grants every _defined_
permission bit but does not bypass tenancy.

## Deploying (humans only)

Rules deploys stay manual and coordinated — **agents never run
`firebase deploy`**.

```bash
# staging — MUST use the staging config, which points at firestore.e2e.rules
firebase deploy --only firestore:rules --config firebase.staging.json --project <staging>

# production — root firebase.json, no --config flag
firebase deploy --only firestore:rules --project <prod>
```

Never pass a staging config to a production project.

## CI (`ci-rules.yml`)

- `rules-offline` — lint/typecheck/unit tests + **both** drift checks.
- `rules-emulator` — the `test:rules` behavior suite against the Firestore
  emulator (`firebase.rules.json`, port 8081). Its helper hard-fails in CI when
  `FIRESTORE_EMULATOR_HOST` is unset, so the suite can never silently skip.
- `rules-api-validate` — compiles both rulesets server-side via the Firebase
  Rules API. Persists nothing; skipped on fork PRs.
