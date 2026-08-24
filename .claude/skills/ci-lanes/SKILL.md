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
  required/optional guard manifest, the thirteen pinnable check names, the
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
3. **A check-run name carries no workflow-name prefix.** A job with no `name:`
   publishes as its bare job id; a reusable-workflow job publishes as
   `<caller job id> / <called job id>`. Names must therefore be unique
   repo-wide — three lanes once published an identical
   `Lint / typecheck / unit / build (offline)`.

## The thirteen pinnable checks

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
| ci.yml | `CI typecheck` | — (full graph) |
| ci.yml | `CI lint` | — (full graph) |
| ci.yml | `CI format check` | — (whole repo) |
| ci.yml | `CI test` | — (full graph minus the eight lane-owned workspaces) |
| ci.yml | `CI build` | — (full graph) |

`ci.yml` needs no gate: it has no `paths:` and **none of its five jobs carries an
`if:`**, so each is already unskippable and directly pinnable. That property is
the whole reason it can stay gateless — adding an `if:` to any of the five would
make it skippable, and behaviour 2 above turns a skippable pinned check into a
permanent free pass.

⚠️ **Nothing is pinned yet.** As of 2026-08-24 `protect-main` (id `16348427`)
carries only `deletion` and `non_fast_forward` — there is no
`required_status_checks` rule at all, and `branches/main/protection` 404s. So the
table above is the list #1052 should pin, not a description of live state, and a
check-name change costs nothing on the ruleset **until** #1052 lands.

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

### ⚠️ The caller and this script are permanently version-skewed

Same root cause as the assertion-1 note at the bottom of this file, different
victim. GitHub runs a `pull_request`'s workflow **YAML from the merge ref**, while
every lane checks out `github.event.pull_request.head.sha`. So the YAML is always
**at least as new** as the script it invokes and never older. Two consequences:

1. On a branch predating the script, `node` exits 1 with `Cannot find module`
   **before** the script's own `catch` can emit anything. That kills `changes`, and
   the gate turns it into a red required check nothing but a rebase clears. It
   happened on runs `31719660542` and `31704153529`.
2. A flag added to the YAML reaches an **older** copy of the script. `parseArgs`
   therefore throws on an unrecognised `--flag` instead of absorbing it as a value
   for whichever flag preceded it.

So **every invocation is wrapped, and the wrapper is not optional**:

```bash
if ! node .github/scripts/e2e-affected.mjs --roots … --files "…"
then
  { echo "run_e2e=true"; echo "reason=…(fail safe)…"; } >> "$GITHUB_OUTPUT"
fi
```

⚠️ **The fallback direction is the MODE's, not the lane's** — `--roots` emits
`true`, `--only-paths` emits `false`. Copying an e2e lane's fallback into
`ci-nfe.yml`'s live step would spend SEFAZ quota on a bug. Assertion 13 in
`ci-lane-gates.test.js` rejects a bare invocation and checks the direction against
the mode; the script's `catch` applies the same rule.

### `--only-paths`: one job, inverted economics

`nfe-live` emits test documents at SEFAZ **homologação**, which rate-limits
(`cStat=656` — the `Detect Consumo Indevido Shield` job exists for it). There,
running unnecessarily is the expensive mistake and skipping is cheap, because
the offline NF-e suite already ran and the gate states out loud that live did not.

⚠️ **This is a real emission path, not a hypothetical one: `NFE_CI_LIVE_ENABLED`
is `true` on this repo.** Which is why every fail-safe on this branch of the code
inverts — `decided()` in `ci-nfe.yml` takes the lane verdict and the live verdict
as two separate arguments, the `decide-live` step's `if !` fallback emits
`run_e2e=false`, and the script's `catch` keys off `--only-paths`. A crash must
never be the thing that decides to call SEFAZ.

**Produção is unreachable from CI, and now enforced rather than merely
conventional.** `assertSafeTpAmbForTransport` guards both SOAP POST sites and
honours `NFE_ALLOW_PRODUCAO=true` and nothing else. The older `assertSafeTpAmb`
still lets `NODE_ENV='test'` through — fine at the generator boundary, where XML is
built but no socket opens, and **exactly wrong at transport**, because `nfe-live` is
itself Vitest, so that passthrough disabled the guard for the whole live suite.
`NFE_ALLOW_PRODUCAO` and `NFE_AMBIENTE` are set in no workflow and are not repo
variables.

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

## After the merge: who watches `main`

Everything above is about a PR. `main` is a separate question, and the answer is
**not** "nothing" — it is `ci.yml`'s `push: branches: [master, main]` (full graph,
unfiltered) plus the five domain lanes' path-filtered `push:` nets. They work: on
2026-08-20 `ci.yml` caught the #1109/#1114 merge-skew break four minutes after the
merge — run `32373838109`, `Lint`, 13:21 UTC.

⚠️ **The defect was never detection. It was that the red had no audience.** Every
`report-failure` job in this repo is gated on
`github.event_name == 'pull_request'`, so on the one event that mattered it
reported `skipped`. The break was rediscovered 51 minutes later by #1158, a PR
that had touched nothing related — and #1158's author had no way to know the
failing check was not theirs.

`main-red-alert.yml` is that audience. `workflow_run` on the six trunk-verifying
workflows → one standing issue per workflow, labelled `main-red`, commented on for
each new failure and closed on the next green run of the same workflow. Three
things about it are load-bearing:

- ⚠️ **`workflow_run` matches by workflow `name:`**, silently and with no error
  when a name matches nothing. Renaming a lane un-alerts it. Assertion 14 in
  `ci-lane-gates.test.js` derives the real set (every workflow with
  `push: branches:` containing `main`, minus the two self-referential Copilot
  bootstraps) and pins the list against it.
- ⚠️ **`cancelled` is never an alert.** Every lane runs `cancel-in-progress: true`,
  so merges landing minutes apart cancel each other's runs constantly — 10 of the
  last 25 `ci.yml` runs on `main`. It costs nothing to ignore them: a cancelled run
  exists only because a newer one superseded it, and the chain always terminates in
  a run that concludes.
- ⚠️ **`workflow_run` cannot fire from a PR branch** — the trigger exists only once
  the file is on the default branch. So no PR can ever exercise this end to end.
  The decision logic therefore lives in `.github/scripts/main-red-alert.mjs` with
  unit tests in `packages/config-eslint/rules/main-red-alert.test.js` (the only
  pre-merge proof), and the workflow carries a `workflow_dispatch` with a `run_id`
  input so it can be rehearsed against a real past run afterwards.

What it does **not** cover: `ci.yml` excludes eight workspaces from `turbo run test`
and the five domain lanes' `push:` triggers are path-filtered, so a merge-skew break
inside a lane-owned suite still runs nowhere on `main`. Same mechanism as #1167, one
surface further in.

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
4. If it carries a `push:` trigger on `main` (every domain lane does), add its
   `name:` **verbatim, em dash included** to `main-red-alert.yml`'s `workflows:`
   list. Assertion 14 fails until you do; skipping it would leave that lane's red
   `main` reported to nobody.
5. Pin the gate on the ruleset (below) once it has published on one run.

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
instead of a catch-all. Anything that shortens `ci.yml`'s **test** work has to
shorten `@delfrance/web`.

### What DID shorten `ci.yml`: removing serialisation, not work — measured

That conclusion is about the Test step alone. The lane as a whole was slow for a
different reason: five independent steps ran **in sequence** on one runner.
Measured over four PR runs on 2026-08-24 (`32752392629` and three siblings):

| step | observed | turbo |
| --- | --- | --- |
| checkout → pnpm-store cache → `Install` | ~34 s | — |
| Typecheck | 111–118 s | 33 tasks, **0 cached** |
| Lint | 159–174 s | 35 tasks, **0 cached** |
| Format check | 29–33 s | root prettier, not a turbo task |
| Test | 265–292 s | 18 tasks — `@delfrance/web` alone ≈ 256 s / 223 files |
| Build | 136–151 s | 10 tasks, 0 cached |
| **job wall** | **13 m 26 s** | |

Splitting them into five sibling jobs takes the critical path to `test` alone,
≈ 5 m 30 s. Three facts made that free, and all three must be **re-checked**
before anyone assumes it still is:

1. **turbo's `^build` edge on `lint`/`typecheck`/`test` resolves to ZERO tasks.**
   `turbo.json` declares it, but no `packages/*`, `packages/integrations/*` or
   `tools/*` workspace defines a `build` script — the libraries export raw
   TypeScript and nothing depends on an app. Proof: the `Build` step reported
   `0 cached, 10 total` *after* typecheck, lint and test had run in the same job,
   so no build task ran earlier. Give one package a `build` script and every one
   of the five jobs starts paying for it separately.
2. **No cache locality to lose.** No turbo remote cache exists (`grep -rn "TURBO_"`
   → zero hits) and no gating lane persists `.turbo`, so every task already ran
   cold. ⚠️ Do **not** "fix" that by caching `.turbo`:
   `packages/config-eslint/turbo.json` sets `cache: false` and explains why — its
   tests `git grep` files belonging to no workspace, so turbo's input hashing
   misses them and a replayed green is a **false** green.
3. **Fan-out is free.** The repo is public, so `ubuntu-latest` is 4 vCPU / 16 GB
   on unmetered minutes.

The five jobs share the pnpm-store cache key; on a lockfile change four of them
log `Unable to reserve cache with key …, another job may be creating this cache`.
Not an error, and not new — the six other lanes already share that namespace.

### ⚠️ `turbo run <task>` has TWO ways to exit 0 having run nothing

Both verified in this repo:

| | command | output | exit |
| --- | --- | --- | --- |
| bad package **name** | `turbo run test --filter '@delfrance/nope'` | `x No package found with name …` | **0** |
| missing **script** | `turbo run test --filter <pkg with no "test">` | `Tasks: 0 successful, 0 total` | **0** |

⚠️ **The second one is not shared with pnpm, and that asymmetry has already bitten
a review.** `pnpm --filter X run <script>` exits **1** when the script is missing —
only a bad *name* is unsafe there. So a `pnpm ls` name-check is a sufficient guard
in front of a `pnpm --filter` step and an **insufficient** one in front of a
`turbo run` step. Do not copy a guard across the two tools without re-deriving
which failure modes it covers.

⚠️ **Counting `task == "test"` in `--dry=json` is also not enough** — turbo still
emits an entry for a package with no script, tagged `"command": "<NONEXISTENT>"`.
The guard must exclude those:

```bash
n=$(pnpm turbo run test --dry=json --filter A --filter B \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).tasks;console.log(t.filter(x=>x.task==="test"&&x.command&&x.command!=="<NONEXISTENT>").length)})')
[ "$n" = "2" ] || { echo "::error::resolved $n runnable test tasks, expected 2"; exit 1; }
```

A bad name makes turbo emit no JSON at all, so `JSON.parse` throws and `pipefail`
fails the step — one check, both modes. `ci-mercado-livre.yml`'s `ml-offline` job
is the reference implementation. This matters most in a lane whose tests `ci.yml`
no longer runs: there, either mode is **total** silent loss of coverage.

## ⚠️ Assertion 1 can go red on `main` after passing on every PR

Every lane checks out `github.event.pull_request.head.sha` — the PR **head**, not
GitHub's merge ref. A repo-state assertion (the `LANES`/`UNGATED` partition, the
`.env.example` locator, the pinned-deps scanners) therefore only ever sees its own
branch, and two PRs that are individually honest can produce a red merge result.

⚠️ **Head-vs-merge-ref skew has a second victim**, in the opposite direction: the
workflow YAML is read from the merge ref while the *script it invokes* comes from
the head, so the caller can be newer than the callee. See "The caller and this
script are permanently version-skewed" above — that one is a red lane on the PR
itself, not on `main`.

It has happened once: **#999** added `ci-mercado-livre.yml` to `main` at 15:11;
**#1031** added the total-partition assertion at 16:34 from a branch that never
contained that file. Both green, `main` red — 15 workflows against 14 classified.

When you hit it, the fix is to classify the lane someone added concurrently, never
to weaken the partition. Closing the skew itself means turning on **"Require
branches to be up to date before merging"** on `protect-main` — a ruleset setting
with real cost (a rebase on every PR, including stacked ones), not a code change.

⚠️ **It is also not available yet, and that is not obvious from the GitHub UI.**
"Require branches to be up to date" is `strict_required_status_checks_policy`,
which lives *inside* a `required_status_checks` rule — and `protect-main`
(id `16348427`) carries no such rule at all today, only `deletion` and
`non_fast_forward`. So it is strictly downstream of **#1052**. Status as of
2026-08-20: **deferred until after the Firebase migration**, because the current
merge cadence makes serialising every merge behind a rebase-and-rerun too
expensive. `main-red-alert.yml` is what covers the gap meanwhile — it does not
prevent the skew, it bounds how long the result goes unnoticed. Tracked in #1167.
