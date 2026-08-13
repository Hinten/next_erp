---
name: ci-lanes
description: >-
  Reference for this monorepo's GitHub Actions lanes and the gate pattern that
  makes "CI green" mean "the suite passed". Use when adding, editing, debugging
  or reviewing anything under `.github/workflows/`, when a check is missing or
  unexpectedly skipped on a PR, when wiring a required status check on the
  `protect-main` ruleset, or when deciding what should trigger a lane. Covers
  the `changes` scope job and `.github/scripts/e2e-affected.mjs` (--roots,
  --self, --only-paths, --kind), the unskippable `gate` job and its
  required/optional guard manifest, the nine pinnable check names, the
  `ci-lane-gates.test.js` backstop, and the three GitHub behaviours that make
  naive CI silently green — a non-matching `paths:` publishing no check at all,
  a `skipped` job satisfying a required check, and check-run names carrying no
  workflow prefix. Triggers on: workflow, lane, gate, paths filter, required
  status check, ruleset, branch protection, check run, `changes` job, e2e-affected,
  E2E gate, CI gate, nfe-live, freight-live, NFE_CI_LIVE_ENABLED,
  FREIGHT_CI_LIVE_ENABLED, timeout-minutes, workflow_call, concurrency.
---

# CI lanes and the gate pattern

Every PR-triggered lane in this repo follows one shape. Learn it once here; the
root `CLAUDE.md` carries only the rules you must not break.

```
pull_request  →  changes (≈20s, derives scope)  →  suite job(s)  →  gate (always())
                        │                                              │
                 e2e-affected.mjs                          THE pinnable check
```

## Three GitHub behaviours that make naive CI silently green

Everything here exists because of these. None is obvious, all three bite.

1. **A non-matching top-level `paths:` publishes NO check run.** Not a failure,
   not a skip — *nothing*. The row simply is not on the PR page. So a correct
   skip and a totally broken lane look identical, and a required check pinned to
   that lane would sit at "Expected" forever.
2. **A job skipped by `if:` publishes `skipped`, and GitHub's required-status-check
   evaluation counts `skipped` as SATISFYING the requirement.** A required check
   that can be skipped is a permanent free pass. **Never pin a skippable job.**
3. **A check-run name carries no workflow-name prefix.** `ci.yml`'s job publishes
   as bare `lint-typecheck-test`; a reusable-workflow job publishes as
   `<caller job id> / <called job id>`. Names must therefore be unique
   repo-wide — three lanes once published an identical
   `Lint / typecheck / unit / build (offline)`.

## The nine pinnable checks

| lane | gate | roots |
| --- | --- | --- |
| e2e-cadastros | `E2E gate (cadastros)` | `web` |
| e2e-vendas | `E2E gate (vendas)` | `web`, `integrations-app` |
| e2e-emulator | `E2E gate (emulator)` | `web`, `functions` |
| ci-nfe | `CI gate (nfe)` | `nfe-app`, `integrations-nfe` |
| ci-freight | `CI gate (freight)` | `melhor-envio-app`, `integrations-freight-br` |
| ci-mercado-livre | `CI gate (mercado-livre)` | `mercado-livre-app` |
| ci-storage | `CI gate (storage)` | `storage`, `functions` |
| ci-rules | `CI gate (rules)` | `rules-gen` |
| ci.yml | `lint-typecheck-test` | — (full graph) |

`ci.yml` needs no gate: it has no `paths:` and its job carries no `if:`, so it is
already unskippable and directly pinnable.

Names are **pure ASCII** on purpose — they get pasted into a JSON payload from
PowerShell on Windows, and a mangled em dash yields a required check that never
matches and an unmergeable `main`. No `:` (YAML quoting), no `/` (reads like
reusable-workflow nesting).

## Scope: `.github/scripts/e2e-affected.mjs`

The old `paths:` lists rotted because they were a human's guess at a dependency
closure that nothing re-checked. Both were wrong: the e2e list omitted
`packages/integrations/{nfe,freight-br}` and `packages/storage` (all imported by
`apps/web`), and no domain list contained `packages/data`, though all six
lane-owned workspaces depend on it.

So scope is **derived**, every run, by walking the `workspace:*` graph.

| flag | meaning |
| --- | --- |
| `--roots <pkg>…` | the lane's entry packages; the transitive closure is what makes it run |
| `--self <workflow>…` | this lane's own workflow files (plus the reusable engine) |
| `--only-paths <prefix>…` | literal-prefix mode; **`nfe-live` only** — see below |
| `--kind CI\|E2E` | labels the job-summary heading |
| `--files <path>` | the changed-file list, from `gh api …/pulls/{n}/files` |

**Direction of failure: every uncertainty runs the suite.** An unattributable
path (root config, `firestore.rules`), an API error, a truncated file list, a
non-`pull_request` event — all run it. Only two things skip: a path attributed to
a workspace outside the closure, and a short inert list (`*.md`, `.claude/`,
`.changeset/`, `.vscode/`, `LICENSE`, …).

⚠️ **`--self` exists because `.github/**` as "unattributable therefore run" was
far too broad** — any workflow edit ran every lane (17 of 30 PRs in a sample).
A lane's own workflow still triggers it; another lane's does not. **An empty
`--self` falls back to running**, so forgetting the flag can only cost an extra
run, never a silent skip.

### `--only-paths`: one job, inverted economics

`nfe-live` emits test documents at SEFAZ **homologação**, which rate-limits
(`cStat=656` — the `Detect Consumo Indevido Shield` job exists for it). There,
running unnecessarily is the expensive mistake and skipping is cheap, because
the offline NF-e suite already ran and the gate states out loud that live did not.

Use it for nothing else. Measured over 30 merged PRs: the dependency closure of
`@delfrance/integrations-nfe` fires on 14 (it depends on `schemas` and `core`),
versus 3 for the literal list — the closure is useless as a narrowing device here.

⚠️ The list must stay a superset of the NF-e-relevant entries the old filter
carried. `packages/schemas/src/pedido/**` is load-bearing: the XML builder reads
those schemas, and this lane has **already once** silently stopped running on
exactly them. See #1036 for the open question of whether this scope is right at
all, given that some NF-e defects only surface against the real SEFAZ server.

## The gate

`if: always()` and **nothing else**. Any other condition and it goes green in
exactly the cases it exists to report on (behaviour 2 above).

Multi-job lanes carry a manifest, one row per certified job:

```
<result env var>|required|<published check-run name>
<result env var>|optional:<guard>[+<guard>]|<published check-run name>
```

The gate **re-derives** each guard predicate from recorded inputs rather than
trusting the declared class. A skip no guard explains goes RED — so adding an
`if:` the gate does not know about fails loudly instead of quietly widening what
"green" covers.

| guard | skip forgiven when |
| --- | --- |
| `live_enabled` | the threaded repo variable is not `true` |
| `live_scope` | `--only-paths` found nothing relevant |
| `not_fork` | the PR is from a fork (cannot read secrets) |

**Anti-vacuity lock:** the gate does not trust `needs.<job>.result` — that reports
what the runner thinks, not that a job of that name ever existed. It queries
`repos/{repo}/actions/runs/{run_id}/jobs` and requires every certified job to be
present with conclusion `success`.

Verdict table:

| condition | gate |
| --- | --- |
| scope job did not conclude, or produced no verdict | **red** |
| scope said skip and every job is `skipped` | green, summary lists the attribution |
| any job `failure` or `cancelled` | **red** (a killed suite proved nothing) |
| a **required** job `skipped` while in scope | **red** — someone added an `if:` |
| an **optional** job `skipped`, guard holds | green + `::warning::` naming the job and reason |

The gate writes to `$GITHUB_STEP_SUMMARY` and emits `::notice`/`::error`. It must
**not** comment on the PR — the `report-*` jobs own that, and doubling up spams.

## Traps

⚠️ **A job-level `if:` REPLACES the implicit `success()`.** Adding
`if: needs.changes.outputs.run_e2e == 'true'` to a *downstream* job makes it run
even after its upstream FAILED. Downstream jobs inherit the skip transitively
through `needs:` — that is both sufficient and safer. The backstop encodes this.

⚠️ **Never locate a job by substring.** `ci-nfe` once used
`select(.name | test("Live SEFAZ"))`; renaming the job would have made the grep
match nothing, take its `exit 0` branch, and the 🛡️ Consumo Indevido comment
would have silently stopped appearing. Use `select(.name == env.LIVE_JOB_NAME)`.

⚠️ **`vars.*` is live repo state; `github.*` is a frozen event snapshot.** Read a
variable **once**, in `changes`, and thread it as an output — otherwise the suite
job's `if:` and the gate's explanation can disagree minutes apart.

⚠️ **`on:` is a YAML 1.1 boolean.** js-yaml@3 parses a workflow's `on:` block
under the key `true`, so a parser-based test reading `doc.on` sees `undefined` for
every file and passes vacuously. The backstop line-scans instead.

⚠️ **`.prettierignore` contains `.github/`** — workflow YAML is not
Prettier-formatted and its indentation is not machine-guaranteed.

## Triggers

- `pull_request: branches: [master, main, production, 'claude/**', 'feat/**', 'fix/**']`
  on every lane. `branches:` matches the PR's **base**, so a stacked PR must sit
  on one of those prefixes. `production` is the release base — omit it and the PR
  that actually ships reports no check, which for a required check means
  permanently unmergeable.
- **Never** a `paths:` on `pull_request:`.
- The domain lanes **keep** `paths:` on `push:`. Nothing on the push path is a
  required check, and `changes` short-circuits to run=true on non-PR events, so
  removing it would run the full live SEFAZ pipeline on every merge to `main` for
  no gating benefit. The e2e lanes have no `push:` at all.
- `timeout-minutes` on every job. 14 jobs once had none, leaving GitHub's 6-hour
  default as the only bound on a hung SEFAZ call. Derive values from observed
  maxima, not guesses: a too-tight timeout turns "slow" into a red required check.

## Adding a lane

1. Copy the `changes` + `gate` pair from `ci-mercado-livre.yml` (the simplest —
   one required job, no guards) or `ci-storage.yml` (two required jobs, no
   guards). The `run:` body of every gate is **byte-identical**; only the `env:`
   block and the `JOBS:` manifest differ. Copy it from a real file rather than
   retyping 142 lines of shell, then `diff` the two bodies to prove you did.
2. Give it `--roots`, `--self`, and a unique ASCII gate name.
3. Add it to `LANES` in `packages/config-eslint/rules/ci-lane-gates.test.js`.
   Every workflow must be in `LANES` **or** `UNGATED` with a written reason — the
   partition is what makes a gateless new lane fail loudly.
4. Pin the gate on the ruleset (below) once it has published on one run.

## Pinning on the `protect-main` ruleset (id 16348427)

Order matters. Merge first, let the gates publish, **then** pin.

Read the names back from the merged PR's **head SHA**, not from `main` — the e2e
lanes have no `push:` trigger and the domain lanes' `push:` keeps a narrow
`paths:`, so a merge commit may carry only some of the nine.

```bash
gh api "repos/Hinten/next_erp/commits/<head-sha>/check-runs?per_page=100" \
  --jq '.check_runs[] | [.name, (.app.id|tostring), .conclusion] | @tsv'
```

⚠️ **`PUT` replaces `rules` wholesale** — snapshot and `jq` the new rule onto the
existing array, or you silently drop `deletion` and `non_fast_forward`.

⚠️ **`integration_id: 15368` is load-bearing, not hygiene.** It is the GitHub
Actions app id. The field is nullable, and omitting it lets the context match
*any* provider — anyone with write access could `POST …/statuses/<sha>` and turn
the gate green with no workflow run.

⚠️ **`bypass_actors` is empty and `current_user_can_bypass` is `never`.** Rulesets
do not exempt admins implicitly. A red gate then blocks `main` for everyone, with
no break-glass. Consider adding a repository-admin bypass actor first, through
the web UI (the `RepositoryRole` id mapping is easy to get subtly wrong).

Recommend `strict_required_status_checks_policy: false` — `true` forces a
rebase-and-rerun storm at this repo's PR volume, and `stale-base-hint` already
mitigates the staleness it leaves.

## Known state

- **`freight-live` has never executed.** `FREIGHT_CI_LIVE_ENABLED` was never set,
  so `calculate.sandbox.test.ts` runs nowhere. The gate says so on every PR.
  Enabling it needs the secret `MELHOR_ENVIO_SANDBOX_TOKEN` and the variable
  `MELHOR_ENVIO_USER_AGENT`, neither of which exists.
- **All NF-e CI is homologação only.** Every invoked suite is `*.homologacao`
  (plus `numeracao.staging` — Firestore, not a SEFAZ ambiente); each hardcodes
  `tpAmb: '2'` and `getEndpoints('SP','homologacao')`;
  `operations.homologacao.test.ts` reads `tpAmb` back off SEFAZ's reply and
  asserts `'2'`; `NFE_AMBIENTE` (accepts `'producao'`, defaults `'homologacao'`)
  is set in no workflow and is neither a repo variable nor a secret; the offline
  job excludes the live suites so it never opens a socket.
- **`ci.yml` excludes eight workspaces** from `turbo run test` —
  `@delfrance/{nfe-app,integrations-nfe,melhor-envio-app,integrations-freight-br,storage,functions,mercado-livre-app,integrations-mercado-livre}`
  — each owned by exactly one domain lane. If that lane skips, those tests run
  nowhere. That is why the domain lanes matter and why their scope must be derived.
  An exclusion is a **promise** that the owning lane runs them; never add a filter
  without an owner on the other side.
- **A lane's `test` script is not always `test`.** `ci-mercado-livre` needs two
  jobs because `apps/mercado-livre` splits its suite across two vitest configs:
  `vitest.config.ts` excludes `**/*.firestore.test.ts`, `vitest.firestore.config.ts`
  includes only those. A file matching neither glob runs in NO job. When adding a
  lane, read the workspace's scripts — do not assume `turbo run test` covers it.

### Moving tests into a lane is not a latency win — measured

Before assuming an exclusion speeds `ci.yml` up, note what was measured on
2026-08-13 when the ML tests moved:

| | |
| --- | --- |
| `ci.yml` Test step, wall | 166 s |
| `@delfrance/web` alone | **138 s** ← critical path |
| `@delfrance/mercado-livre-app` | 74.8 s |
| `@delfrance/integrations-mercado-livre` | 9.2 s |
| ML share of total CPU | 84 s / 487 s = 17 % |

turbo runs these in parallel and `web` is 83 % of the step's wall time, so
removing 17 % of the CPU saved ~0 s. The reason to move tests into a lane is
**ownership and failure attribution** — the failure lands on `CI gate (<lane>)`
instead of the catch-all `lint-typecheck-test`. Anything that shortens `ci.yml`
has to shorten `@delfrance/web`.

### ⚠️ `turbo run test --filter <typo>` exits 0

Verified: `pnpm turbo run test --filter '@delfrance/does-not-exist'` prints
`x No package found with name ... in workspace` and exits **zero** — same trap as
`pnpm --filter`. In a lane job whose tests `ci.yml` no longer runs, a typo is
total silent loss of coverage. Every such step needs a resolution assertion
before it; `ci-mercado-livre.yml` carries one per job, asserting an exact count.

## ⚠️ Assertion 1 can go red on `main` after passing on every PR

Every lane checks out `github.event.pull_request.head.sha` — the PR **head**, not
GitHub's merge ref. A repo-state assertion (the `LANES`/`UNGATED` partition, the
`.env.example` locator, the pinned-deps scanners) therefore only ever sees its own
branch, and two PRs that are individually honest can produce a red merge result.

It has happened once: **#999** added `ci-mercado-livre.yml` to `main` at 15:11;
**#1031** added the total-partition assertion at 16:34 from a branch that never
contained that file. Both green, `main` red — 15 workflows against 14 classified.

When you hit it, the fix is to classify the lane someone added concurrently, never
to weaken the partition. Closing the skew itself means turning on **"Require
branches to be up to date before merging"** on `protect-main` — a ruleset setting
with real cost (a rebase on every PR, including stacked ones), not a code change.
Deliberately not done as of 2026-08-13.
